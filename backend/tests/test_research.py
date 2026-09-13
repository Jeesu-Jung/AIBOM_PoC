import json
from dataclasses import replace
from datetime import date

import pytest

from fastapi.testclient import TestClient

from app import main, research
from app.research import (
    CatalogContext,
    CatalogFamily,
    MergeResearchRequest,
    _public_chunk,
    build_merge_payload,
    build_openrouter_payload,
    compact_merge_inputs,
    parse_merge_response,
    parse_openrouter_response,
)


def research_content() -> dict:
    return {
        "status": "found",
        "draft": {
            "modelId": "org/model",
            "namespace": "org",
            "modelName": "model",
            "familyKey": "model-family",
            "familyName": "Model Family",
            "modelRole": "BASE",
            "supplier": "Example Org",
            "familyDeveloper": "Example Org",
            "familyReleaseDate": "2026-01-02",
            "familyLicenseName": "Apache-2.0",
            "primaryPurpose": "Text generation",
            "modelVersion": "1.0",
            "packageUrl": None,
            "modelUrl": "https://example.test/model",
            "licenseReported": ["Apache-2.0"],
            "artifactFormat": "safetensors",
            "tensorType": "BF16",
            "parameterScale": "7B",
            "artifactRevision": None,
            "description": "Example model",
        },
        "parentCandidates": [],
        "fieldEvidence": [{
            "fields": ["modelId", "supplier"],
            "confidence": "high",
            "urls": ["https://example.test/model"],
            "note": None,
        }],
        "warnings": [],
    }


def test_openrouter_payload_prioritizes_deep_bounded_search() -> None:
    payload = build_openrouter_payload("org/model", as_of=date(2026, 9, 12))

    assert payload["model"] == "anthropic/claude-opus-5"
    assert payload["tools"][0]["type"] == "openrouter:web_search"
    assert payload["tools"][0]["parameters"]["mode"] == "deep"
    assert payload["tools"][0]["parameters"]["max_uses"] == 4
    assert payload["response_format"]["type"] == "json_schema"
    assert payload["response_format"]["json_schema"]["strict"] is True
    assert "2026-09-12" in payload["messages"][1]["content"]


def test_openrouter_payload_defaults_to_huggingface_strategy() -> None:
    payload = build_openrouter_payload("org/model")

    assert "Research strategy: HUGGING FACE REPOSITORY." in payload["messages"][0]["content"]
    assert "TECHNICAL PAPER" not in payload["messages"][0]["content"]
    assert "from the repository and its model card" in payload["messages"][1]["content"]


def test_openrouter_payload_switches_to_paper_strategy() -> None:
    payload = build_openrouter_payload("org/model", source="paper")

    system_prompt = payload["messages"][0]["content"]
    assert "Research strategy: TECHNICAL PAPER." in system_prompt
    assert "HUGGING FACE REPOSITORY" not in system_prompt
    assert "arXiv" in system_prompt
    assert "official paper or technical report" in payload["messages"][1]["content"]
    assert payload["response_format"]["json_schema"]["schema"] == build_openrouter_payload("org/model")["response_format"]["json_schema"]["schema"]


def test_openrouter_payload_rejects_unknown_source() -> None:
    with pytest.raises(ValueError):
        build_openrouter_payload("org/model", source="wikipedia")  # type: ignore[arg-type]


def test_research_request_validates_source() -> None:
    from pydantic import ValidationError

    from app.research import ModelResearchRequest

    assert ModelResearchRequest.model_validate({"modelName": "org/model"}).source == "huggingface"
    assert ModelResearchRequest.model_validate({"modelName": "org/model", "source": "paper"}).source == "paper"
    with pytest.raises(ValidationError):
        ModelResearchRequest.model_validate({"modelName": "org/model", "source": "blog"})


def test_openrouter_schema_carries_field_glossary_without_bom_fields() -> None:
    schema = build_openrouter_payload("org/model")["response_format"]["json_schema"]["schema"]
    draft = schema["$defs"]["ResearchDraft"]["properties"]

    assert "status" in schema["properties"]
    assert "bomFormat" not in draft
    assert "llama31" in draft["familyKey"]["description"]
    assert "pkg:huggingface" in draft["packageUrl"]["description"]
    assert all("description" in spec for spec in draft.values())


def test_openrouter_prompt_injects_catalog_context() -> None:
    context = CatalogContext(
        families=(CatalogFamily(key="llama31", name="Llama 3.1", developer="Meta"),),
        relationship_types=("customTunedFrom",),
        model_ids=("meta-llama/Llama-3.1-8B",),
    )

    prompt = build_openrouter_payload("org/model", context=context)["messages"][1]["content"]

    assert "- llama31 | Llama 3.1 | Meta" in prompt
    assert "customTunedFrom, instructionTunedFrom" in prompt
    assert "- meta-llama/Llama-3.1-8B" in prompt
    assert prompt.index("<requested_model>") < prompt.index("Catalog context")


def test_openrouter_prompt_without_context_says_catalog_is_empty() -> None:
    prompt = build_openrouter_payload("org/model")["messages"][1]["content"]

    assert "Existing families: none recorded yet." in prompt
    assert "convertedFrom" in prompt


def test_openrouter_response_becomes_reviewable_admin_draft() -> None:
    upstream = {
        "model": "anthropic/claude-opus-5",
        "choices": [{"message": {
            "content": json.dumps(research_content()),
            "annotations": [{
                "type": "url_citation",
                "url_citation": {
                    "url": "https://example.test/model",
                    "title": "Official model card",
                    "content": "Model details",
                },
            }],
        }}],
        "usage": {"server_tool_use": {"web_search_requests": 2}},
    }

    result = parse_openrouter_response(upstream)

    assert result["status"] == "found"
    assert result["source"] == "huggingface"
    assert result["research"]["source"] == "huggingface"
    assert result["draft"]["detailsJson"]["ai_research"]["source"] == "huggingface"
    assert result["draft"]["modelId"] == "org/model"
    assert result["draft"]["bomFormat"] is None
    assert result["draft"]["detailsJson"]["ai_research"]["reviewed"] is False
    assert result["draft"]["detailsJson"]["ai_research"]["status"] == "found"
    assert result["warnings"] == []
    assert result["draft"]["parentModelId"] is None
    assert result["sources"][0]["title"] == "Official model card"
    assert result["research"]["webSearchRequests"] == 2


def test_openrouter_response_accepts_block_content_and_json_fence() -> None:
    upstream = {
        "choices": [{"message": {
            "content": [{"type": "text", "text": f"```json\n{json.dumps(research_content())}\n```"}],
        }}],
    }

    result = parse_openrouter_response(upstream)

    assert result["draft"]["modelId"] == "org/model"


def test_not_found_status_adds_reviewer_warning_and_context_warnings() -> None:
    content = research_content()
    content["status"] = "not_found"
    content["warnings"] = ["모델 페이지를 찾지 못했습니다."]
    upstream = {"choices": [{"message": {"content": json.dumps(content)}}]}
    context = CatalogContext(warnings=("DB 컨텍스트 없음",))

    result = parse_openrouter_response(upstream, context=context)

    assert result["status"] == "not_found"
    assert result["warnings"][0].startswith("신뢰할 수 있는 출처에서")
    assert result["warnings"][1] == "DB 컨텍스트 없음"
    assert "모델 페이지를 찾지 못했습니다." in result["warnings"]
    assert result["warnings"][-1] == "OpenRouter 응답에 URL 인용 정보가 없습니다."


def test_public_stream_chunk_removes_private_reasoning() -> None:
    public = _public_chunk({
        "choices": [{"delta": {"content": "ok", "reasoning": "private"}}],
        "reasoning_details": [{"text": "private"}],
    })

    assert public == {"choices": [{"delta": {"content": "ok"}}]}


def test_load_catalog_context_collects_families_relationships_and_ids() -> None:
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import StaticPool

    from app.admin import AdminModelWrite, create_admin_model
    from app.models import Base
    from app.research import load_catalog_context

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    base = {"familyKey": "llama31", "familyName": "Llama 3.1", "familyDeveloper": "Meta", "detailsJson": {}}
    create_admin_model(db, AdminModelWrite.model_validate({
        "modelId": "meta-llama/Llama-3.1-8B", "namespace": "meta-llama", "modelName": "Llama-3.1-8B",
        "modelRole": "BASE", "modelUrl": "https://example.test/base", **base,
    }))
    create_admin_model(db, AdminModelWrite.model_validate({
        "modelId": "org/child", "namespace": "org", "modelName": "child", "modelRole": "DERIVED",
        "modelUrl": "https://example.test/child", "parentModelId": "meta-llama/Llama-3.1-8B",
        "relationshipType": "adapterTrainedFrom", **base,
    }))

    context = load_catalog_context(db)

    assert context.families == (CatalogFamily(key="llama31", name="Llama 3.1", developer="Meta"),)
    assert context.relationship_types == ("adapterTrainedFrom",)
    assert context.model_ids == ("meta-llama/Llama-3.1-8B", "org/child")
    assert context.relationship_vocabulary[0] == "adapterTrainedFrom"
    assert context.relationship_vocabulary.count("adapterTrainedFrom") == 1


def test_stream_endpoint_reports_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key=""))
    monkeypatch.setattr(main, "_load_research_context", lambda: CatalogContext())
    response = TestClient(main.app).post(
        "/api/v1/admin/model-research/stream",
        json={"modelName": "org/model"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: error" in response.text
    assert "OPENROUTER_API_KEY is not configured." in response.text


def research_result(source: str, **draft_overrides) -> dict:
    content = research_content()
    content["draft"].update(draft_overrides)
    upstream = {
        "model": "anthropic/claude-opus-5",
        "choices": [{"message": {
            "content": json.dumps(content),
            "annotations": [{"type": "url_citation", "url_citation": {"url": f"https://example.test/{source}", "title": source}}],
        }}],
        "usage": {"server_tool_use": {"web_search_requests": 1}},
    }
    return parse_openrouter_response(upstream, source=source)


def merge_content() -> dict:
    draft = research_content()["draft"]
    draft["familyDeveloper"] = "Example Org (paper)"
    fields = list(draft.keys())
    return {
        "status": "found",
        "draft": draft,
        "fieldDecisions": [
            {"field": field, "chosen": "paper" if field == "familyDeveloper" else "huggingface", "rationale": "근거가 더 명확합니다."}
            for field in fields
        ],
        "parentCandidates": [],
        "warnings": ["familyDeveloper 값이 두 조사에서 달랐습니다."],
    }


def test_merge_request_requires_at_least_one_result() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MergeResearchRequest.model_validate({"modelName": "org/model", "results": {"huggingface": None, "paper": None}})
    request = MergeResearchRequest.model_validate({"modelName": "org/model", "results": {"huggingface": research_result("huggingface")}})
    assert request.results.get("paper") is None


def test_merge_payload_compacts_inputs_and_disables_web_search() -> None:
    results = {"huggingface": research_result("huggingface"), "paper": research_result("paper", familyDeveloper="Example Org (paper)")}
    inputs = compact_merge_inputs(results)

    assert inputs["huggingface"]["draft"]["familyDeveloper"] == "Example Org"
    assert "detailsJson" not in inputs["huggingface"]["draft"]
    assert inputs["paper"]["sources"] == [{"title": "paper", "url": "https://example.test/paper"}]

    payload = build_merge_payload("org/model", inputs, as_of=date(2026, 9, 13))

    assert "tools" not in payload
    assert payload["response_format"]["json_schema"]["name"] == "aibom_model_merge"
    assert "<research_inputs>" in payload["messages"][1]["content"]
    assert "Example Org (paper)" in payload["messages"][1]["content"]
    assert "fieldDecisions" in payload["response_format"]["json_schema"]["schema"]["properties"]


def test_merge_response_becomes_admin_draft_with_decisions() -> None:
    results = {"huggingface": research_result("huggingface"), "paper": research_result("paper")}
    upstream = {"model": "anthropic/claude-opus-5", "choices": [{"message": {"content": json.dumps(merge_content())}}]}

    result = parse_merge_response(upstream, results, context=CatalogContext())

    assert result["source"] == "merged"
    assert result["draft"]["familyDeveloper"] == "Example Org (paper)"
    assert result["draft"]["bomFormat"] is None
    assert result["draft"]["detailsJson"]["ai_research"]["merged"] is True
    assert result["draft"]["detailsJson"]["ai_research"]["fieldDecisions"]["familyDeveloper"] == "paper"
    assert result["draft"]["detailsJson"]["ai_research"]["runs"]["paper"]["webSearchRequests"] == 1
    assert [item["source"] for item in result["sources"]] == ["huggingface", "paper"]
    assert result["warnings"] == ["familyDeveloper 값이 두 조사에서 달랐습니다."]
    assert len(result["fieldDecisions"]) == len(merge_content()["fieldDecisions"])


def test_merge_stream_endpoint_reports_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key=""))
    monkeypatch.setattr(main, "_load_research_context", lambda: CatalogContext())
    response = TestClient(main.app).post(
        "/api/v1/admin/model-research/merge/stream",
        json={"modelName": "org/model", "results": {"huggingface": research_result("huggingface"), "paper": None}},
    )

    assert response.status_code == 200
    assert "OPENROUTER_API_KEY is not configured." in response.text
