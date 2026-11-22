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


def aibom_content() -> dict:
    return {
        "model": {
            "architecture": {"family": "decoder-only Transformer", "parameter_count": 7000000000,
                             "context_length": 32768, "layers": 28, "hidden_size": None, "attention_heads": None,
                             "kv_heads": None, "activation": None, "position_embedding": "RoPE"},
            "tokenizer": {"name": "BPE", "vocab_size": 151000},
            "modality": {"input": ["text"], "output": ["text"], "languages": ["en"]},
            "artifact": {"format": "safetensors", "tensor_type": "BF16"},
            "intended_use": "General-purpose chat assistant.",
            "capabilities": ["chat"],
            "limitations": ["may hallucinate"],
            "knowledge_cutoff": None,
            "release_date": "2026-01-02",
            "evidence_urls": ["https://example.test/model"],
        },
        "provenance": {"origin": "Model Family", "provider": "Example Org", "relation": "instruction_tuned_from",
                       "disclosure_status": "partially_disclosed", "notes": None,
                       "evidence_urls": ["https://example.test/model"]},
        "transformation": {
            "inputs": [{"model": "org/model-base", "role": "base"}, {"model": "GPT-4o", "role": "verifier"}],
            "method": ["SFT", "DPO"], "objective": "Instruction following.",
            "hyperparameters": [{"name": "learning_rate", "value": "1e-5"}],
            "datasets": [{"dataset": "org/sft-data", "role": "finetuning"},
                         {"dataset": "missing/data", "role": "other"}],
            "timestamp": None, "notes": None, "evidence_urls": ["https://arxiv.org/abs/2601.00001"],
        },
        "datasets": [
            {"identity": "org/sft-data", "name": "SFT data", "version": None, "license": "MIT", "provider": "Example Org",
             "description": "Chat pairs.", "size": "10K", "uri": None, "disclosure_status": "disclosed",
             "processing": ["dedup"], "parents": [{"dataset": "cais/mmlu", "relation": "derived_from"}],
             "evidence_urls": ["https://huggingface.co/datasets/org/sft-data"]},
            {"identity": "cais/mmlu", "name": "MMLU", "version": None, "license": "MIT", "provider": None,
             "description": None, "size": None, "uri": None, "disclosure_status": "disclosed", "processing": [],
             "parents": [], "evidence_urls": []},
        ],
        "evaluations": [{"benchmark": "MMLU", "dataset": "cais/mmlu", "metric": "acc", "score": 70.5,
                         "score_text": None, "shots": 5, "configuration_notes": None, "baseline_model": "org/model-base",
                         "baseline_score": 65.0, "evaluator_model": None,
                         "source_url": "https://example.test/model", "source_locator": "Table 2 (Main results)",
                         "reported_at": "2026-01-02"}],
        "safety_ethics": {"risk_summary": None,
                          "safety_risk": [{"description": "May hallucinate.", "source_url": "https://example.test/model"}],
                          "ethical_considerations": [], "prohibited_use": [], "mitigation": []},
        "license_policy": [{"license": "Apache License 2.0", "spdx_id": "Apache-2.0", "license_uri": None,
                            "usage_policy": None, "usage_policy_uri": None, "commercial_use": "allowed",
                            "restrictions": [], "kind": "declared", "scope_note": None,
                            "source_url": "https://example.test/model"}],
        "references": [{"type": "model_card", "uri": "https://example.test/model", "title": "Card", "revision": "abc123"}],
        "unknowns": ["exact training data mixture"],
        "field_evidence": [{"area": "model", "fields": ["architecture.parameter_count", "tokenizer.vocab_size"],
                            "confidence": "high", "urls": ["https://example.test/model/config.json"], "note": None},
                           {"area": "transformation", "fields": ["inputs", "method"], "confidence": "medium",
                            "urls": ["https://arxiv.org/abs/2601.00001"], "note": "논문 3장"}],
    }


def research_content() -> dict:
    return {
        "status": "found",
        "draft": {
            "modelId": "org/model",
            "namespace": "org",
            "modelName": "model",
            "familyKey": "model-family",
            "familyName": "Model Family",
            "modelRole": "DERIVED",  # the AIBOM below names `org/model-base` as its base
            "supplier": "Example Org",
            "primaryPurpose": "Text generation",
            "modelVersion": "1.0",
            "packageUrl": None,
            "modelUrl": "https://example.test/model",
            "description": "Example model",
        },
        "parentCandidates": [],
        "fieldEvidence": [{
            "fields": ["modelId", "supplier"],
            "confidence": "high",
            "urls": ["https://example.test/model"],
            "note": None,
        }],
        "aibom": aibom_content(),
        "warnings": [],
    }


def test_openrouter_payload_prioritizes_deep_bounded_search() -> None:
    payload = build_openrouter_payload("org/model", as_of=date(2026, 9, 12))

    assert payload["model"] == "anthropic/claude-opus-5"
    assert payload["tools"][0]["type"] == "openrouter:web_search"
    assert payload["tools"][0]["parameters"]["mode"] == "deep"
    assert payload["tools"][0]["parameters"]["max_uses"] == 12
    assert payload["max_tool_calls"] >= payload["tools"][0]["parameters"]["max_uses"]
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
    assert "such as a Hugging Face model README" in system_prompt
    assert "Hugging Face model README" not in build_openrouter_payload("org/model")["messages"][0]["content"]
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
        families=(CatalogFamily(key="llama31", name="Llama 3.1"),),
        relationship_types=("customTunedFrom",),
        model_ids=("meta-llama/Llama-3.1-8B",),
    )

    prompt = build_openrouter_payload("org/model", context=context)["messages"][1]["content"]

    assert "- llama31 | Llama 3.1" in prompt
    assert "customTunedFrom, instructionTunedFrom" in prompt
    assert "- meta-llama/Llama-3.1-8B" in prompt
    assert "instruction_tuned_from" in prompt
    assert prompt.index("<requested_model>") < prompt.index("Catalog context")


def test_openrouter_prompt_without_context_says_catalog_is_empty() -> None:
    prompt = build_openrouter_payload("org/model")["messages"][1]["content"]

    assert "Existing families: none recorded yet." in prompt
    assert "convertedFrom" in prompt
    assert "Existing AIBOM dataset identities: none recorded yet." in prompt


def test_prompt_separates_catalog_roots_from_aibom_lineage() -> None:
    payload = build_openrouter_payload("org/model", context=CatalogContext(datasets=(("cais/mmlu", "MMLU"),)))
    system_prompt = payload["messages"][0]["content"]

    assert "an official instruction/chat model built on a released pretrained checkpoint\n     is DERIVED" in system_prompt
    assert "`cardData.base_model`" in system_prompt
    assert "A model with a parent candidate is always DERIVED." in (
        payload["response_format"]["json_schema"]["schema"]["$defs"]["ResearchDraft"]["properties"]["modelRole"]["description"])
    assert "Do not copy leaderboard numbers or claims that are not needed" not in system_prompt
    assert "- cais/mmlu | MMLU" in payload["messages"][1]["content"]
    assert "aibom" in payload["response_format"]["json_schema"]["schema"]["properties"]


def test_response_schemas_are_valid_for_strict_structured_outputs() -> None:
    """OpenAI strict mode rejects `$ref` with sibling keywords and optional / open objects."""
    problems: list[str] = []

    def walk(node, path: str) -> None:
        if isinstance(node, dict):
            if "$ref" in node and len(node) > 1:
                problems.append(f"{path}: $ref with {sorted(node)}")
            if node.get("type") == "object" and "properties" in node:
                if set(node.get("required", [])) != set(node["properties"]):
                    problems.append(f"{path}: not every property is required")
                if node.get("additionalProperties") is not False:
                    problems.append(f"{path}: additionalProperties is not false")
            for key, value in node.items():
                walk(value, f"{path}/{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(build_openrouter_payload("org/model")["response_format"]["json_schema"]["schema"], "research")
    walk(build_merge_payload("org/model", {})["response_format"]["json_schema"]["schema"], "merge")
    assert problems == []


def test_catalog_draft_takes_scale_license_and_artifact_from_the_aibom() -> None:
    from app.aibom_research import parameter_scale

    schema = build_openrouter_payload("org/model")["response_format"]["json_schema"]["schema"]
    researched = set(schema["$defs"]["ResearchDraft"]["properties"])
    assert not researched & {"licenseReported", "parameterScale", "artifactFormat", "tensorType", "artifactRevision"}

    result = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(research_content())}}]})
    draft = result["draft"]
    assert draft["parameterScale"] == "7B"
    assert draft["licenseReported"] == ["apache-2.0"]
    assert (draft["artifactFormat"], draft["tensorType"]) == ("safetensors", "BF16")
    assert result["aibom"]["model"]["extensions"]["artifact"] == {"format": "safetensors", "tensor_type": "BF16"}
    assert parameter_scale(8030261248) == "8.03B"
    assert parameter_scale(None) is None


def test_research_aibom_becomes_admin_aibom_payload() -> None:
    from app.aibom import AibomWrite

    upstream = {"choices": [{"message": {"content": json.dumps(research_content())}}]}
    result = parse_openrouter_response(upstream)
    aibom = result["aibom"]

    AibomWrite.model_validate(aibom)
    assert aibom["model"]["architecture"]["parameter_count"] == 7000000000
    assert "hidden_size" not in aibom["model"]["architecture"]
    assert aibom["model"]["extensions"]["evidence"][0] == "https://example.test/model"
    assert set(aibom["model"]["extensions"]["evidence"]) == {r["uri"] for r in aibom["reference"]}
    assert aibom["provenance"]["relation"] == "instruction_tuned_from"
    assert [i["model"] for i in aibom["transformation"]["input"]] == ["org/model-base", "GPT-4o"]
    assert aibom["transformation"]["hyperparameters"] == {"learning_rate": "1e-5"}
    # datasets that the draft references but does not describe are dropped
    assert aibom["transformation"]["datasets"] == [{"dataset": "org/sft-data", "role": "finetuning"}]
    sft = next(d for d in aibom["dataset"] if d["identity"] == "org/sft-data")
    assert sft["provenance"]["parent"] == ["cais/mmlu"]
    assert aibom["evaluation"][0]["configuration"] == {"benchmark": "MMLU", "shots": 5}
    assert aibom["evaluation"][0]["extensions"]["baseline_score"] == 65.0
    assert aibom["license_policy"][0]["extensions"]["spdx_id"] == "Apache-2.0"
    uris = {r["uri"]: r["type"] for r in aibom["reference"]}
    assert uris["https://arxiv.org/abs/2601.00001"] == "paper"
    assert uris["https://huggingface.co/datasets/org/sft-data"] == "dataset_card"
    assert result["aibomSummary"]["evaluations"] == 1
    assert result["aibomDraft"]["transformation"]["method"] == ["SFT", "DPO"]


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
    assert result["warnings"][-1].startswith("OpenRouter 응답에 URL 인용 정보가 없어")
    # without citations, the AIBOM references stand in as sources
    assert result["sources"][0] == {"title": "Card", "url": "https://example.test/model", "excerpt": None,
                                    "origin": "aibom_reference"}


def test_web_search_count_reads_streaming_usage_key() -> None:
    from app.research import web_search_count

    assert web_search_count({"server_tool_use": {"web_search_requests": 2}}) == 2
    assert web_search_count({"server_tool_use_details": {"web_search_requests": 13}}) == 13
    assert web_search_count(None) is None


def test_duplicate_evaluations_from_two_sources_are_merged() -> None:
    from app.aibom_research import aibom_write_from_draft

    draft = aibom_content()
    first = draft["evaluations"][0]
    draft["datasets"].append({**draft["datasets"][1], "identity": "slug:mmlu"})
    first = {**first, "dataset": "slug:mmlu", "metric": "accuracy_percent"}
    draft["evaluations"] = [first, {**first, "benchmark": "mmlu ", "metric": "accuracy (%)", "dataset": "cais/mmlu",
                                    "source_url": "https://arxiv.org/abs/2601.00001"},
                            {**first, "score": 71.0}]
    rows = aibom_write_from_draft(draft)["evaluation"]
    assert [row["score"] for row in rows] == [70.5, 71.0]
    assert rows[0]["dataset"] == "cais/mmlu"  # the real dataset id wins over the slug
    assert rows[0]["extensions"]["also_reported_in"] == ["https://arxiv.org/abs/2601.00001"]


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
    base = {"familyKey": "llama31", "familyName": "Llama 3.1", "detailsJson": {}}
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

    assert context.families == (CatalogFamily(key="llama31", name="Llama 3.1"),)
    assert context.relationship_types == ("adapterTrainedFrom",)
    assert context.model_ids == ("meta-llama/Llama-3.1-8B", "org/child")
    assert context.relationship_vocabulary[0] == "adapterTrainedFrom"
    assert context.relationship_vocabulary.count("adapterTrainedFrom") == 1
    assert context.datasets == ()


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
    draft["supplier"] = "Example Org (paper)"
    fields = list(draft.keys())
    return {
        "status": "found",
        "draft": draft,
        "fieldDecisions": [
            {"field": field, "chosen": "paper" if field == "supplier" else "huggingface", "rationale": "근거가 더 명확합니다."}
            for field in fields
        ],
        "parentCandidates": [],
        "aibom": aibom_content(),
        "areaDecisions": [{"area": "evaluations", "chosen": "combined", "rationale": "두 결과를 합쳤습니다."}],
        "warnings": ["supplier 값이 두 조사에서 달랐습니다."],
    }


def test_merge_request_requires_at_least_one_result() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        MergeResearchRequest.model_validate({"modelName": "org/model", "results": {"huggingface": None, "paper": None}})
    request = MergeResearchRequest.model_validate({"modelName": "org/model", "results": {"huggingface": research_result("huggingface")}})
    assert request.results.get("paper") is None


def test_merge_payload_compacts_inputs_and_disables_web_search() -> None:
    results = {"huggingface": research_result("huggingface"), "paper": research_result("paper", supplier="Example Org (paper)")}
    inputs = compact_merge_inputs(results)

    assert inputs["huggingface"]["draft"]["supplier"] == "Example Org"
    assert "detailsJson" not in inputs["huggingface"]["draft"]
    assert inputs["paper"]["sources"] == [{"title": "paper", "url": "https://example.test/paper"}]
    assert inputs["huggingface"]["aibom"]["transformation"]["method"] == ["SFT", "DPO"]

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
    assert result["draft"]["supplier"] == "Example Org (paper)"
    assert result["draft"]["bomFormat"] is None
    assert result["draft"]["detailsJson"]["ai_research"]["merged"] is True
    assert result["draft"]["detailsJson"]["ai_research"]["fieldDecisions"]["supplier"] == "paper"
    assert result["draft"]["detailsJson"]["ai_research"]["runs"]["paper"]["webSearchRequests"] == 1
    assert [item["source"] for item in result["sources"]] == ["huggingface", "paper"]
    assert result["warnings"] == ["supplier 값이 두 조사에서 달랐습니다."]
    assert len(result["fieldDecisions"]) == len(merge_content()["fieldDecisions"])
    assert result["areaDecisions"][0]["area"] == "evaluations"
    assert result["aibom"]["evaluation"][0]["score"] == 70.5


def test_merge_stream_endpoint_reports_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key=""))
    monkeypatch.setattr(main, "_load_research_context", lambda: CatalogContext())
    response = TestClient(main.app).post(
        "/api/v1/admin/model-research/merge/stream",
        json={"modelName": "org/model", "results": {"huggingface": research_result("huggingface"), "paper": None}},
    )

    assert response.status_code == 200
    assert "OPENROUTER_API_KEY is not configured." in response.text


def _lineage_context() -> CatalogContext:
    from app.research import CatalogModel

    family = {"family_key": "llama31", "family_name": "Llama 3.1"}
    return CatalogContext(models=(
        CatalogModel(model_id="meta-llama/Llama-3.1-8B-Instruct", **family),
        CatalogModel(model_id="FreedomIntelligence/HuatuoGPT-o1-8B", depth=1,
                     parent_model_id="meta-llama/Llama-3.1-8B-Instruct", **family),
    ))


def _grandchild_content() -> dict:
    content = research_content()
    content["draft"].update({
        "modelId": "BrainHealthAI/MedCortex-Huatuo-8B-e1", "namespace": "BrainHealthAI",
        "modelName": "MedCortex-Huatuo-8B-e1", "modelRole": "DERIVED",
        "familyKey": "huatuogpto1", "familyName": "HuatuoGPT-o1",
    })
    content["parentCandidates"] = [
        {"modelId": "meta-llama/Llama-3.1-8B-Instruct", "relationshipType": "domainFineTunedFrom",
         "confidence": "low", "evidenceUrls": []},
        {"modelId": "freedomintelligence/huatuogpt-o1-8b", "relationshipType": "domainFineTunedFrom",
         "confidence": "high", "evidenceUrls": ["https://example.test/model"]},
    ]
    return content


def test_derivative_of_a_derivative_joins_the_parent_family_at_depth_two() -> None:
    upstream = {"choices": [{"message": {"content": json.dumps(_grandchild_content())}}]}

    result = parse_openrouter_response(upstream, context=_lineage_context())
    draft = result["draft"]

    assert draft["parentModelId"] == "FreedomIntelligence/HuatuoGPT-o1-8B"  # catalog casing, best confidence
    assert draft["relationshipType"] == "domainFineTunedFrom"
    assert draft["hierarchyDepth"] == 2
    assert (draft["familyKey"], draft["familyName"]) == ("llama31", "Llama 3.1")
    # The release date is the model's own (from its AIBOM), never the family's.
    assert draft["releaseDate"] == "2026-01-02"
    assert not {"familyDeveloper", "familyReleaseDate", "familyLicenseName"} & set(draft)
    assert any("huatuogpto1" in warning and "llama31" in warning for warning in result["warnings"])
    assert result["catalogLineage"]["suggestedFamily"]["familyKey"] == "huatuogpto1"


def test_lineage_is_re_resolved_against_the_current_catalog() -> None:
    from app.research import resolve_catalog_lineage

    upstream = {"choices": [{"message": {"content": json.dumps(_grandchild_content())}}]}
    full = _lineage_context()
    without_parents = CatalogContext(models=(replace(full.models[0], model_id="other/model"),))

    result = parse_openrouter_response(upstream, context=without_parents)
    assert result["draft"]["parentModelId"] is None
    assert result["draft"]["familyKey"] == "huatuogpto1"
    assert any("카탈로그에 등록되어 있지 않아" in warning for warning in result["warnings"])

    resolve_catalog_lineage(result, full)  # the parent was registered afterwards
    assert result["draft"]["hierarchyDepth"] == 2
    assert result["draft"]["familyKey"] == "llama31"
    assert not any("카탈로그에 등록되어 있지 않아" in warning for warning in result["warnings"])

    resolve_catalog_lineage(result, without_parents)  # and removed again
    assert result["draft"]["parentModelId"] is None
    assert (result["draft"]["familyKey"], result["draft"]["familyName"]) == ("huatuogpto1", "HuatuoGPT-o1")
    assert sum("카탈로그에 등록되어 있지 않아" in warning for warning in result["warnings"]) == 1


def _official_chat_content() -> dict:
    """An official chat checkpoint the research model called BASE although it names its base."""
    content = research_content()
    content["draft"].update({"modelId": "Qwen/Qwen3.5-9B", "namespace": "Qwen", "modelName": "Qwen3.5-9B",
                             "modelRole": "BASE", "familyKey": "qwen35", "familyName": "Qwen 3.5"})
    content["aibom"]["transformation"]["inputs"] = [{"model": "qwen/qwen3.5-9b-base", "role": "base"},
                                                    {"model": "GPT-4o", "role": "verifier"}]
    return content


def test_base_role_with_a_stated_parent_becomes_derived_under_that_parent() -> None:
    from app.research import ROLE_CORRECTED_WARNING, CatalogModel, resolve_catalog_lineage

    context = CatalogContext(models=(
        CatalogModel(model_id="Qwen/Qwen3.5-9B-Base", family_key="qwen35", family_name="Qwen 3.5"),))
    upstream = {"choices": [{"message": {"content": json.dumps(_official_chat_content())}}]}

    result = parse_openrouter_response(upstream, context=context)
    draft = result["draft"]

    assert draft["modelRole"] == "DERIVED"
    assert draft["parentModelId"] == "Qwen/Qwen3.5-9B-Base"
    assert draft["relationshipType"] == "instructionTunedFrom"  # from aibom.provenance.relation
    assert draft["hierarchyDepth"] == 1
    assert result["parentCandidates"] == []  # the research model's answer is kept as given

    resolve_catalog_lineage(result, context)  # reloading a stored result does not repeat the warning
    assert result["warnings"].count(ROLE_CORRECTED_WARNING) == 1


def test_base_role_is_corrected_without_a_catalog_and_kept_for_real_roots() -> None:
    upstream = {"choices": [{"message": {"content": json.dumps(_official_chat_content())}}]}
    assert parse_openrouter_response(upstream)["draft"]["modelRole"] == "DERIVED"

    root = _official_chat_content()
    root["aibom"]["provenance"]["relation"] = "pretrained"
    root["aibom"]["transformation"]["inputs"] = []
    result = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(root)}}]})
    assert result["draft"]["modelRole"] == "BASE"
    assert not any("DERIVED" in warning for warning in result["warnings"])


def test_dataset_the_research_model_lists_twice_becomes_one_entry() -> None:
    """The merge prompt asks for one entry per identity; the code enforces it like it does for evaluations."""
    content = research_content()
    first = content["aibom"]["datasets"][1]  # cais/mmlu
    content["aibom"]["datasets"].append({
        **first, "name": "MMLU benchmark", "license": "CC-BY-4.0", "size": "15K", "provider": "CAIS",
        "evidence_urls": ["https://huggingface.co/datasets/cais/mmlu", "https://example.test/model"]})
    first["evidence_urls"] = ["https://example.test/model"]

    result = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(content)}}]})
    datasets = result["aibom"]["dataset"]

    assert [item["identity"] for item in datasets] == ["org/sft-data", "cais/mmlu"]
    mmlu = datasets[1]
    assert mmlu["license"] == "MIT"  # the first entry wins
    assert mmlu["extensions"] == {"name": "MMLU", "hf_id": "cais/mmlu", "size": "15K", "provider": "CAIS"}
    assert mmlu["provenance"]["evidence"] == ["https://example.test/model", "https://huggingface.co/datasets/cais/mmlu"]
    assert result["aibomSummary"]["datasets"] == 2


def test_prompt_lists_family_and_parent_of_existing_models() -> None:
    prompt = build_openrouter_payload("org/model", context=_lineage_context())["messages"][1]["content"]

    assert "- FreedomIntelligence/HuatuoGPT-o1-8B | llama31 | meta-llama/Llama-3.1-8B-Instruct" in prompt
    assert "- meta-llama/Llama-3.1-8B-Instruct | llama31 | root" in prompt


def test_upstream_error_carries_openrouter_response_to_the_client() -> None:
    from app.research import _upstream_error

    body = json.dumps({"error": {"message": "openai/gpt-6.0-luna is not a valid model ID", "code": 400},
                       "user_id": "user_x"})
    payload = _upstream_error(400, body.encode(), "openai/gpt-6.0-luna")
    assert payload["message"] == "OpenRouter HTTP 400: openai/gpt-6.0-luna is not a valid model ID"
    assert payload["upstream"] == {"status": 400, "code": 400, "model": "openai/gpt-6.0-luna", "metadata": None,
                                   "message": "openai/gpt-6.0-luna is not a valid model ID"}
    assert "user_x" not in json.dumps(payload)

    chunk_error = {"code": 502, "message": "Provider returned error",
                   "metadata": {"provider_name": "OpenAI", "raw": "Invalid schema for response_format"}}
    payload = _upstream_error(None, chunk_error)
    assert payload["message"] == ("OpenRouter HTTP 502: Provider returned error | "
                                  "OpenAI: Invalid schema for response_format")

    assert _upstream_error(503, "<html>Bad gateway</html>")["message"] == "OpenRouter HTTP 503: <html>Bad gateway</html>"


def test_stream_passes_openrouter_http_error_through(monkeypatch) -> None:
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad-model is not a valid model ID", "code": 400}})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(research.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key="test-key"))
    monkeypatch.setattr(main, "_load_research_context", lambda: CatalogContext())

    response = TestClient(main.app).post("/api/v1/admin/model-research/stream", json={"modelName": "org/model"})

    assert response.status_code == 200
    assert "event: error" in response.text
    assert "OpenRouter HTTP 400: bad-model is not a valid model ID" in response.text
    assert '"upstream"' in response.text


def test_stream_completion_measures_the_openrouter_call(monkeypatch) -> None:
    import asyncio

    import httpx

    chunks = [
        json.dumps({"model": "m", "choices": [{"delta": {"content": "ab"}}]}),
        "not json",
        json.dumps({"choices": [{"delta": {"content": "cde"}}], "usage": {"cost": 0.01}}),
    ]
    body = "".join(f"data: {chunk}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
    real_client = httpx.AsyncClient
    monkeypatch.setattr(research.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, text=body)), **kwargs))
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key="test-key"))

    async def run() -> tuple[dict, list[str]]:
        sink: dict = {}
        events = [event async for event in research._stream_completion({"model": "m"}, {"stage": "researching"}, sink)]
        return sink, events

    sink, events = asyncio.run(run())

    metrics = sink["metrics"]
    # eventCount is what the admin UI shows as "OpenRouter 원본 이벤트 N개".
    assert metrics["eventCount"] == sum(event.startswith("event: provider_event") for event in events) == 3
    assert "responseCharacters" not in metrics
    assert metrics["contentCharacters"] == 5  # "ab" + "cde": the generated answer only
    assert isinstance(metrics["responseTimeMs"], int) and metrics["responseTimeMs"] >= 0


def _huggingface_transport(routes: dict[str, tuple[int, object]], seen: list[str] | None = None):
    """httpx transport answering huggingface.co paths from `routes`; unknown paths are 404."""
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if seen is not None:
            seen.append(request.url.path)
        status_code, body = routes.get(request.url.path, (404, "Not Found"))
        return httpx.Response(status_code, json=body) if isinstance(body, dict) else httpx.Response(status_code, text=body)

    return httpx.MockTransport(handler)


def _fetch_repository_facts(monkeypatch, model_name: str, routes: dict, seen: list[str] | None = None) -> str | None:
    import asyncio

    import httpx

    real_client = httpx.AsyncClient
    monkeypatch.setattr(research.httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=_huggingface_transport(routes, seen), **kwargs))
    return asyncio.run(research.fetch_repository_facts(model_name))


REPOSITORY_ROUTES = {
    "/api/models/org/model": (200, {
        "id": "Org/Model", "sha": "003b99eb0000", "createdAt": "2025-01-13T23:47:25.000Z", "gated": False,
        "cardData": {"base_model": "meta-llama/Llama-3.1-8B-Instruct", "license": "llama3.1"},
        "safetensors": {"parameters": {"BF16": 8030261248}, "total": 8030261248},
        "siblings": [{"rfilename": "README.md"}, {"rfilename": "model.safetensors"}],
        "downloads": 8,
    }),
    "/Org/Model/raw/main/README.md": (200, "---\nbase_model: meta-llama/Llama-3.1-8B-Instruct\n---\n# Model"),
    "/Org/Model/raw/main/config.json": (200, '{"num_hidden_layers": 32}'),
}


def test_repository_facts_carry_the_api_record_card_and_config(monkeypatch) -> None:
    facts = _fetch_repository_facts(monkeypatch, "https://huggingface.co/org/model", REPOSITORY_ROUTES)

    assert "https://huggingface.co/api/models/Org/Model" in facts  # canonical id from the API record
    assert '"sha": "003b99eb0000"' in facts and '"total": 8030261248' in facts
    assert '"files": ["README.md", "model.safetensors"]' in facts
    assert "downloads" not in facts
    assert '<file name="README.md">\n---\nbase_model: meta-llama/Llama-3.1-8B-Instruct' in facts
    assert '<file name="config.json">\n{"num_hidden_layers": 32}' in facts
    assert "You must still use web search" in facts

    payload = build_openrouter_payload("org/model", repository_facts=facts)
    assert payload["messages"][1]["content"].endswith(facts)
    assert payload["tools"][0]["type"] == "openrouter:web_search"  # the search stays on
    assert "Repository facts" not in build_openrouter_payload("org/model")["messages"][1]["content"]


def test_repository_facts_of_a_gated_repository_keep_the_api_record(monkeypatch) -> None:
    routes = {**REPOSITORY_ROUTES, "/Org/Model/raw/main/README.md": (401, "Access restricted"),
              "/Org/Model/raw/main/config.json": (401, "Access restricted")}

    facts = _fetch_repository_facts(monkeypatch, "org/model", routes)

    assert '"sha": "003b99eb0000"' in facts
    assert "- README.md: not readable without authentication or missing (HTTP 401)." in facts
    assert "<file" not in facts


def test_repository_facts_cut_a_long_model_card(monkeypatch) -> None:
    limit = dict(research.REPOSITORY_FILE_LIMITS)["README.md"]
    routes = {**REPOSITORY_ROUTES, "/Org/Model/raw/main/README.md": (200, "a" * (limit + 500))}

    facts = _fetch_repository_facts(monkeypatch, "org/model", routes)

    assert "a" * limit + "\n[truncated]\n</file>" in facts
    assert "a" * (limit + 1) not in facts


@pytest.mark.parametrize("status_code", [404, 429, 500])
def test_repository_facts_are_skipped_when_the_repository_cannot_be_read(monkeypatch, status_code) -> None:
    routes = {"/api/models/org/model": (status_code, "error")}

    assert _fetch_repository_facts(monkeypatch, "org/model", routes) is None


def test_repository_facts_are_skipped_on_network_errors(monkeypatch) -> None:
    import asyncio

    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable", request=request)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(research.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))

    assert asyncio.run(research.fetch_repository_facts("org/model")) is None


def test_repository_facts_need_a_repository_id(monkeypatch) -> None:
    seen: list[str] = []

    assert _fetch_repository_facts(monkeypatch, "Llama 3.1 8B Instruct", REPOSITORY_ROUTES, seen) is None
    assert seen == []  # a free-text name is left to the web search
    assert research.repository_id(" https://huggingface.co/Qwen/Qwen2.5-7B/ ") == "Qwen/Qwen2.5-7B"
    assert research.repository_id("Qwen/Qwen2.5-7B/tree/main") is None


def test_stream_reads_the_repository_for_the_huggingface_strategy_only(monkeypatch) -> None:
    import httpx

    prompts: list[str] = []
    hub = _huggingface_transport(REPOSITORY_ROUTES)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "huggingface.co":
            return hub.handle_request(request)
        prompts.append(json.loads(request.content)["messages"][1]["content"])
        return httpx.Response(400, json={"error": {"message": "stop here", "code": 400}})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(research.httpx, "AsyncClient",
                        lambda **kwargs: real_client(transport=httpx.MockTransport(handler), **kwargs))
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key="test-key"))
    monkeypatch.setattr(main, "_load_research_context", lambda: CatalogContext())

    client = TestClient(main.app)
    for source in ("huggingface", "paper"):
        client.post("/api/v1/admin/model-research/stream", json={"modelName": "org/model", "source": source})

    assert "Repository facts read directly from huggingface.co" in prompts[0]
    assert "Repository facts" not in prompts[1]


def test_paper_not_found_warns_about_the_missing_paper_not_the_model() -> None:
    content = research_content()
    content["status"] = "not_found"

    paper = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(content)}}]}, source="paper")
    repository = parse_openrouter_response({"choices": [{"message": {"content": json.dumps(content)}}]})

    assert paper["warnings"][0] == research.PAPER_NOT_FOUND_WARNING
    assert repository["warnings"][0] == research.STATUS_WARNINGS["not_found"]
