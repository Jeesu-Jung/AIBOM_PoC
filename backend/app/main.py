from fastapi import Depends, FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .catalog import (
    build_catalog,
    load_family_index,
    load_model_row,
    load_model_rows,
    model_to_dict,
)
from .config import settings
from .database import get_db


app = FastAPI(
    title="AIBOM Model Catalog API",
    version="1.0.0",
    description="MySQL-backed API for model metadata and model hierarchy data.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["GET"],
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
    try:
        row = load_model_row(db, model_id)
    except SQLAlchemyError as error:
        raise _database_unavailable() from error
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found.")
    return model_to_dict(row)
