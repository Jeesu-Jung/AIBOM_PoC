from collections import defaultdict
from typing import Any

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session, selectinload

from .aibom import count_relation_types
from .models import ModelHierarchy, ModelInfo


def load_family_index(session: Session) -> dict[str, Any]:
    root_count = func.sum(case((ModelHierarchy.hierarchy_depth == 0, 1), else_=0))
    derived_count = func.sum(case((ModelHierarchy.hierarchy_depth > 0, 1), else_=0))
    preferred_root = func.coalesce(
        func.min(case((ModelInfo.model_role == "INSTRUCT", ModelInfo.model_id))),
        func.min(case((ModelHierarchy.hierarchy_depth == 0, ModelInfo.model_id))),
    )
    statement = (
        select(
            ModelInfo.family_key,
            func.max(ModelInfo.family_name).label("family_name"),
            func.max(ModelInfo.family_release_date).label("release_date"),
            func.count(ModelInfo.model_id).label("model_count"),
            root_count.label("root_count"),
            derived_count.label("derived_count"),
            preferred_root.label("default_node_id"),
        )
        .join(ModelHierarchy, ModelHierarchy.model_id == ModelInfo.model_id)
        .group_by(ModelInfo.family_key)
        .order_by(func.max(ModelInfo.family_release_date), ModelInfo.family_key)
    )
    rows = session.execute(statement).all()
    items = [
        {
            "familyKey": row.family_key,
            "familyName": row.family_name,
            "releaseDate": row.release_date,
            "modelCount": row.model_count,
            "rootCount": int(row.root_count or 0),
            "derivedCount": int(row.derived_count or 0),
            "defaultNodeId": row.default_node_id,
        }
        for row in rows
    ]
    # Transformation types come from the AIBOM provenance relations; the catalog's free-form
    # relationship_type is the fallback until AIBOM rows exist.
    transformation_count = count_relation_types(session) or session.scalar(
        select(func.count(func.distinct(ModelHierarchy.relationship_type))).where(
            ModelHierarchy.relationship_type.is_not(None)
        )
    ) or 0
    return {
        "items": items,
        "summary": {
            "familyCount": len(items),
            "modelCount": sum(item["modelCount"] for item in items),
            "rootCount": sum(item["rootCount"] for item in items),
            "derivedCount": sum(item["derivedCount"] for item in items),
            "transformationTypeCount": transformation_count,
            "latestRelease": max(
                (item["releaseDate"] for item in items if item["releaseDate"]),
                default=None,
            ),
        },
    }


def load_model_rows(session: Session, family_key: str | None = None) -> list[ModelInfo]:
    statement = (
        select(ModelInfo)
        .options(selectinload(ModelInfo.hierarchy))
        .order_by(ModelInfo.family_release_date, ModelInfo.family_key, ModelInfo.model_id)
    )
    if family_key is not None:
        statement = statement.where(ModelInfo.family_key == family_key)
    return list(session.scalars(statement))


def load_model_row(session: Session, model_id: str) -> ModelInfo | None:
    statement = (
        select(ModelInfo)
        .options(selectinload(ModelInfo.hierarchy))
        .where(ModelInfo.model_id == model_id)
    )
    return session.scalar(statement)


def _fallback_family_config(row: ModelInfo) -> dict[str, Any]:
    root_family = row.details_json.get("family", {})
    return {
        "id": row.family_key,
        "label": row.family_name,
        "default_node_id": None,
        "document_node": {
            "id": f"document:{row.family_key}",
            "title": f"{row.family_name} source materials",
            "subtitle": "Evidence used to populate this family AIBOM.",
        },
        "root_family": root_family,
    }


def build_catalog(rows: list[ModelInfo]) -> dict[str, Any]:
    family_rows: dict[str, list[ModelInfo]] = defaultdict(list)
    checklist_registry: dict[str, Any] = {}

    for row in rows:
        if row.hierarchy is None:
            raise ValueError(f"Hierarchy row missing for model: {row.model_id}")
        family_rows[row.family_key].append(row)
        checklist = row.details_json.get("checklist")
        if checklist:
            checklist_registry[row.model_id] = checklist

    family_registry: dict[str, Any] = {}
    for family_key, members in family_rows.items():
        first = members[0]
        config = first.details_json.get("family_config") or _fallback_family_config(first)
        family = {
            **config,
            "id": family_key,
            "label": first.family_name,
            "root_nodes": [],
            "derived_models": [],
        }

        roots = [member for member in members if member.hierarchy.parent_model_id is None]
        roots.sort(key=lambda member: member.hierarchy.sibling_order)
        for member in roots:
            source = member.details_json.get("model", {})
            family["root_nodes"].append({
                **source,
                "id": member.model_id,
                "kind": "root",
                "title": source.get("title") or member.model_id,
                "subtitle": source.get("subtitle") or member.description,
            })

        derived = [member for member in members if member.hierarchy.parent_model_id is not None]
        derived.sort(key=lambda member: (
            member.hierarchy.parent_model_id or "",
            member.hierarchy.sibling_order,
        ))
        for member in derived:
            source = member.details_json.get("model", {})
            hierarchy = member.hierarchy
            family["derived_models"].append({
                **source,
                "model_id": member.model_id,
                "parent_model": hierarchy.parent_model_id,
                "relationship": hierarchy.relationship_type,
                "supplier": member.supplier,
                "license_reported": member.license_reported,
                "artifact": source.get("artifact", {}),
                "delta": hierarchy.change_details_json,
            })

        if not family.get("default_node_id"):
            instruct = next(
                (member.model_id for member in roots if member.model_role == "INSTRUCT"),
                None,
            )
            family["default_node_id"] = instruct or (roots[0].model_id if roots else None)
        family_registry[family_key] = family

    return {
        "familyRegistry": family_registry,
        "checklistRegistry": checklist_registry,
        "modelCount": len(rows),
    }


def model_to_dict(row: ModelInfo) -> dict[str, Any]:
    hierarchy: ModelHierarchy = row.hierarchy
    return {
        "modelId": row.model_id,
        "namespace": row.namespace,
        "modelName": row.model_name,
        "familyKey": row.family_key,
        "familyName": row.family_name,
        "modelRole": row.model_role,
        "supplier": row.supplier,
        "familyDeveloper": row.family_developer,
        "familyReleaseDate": row.family_release_date,
        "familyLicenseName": row.family_license_name,
        "primaryPurpose": row.primary_purpose,
        "modelVersion": row.model_version,
        "packageUrl": row.package_url,
        "modelUrl": row.model_url,
        "licenseReported": row.license_reported,
        "artifactFormat": row.artifact_format,
        "tensorType": row.tensor_type,
        "parameterScale": row.parameter_scale,
        "artifactRevision": row.artifact_revision,
        "description": row.description,
        "checklistScore": float(row.checklist_score) if row.checklist_score is not None else None,
        "sourceGeneratedAt": row.source_generated_at,
        "hierarchy": {
            "parentModelId": hierarchy.parent_model_id,
            "relationshipType": hierarchy.relationship_type,
            "depth": hierarchy.hierarchy_depth,
            "siblingOrder": hierarchy.sibling_order,
            "changeDetails": hierarchy.change_details_json,
        },
        "details": row.details_json,
    }
