"""Per-model evidence for researched values (sql/007).

The AIBOM area tables keep evidence next to shared rows (a DATASET row is keyed by its identity and
shared by every model that uses it), so they cannot say which URL supported which value *for one
model's research*. `model_evidence` records exactly that: one row per (model, area, item, field,
URL). It is filled from the AI research result the admin registered, and read back when a human
reviews the model.

`build_result_evidence` flattens one research result into those rows; the admin UI shows them in
the review dialog and sends the rows of the values it kept when the model is saved.
"""
from __future__ import annotations

from typing import Any, Iterable, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models import ModelEvidence, ModelInfo, ModelResearchRun

EvidenceArea = Literal["catalog", "model", "provenance", "transformation", "dataset", "evaluation",
                       "safety_ethics", "license_policy"]
# Every field of the area / item (the research model gave one URL list for the whole thing).
WHOLE = "*"
SAFETY_CATEGORIES = ("safety_risk", "ethical_considerations", "prohibited_use", "mitigation")
# AibomDraft spelling -> AIBOM table (AibomWrite) spelling, so rows match the stored field names.
_FIELD_ALIASES = {"transformation": {"inputs": "input"}}


def evaluation_key(benchmark: str | None, metric: str | None, shots: int | None) -> str:
    """Identifies one evaluation row of a model; the admin UI builds the same key (src/domain/evidence.js)."""
    parts = [(benchmark or "").strip() or "-", (metric or "").strip() or "-"]
    if shots is not None:
        parts.append(f"{shots}-shot")
    return " | ".join(parts)


def _urls(values: Iterable[Any]) -> list[str]:
    return list(dict.fromkeys(
        value.strip() for value in values
        if isinstance(value, str) and value.strip().startswith(("http://", "https://"))
    ))


def _catalog_rows(entries: list[Any], source: str, only_field: str | None = None,
                  skip: frozenset[str] = frozenset()) -> list[dict[str, Any]]:
    rows = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        for field in entry.get("fields") or []:
            if field in skip or (only_field is not None and field != only_field):
                continue
            rows.extend({"area": "catalog", "itemKey": "", "field": field, "url": url, "locator": None,
                         "confidence": entry.get("confidence"), "note": entry.get("note"), "source": source}
                        for url in _urls(entry.get("urls") or []))
    return rows


def _aibom_rows(draft: dict[str, Any], source: str) -> list[dict[str, Any]]:
    """Rows from an AibomDraft-shaped dict (`aibomDraft` of a research result)."""
    rows: list[dict[str, Any]] = []

    def add(area: str, item_key: str, field: str, urls: Iterable[Any], confidence: str | None = None,
            note: str | None = None, locator: str | None = None) -> None:
        rows.extend({"area": area, "itemKey": item_key[:512], "field": field[:150], "url": url,
                     "locator": (locator or "").strip()[:500] or None,
                     "confidence": confidence, "note": note, "source": source} for url in _urls(urls))

    for entry in draft.get("field_evidence") or []:
        area = entry.get("area")
        for field in entry.get("fields") or []:
            field = str(field).strip()
            head, _, rest = field.partition(".")
            head = _FIELD_ALIASES.get(area, {}).get(head, head)
            add(area, "", f"{head}.{rest}" if rest else head, entry.get("urls") or [],
                entry.get("confidence"), entry.get("note"))
    for area in ("model", "provenance", "transformation"):
        add(area, "", WHOLE, (draft.get(area) or {}).get("evidence_urls") or [])
    for dataset in draft.get("datasets") or []:
        add("dataset", dataset.get("identity") or "", WHOLE, dataset.get("evidence_urls") or [])
    for evaluation in draft.get("evaluations") or []:
        add("evaluation", evaluation_key(evaluation.get("benchmark"), evaluation.get("metric"), evaluation.get("shots")),
            "score", [evaluation.get("source_url")], locator=evaluation.get("source_locator"))
    safety = draft.get("safety_ethics") or {}
    for category in SAFETY_CATEGORIES:
        for item in safety.get(category) or []:
            add("safety_ethics", item.get("description") or "", category, [item.get("source_url")])
    for license_ in draft.get("license_policy") or []:
        add("license_policy", license_.get("license") or "", WHOLE, [license_.get("source_url")])
    return rows


def build_result_evidence(result: dict[str, Any],
                          inputs: dict[str, dict[str, Any] | None] | None = None) -> list[dict[str, Any]]:
    """Evidence rows of one research result, `[{area, itemKey, field, url, locator, confidence, note, source}]`.

    A merged result has no catalog field evidence of its own; its rows are the evidence of the input
    (`huggingface` / `paper`) each field decision took the value from, so pass the merge `inputs`.
    Family fields inherited from the catalog parent (`catalogLineage.inheritedFields`) get no rows:
    the URLs the research model gave supported the value it suggested, not the inherited one.
    """
    source = result.get("source") or "manual"
    inherited = frozenset((result.get("catalogLineage") or {}).get("inheritedFields") or [])
    rows: list[dict[str, Any]] = []
    if source == "merged":
        for decision in result.get("fieldDecisions") or []:
            field, chosen = decision.get("field"), decision.get("chosen")
            if field in inherited:
                continue
            for key in (("huggingface", "paper") if chosen == "combined" else (chosen,)):
                origin = (inputs or {}).get(key) if key in ("huggingface", "paper") else None
                if origin:
                    rows.extend(_catalog_rows(origin.get("fieldEvidence") or [], key, only_field=field))
    else:
        rows.extend(_catalog_rows(result.get("fieldEvidence") or [], source, skip=inherited))
    if isinstance(result.get("aibomDraft"), dict):
        rows.extend(_aibom_rows(result["aibomDraft"], source))

    unique: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        unique.setdefault((row["area"], row["itemKey"], row["field"], row["url"]), row)
    return list(unique.values())


# --- storage -------------------------------------------------------------------------------------

class EvidenceItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    area: EvidenceArea
    item_key: str = Field(default="", alias="itemKey", max_length=512,
                          description="Row within the area: dataset identity, evaluation key, license name, "
                                      "safety item description. Empty for the single-row areas.")
    field: str = Field(default=WHOLE, min_length=1, max_length=150,
                       description="Field the URL supports (`architecture.parameter_count`), or `*` for the whole item.")
    url: str = Field(min_length=1, max_length=1000)
    locator: str | None = Field(default=None, max_length=500,
                                description="Where in the source the value is: `Table 2 (Main results), row ...`.")
    confidence: Literal["high", "medium", "low"] | None = None
    note: str | None = None
    source: str | None = Field(default=None, max_length=20,
                               description="huggingface | paper | merged | manual")


class ModelEvidenceWrite(BaseModel):
    """Full replacement of one model's evidence rows."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    run_id: int | None = Field(default=None, alias="runId", description="Research run the rows come from.")
    items: list[EvidenceItem] = Field(default_factory=list, max_length=5000)


def _row_dict(row: ModelEvidence) -> dict[str, Any]:
    return {"id": row.id, "area": row.area, "itemKey": row.item_key, "field": row.field, "url": row.url,
            "locator": row.locator,
            "confidence": row.confidence, "note": row.note, "source": row.source, "runId": row.run_id,
            "createdAt": row.created_at.isoformat() if row.created_at else None}


def load_model_evidence(session: Session, model_id: str) -> list[dict[str, Any]]:
    return [_row_dict(row) for row in session.scalars(
        select(ModelEvidence).where(ModelEvidence.model_id == model_id).order_by(ModelEvidence.id))]


def replace_model_evidence(session: Session, model_id: str, payload: ModelEvidenceWrite,
                           *, commit: bool = True) -> list[dict[str, Any]]:
    if session.get(ModelInfo, model_id) is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")
    run_id = payload.run_id if payload.run_id and session.get(ModelResearchRun, payload.run_id) else None
    session.execute(delete(ModelEvidence).where(ModelEvidence.model_id == model_id))
    seen: set[tuple] = set()
    for item in payload.items:
        key = (item.area, item.item_key, item.field, item.url)
        if key in seen:
            continue
        seen.add(key)
        session.add(ModelEvidence(model_id=model_id, area=item.area, item_key=item.item_key, field=item.field,
                                  url=item.url, locator=item.locator, confidence=item.confidence, note=item.note,
                                  source=item.source,
                                  run_id=run_id))
    if commit:
        session.commit()
    else:
        session.flush()
    return load_model_evidence(session, model_id)


def delete_model_evidence(session: Session, model_id: str) -> None:
    # Explicit delete (not only the FK cascade) so SQLite and MySQL behave the same.
    session.execute(delete(ModelEvidence).where(ModelEvidence.model_id == model_id))
