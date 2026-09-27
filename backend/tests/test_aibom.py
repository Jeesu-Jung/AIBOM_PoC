import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import main
from app.admin import AdminModelWrite, create_admin_model, delete_admin_model, update_admin_model
from app.aibom import AibomWrite, load_model_aibom, relation_from_hierarchy, save_model_aibom
from app.database import get_db
from app.models import Base, Dataset, LicensePolicy, Provenance, Transformation


def session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def catalog_payload(model_id: str, parent_id: str | None = None, **extra) -> AdminModelWrite:
    return AdminModelWrite.model_validate({
        "modelId": model_id,
        "namespace": model_id.split("/")[0],
        "modelName": model_id.split("/")[-1],
        "familyKey": "sample",
        "familyName": "Sample",
        "modelRole": "DERIVED" if parent_id else "BASE",
        "modelUrl": f"https://example.test/{model_id}",
        "parentModelId": parent_id,
        "relationshipType": "fineTunedFrom" if parent_id else None,
        "familyLicenseName": "Apache-2.0",
        "detailsJson": {},
        **extra,
    })


def provenance(db: Session, model_id: str) -> Provenance:
    return db.scalar(select(Provenance).where(Provenance.subject == f"model:{model_id}"))


def test_relation_from_hierarchy_converts_camel_case() -> None:
    assert relation_from_hierarchy("fineTunedFrom") == "fine_tuned_from"
    assert relation_from_hierarchy(None) is None


def test_catalog_create_seeds_provenance_transformation_and_license() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base"))
    create_admin_model(db, catalog_payload("org/child", "org/base"))

    child = provenance(db, "org/child")
    assert child.parent == ["model:org/base"]
    assert child.relation == "fine_tuned_from"
    assert provenance(db, "org/base").relation == "pretrained"
    transformation = db.scalar(select(Transformation).where(Transformation.output == "org/child"))
    assert transformation.input == [{"model": "org/base", "role": "base", "external": False}]
    assert db.scalar(select(LicensePolicy.license).where(LicensePolicy.subject == "model:org/child")) == "Apache-2.0"


def test_reparent_updates_lineage_but_unrelated_edits_keep_aibom_inputs() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base-a"))
    create_admin_model(db, catalog_payload("org/base-b"))
    create_admin_model(db, catalog_payload("org/child", "org/base-a"))
    save_model_aibom(db, "org/child", AibomWrite.model_validate({
        "transformation": {"input": [{"model": "org/base-a", "role": "base"},
                                     {"model": "GPT-4o", "role": "verifier"}], "method": ["SFT"]},
    }))

    update_admin_model(db, "org/child", catalog_payload("org/child", "org/base-a", description="edited"))
    tr = db.scalar(select(Transformation).where(Transformation.output == "org/child"))
    assert [i["model"] for i in tr.input] == ["org/base-a", "GPT-4o"]

    update_admin_model(db, "org/child", catalog_payload("org/child", "org/base-b"))
    tr = db.scalar(select(Transformation).where(Transformation.output == "org/child"))
    assert [(i["model"], i["role"]) for i in tr.input] == [("org/base-b", "base"), ("GPT-4o", "verifier")]
    assert provenance(db, "org/child").parent == ["model:org/base-b"]


def test_save_model_aibom_round_trip_and_dataset_roles() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base"))
    create_admin_model(db, catalog_payload("org/child", "org/base"))

    result = save_model_aibom(db, "org/child", AibomWrite.model_validate({
        "model": {"architecture": {"family": "decoder-only"}, "intended_use": "chat"},
        "provenance": {"origin": "Sample", "provider": "Org", "relation": "fine_tuned_from",
                       "evidence": ["https://example.test/card"]},
        "transformation": {"input": [{"model": "org/base", "role": "base"}], "method": ["SFT", "DPO"],
                           "datasets": [{"dataset": "org/sft-data", "role": "finetuning"}]},
        "evaluation": [{"dataset": "cais/mmlu", "configuration": {"benchmark": "MMLU"}, "metric": "acc", "score": 61.5}],
        "safety_ethics": {"safety_risk": [{"description": "May hallucinate."}]},
        "license_policy": [{"license": "Apache-2.0", "restrictions": []}],
        "dataset": [{"identity": "org/sft-data"}, {"identity": "cais/mmlu"}],
    }))

    assert result["model"]["intended_use"] == "chat"
    assert result["provenance"]["parent"] == ["model:org/base"]
    assert [r["uri"] for r in result["reference"]] == ["https://example.test/card"]
    assert result["evaluation"][0]["score"] == 61.5
    assert {d["identity"]: d["role"] for d in result["dataset"]} == {
        "org/sft-data": ["finetuning"], "cais/mmlu": ["evaluation"]}
    assert result["safety_ethics"]["safety_risk"][0]["description"] == "May hallucinate."


def test_save_model_aibom_rejects_unknown_dataset() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base"))
    with pytest.raises(HTTPException) as error:
        save_model_aibom(db, "org/base", AibomWrite.model_validate({
            "evaluation": [{"dataset": "missing/data", "metric": "acc", "score": 1}]}))
    assert error.value.status_code == 422


def test_delete_blocks_models_used_as_inputs_and_cleans_subject_rows() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/teacher"))
    create_admin_model(db, catalog_payload("org/student"))
    save_model_aibom(db, "org/student", AibomWrite.model_validate({
        "transformation": {"input": [{"model": "org/teacher", "role": "teacher"}], "method": ["distillation"]}}))

    with pytest.raises(HTTPException) as error:
        delete_admin_model(db, "org/teacher")
    assert error.value.status_code == 409

    delete_admin_model(db, "org/student")
    assert provenance(db, "org/student") is None
    assert db.scalar(select(LicensePolicy).where(LicensePolicy.subject == "model:org/student")) is None
    assert load_model_aibom(db, "org/student") is None
    delete_admin_model(db, "org/teacher")


def test_dataset_role_is_cleared_when_last_user_is_removed() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base"))
    save_model_aibom(db, "org/base", AibomWrite.model_validate({
        "evaluation": [{"dataset": "cais/mmlu", "metric": "acc", "score": 50}],
        "dataset": [{"identity": "cais/mmlu"}]}))
    assert db.get(Dataset, "cais/mmlu").role == "evaluation"

    save_model_aibom(db, "org/base", AibomWrite.model_validate({}))
    assert db.get(Dataset, "cais/mmlu").role is None


def test_catalog_create_does_not_copy_pipeline_tag_into_intended_use() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base", primaryPurpose="text-generation"))
    assert load_model_aibom(db, "org/base")["model"]["intended_use"] is None


def test_save_model_aibom_writes_dataset_provenance_and_resolves_model_evidence_uris() -> None:
    db = session()
    create_admin_model(db, catalog_payload("org/base"))
    result = save_model_aibom(db, "org/base", AibomWrite.model_validate({
        "model": {"extensions": {"evidence": ["https://example.test/config.json"]}},
        "transformation": {"method": ["SFT"], "datasets": [{"dataset": "org/derived", "role": "finetuning"}]},
        "dataset": [
            {"identity": "org/source"},
            {"identity": "org/derived", "provenance": {"provider": "Org", "parent": ["org/source"],
                                                       "relation": "filtered_from", "evidence": ["https://example.test/ds"]}},
        ],
    }))

    derived = next(d for d in result["dataset"] if d["identity"] == "org/derived")
    assert derived["provenance"]["parent"] == ["dataset:org/source"]
    assert derived["provenance"]["relation"] == "filtered_from"
    assert isinstance(result["model"]["extensions"]["evidence"][0], int)
    assert "https://example.test/config.json" in [r["uri"] for r in result["reference"]]

    with pytest.raises(HTTPException) as error:
        save_model_aibom(db, "org/base", AibomWrite.model_validate({
            "dataset": [{"identity": "org/x", "provenance": {"parent": ["org/missing"]}}]}))
    assert error.value.status_code == 422


def test_admin_aibom_route_is_not_swallowed_by_model_path(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_model_row", lambda _db, _model_id: object())
    monkeypatch.setattr(main, "load_model_aibom", lambda _db, model_id: {"model": {"identity": model_id}})
    main.app.dependency_overrides[get_db] = lambda: object()
    try:
        response = TestClient(main.app).get("/api/v1/admin/models/org/name/aibom")
    finally:
        main.app.dependency_overrides.clear()
    assert response.status_code == 200
    assert response.json() == {"model": {"identity": "org/name"}}
