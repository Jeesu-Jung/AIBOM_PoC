from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from .models import ModelHierarchy, ModelInfo


class AdminModelWrite(BaseModel):
    """Editable model metadata and its position in the model tree."""

    model_config = ConfigDict(populate_by_name=True)

    model_id: str = Field(alias="modelId", min_length=1, max_length=512)
    namespace: str = Field(min_length=1, max_length=255)
    model_name: str = Field(alias="modelName", min_length=1, max_length=255)
    family_key: str = Field(alias="familyKey", min_length=1, max_length=100)
    family_name: str = Field(alias="familyName", min_length=1, max_length=255)
    model_role: Literal["BASE", "INSTRUCT", "DERIVED"] = Field(alias="modelRole")
    supplier: str | None = Field(default=None, max_length=255)
    family_developer: str | None = Field(default=None, alias="familyDeveloper", max_length=255)
    family_release_date: date | None = Field(default=None, alias="familyReleaseDate")
    family_license_name: str | None = Field(default=None, alias="familyLicenseName", max_length=255)
    primary_purpose: str | None = Field(default=None, alias="primaryPurpose", max_length=255)
    model_version: str | None = Field(default=None, alias="modelVersion", max_length=255)
    package_url: str | None = Field(default=None, alias="packageUrl", max_length=1000)
    model_url: str = Field(alias="modelUrl", min_length=1, max_length=1000)
    license_reported: Any | None = Field(default=None, alias="licenseReported")
    artifact_format: str | None = Field(default=None, alias="artifactFormat", max_length=100)
    tensor_type: str | None = Field(default=None, alias="tensorType", max_length=100)
    parameter_scale: str | None = Field(default=None, alias="parameterScale", max_length=100)
    artifact_revision: str | None = Field(default=None, alias="artifactRevision", max_length=255)
    description: str | None = None
    bom_format: str | None = Field(default=None, alias="bomFormat", max_length=50)
    bom_spec_version: str | None = Field(default=None, alias="bomSpecVersion", max_length=20)
    bom_serial_number: str | None = Field(default=None, alias="bomSerialNumber", max_length=100)
    bom_version: str | None = Field(default=None, alias="bomVersion", max_length=50)
    checklist_present_fields: int | None = Field(default=None, alias="checklistPresentFields", ge=0)
    checklist_total_fields: int | None = Field(default=None, alias="checklistTotalFields", ge=0)
    checklist_score: Decimal | None = Field(default=None, alias="checklistScore", ge=0, le=100)
    checklist_penalty_factor: Decimal | None = Field(default=None, alias="checklistPenaltyFactor", ge=0, le=1)
    source_generated_at: datetime | None = Field(default=None, alias="sourceGeneratedAt")
    details_json: dict[str, Any] = Field(default_factory=dict, alias="detailsJson")
    parent_model_id: str | None = Field(default=None, alias="parentModelId", max_length=512)
    relationship_type: str | None = Field(default=None, alias="relationshipType", max_length=100)
    sibling_order: int = Field(default=0, alias="siblingOrder", ge=0)
    change_details_json: dict[str, Any] | None = Field(default=None, alias="changeDetailsJson")

    @model_validator(mode="after")
    def validate_hierarchy(self) -> "AdminModelWrite":
        if self.parent_model_id == self.model_id:
            raise ValueError("A model cannot be its own parent.")
        if self.parent_model_id is None and self.relationship_type is not None:
            raise ValueError("Root models cannot have a relationship type.")
        if self.parent_model_id is not None and not self.relationship_type:
            raise ValueError("Derived models require a relationship type.")
        if (
            self.checklist_present_fields is not None
            and self.checklist_total_fields is not None
            and self.checklist_present_fields > self.checklist_total_fields
        ):
            raise ValueError("Present checklist fields cannot exceed total fields.")
        return self


def _statement():
    return select(ModelInfo).options(selectinload(ModelInfo.hierarchy))


def load_admin_models(session: Session) -> list[ModelInfo]:
    return list(session.scalars(_statement().order_by(ModelInfo.family_key, ModelInfo.model_id)))


def _not_found(model_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"Model not found: {model_id}")


def _hierarchy_map(session: Session) -> dict[str, ModelHierarchy]:
    return {row.model_id: row for row in session.scalars(select(ModelHierarchy))}


def _validate_parent(
    session: Session,
    payload: AdminModelWrite,
    current_id: str | None = None,
) -> int:
    parent_id = payload.parent_model_id
    if parent_id is None:
        return 0
    parent = session.get(ModelInfo, parent_id)
    if parent is None:
        raise HTTPException(status_code=422, detail="The selected parent model does not exist.")
    if parent.family_key != payload.family_key:
        raise HTTPException(status_code=422, detail="Parent and child must belong to the same family.")

    hierarchy = _hierarchy_map(session)
    if current_id:
        cursor = parent_id
        while cursor is not None:
            if cursor == current_id:
                raise HTTPException(status_code=422, detail="The selected parent would create a hierarchy cycle.")
            cursor = hierarchy.get(cursor).parent_model_id if hierarchy.get(cursor) else None
    parent_hierarchy = hierarchy.get(parent_id)
    if parent_hierarchy is None:
        raise HTTPException(status_code=422, detail="The selected parent has no hierarchy record.")
    return parent_hierarchy.hierarchy_depth + 1


MODEL_COLUMNS = (
    "namespace", "model_name", "family_key", "family_name", "model_role", "supplier",
    "family_developer", "family_release_date", "family_license_name", "primary_purpose",
    "model_version", "package_url", "model_url", "license_reported", "artifact_format",
    "tensor_type", "parameter_scale", "artifact_revision", "description", "bom_format",
    "bom_spec_version", "bom_serial_number", "bom_version", "checklist_present_fields",
    "checklist_total_fields", "checklist_score", "checklist_penalty_factor",
    "source_generated_at", "details_json",
)


def _apply_model(row: ModelInfo, payload: AdminModelWrite) -> None:
    for column in MODEL_COLUMNS:
        setattr(row, column, getattr(payload, column))


def _recalculate_descendant_depths(session: Session, root_id: str) -> None:
    hierarchy = _hierarchy_map(session)
    children: dict[str, list[ModelHierarchy]] = {}
    for row in hierarchy.values():
        if row.parent_model_id:
            children.setdefault(row.parent_model_id, []).append(row)

    queue = [root_id]
    while queue:
        parent_id = queue.pop(0)
        parent = hierarchy[parent_id]
        for child in children.get(parent_id, []):
            child.hierarchy_depth = parent.hierarchy_depth + 1
            queue.append(child.model_id)


def create_admin_model(session: Session, payload: AdminModelWrite) -> ModelInfo:
    if session.get(ModelInfo, payload.model_id) is not None:
        raise HTTPException(status_code=409, detail="A model with this ID already exists.")
    depth = _validate_parent(session, payload)
    row = ModelInfo(model_id=payload.model_id)
    _apply_model(row, payload)
    row.hierarchy = ModelHierarchy(
        model_id=payload.model_id,
        parent_model_id=payload.parent_model_id,
        relationship_type=payload.relationship_type,
        hierarchy_depth=depth,
        sibling_order=payload.sibling_order,
        change_details_json=payload.change_details_json,
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    return session.scalar(_statement().where(ModelInfo.model_id == payload.model_id))


def update_admin_model(session: Session, model_id: str, payload: AdminModelWrite) -> ModelInfo:
    if payload.model_id != model_id:
        raise HTTPException(status_code=422, detail="Model ID cannot be changed after creation.")
    row = session.scalar(_statement().where(ModelInfo.model_id == model_id))
    if row is None:
        raise _not_found(model_id)

    hierarchy = _hierarchy_map(session)
    child_ids = [item.model_id for item in hierarchy.values() if item.parent_model_id == model_id]
    if child_ids and payload.family_key != row.family_key:
        raise HTTPException(status_code=422, detail="A model with children cannot be moved to another family.")

    depth = _validate_parent(session, payload, current_id=model_id)
    _apply_model(row, payload)
    row.hierarchy.parent_model_id = payload.parent_model_id
    row.hierarchy.relationship_type = payload.relationship_type
    row.hierarchy.hierarchy_depth = depth
    row.hierarchy.sibling_order = payload.sibling_order
    row.hierarchy.change_details_json = payload.change_details_json
    _recalculate_descendant_depths(session, model_id)
    session.commit()
    return session.scalar(_statement().where(ModelInfo.model_id == model_id))


def delete_admin_model(session: Session, model_id: str) -> None:
    row = session.get(ModelInfo, model_id)
    if row is None:
        raise _not_found(model_id)
    has_children = session.scalar(
        select(ModelHierarchy.model_id).where(ModelHierarchy.parent_model_id == model_id).limit(1)
    )
    if has_children:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Move or delete this model's children before deleting it.",
        )
    hierarchy = session.get(ModelHierarchy, model_id)
    if hierarchy:
        session.delete(hierarchy)
        session.flush()
    session.delete(row)
    session.commit()


def admin_model_to_dict(row: ModelInfo) -> dict[str, Any]:
    result = {"modelId": row.model_id}
    aliases = {
        "model_name": "modelName", "family_key": "familyKey", "family_name": "familyName",
        "model_role": "modelRole", "family_developer": "familyDeveloper",
        "family_release_date": "familyReleaseDate", "family_license_name": "familyLicenseName",
        "primary_purpose": "primaryPurpose", "model_version": "modelVersion",
        "package_url": "packageUrl", "model_url": "modelUrl", "license_reported": "licenseReported",
        "artifact_format": "artifactFormat", "tensor_type": "tensorType",
        "parameter_scale": "parameterScale", "artifact_revision": "artifactRevision",
        "bom_format": "bomFormat", "bom_spec_version": "bomSpecVersion",
        "bom_serial_number": "bomSerialNumber", "bom_version": "bomVersion",
        "checklist_present_fields": "checklistPresentFields",
        "checklist_total_fields": "checklistTotalFields", "checklist_score": "checklistScore",
        "checklist_penalty_factor": "checklistPenaltyFactor",
        "source_generated_at": "sourceGeneratedAt", "details_json": "detailsJson",
    }
    for column in MODEL_COLUMNS:
        value = getattr(row, column)
        if isinstance(value, Decimal):
            value = float(value)
        result[aliases.get(column, column)] = value
    hierarchy = row.hierarchy
    result.update({
        "parentModelId": hierarchy.parent_model_id,
        "relationshipType": hierarchy.relationship_type,
        "hierarchyDepth": hierarchy.hierarchy_depth,
        "siblingOrder": hierarchy.sibling_order,
        "changeDetailsJson": hierarchy.change_details_json,
    })
    return result
