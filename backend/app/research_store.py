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

from .models import ModelInfo, ModelResearchResult, ModelResearchRun, Reviewer

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


def _metric(result: dict[str, Any], key: str) -> int | None:
    """A call measurement the research stream attached (`research.metrics`); None for older results."""
    research = result.get("research") if isinstance(result.get("research"), dict) else {}
    value = (research.get("metrics") or {}).get(key) if isinstance(research.get("metrics"), dict) else None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


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
        "responseTimeMs": row.response_time_ms,
        "eventCount": row.event_count,
        "contentCharacters": row.content_characters,
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
        "reviewerId": run.reviewer_id,
        "assignedAt": _iso(run.assigned_at),
        "reviewedById": run.reviewed_by,
        "reviewedAt": _iso(run.reviewed_at),
        "createdAt": _iso(run.created_at),
        "updatedAt": _iso(run.updated_at),
        "totalCostUsd": float(sum(costs)) if costs else None,
        "totalWebSearches": sum(searches) if searches else None,
        "results": results,
    }


def _reviewer_names(session: Session) -> dict[int, str]:
    return dict(session.execute(select(Reviewer.id, Reviewer.name)).all())


def _add_review_state(run: dict[str, Any], catalog_ids: set[str],
                      reviewer_names: dict[int, str] | None = None) -> dict[str, Any]:
    """Whether a human reviewed and saved the run, and which catalog model it belongs to.

    `saved`: the run is linked to the catalog model that was registered (or updated) from it.
    `pending`: the results are only stored; `catalogModelId` then names the catalog model with the
    researched id when one already exists, so the review continues on that model instead of
    creating a duplicate.
    """
    result_id = run.get("resultModelId")
    run["reviewStatus"] = "saved" if run.get("modelId") else "pending"
    run["catalogModelId"] = run.get("modelId") or (result_id if result_id in catalog_ids else None)
    names = reviewer_names or {}
    run["reviewerName"] = names.get(run.get("reviewerId"))
    run["reviewedByName"] = names.get(run.get("reviewedById"))
    return run


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
        row.response_time_ms = _metric(result, "responseTimeMs")
        row.event_count = _metric(result, "eventCount")
        row.content_characters = _metric(result, "contentCharacters")
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
    catalog_ids = set(session.scalars(select(ModelInfo.model_id)))
    names = _reviewer_names(session)
    return [_add_review_state(_run_to_dict(run, include_results=False), catalog_ids, names) for run in runs[:limit]]


def get_research_run(session: Session, run_id: int) -> dict[str, Any]:
    run = session.scalar(_run_query().where(ModelResearchRun.id == run_id))
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    data = _run_to_dict(run)
    result_id = data.get("resultModelId")
    return _add_review_state(data, {result_id} if result_id and session.get(ModelInfo, result_id) else set(),
                             _reviewer_names(session))


def link_research_run(session: Session, run_id: int, model_id: str | None,
                      reviewed_by: int | None = None) -> dict[str, Any]:
    """Mark the run as reviewed and saved to `model_id` (None undoes it).

    `reviewed_by` is the reviewer who did the review; None records nobody.
    """
    run = session.get(ModelResearchRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    if model_id is not None and session.get(ModelInfo, model_id) is None:
        raise HTTPException(status_code=422, detail="The model to link does not exist in the catalog.")
    if reviewed_by is not None and session.get(Reviewer, reviewed_by) is None:
        raise HTTPException(status_code=422, detail="The reviewer does not exist.")
    run.model_id = model_id
    if model_id is None:
        run.reviewed_by, run.reviewed_at = None, None
    else:
        run.reviewed_by = reviewed_by
        run.reviewed_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.commit()
    return get_research_run(session, run_id)


# --- reviewers and assignment (sql/010) ----------------------------------------------------------

class ReviewerWrite(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    name: str = Field(min_length=1, max_length=100)
    email: str | None = Field(default=None, max_length=255)


class AssignRunsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    run_ids: list[int] = Field(alias="runIds", min_length=1, max_length=500)
    reviewer_id: int | None = Field(default=None, alias="reviewerId", description="null removes the assignment")


def _pending_load(session: Session) -> dict[int, int]:
    """Runs still waiting for review, per assigned reviewer."""
    load: dict[int, int] = {}
    for (reviewer_id,) in session.execute(select(ModelResearchRun.reviewer_id).where(
            ModelResearchRun.model_id.is_(None), ModelResearchRun.reviewer_id.is_not(None))):
        load[reviewer_id] = load.get(reviewer_id, 0) + 1
    return load


def list_reviewers(session: Session) -> list[dict[str, Any]]:
    """Reviewers that can be given work. Deleted ones (`is_active` false) are left out; their rows
    stay so the runs they reviewed keep showing their name."""
    pending = _pending_load(session)
    reviewed: dict[int, int] = {}
    for (reviewer_id,) in session.execute(select(ModelResearchRun.reviewed_by).where(
            ModelResearchRun.reviewed_by.is_not(None))):
        reviewed[reviewer_id] = reviewed.get(reviewer_id, 0) + 1
    return [{"id": row.id, "name": row.name, "email": row.email,
             "pendingCount": pending.get(row.id, 0), "reviewedCount": reviewed.get(row.id, 0)}
            for row in session.scalars(select(Reviewer).where(Reviewer.is_active.is_(True)).order_by(Reviewer.name))]


def save_reviewer(session: Session, payload: ReviewerWrite, reviewer_id: int | None = None) -> list[dict[str, Any]]:
    name = " ".join(payload.name.split())
    if not name:
        raise HTTPException(status_code=422, detail="Reviewer name is required.")
    row = session.get(Reviewer, reviewer_id) if reviewer_id is not None else Reviewer()
    if row is None or (reviewer_id is not None and not row.is_active):
        raise HTTPException(status_code=404, detail="Reviewer not found.")
    duplicate = session.scalar(select(Reviewer).where(Reviewer.name == name))
    if duplicate is not None and duplicate.id != row.id:
        if reviewer_id is None and not duplicate.is_active:
            # Adding the name of a deleted reviewer brings that reviewer back, history included.
            row = duplicate
        elif not duplicate.is_active:
            raise HTTPException(status_code=409, detail="A deleted reviewer has this name. Add the name again to restore that reviewer.")
        else:
            raise HTTPException(status_code=409, detail="A reviewer with this name already exists.")
    row.name, row.is_active = name, True
    if payload.email is not None or reviewer_id is not None:
        row.email = (payload.email or "").strip() or None
    session.add(row)
    session.commit()
    return list_reviewers(session)


def delete_reviewer(session: Session, reviewer_id: int) -> list[dict[str, Any]]:
    """Soft delete: the reviewer disappears from the lists and gets no more work.

    The row stays (`is_active` false) so runs they reviewed keep their name; runs still waiting
    for them go back to unassigned. Adding the same name again restores the reviewer.
    """
    row = session.get(Reviewer, reviewer_id)
    if row is None or not row.is_active:
        raise HTTPException(status_code=404, detail="Reviewer not found.")
    row.is_active = False
    for run in session.scalars(select(ModelResearchRun).where(
            ModelResearchRun.reviewer_id == reviewer_id, ModelResearchRun.model_id.is_(None))):
        run.reviewer_id, run.assigned_at = None, None
    session.commit()
    return list_reviewers(session)


def _active_reviewer(session: Session, reviewer_id: int) -> Reviewer:
    row = session.get(Reviewer, reviewer_id)
    if row is None or not row.is_active:
        raise HTTPException(status_code=422, detail="The reviewer does not exist.")
    return row


def assign_runs(session: Session, payload: AssignRunsRequest) -> dict[str, Any]:
    """Assign runs to a reviewer (or unassign them). Runs that are already saved are left alone."""
    if payload.reviewer_id is not None:
        _active_reviewer(session, payload.reviewer_id)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    changed = 0
    for run in session.scalars(select(ModelResearchRun).where(ModelResearchRun.id.in_(payload.run_ids))):
        if run.model_id is not None or run.reviewer_id == payload.reviewer_id:
            continue
        run.reviewer_id = payload.reviewer_id
        run.assigned_at = now if payload.reviewer_id is not None else None
        changed += 1
    session.commit()
    return {"assigned": changed}


def distribute_runs(session: Session) -> dict[str, Any]:
    """Share the unassigned pending runs between the active reviewers.

    Each run goes to whoever has the fewest runs waiting at that moment, so people who already
    carry more get fewer new ones. Oldest runs are handed out first.
    """
    reviewers = list(session.scalars(select(Reviewer).where(Reviewer.is_active.is_(True)).order_by(Reviewer.id)))
    if not reviewers:
        raise HTTPException(status_code=422, detail="There is no active reviewer to assign runs to.")
    load = _pending_load(session)
    counts = {reviewer.id: load.get(reviewer.id, 0) for reviewer in reviewers}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    given: dict[int, int] = {}
    runs = session.scalars(select(ModelResearchRun).where(
        ModelResearchRun.model_id.is_(None), ModelResearchRun.reviewer_id.is_(None))
        .order_by(ModelResearchRun.created_at, ModelResearchRun.id))
    for run in runs:
        target = min(counts, key=lambda reviewer_id: (counts[reviewer_id], reviewer_id))
        run.reviewer_id, run.assigned_at = target, now
        counts[target] += 1
        given[target] = given.get(target, 0) + 1
    session.commit()
    names = {reviewer.id: reviewer.name for reviewer in reviewers}
    return {"assigned": sum(given.values()),
            "byReviewer": [{"reviewerId": key, "name": names[key], "assigned": value} for key, value in given.items()]}


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
