from dataclasses import dataclass

import pytest

from app.catalog import build_catalog


@dataclass
class HierarchyRow:
    parent_model_id: str | None
    relationship_type: str | None
    hierarchy_depth: int
    sibling_order: int
    change_details_json: dict | None


@dataclass
class ModelRow:
    model_id: str
    family_key: str
    family_name: str
    model_role: str
    supplier: str
    license_reported: object
    description: str | None
    details_json: dict
    hierarchy: HierarchyRow | None


def family_config() -> dict:
    return {
        "id": "sample",
        "label": "Sample",
        "default_node_id": "org/root",
        "document_node": {"id": "document:sample", "title": "Sample source"},
        "root_family": {"sources": []},
        "root_nodes": [],
        "derived_models": [],
    }


def test_build_catalog_reconstructs_model_tree() -> None:
    root = ModelRow(
        model_id="org/root",
        family_key="sample",
        family_name="Sample",
        model_role="BASE",
        supplier="org",
        license_reported="example-license",
        description="Root",
        details_json={
            "family_config": family_config(),
            "model": {"id": "org/root", "title": "org/root"},
            "checklist": {"modelId": "org/root", "categories": []},
        },
        hierarchy=HierarchyRow(None, None, 0, 0, None),
    )
    child = ModelRow(
        model_id="org/child",
        family_key="sample",
        family_name="Sample",
        model_role="DERIVED",
        supplier="org",
        license_reported="example-license",
        description=None,
        details_json={
            "family_config": family_config(),
            "model": {"sources": [], "artifact": {"format": "safetensors"}},
            "checklist": {"modelId": "org/child", "categories": []},
        },
        hierarchy=HierarchyRow("org/root", "fineTunedFrom", 1, 0, {"added_task": "demo"}),
    )

    payload = build_catalog([root, child])
    family = payload["familyRegistry"]["sample"]

    assert payload["modelCount"] == 2
    assert family["root_nodes"][0]["id"] == "org/root"
    assert family["derived_models"][0]["parent_model"] == "org/root"
    assert family["derived_models"][0]["delta"] == {"added_task": "demo"}
    assert set(payload["checklistRegistry"]) == {"org/root", "org/child"}


def test_build_catalog_rejects_missing_hierarchy() -> None:
    row = ModelRow(
        model_id="org/root",
        family_key="sample",
        family_name="Sample",
        model_role="BASE",
        supplier="org",
        license_reported=None,
        description=None,
        details_json={},
        hierarchy=None,
    )

    with pytest.raises(ValueError, match="Hierarchy row missing"):
        build_catalog([row])
