from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import main
from app.database import get_db
from app.models import Base
from app.research_store import SaveResearchResultsRequest, load_research_results, save_research_results


def session() -> Session:
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def result(source: str, model_id: str = "org/model") -> dict:
    return {
        "status": "found",
        "source": source,
        "draft": {"modelId": model_id, "familyName": "Family"},
        "research": {"model": "anthropic/claude-opus-5"},
        "sources": [],
        "warnings": [],
    }


def test_save_then_load_round_trips_all_sources() -> None:
    db = session()
    payload = SaveResearchResultsRequest.model_validate({
        "modelName": "  org/model  ",
        "results": {"huggingface": result("huggingface"), "paper": result("paper"), "merged": None},
    })

    saved = save_research_results(db, payload)

    assert saved["modelName"] == "org/model"
    assert saved["exists"] is True
    assert saved["results"]["huggingface"]["resultModelId"] == "org/model"
    assert saved["results"]["paper"]["researchModel"] == "anthropic/claude-opus-5"
    assert saved["results"]["merged"] is None
    loaded = load_research_results(db, "org/model")
    assert loaded["results"]["huggingface"]["result"]["draft"]["modelId"] == "org/model"
    assert loaded["latestCreatedAt"] is not None


def test_replace_previous_drops_old_rows_and_upsert_keeps_them() -> None:
    db = session()
    save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model",
        "results": {"huggingface": result("huggingface", "org/old"), "paper": result("paper", "org/old")},
    }))

    save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "replacePrevious": True,
        "results": {"huggingface": result("huggingface", "org/new")},
    }))
    after_replace = load_research_results(db, "org/model")
    assert after_replace["results"]["huggingface"]["resultModelId"] == "org/new"
    assert after_replace["results"]["paper"] is None

    save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "results": {"merged": result("merged", "org/new")},
    }))
    after_merge = load_research_results(db, "org/model")
    assert after_merge["results"]["huggingface"]["resultModelId"] == "org/new"
    assert after_merge["results"]["merged"]["source"] == "merged"


def test_missing_name_reports_empty() -> None:
    loaded = load_research_results(session(), "org/unknown")
    assert loaded == {
        "modelName": "org/unknown", "exists": False, "latestCreatedAt": None, "runId": None, "runCount": 0,
        "results": {"huggingface": None, "paper": None, "merged": None},
    }


def test_new_runs_keep_the_history_and_run_id_targets_a_run() -> None:
    from app.research_store import get_research_run, list_research_runs

    db = session()
    first = save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "replacePrevious": True,
        "results": {"huggingface": {**result("huggingface", "org/old"),
                                    "research": {"model": "m", "usage": {"cost": 0.1,
                                                 "server_tool_use_details": {"web_search_requests": 7}}}}},
    }))
    second = save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "replacePrevious": True, "results": {"paper": result("paper", "org/new")},
    }))
    save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "runId": first["runId"], "results": {"merged": result("merged", "org/old")},
    }))

    runs = list_research_runs(db, model_name="org/model")
    assert [run["runId"] for run in runs] == [second["runId"], first["runId"]]
    assert load_research_results(db, "org/model")["runCount"] == 2
    old = get_research_run(db, first["runId"])
    assert old["results"]["merged"]["resultModelId"] == "org/old"
    assert old["results"]["huggingface"]["webSearchRequests"] == 7
    assert old["totalCostUsd"] == 0.1
    assert "result" not in runs[1]["results"]["huggingface"]  # summaries omit the full payload
    assert [run["runId"] for run in list_research_runs(db, model_id="org/new")] == [second["runId"]]


def test_research_run_endpoints_list_get_link_and_delete() -> None:
    from app.admin import AdminModelWrite, create_admin_model

    db = session()
    create_admin_model(db, AdminModelWrite.model_validate({
        "modelId": "org/model", "namespace": "org", "modelName": "model", "familyKey": "f", "familyName": "F",
        "modelRole": "BASE", "modelUrl": "https://example.test", "detailsJson": {}}))
    saved = save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "replacePrevious": True, "results": {"huggingface": result("huggingface")}}))
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(main.app)
        run_id = saved["runId"]
        assert client.get("/api/v1/admin/research-runs").json()[0]["runId"] == run_id
        assert client.get(f"/api/v1/admin/research-runs/{run_id}").json()["results"]["huggingface"]["result"]["status"] == "found"
        linked = client.put(f"/api/v1/admin/research-runs/{run_id}/model", json={"modelId": "org/model"})
        assert linked.status_code == 200 and linked.json()["modelId"] == "org/model"
        assert client.put(f"/api/v1/admin/research-runs/{run_id}/model", json={"modelId": "org/missing"}).status_code == 422
        assert client.get("/api/v1/admin/research-runs", params={"modelId": "org/model"}).json()[0]["runId"] == run_id
        assert client.delete(f"/api/v1/admin/research-runs/{run_id}").status_code == 204
        assert client.get(f"/api/v1/admin/research-runs/{run_id}").status_code == 404
    finally:
        main.app.dependency_overrides.clear()


def test_results_endpoints_save_load_and_delete() -> None:
    db = session()
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        client = TestClient(main.app)
        params = {"modelName": "org/model"}
        assert client.get("/api/v1/admin/model-research/results", params=params).json()["exists"] is False
        saved = client.post("/api/v1/admin/model-research/results", json={
            "modelName": "org/model", "replacePrevious": True,
            "results": {"huggingface": result("huggingface"), "paper": None},
        })
        assert saved.status_code == 200
        assert saved.json()["results"]["huggingface"]["status"] == "found"
        assert client.get("/api/v1/admin/model-research/results", params=params).json()["exists"] is True
        assert client.delete("/api/v1/admin/model-research/results", params=params).status_code == 204
        assert client.get("/api/v1/admin/model-research/results", params=params).json()["exists"] is False
        assert client.post("/api/v1/admin/model-research/results", json={"modelName": "org/model", "results": {}}).status_code == 422
    finally:
        main.app.dependency_overrides.clear()
