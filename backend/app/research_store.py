"""Stored AI research runs (sql/006).

Every "AI로 정보 채우기" run is kept: `model_research_run` groups the Hugging Face, paper and
merged results (`model_research_result`, one row per run and source). Nothing is overwritten by a
new run, so the admin can compare past runs at any time.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import case, delete, false, func, or_, select
from sqlalchemy.orm import Session, aliased, selectinload

from .models import ModelInfo, ModelResearchResult, ModelResearchReview, ModelResearchRun, Reviewer

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


def _draft_text(draft: dict[str, Any], key: str, limit: int) -> str | None:
    """A draft value as stored in its filter column: trimmed text, None when empty or not text."""
    value = draft.get(key)
    return value.strip()[:limit] or None if isinstance(value, str) else None


def _row_to_dict(row: ModelResearchResult, include_result: bool = True) -> dict[str, Any]:
    result = row.result_json or {}
    summary = {
        "id": row.id,
        "runId": row.run_id,
        "source": row.source,
        "status": row.status,
        "resultModelId": row.result_model_id,
        "familyName": row.family_name,
        "parentModelId": row.parent_model_id,
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


def _run_to_dict(run: ModelResearchRun, include_results: bool = True,
                 include_summary: bool | None = None) -> dict[str, Any]:
    """`include_summary` (default: as `include_results`) adds how each value was decided (`finalize.summary`)."""
    include_summary = include_results if include_summary is None else include_summary
    results: dict[str, Any] = {key: None for key in STORED_SOURCES}
    for row in run.results:
        results[row.source] = _row_to_dict(row, include_results)
    costs = [row.cost_usd for row in run.results if row.cost_usd is not None]
    searches = [row.web_search_requests for row in run.results if row.web_search_requests is not None]
    # What the run says about the model: the merged result, else Hugging Face, else the paper.
    shown = next((results[key] for key in ("merged", "huggingface", "paper") if results[key]), None) or {}
    return {
        "runId": run.id,
        "modelName": run.requested_model,
        "modelId": run.model_id,
        "resultModelId": next((results[k]["resultModelId"] for k in ("merged", "huggingface", "paper")
                               if results[k] and results[k]["resultModelId"]), None),
        "familyName": shown.get("familyName"),
        "parentModelId": shown.get("parentModelId"),
        "reviews": [{"reviewerId": review.reviewer_id, "status": review.status, "assignedAt": _iso(review.assigned_at),
                     "submittedAt": _iso(review.submitted_at)} for review in run.reviews],
        "finalize": {"status": run.finalize_status, "error": run.finalize_error,
                     "startedAt": _iso(run.finalize_started_at), "stale": finalize_is_stale(run),
                     **({"summary": run.finalize_json} if include_summary else {})},
        "reviewedById": run.reviewed_by,
        "reviewedAt": _iso(run.reviewed_at),
        "createdAt": _iso(run.created_at),
        "updatedAt": _iso(run.updated_at),
        "totalCostUsd": float(sum(costs)) if costs else None,
        "totalWebSearches": sum(searches) if searches else None,
        "results": results,
    }


# The save that follows the last review (app/review.py) is running in these states.
FINALIZING = ("saving", "merging")
# A save still "running" after this long was cut off (server restart) and may be started again.
FINALIZE_STALE_AFTER = timedelta(minutes=15)


def finalize_is_stale(run: ModelResearchRun) -> bool:
    if run.finalize_status not in FINALIZING or run.finalize_started_at is None:
        return False
    return datetime.now(timezone.utc).replace(tzinfo=None) - run.finalize_started_at > FINALIZE_STALE_AFTER


def reviews_complete(run: ModelResearchRun) -> bool:
    """Every assigned reviewer has submitted (and there is at least one)."""
    return bool(run.reviews) and all(review.status == "submitted" for review in run.reviews)


def _reviewer_names(session: Session) -> dict[int, str]:
    return dict(session.execute(select(Reviewer.id, Reviewer.name)).all())


def _add_review_state(run: dict[str, Any], catalog_ids: set[str],
                      reviewer_names: dict[int, str] | None = None) -> dict[str, Any]:
    """Where the review of the run stands, who reviews it, and which catalog model it belongs to.

    `saved`: the run is linked to the catalog model that was registered (or updated) from it.
    `pending`: the results are only stored and reviewers may still be working; `catalogModelId` then
    names the catalog model with the researched id when one already exists, so the review continues
    on that model instead of creating a duplicate.
    `saving` / `merging` / `failed`: every reviewer submitted and the save is running (`merging`:
    the AI is merging the values they tied on) or stopped with `finalize.error`.
    """
    result_id = run.get("resultModelId")
    run["reviewStatus"] = "saved" if run.get("modelId") else run["finalize"]["status"] or "pending"
    run["catalogModelId"] = run.get("modelId") or (result_id if result_id in catalog_ids else None)
    names = reviewer_names or {}
    run["reviewers"] = [{"id": review["reviewerId"], "name": names.get(review["reviewerId"]),
                         "status": review["status"], "submittedAt": review["submittedAt"]}
                        for review in run.pop("reviews")]
    run["reviewProgress"] = {"submitted": sum(item["status"] == "submitted" for item in run["reviewers"]),
                             "total": len(run["reviewers"])}
    run["reviewedByName"] = names.get(run.get("reviewedById"))
    return run


def _run_query():
    return select(ModelResearchRun).options(selectinload(ModelResearchRun.results),
                                            selectinload(ModelResearchRun.reviews))


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
        row.family_name = _draft_text(draft, "familyName", 255)
        row.parent_model_id = _draft_text(draft, "parentModelId", 512)
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


def _count_if(condition):
    return func.coalesce(func.sum(case((condition, 1), else_=0)), 0)


RESULT_SOURCES = ("huggingface", "paper", "merged")
RESULT_STATUSES = ("found", "ambiguous", "not_found")


def _result_label_condition(label: str):
    """Runs whose result of one source has one status: `<source>:<status>`, e.g. `huggingface:not_found`.

    The status `missing` selects the runs that have no result of that source. These are the badges
    of the research history list. Anything else (including `all`) is no filter.
    """
    source, _, state = (label or "").partition(":")
    if source not in RESULT_SOURCES or state not in (*RESULT_STATUSES, "missing"):
        return None
    of_source = select(ModelResearchResult.id).where(ModelResearchResult.run_id == ModelResearchRun.id,
                                                     ModelResearchResult.source == source)
    return ~of_source.exists() if state == "missing" else of_source.where(ModelResearchResult.status == state).exists()


def _like(column, text: str):
    """Case-insensitive "contains"; % and _ in the text are literal."""
    escaped = text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return func.lower(column).like(f"%{escaped}%", escape="\\")


def _shown_result(condition):
    """Runs whose result meets `condition`: the merged result when the run has one, else any result."""
    merged = aliased(ModelResearchResult)
    has_merged = select(merged.id).where(merged.run_id == ModelResearchResult.run_id, merged.source == "merged").exists()
    return select(ModelResearchResult.id).where(
        ModelResearchResult.run_id == ModelResearchRun.id, condition,
        or_(ModelResearchResult.source == "merged", ~has_merged)).exists()


def research_filter_options(session: Session) -> dict[str, list[str]]:
    """Family names and parent model ids found in the stored results, for the history filters."""
    # Like the filters, a run speaks through its merged result when it has one.
    merged = aliased(ModelResearchResult)
    shown = or_(ModelResearchResult.source == "merged", ~select(merged.id).where(
        merged.run_id == ModelResearchResult.run_id, merged.source == "merged").exists())

    def values(column) -> list[str]:
        found: dict[str, str] = {}
        for value in session.scalars(select(column).where(column.is_not(None), shown).distinct()):
            found.setdefault(value.casefold(), value)  # "unknown" and "Unknown" are one choice
        return sorted(found.values(), key=str.casefold)
    return {"families": values(ModelResearchResult.family_name), "parents": values(ModelResearchResult.parent_model_id)}


def page_research_runs(session: Session, status: str = "all", reviewer: str = "all", query: str | None = None,
                       search_by: str = "model", offset: int = 0, limit: int = 100,
                       label: str = "all", family: str | None = None, parent: str | None = None,
                       verified: bool = False) -> dict[str, Any]:
    """One page of run summaries (newest first) for the research history page.

    `label` narrows the list to the runs carrying one result badge (see `_result_label_condition`).
    Like the reviewer filter it also applies to `counts`.

    `reviewer` is "all", "none" or a reviewer id: the runs that reviewer reviews (or saved directly),
    or the runs nobody is assigned to. `counts` are the status totals inside that reviewer filter
    (the status tabs); `stats` are the totals of every stored run.

    `family` is a family name (any case), `parent` a parent model id or a part of one, and `verified`
    keeps the runs whose Hugging Face, paper and merged results were all found. They apply to
    `counts` too.
    """
    run = ModelResearchRun
    pending, saved = run.model_id.is_(None), run.model_id.is_not(None)
    conditions = []
    of_run = select(ModelResearchReview.id).where(ModelResearchReview.run_id == run.id)
    if reviewer == "none":
        conditions.append(~of_run.exists() & run.reviewed_by.is_(None))
    elif reviewer != "all":
        conditions.append(or_(of_run.where(ModelResearchReview.reviewer_id == int(reviewer)).exists(),
                              run.reviewed_by == int(reviewer)) if reviewer.isdigit() else false())
    label_condition = _result_label_condition(label)
    if label_condition is not None:
        conditions.append(label_condition)
    if (family or "").strip():
        conditions.append(_shown_result(func.lower(ModelResearchResult.family_name) == family.strip().lower()))
    if (parent or "").strip():
        # A whole parent id (picked from the list) is matched as it is, so "…-8B" leaves out
        # "…-8B-Instruct"; anything else is taken as a part of the id.
        whole = func.lower(ModelResearchResult.parent_model_id) == parent.strip().lower()
        known = session.scalar(select(ModelResearchResult.id).where(whole).limit(1)) is not None
        conditions.append(_shown_result(whole if known else _like(ModelResearchResult.parent_model_id, parent.strip())))
    if verified:
        conditions.append(select(func.count()).where(
            ModelResearchResult.run_id == run.id, ModelResearchResult.status == "found",
            ModelResearchResult.source.in_(STORED_SOURCES)).scalar_subquery() == len(STORED_SOURCES))
    counts = session.execute(select(func.count(), _count_if(pending), _count_if(saved)).where(*conditions)).one()
    stats = session.execute(select(func.count(), _count_if(pending), _count_if(saved),
                                   _count_if(pending & ~of_run.exists()))).one()

    if status in ("pending", "saved"):
        conditions.append(pending if status == "pending" else saved)
    text = (query or "").strip()
    if text and search_by == "id":
        number = text.lstrip("#")
        conditions.append(run.id == int(number) if number.isdigit() else false())
    elif text:
        conditions.append(or_(_like(run.requested_model, text), _like(run.model_id, text), select(ModelResearchResult.id).where(
            ModelResearchResult.run_id == run.id, _like(ModelResearchResult.result_model_id, text)).exists()))

    total = session.scalar(select(func.count()).select_from(run).where(*conditions)) or 0
    rows = list(session.scalars(_run_query().where(*conditions).order_by(run.created_at.desc(), run.id.desc())
                                .offset(offset).limit(limit)))
    catalog_ids = set(session.scalars(select(ModelInfo.model_id)))
    names = _reviewer_names(session)
    end = offset + len(rows)
    return {
        "items": [_add_review_state(_run_to_dict(row, include_results=False), catalog_ids, names) for row in rows],
        "total": total,
        "offset": offset,
        "nextOffset": end if rows and end < total else None,
        # int(): MySQL returns SUM() as Decimal
        "counts": {"all": int(counts[0]), "pending": int(counts[1]), "saved": int(counts[2])},
        "stats": {"all": int(stats[0]), "pending": int(stats[1]), "saved": int(stats[2]), "unassigned": int(stats[3])},
    }


def get_research_run(session: Session, run_id: int) -> dict[str, Any]:
    run = session.scalar(_run_query().where(ModelResearchRun.id == run_id))
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    data = _run_to_dict(run)
    result_id = data.get("resultModelId")
    return _add_review_state(data, {result_id} if result_id and session.get(ModelInfo, result_id) else set(),
                             _reviewer_names(session))


def get_research_run_status(session: Session, run_id: int) -> dict[str, Any]:
    """The review state of one run without its result payloads: small enough to poll while it is saved."""
    run = session.scalar(_run_query().where(ModelResearchRun.id == run_id))
    if run is None:
        raise HTTPException(status_code=404, detail="Research run not found.")
    data = _run_to_dict(run, include_results=False, include_summary=True)
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
    run.finalize_status, run.finalize_error, run.finalize_started_at = None, None, None
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
    reviewer_ids: list[int] = Field(default_factory=list, alias="reviewerIds", max_length=50)
    mode: Literal["add", "remove", "set"] = Field(
        default="add",
        description="add: also assign these reviewers. remove: unassign them. "
                    "set: the runs are reviewed by exactly these reviewers (an empty list unassigns everyone).")
    dry_run: bool = Field(default=False, alias="dryRun", description="Only count what the ids cover; change nothing.")


class DistributeRunsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    reviewer_ids: list[int] = Field(alias="reviewerIds", min_length=1, max_length=50,
                                    description="Reviewers who all review every unassigned run.")


def _pending_load(session: Session) -> dict[int, int]:
    """Reviews still to be done, per reviewer."""
    load: dict[int, int] = {}
    for (reviewer_id,) in session.execute(
            select(ModelResearchReview.reviewer_id).join(ModelResearchRun, ModelResearchRun.id == ModelResearchReview.run_id)
            .where(ModelResearchRun.model_id.is_(None), ModelResearchReview.status == "assigned")):
        load[reviewer_id] = load.get(reviewer_id, 0) + 1
    return load


def list_reviewers(session: Session) -> list[dict[str, Any]]:
    """Reviewers that can be given work. Deleted ones (`is_active` false) are left out; their rows
    stay so the runs they reviewed keep showing their name.

    `pendingCount`: runs waiting for this reviewer's review. `reviewedCount`: reviews they submitted,
    plus the runs they saved directly from the editor."""
    pending = _pending_load(session)
    reviewed: dict[int, int] = {}
    done = [select(ModelResearchReview.reviewer_id).where(ModelResearchReview.status == "submitted"),
            select(ModelResearchRun.reviewed_by).where(ModelResearchRun.reviewed_by.is_not(None))]
    for query in done:
        for (reviewer_id,) in session.execute(query):
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


def _assignable(run: ModelResearchRun) -> bool:
    """Reviewers can be changed until the run is saved, and not while its save is running."""
    return run.model_id is None and (run.finalize_status not in FINALIZING or finalize_is_stale(run))


def _after_assignment_change(run: ModelResearchRun) -> None:
    # A failed save is void once the reviewers change: the run waits (or is saved) again.
    run.finalize_status, run.finalize_error, run.finalize_started_at = None, None, None


def delete_reviewer(session: Session, reviewer_id: int) -> list[dict[str, Any]]:
    """Soft delete: the reviewer disappears from the lists and gets no more work.

    The row stays (`is_active` false) so the reviews they submitted keep their name; reviews they
    had not submitted yet are unassigned. Adding the same name again restores the reviewer.
    """
    row = session.get(Reviewer, reviewer_id)
    if row is None or not row.is_active:
        raise HTTPException(status_code=404, detail="Reviewer not found.")
    row.is_active = False
    for run in session.scalars(_run_query().where(ModelResearchRun.id.in_(reviewer_open_run_ids(session, reviewer_id)))):
        if not _assignable(run):
            continue
        run.reviews[:] = [review for review in run.reviews if review.reviewer_id != reviewer_id]
        _after_assignment_change(run)
    session.commit()
    return list_reviewers(session)


def reviewer_open_run_ids(session: Session, reviewer_id: int) -> list[int]:
    """Unsaved runs this reviewer has not submitted a review for yet."""
    return list(session.scalars(
        select(ModelResearchReview.run_id).join(ModelResearchRun, ModelResearchRun.id == ModelResearchReview.run_id)
        .where(ModelResearchReview.reviewer_id == reviewer_id, ModelResearchReview.status == "assigned",
               ModelResearchRun.model_id.is_(None))))


def runs_ready_to_finalize(session: Session, run_ids: list[int]) -> list[int]:
    """Of these runs, the ones every reviewer has submitted and whose save has not started."""
    if not run_ids:
        return []
    return [run.id for run in session.scalars(_run_query().where(ModelResearchRun.id.in_(run_ids)))
            if run.model_id is None and run.finalize_status is None and reviews_complete(run)]


def _active_reviewer(session: Session, reviewer_id: int) -> Reviewer:
    row = session.get(Reviewer, reviewer_id)
    if row is None or not row.is_active:
        raise HTTPException(status_code=422, detail="The reviewer does not exist.")
    return row


def assign_runs(session: Session, payload: AssignRunsRequest) -> dict[str, Any]:
    """Change who reviews the runs (see `AssignRunsRequest.mode`). A run can have several reviewers.

    Runs that are saved, or being saved, are left alone. Unassigning a reviewer drops the review
    they submitted for that run. `readyRunIds` are the changed runs whose remaining reviewers have
    all submitted: their save can start.

    A dry run changes nothing and reports how many of the ids exist (`found`) and still wait for
    review (`pending`), so a range of ids can be previewed without loading those runs.
    """
    if payload.dry_run:
        found, waiting = session.execute(select(func.count(), _count_if(ModelResearchRun.model_id.is_(None)))
                                         .where(ModelResearchRun.id.in_(payload.run_ids))).one()
        return {"found": int(found), "pending": int(waiting)}
    reviewer_ids = list(dict.fromkeys(payload.reviewer_ids))
    if payload.mode != "remove":
        for reviewer_id in reviewer_ids:
            _active_reviewer(session, reviewer_id)
    if payload.mode != "set" and not reviewer_ids:
        raise HTTPException(status_code=422, detail="Name the reviewers to assign or unassign.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    changed: list[int] = []
    for run in session.scalars(_run_query().where(ModelResearchRun.id.in_(payload.run_ids))):
        if not _assignable(run):
            continue
        current = [review.reviewer_id for review in run.reviews]
        keep = (current + [item for item in reviewer_ids if item not in current] if payload.mode == "add"
                else [item for item in current if item not in reviewer_ids] if payload.mode == "remove"
                else reviewer_ids)
        if set(keep) == set(current):
            continue
        run.reviews[:] = [review for review in run.reviews if review.reviewer_id in keep]
        run.reviews.extend(ModelResearchReview(reviewer_id=reviewer_id, status="assigned", assigned_at=now)
                           for reviewer_id in keep if reviewer_id not in current)
        _after_assignment_change(run)
        changed.append(run.id)
    session.commit()
    return {"assigned": len(changed), "readyRunIds": runs_ready_to_finalize(session, changed)}


def distribute_runs(session: Session, reviewer_ids: list[int]) -> dict[str, Any]:
    """Give every unassigned pending run to all of the named reviewers.

    Nothing is balanced or picked: each run nobody reviews yet gets exactly these reviewers.
    """
    wanted = list(dict.fromkeys(reviewer_ids))
    reviewers = list(session.scalars(select(Reviewer).where(
        Reviewer.id.in_(wanted), Reviewer.is_active.is_(True)).order_by(Reviewer.id))) if wanted else []
    if not wanted or len(reviewers) != len(wanted):
        raise HTTPException(status_code=422, detail="Choose active reviewers to assign the runs to.")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    runs = list(session.scalars(_run_query().where(
        ModelResearchRun.model_id.is_(None), ModelResearchRun.finalize_status.is_(None),
        ~select(ModelResearchReview.id).where(ModelResearchReview.run_id == ModelResearchRun.id).exists())))
    for run in runs:
        for reviewer in reviewers:
            run.reviews.append(ModelResearchReview(reviewer_id=reviewer.id, status="assigned", assigned_at=now))
    session.commit()
    return {"assigned": len(runs), "reviewers": [{"reviewerId": reviewer.id, "name": reviewer.name} for reviewer in reviewers]}


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
        session.execute(delete(ModelResearchReview).where(ModelResearchReview.run_id.in_(run_ids)))
        session.execute(delete(ModelResearchResult).where(ModelResearchResult.run_id.in_(run_ids)))
        session.execute(delete(ModelResearchRun).where(ModelResearchRun.id.in_(run_ids)))
    session.commit()
    return len(run_ids)
