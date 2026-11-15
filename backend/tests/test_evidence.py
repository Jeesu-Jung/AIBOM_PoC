import json

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import main
from app.admin import AdminModelWrite, create_admin_model, delete_admin_model
from app.database import get_db
from app.evidence import ModelEvidenceWrite, build_result_evidence, load_model_evidence, replace_model_evidence
from app.models import Base, ModelEvidence
from app.research import parse_merge_response, parse_openrouter_response

from test_research import _grandchild_content, _lineage_context, research_content


def session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def model(model_id: str = "org/model") -> AdminModelWrite:
    return AdminModelWrite.model_validate({
        "modelId": model_id, "namespace": "org", "modelName": "model", "familyKey": "sample",
        "familyName": "Sample", "modelRole": "BASE", "modelUrl": "https://example.test/model", "detailsJson": {},
    })


def rows(result: dict, area: str) -> list[dict]:
    return [row for row in result["evidence"] if row["area"] == area]


def test_research_result_lists_evidence_per_value() -> None:
    result = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(research_content())}}]})

    catalog = rows(result, "catalog")
    assert {(row["field"], row["url"], row["confidence"]) for row in catalog} == {
        ("modelId", "https://example.test/model", "high"), ("supplier", "https://example.test/model", "high")}
    assert all(row["source"] == "huggingface" for row in result["evidence"])

    model_fields = {row["field"]: row for row in rows(result, "model")}
    assert model_fields["architecture.parameter_count"]["url"] == "https://example.test/model/config.json"
    assert model_fields["*"]["url"] == "https://example.test/model"  # area-level evidence_urls
    transformation = {row["field"]: row for row in rows(result, "transformation")}
    assert "input" in transformation and "inputs" not in transformation  # table spelling
    assert transformation["method"]["note"] == "논문 3장"

    assert [(row["itemKey"], row["url"]) for row in rows(result, "dataset")] == [
        ("org/sft-data", "https://huggingface.co/datasets/org/sft-data")]
    assert [(row["itemKey"], row["field"], row["locator"]) for row in rows(result, "evaluation")] == [
        ("MMLU | acc | 5-shot", "score", "Table 2 (Main results)")]
    assert result["aibom"]["evaluation"][0]["extensions"]["reference_locator"] == "Table 2 (Main results)"
    assert [(row["itemKey"], row["field"]) for row in rows(result, "safety_ethics")] == [
        ("May hallucinate.", "safety_risk")]
    assert [row["itemKey"] for row in rows(result, "license_policy")] == ["Apache License 2.0"]


def test_inherited_family_fields_carry_no_research_evidence() -> None:
    content = _grandchild_content()
    content["fieldEvidence"] = [{"fields": ["familyKey", "familyName", "supplier"], "confidence": "high",
                                 "urls": ["https://example.test/huatuo"], "note": None}]
    result = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(content)}}]},
                                       context=_lineage_context())

    assert set(result["catalogLineage"]["inheritedFields"]) >= {"familyKey", "familyName", "familyDeveloper"}
    assert {row["field"] for row in rows(result, "catalog")} == {"supplier"}


def test_merged_result_takes_catalog_evidence_from_the_chosen_input() -> None:
    def research(source: str, url: str) -> dict:
        content = research_content()
        content["fieldEvidence"] = [{"fields": ["supplier", "familyDeveloper"], "confidence": "high",
                                     "urls": [url], "note": None}]
        return parse_openrouter_response({"choices": [{"message": {"content": json.dumps(content)}}]}, source=source)

    inputs = {"huggingface": research("huggingface", "https://example.test/hf"),
              "paper": research("paper", "https://example.test/paper")}
    merged = research_content()
    merge_content = {
        "status": "found", "draft": merged["draft"], "parentCandidates": [], "aibom": merged["aibom"],
        "fieldDecisions": [{"field": "supplier", "chosen": "huggingface", "rationale": "저장소 기준"},
                           {"field": "familyDeveloper", "chosen": "combined", "rationale": "일치"},
                           {"field": "description", "chosen": "none", "rationale": "없음"}],
        "areaDecisions": [], "warnings": [],
    }
    result = parse_merge_response({"choices": [{"message": {"content": json.dumps(merge_content)}}]}, inputs)

    assert {(row["field"], row["source"], row["url"]) for row in rows(result, "catalog")} == {
        ("supplier", "huggingface", "https://example.test/hf"),
        ("familyDeveloper", "huggingface", "https://example.test/hf"),
        ("familyDeveloper", "paper", "https://example.test/paper")}
    assert all(row["source"] == "merged" for row in rows(result, "model"))


def test_evidence_is_stored_per_model_and_removed_with_it() -> None:
    db = session()
    create_admin_model(db, model())
    payload = ModelEvidenceWrite.model_validate({"runId": 999, "items": [
        {"area": "dataset", "itemKey": "cais/mmlu", "field": "*", "url": "https://example.test/a", "source": "paper"},
        {"area": "dataset", "itemKey": "cais/mmlu", "field": "*", "url": "https://example.test/a"},  # duplicate
        {"area": "catalog", "field": "supplier", "url": "https://example.test/b", "confidence": "high"},
    ]})

    stored = replace_model_evidence(db, "org/model", payload)
    assert [(row["area"], row["itemKey"], row["url"], row["runId"]) for row in stored] == [
        ("dataset", "cais/mmlu", "https://example.test/a", None),  # unknown run id is not kept
        ("catalog", "", "https://example.test/b", None)]

    replace_model_evidence(db, "org/model", ModelEvidenceWrite(items=payload.items[2:]))
    assert [row["field"] for row in load_model_evidence(db, "org/model")] == ["supplier"]

    delete_admin_model(db, "org/model")
    assert db.scalars(select(ModelEvidence)).all() == []


def test_evidence_endpoints_round_trip() -> None:
    db = session()
    create_admin_model(db, model())
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(main.app)
        body = {"items": [{"area": "model", "field": "architecture.layers", "url": "https://example.test/config",
                           "confidence": "high", "source": "huggingface", "locator": "config.json"}]}
        assert client.put("/api/v1/admin/models/org/model/evidence", json=body).status_code == 200
        listed = client.get("/api/v1/admin/models/org/model/evidence").json()
        assert [(row["area"], row["field"], row["url"], row["locator"]) for row in listed] == [
            ("model", "architecture.layers", "https://example.test/config", "config.json")]
        assert client.get("/api/v1/admin/models/org/missing/evidence").status_code == 404
        assert client.put("/api/v1/admin/models/org/model/evidence",
                          json={"items": [{"area": "nope", "url": "https://example.test"}]}).status_code == 422
    finally:
        main.app.dependency_overrides.clear()


def test_build_result_evidence_tolerates_results_stored_before_field_evidence() -> None:
    assert build_result_evidence({"source": "paper", "draft": {}, "aibomDraft": {"model": {"evidence_urls": ["x"]}}}) == []
