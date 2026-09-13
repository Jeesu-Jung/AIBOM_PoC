import json
from dataclasses import replace
from datetime import date

from fastapi.testclient import TestClient

from app import main, research
from app.research import _public_chunk, build_openrouter_payload, parse_openrouter_response


def research_content() -> dict:
    return {
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
            "bomFormat": None,
            "bomSpecVersion": None,
            "bomSerialNumber": None,
            "bomVersion": None,
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

    assert result["draft"]["modelId"] == "org/model"
    assert result["draft"]["detailsJson"]["ai_research"]["reviewed"] is False
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


def test_public_stream_chunk_removes_private_reasoning() -> None:
    public = _public_chunk({
        "choices": [{"delta": {"content": "ok", "reasoning": "private"}}],
        "reasoning_details": [{"text": "private"}],
    })

    assert public == {"choices": [{"delta": {"content": "ok"}}]}


def test_stream_endpoint_reports_missing_configuration(monkeypatch) -> None:
    monkeypatch.setattr(research, "settings", replace(research.settings, openrouter_api_key=""))
    response = TestClient(main.app).post(
        "/api/v1/admin/model-research/stream",
        json={"modelName": "org/model"},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "event: error" in response.text
    assert "OPENROUTER_API_KEY is not configured." in response.text
