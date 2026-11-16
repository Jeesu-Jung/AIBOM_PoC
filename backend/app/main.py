from copy import deepcopy

from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from .aibom import AibomWrite, load_aibom_options, load_model_aibom, save_model_aibom
from .catalog import (
    build_catalog,
    load_family_index,
    load_model_row,
    load_model_rows,
    model_to_dict,
)
from .admin import (
    AdminModelWrite,
    admin_model_to_dict,
    create_admin_model,
    delete_admin_model,
    load_admin_models,
    update_admin_model,
)
from .config import settings
from .evidence import ModelEvidenceWrite, load_model_evidence, replace_model_evidence
from .database import SessionLocal, get_db
from pydantic import BaseModel, Field

from .research_store import (
    AssignRunsRequest,
    ReviewerWrite,
    SaveResearchResultsRequest,
    assign_runs,
    distribute_runs,
    list_reviewers,
    save_reviewer,
    delete_research_results,
    delete_research_run,
    get_research_run,
    link_research_run,
    list_research_runs,
    load_research_results,
    save_research_results,
)
from .research import (
    CatalogContext,
    MergeResearchRequest,
    ModelResearchRequest,
    attach_evidence,
    load_catalog_context,
    resolve_catalog_lineage,
    stream_model_merge,
    stream_model_research,
)


class AdminModelWithAibomWrite(BaseModel):
    """The admin editor saves the catalog fields and all AIBOM areas as one unit."""
    model: AdminModelWrite
    aibom: AibomWrite


app = FastAPI(
    title="AIBOM Model Catalog API",
    version="1.0.0",
    description="MySQL-backed API for model metadata, model hierarchy, and AIBOM area data.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)


def _database_unavailable() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="The model catalog database is unavailable.",
    )


@app.get("/api/v1/health", tags=["system"])
def health(response: Response, db: Session = Depends(get_db)) -> dict[str, str]:
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unhealthy"}
    return {"status": "ok"}


@app.get("/api/v1/families", tags=["families"])
def families(db: Session = Depends(get_db)) -> dict:
    """Return only the small family index needed to bootstrap the UI."""
    try:
        return load_family_index(db)
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.get("/api/v1/models", tags=["models"])
def models(db: Session = Depends(get_db)) -> list[dict]:
    try:
        return [model_to_dict(row) for row in load_model_rows(db)]
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.get("/api/v1/families/{family_key}/hierarchy", tags=["families"])
def family_hierarchy(family_key: str, db: Session = Depends(get_db)) -> dict:
    try:
        payload = build_catalog(load_model_rows(db, family_key=family_key))
    except SQLAlchemyError as error:
        raise _database_unavailable() from error
    family = payload["familyRegistry"].get(family_key)
    if family is None:
        raise HTTPException(status_code=404, detail="Model family not found.")
    return family


@app.get("/api/v1/models/{model_id:path}", tags=["models"])
def model(model_id: str, db: Session = Depends(get_db)) -> dict:
    """Catalog record plus the model's AIBOM (the 8 design areas) under `aibom`."""
    try:
        row = load_model_row(db, model_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Model not found.")
        return {**model_to_dict(row), "aibom": load_model_aibom(db, model_id)}
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.get("/api/v1/admin/models", tags=["admin"])
def admin_models(db: Session = Depends(get_db)) -> list[dict]:
    try:
        return [admin_model_to_dict(row) for row in load_admin_models(db)]
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


def _load_research_context() -> CatalogContext:
    """Collect existing family keys, relationship types, and model ids for the research prompt."""
    session = SessionLocal()
    try:
        return load_catalog_context(session)
    except SQLAlchemyError:
        return CatalogContext(
            warnings=("카탈로그 DB를 읽지 못해 기존 패밀리 키와 모델 ID 없이 조사했습니다. familyKey와 부모 후보를 직접 확인하세요.",)
        )
    finally:
        session.close()


@app.post("/api/v1/admin/model-research/stream", tags=["admin"])
async def admin_stream_model_research(payload: ModelResearchRequest) -> StreamingResponse:
    """Stream public OpenRouter activity and finish with a validated admin draft."""
    context = await run_in_threadpool(_load_research_context)
    return StreamingResponse(
        stream_model_research(payload.model_name, context=context, source=payload.source),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


def _refresh_stored_results(db: Session, data: dict) -> dict:
    """Bring stored research results up to date with the current catalog, on copies.

    Stored drafts predate later catalog changes (e.g. the parent was registered afterwards), so
    they are placed in the tree again; evidence rows follow the lineage (inherited fields carry
    none) and older runs stored none.
    """
    context = load_catalog_context(db)
    for row in data["results"].values():
        if row and isinstance(row.get("result"), dict):
            row["result"] = resolve_catalog_lineage(deepcopy(row["result"]), context)
    inputs = {key: (data["results"].get(key) or {}).get("result") for key in ("huggingface", "paper")}
    for row in data["results"].values():
        if row and isinstance(row.get("result"), dict):
            attach_evidence(row["result"], inputs)
    return data


@app.get("/api/v1/admin/model-research/results", tags=["admin"])
def admin_research_results(modelName: str, db: Session = Depends(get_db)) -> dict:
    """Return stored research results (huggingface / paper / merged) for a requested model name."""
    if len(modelName.strip()) < 2:
        raise HTTPException(status_code=422, detail="modelName must be at least 2 characters.")
    try:
        return _refresh_stored_results(db, load_research_results(db, modelName))
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.post("/api/v1/admin/model-research/results", tags=["admin"])
def admin_save_research_results(payload: SaveResearchResultsRequest, db: Session = Depends(get_db)) -> dict:
    """Persist research results into a run (new run with replacePrevious, or `runId`); runs are never overwritten."""
    try:
        return save_research_results(db, payload)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.delete("/api/v1/admin/model-research/results", tags=["admin"], status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_research_results(modelName: str, db: Session = Depends(get_db)) -> Response:
    try:
        delete_research_results(db, modelName)
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class ResearchRunLink(BaseModel):
    model_id: str | None = Field(alias="modelId", default=None, max_length=512)
    reviewed_by: int | None = Field(alias="reviewedBy", default=None,
                                    description="Reviewer who reviewed and saved the run; null records nobody.")


def _store_call(db: Session, action):
    """Run a research-store write and map its failures like the other admin writes."""
    try:
        return action()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The change conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.get("/api/v1/admin/reviewers", tags=["admin"])
def admin_reviewers(db: Session = Depends(get_db)) -> list[dict]:
    """Reviewers with how many runs wait for them and how many they reviewed."""
    try:
        return list_reviewers(db)
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.post("/api/v1/admin/reviewers", tags=["admin"], status_code=status.HTTP_201_CREATED)
def admin_create_reviewer(payload: ReviewerWrite, db: Session = Depends(get_db)) -> list[dict]:
    return _store_call(db, lambda: save_reviewer(db, payload))


@app.put("/api/v1/admin/reviewers/{reviewer_id}", tags=["admin"])
def admin_update_reviewer(reviewer_id: int, payload: ReviewerWrite, db: Session = Depends(get_db)) -> list[dict]:
    """Rename a reviewer or (de)activate them. Reviewers are not deleted so their history stays."""
    return _store_call(db, lambda: save_reviewer(db, payload, reviewer_id))


@app.post("/api/v1/admin/research-runs/assign", tags=["admin"])
def admin_assign_runs(payload: AssignRunsRequest, db: Session = Depends(get_db)) -> dict:
    """Assign pending runs to a reviewer (`reviewerId: null` unassigns)."""
    return _store_call(db, lambda: assign_runs(db, payload))


@app.post("/api/v1/admin/research-runs/distribute", tags=["admin"])
def admin_distribute_runs(db: Session = Depends(get_db)) -> dict:
    """Share the unassigned pending runs between the active reviewers, least loaded first."""
    return _store_call(db, lambda: distribute_runs(db))


@app.get("/api/v1/admin/research-runs", tags=["admin"])
def admin_research_runs(modelName: str | None = None, modelId: str | None = None, limit: int = 100,
                        db: Session = Depends(get_db)) -> list[dict]:
    """Every stored research run (newest first) with per-source summaries."""
    try:
        return list_research_runs(db, model_name=modelName, model_id=modelId, limit=max(1, min(limit, 500)))
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.get("/api/v1/admin/research-runs/{run_id}", tags=["admin"])
def admin_research_run(run_id: int, resolve: bool = False, db: Session = Depends(get_db)) -> dict:
    """One stored run. `resolve=true` returns the results as the editor uses them: placed in the
    current catalog tree and with per-value evidence rows (the history view keeps them as stored)."""
    try:
        run = get_research_run(db, run_id)
        return _refresh_stored_results(db, run) if resolve else run
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.put("/api/v1/admin/research-runs/{run_id}/model", tags=["admin"])
def admin_link_research_run(run_id: int, payload: ResearchRunLink, db: Session = Depends(get_db)) -> dict:
    """Record which catalog model was registered from this run (null to unlink)."""
    try:
        return link_research_run(db, run_id, payload.model_id, payload.reviewed_by)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.delete("/api/v1/admin/research-runs/{run_id}", tags=["admin"], status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_research_run(run_id: int, db: Session = Depends(get_db)) -> Response:
    try:
        delete_research_run(db, run_id)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@app.post("/api/v1/admin/model-research/merge/stream", tags=["admin"])
async def admin_stream_model_merge(payload: MergeResearchRequest) -> StreamingResponse:
    """Reconcile the Hugging Face and paper research results into one draft over SSE."""
    context = await run_in_threadpool(_load_research_context)
    return StreamingResponse(
        stream_model_merge(payload, context=context),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"},
    )


@app.get("/api/v1/admin/aibom/options", tags=["admin"])
def admin_aibom_options(db: Session = Depends(get_db)) -> dict:
    """Datasets and references that an AIBOM payload can point to."""
    try:
        return load_aibom_options(db)
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


# Registered before the `{model_id:path}` routes below, which would otherwise swallow `/evidence`.
@app.get("/api/v1/admin/models/{model_id:path}/evidence", tags=["admin"])
def admin_model_evidence(model_id: str, db: Session = Depends(get_db)) -> list[dict]:
    """Evidence URLs recorded for this model's researched values (catalog fields and AIBOM areas)."""
    try:
        if load_model_row(db, model_id) is None:
            raise HTTPException(status_code=404, detail="Model not found.")
        return load_model_evidence(db, model_id)
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.put("/api/v1/admin/models/{model_id:path}/evidence", tags=["admin"])
def admin_save_model_evidence(model_id: str, payload: ModelEvidenceWrite, db: Session = Depends(get_db)) -> list[dict]:
    """Replace the model's evidence rows (sent when a model is registered from an AI research draft)."""
    try:
        return replace_model_evidence(db, model_id, payload)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


# Registered before the `{model_id:path}` routes below, which would otherwise swallow `/aibom`.
@app.get("/api/v1/admin/models/{model_id:path}/aibom", tags=["admin"])
def admin_model_aibom(model_id: str, db: Session = Depends(get_db)) -> dict:
    try:
        if load_model_row(db, model_id) is None:
            raise HTTPException(status_code=404, detail="Model not found.")
        return load_model_aibom(db, model_id) or {}
    except SQLAlchemyError as error:
        raise _database_unavailable() from error


@app.put("/api/v1/admin/models/{model_id:path}/aibom", tags=["admin"])
def admin_save_model_aibom(model_id: str, payload: AibomWrite, db: Session = Depends(get_db)) -> dict:
    """Replace the model's AIBOM rows; `dataset` / `reference` entries are upserted."""
    try:
        return save_model_aibom(db, model_id, payload)
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The AIBOM could not be saved because it conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.post("/api/v1/admin/models", tags=["admin"], status_code=status.HTTP_201_CREATED)
def admin_create_model(payload: AdminModelWrite, db: Session = Depends(get_db)) -> dict:
    try:
        return admin_model_to_dict(create_admin_model(db, payload))
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The model could not be saved because its data conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.post("/api/v1/admin/models/complete", tags=["admin"], status_code=status.HTTP_201_CREATED)
def admin_create_complete_model(payload: AdminModelWithAibomWrite, db: Session = Depends(get_db)) -> dict:
    try:
        row = create_admin_model(db, payload.model, commit=False)
        aibom = save_model_aibom(db, row.model_id, payload.aibom, commit=False)
        db.commit()
        return {"model": admin_model_to_dict(row), "aibom": aibom}
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The model could not be saved because its data conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.put("/api/v1/admin/models/{model_id:path}/complete", tags=["admin"])
def admin_update_complete_model(model_id: str, payload: AdminModelWithAibomWrite, db: Session = Depends(get_db)) -> dict:
    try:
        row = update_admin_model(db, model_id, payload.model, commit=False)
        aibom = save_model_aibom(db, model_id, payload.aibom, commit=False)
        db.commit()
        return {"model": admin_model_to_dict(row), "aibom": aibom}
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The model could not be saved because its data conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.put("/api/v1/admin/models/{model_id:path}", tags=["admin"])
def admin_update_model(model_id: str, payload: AdminModelWrite, db: Session = Depends(get_db)) -> dict:
    try:
        return admin_model_to_dict(update_admin_model(db, model_id, payload))
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(status_code=409, detail="The model could not be saved because its data conflicts with another record.") from error
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error


@app.delete("/api/v1/admin/models/{model_id:path}", tags=["admin"], status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_model(model_id: str, db: Session = Depends(get_db)) -> Response:
    try:
        delete_admin_model(db, model_id)
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise _database_unavailable() from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)
