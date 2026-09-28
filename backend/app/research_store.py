"""Stored AI research runs (sql/006).

Every "AI로 정보 채우기" run is kept: `model_research_run` groups the Hugging Face, paper and
merged results (`model_research_result`, one row per run and source). Nothing is overwritten by a
new run, so the admin can compare past runs at any time.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, selectinload

from .models import ModelInfo, ModelResearchResult, ModelResearchRun

StoredSource = Literal["huggingface", "paper", "merged"]
STORED_SOURCES: tuple[StoredSource, ...] = ("huggingface", "paper", "merged")


class SaveResearchResultsRequest(BaseModel):
    """Persist results of a research run for a requested model name."""

    model_config = ConfigDict(populate_by_name=True)

    model_name: str = Field(alias="modelName", min_length=2, max_length=512)
    results: dict[StoredSource, dict[str, Any] | None]
    run_id: int | None = Field(
        default=None,
        alias="runId",
        description="Add to this run (e.g. the merge result after the two research results).",
    )
    replace_previous: bool = Field(
        default=False,
        alias="replacePrevious",
        description="Start a new run. Earlier runs are kept in the history (nothing is deleted).",
    )

    @model_validator(mode="after")
    def _require_one_result(self) -> "SaveResearchResultsRequest":
        if not any(self.results.get(key) for key in STORED_SOURCES):
            raise ValueError("At least one research result is required.")
        return self


def normalize_requested_model(model_name: str) -> str:
    return " ".join(model_name.split())


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def _web_searches(result: dict[str, Any]) -> int | None:
    research = result.get("research") if isinstance(result.get("research"), dict) else {}
    if isinstance(research.get("webSearchRequests"), int):
        return research["webSearchRequests"]
    usage = research.get("usage") or {}
    for key in ("server_tool_use", "server_tool_use_details"):
        count = (usage.get(key) or {}).get("web_search_requests")
        if isinstance(count, int):
            return count
    return None


def _cost(result: dict[str, Any]) -> Decimal | None:
    usage = ((result.get("research") or {}).get("usage") or {}) if isinstance(result.get("research"), dict) else {}
    try:
        return Decimal(str(usage["cost"])) if usage.get("cost") is not None else None
    except (InvalidOperation, TypeError):
        return None


def _row_to_dict(row: ModelResearchResult, include_result: bool = True) -> dict[str, Any]:
    result = row.result_json or {}
    summary = {
        "id": row.id,
        "runId": row.run_id,
        "source": row.source,
        "status": row.status,
        "resultModelId": row.result_model_id,
        "researchModel": row.research_model,
        "webSearchRequests": row.web_search_requests,
        "costUsd": float(row.cost_usd) if row.cost_usd is not None else None,
        "createdAt": _iso(row.created_at),
        "aibomSummary": result.get("aibomSummary") or {},
        "hasAibom": bool(result.get("aibom")),
        "sourceCount": len(result.get("sources") or []),
        "warningCount": len(result.get("warnings") or []),
    }
    if include_result:
        summary["result"] = result
    return summary


def _run_to_dict(run: ModelResearchRun, include_results: bool = True) -> dict[str, Any]:
    results: dict[str, Any] = {key: None for key in STORED_SOURCES}
    for row in run.results:
        results[row.source] = _row_to_dict(row, include_results)
    costs = [row.cost_usd for row in run.results if row.cost_usd is not None]
    searches = [row.web_search_requests for row in run.results if row.web_search_requests is not None]
    return {
        "runId": run.id,
        "modelName": run.requested_model,
        "modelId": run.model_id,
        "resultModelId": next((results[k]["resultModelId"] for k in ("merged", "huggingface", "paper")
                               if results[k] and results[k]["resultModelId"]), None),
        "createdAt": _iso(run.created_at),
        "updatedAt": _iso(run.updated_at),
        "totalCostUsd": float(sum(costs)) if costs else None,
        "totalWebSearches": sum(searches) if searches else None,
        "results": results,
    }


def _run_query():
    return select(ModelResearchRun).options(selectinload(ModelResearchRun.results))


def _latest_run(session: Session, requested: str) -> ModelResearchRun | None:
    return session.scalar(_run_query().where(ModelResearchRun.requested_model == requested)
                          .order_by(ModelResearchRun.created_at.desc(), ModelResearchRun.id.desc()).limit(1))


def load_research_results(session: Session, model_name: str) -> dict[str, Any]:
    """Latest run for a requested name (used by the create dialog), plus the number of stored runs."""
    requested = normalize_requested_model(model_name)
    run = _latest_run(session, requested)
    run_count = len(session.scalars(select(ModelResearchRun.id).where(ModelResearchRun.requested_model == requested)).all())
    if run is None:
        return {"modelName": requested, "exists": False, "latestCreatedAt": None, "runId": None, "runCount": 0,
                "results": {key: None for key in STORED_SOURCES}}
    data = _run_to_dict(run)
    latest = max((row.created_at for row in run.results), default=run.created_at)
    return {**data, "modelName": requested, "exists": True, "latestCreatedAt": _iso(latest), "runCount": run_count}


def save_research_results(session: Session, payload: SaveResearchResultsRequest) -> dict[str, Any]:
    requested = normalize_requested_model(payload.model_name)
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if payload.run_id is not None:
        run = session.get(ModelResearchRun, payload.run_id)
        if run is None or run.requested_model != requested:
            raise HTTPException(status_code=404, detail="Research run not found for this model name.")
    else:
        run = None if payload.replace_previous else _latest_run(session, requested)
        if run is None:
            run = ModelResearchRun(requested_model=requested, created_at=now, updated_at=now)
            session.add(run)
            session.flush()

    for source in STORED_SOURCES:
        result = payload.results.get(source)
        if not result:
            continue
        # Re-saving a source within the same run (e.g. a retried merge) replaces that row only.
        row = session.scalar(select(ModelResearchResult).where(
            ModelResearchResult.run_id == run.id, ModelResearchResult.source == source))
        if row is None:
            row = ModelResearchResult(run_id=run.id, requested_model=requested, source=source)
            session.add(row)
        draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
        research = result.get("research") if isinstance(result.get("research"), dict) else {}
        row.status = result.get("status")
        row.result_model_id = draft.get("modelId")
        row.research_model = research.get("model")
        row.web_search_requests = _web_searches(result)
        row.cost_usd = _cost(result)
        row.result_json = result
        row.created_at = now
    run.updated_at = now

    session.commit()
    session.expire_all()
    return load_research_results(session, requested) | {"runId": run.id}


def list_research_runs(session: Session, model_name: str | None = None, model_id: str | None = None,
                       limit: int = 100) -> list[dict[str, Any]]:
    """Run summaries, newest first. `model_id` matches runs linked to the model or whose result named it."""
    query = _run_query().order_by(ModelResearchRun.created_at.desc(), ModelResearchRun.id.desc())
    if model_name:
        query = query.where(ModelResearchRun.requested_model == normalize_requested_model(model_name))
    runs = list(session.scalars(query))
    if model_id:
        runs = [run for run in runs
                if run.model_id == model_id or any(row.result_model_id == model_id for row in run.results)]
    return [_run_to_dict(run, include_results=False) for run in runs[:limit]]


def get_research_run(session: Session, run_id: int) -> dict[str, Any]:
    run = session.scalar(_run_query().where(ModelResearchRun.id == run_id))
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    return _run_to_dict(run)


def link_research_run(session: Session, run_id: int, model_id: str | None) -> dict[str, Any]:
    run = session.get(ModelResearchRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    if model_id is not None and session.get(ModelInfo, model_id) is None:
        raise HTTPException(status_code=422, detail="The model to link does not exist in the catalog.")
    run.model_id = model_id
    session.commit()
    return get_research_run(session, run_id)


def delete_research_run(session: Session, run_id: int) -> None:
    run = session.get(ModelResearchRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    session.delete(run)
    session.commit()


def delete_research_results(session: Session, model_name: str) -> int:
    """Delete every stored run for a requested name."""
    requested = normalize_requested_model(model_name)
    run_ids = list(session.scalars(select(ModelResearchRun.id).where(ModelResearchRun.requested_model == requested)))
    if run_ids:
        session.execute(delete(ModelResearchResult).where(ModelResearchResult.run_id.in_(run_ids)))
        session.execute(delete(ModelResearchRun).where(ModelResearchRun.id.in_(run_ids)))
    session.commit()
    return len(run_ids)
