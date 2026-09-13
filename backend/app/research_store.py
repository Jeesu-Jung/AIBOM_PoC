from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models import ModelResearchResult

StoredSource = Literal["huggingface", "paper", "merged"]
STORED_SOURCES: tuple[StoredSource, ...] = ("huggingface", "paper", "merged")


class SaveResearchResultsRequest(BaseModel):
    """Persist the results of one research run for a requested model name."""

    model_config = ConfigDict(populate_by_name=True)

    model_name: str = Field(alias="modelName", min_length=2, max_length=512)
    results: dict[StoredSource, dict[str, Any] | None]
    replace_previous: bool = Field(
        default=False,
        alias="replacePrevious",
        description="Delete every stored row for this model name before inserting the new results.",
    )

    @model_validator(mode="after")
    def _require_one_result(self) -> "SaveResearchResultsRequest":
        if not any(self.results.get(key) for key in STORED_SOURCES):
            raise ValueError("At least one research result is required.")
        return self


def normalize_requested_model(model_name: str) -> str:
    return " ".join(model_name.split())


def _row_to_dict(row: ModelResearchResult) -> dict[str, Any]:
    created = row.created_at
    if created is not None and created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return {
        "id": row.id,
        "source": row.source,
        "status": row.status,
        "resultModelId": row.result_model_id,
        "researchModel": row.research_model,
        "createdAt": created.isoformat() if created else None,
        "result": row.result_json,
    }


def load_research_results(session: Session, model_name: str) -> dict[str, Any]:
    requested = normalize_requested_model(model_name)
    rows = session.scalars(
        select(ModelResearchResult)
        .where(ModelResearchResult.requested_model == requested)
        .order_by(ModelResearchResult.created_at)
    ).all()
    results: dict[str, Any] = {key: None for key in STORED_SOURCES}
    for row in rows:
        results[row.source] = _row_to_dict(row)
    latest = max((row.created_at for row in rows), default=None)
    if latest is not None and latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    return {
        "modelName": requested,
        "exists": bool(rows),
        "latestCreatedAt": latest.isoformat() if latest else None,
        "results": results,
    }


def save_research_results(session: Session, payload: SaveResearchResultsRequest) -> dict[str, Any]:
    requested = normalize_requested_model(payload.model_name)
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    if payload.replace_previous:
        session.execute(delete(ModelResearchResult).where(ModelResearchResult.requested_model == requested))
        session.flush()

    for source in STORED_SOURCES:
        result = payload.results.get(source)
        if not result:
            continue
        existing = session.scalar(
            select(ModelResearchResult).where(
                ModelResearchResult.requested_model == requested,
                ModelResearchResult.source == source,
            )
        )
        row = existing or ModelResearchResult(requested_model=requested, source=source)
        draft = result.get("draft") if isinstance(result.get("draft"), dict) else {}
        research = result.get("research") if isinstance(result.get("research"), dict) else {}
        row.status = result.get("status")
        row.result_model_id = draft.get("modelId")
        row.research_model = research.get("model")
        row.result_json = result
        row.created_at = now
        if existing is None:
            session.add(row)

    session.commit()
    return load_research_results(session, requested)


def delete_research_results(session: Session, model_name: str) -> int:
    requested = normalize_requested_model(model_name)
    deleted = session.execute(
        delete(ModelResearchResult).where(ModelResearchResult.requested_model == requested)
    ).rowcount
    session.commit()
    return int(deleted or 0)
