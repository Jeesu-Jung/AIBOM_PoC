"""Several reviewers review one research run; the majority answer is saved, ties go to the AI (app/review.py)."""
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app import main, review
from app.aibom import load_model_aibom
from app.database import get_db
from app.evidence import load_model_evidence
from app.models import Base, ModelInfo
from app.research_store import (AssignRunsRequest, ReviewerWrite, SaveResearchResultsRequest, assign_runs,
                                distribute_runs, get_research_run, list_reviewers, page_research_runs,
                                save_research_results, save_reviewer)
from app.review import ABSENT, Unit, build_units, canonical, decide


def model(**changes) -> dict:
    return {"modelId": "org/model", "namespace": "org", "modelName": "model", "familyKey": "family",
            "familyName": "Family", "modelRole": "BASE", "modelUrl": "https://example.test/model",
            "supplier": "Org", "description": "A model.", "detailsJson": {}} | changes


def aibom(**changes) -> dict:
    return {
        "model": {"intended_use": "chat", "capabilities": ["answers questions"]},
        "provenance": {"origin": "Org"},
        "transformation": None,
        "evaluation": [{"dataset": "org/data", "configuration": {"benchmark": "MMLU"}, "metric": "accuracy", "score": 70.5}],
        "safety_ethics": None,
        "license_policy": [{"license": "MIT"}],
        "dataset": [{"identity": "org/data", "version": "1"}],
        "reference": [{"type": "paper", "uri": "https://example.test/paper"}],
    } | changes


def evidence(field: str, url: str, area: str = "catalog", item_key: str = "") -> dict:
    return {"area": area, "itemKey": item_key, "field": field, "url": url}


def research(source: str, supplier: str) -> dict:
    return {"status": "found", "source": source, "draft": model(supplier=supplier), "aibom": aibom(),
            "fieldEvidence": [{"fields": ["supplier"], "confidence": "high", "urls": [f"https://example.test/{source}"]}],
            "research": {"model": "test/model"}, "sources": [], "warnings": []}


@pytest.fixture
def api(monkeypatch):
    """A client on an in-memory database; background saves use the same session."""
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine, expire_on_commit=False)
    monkeypatch.setattr(main, "SessionLocal", lambda: db)
    main.app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(main.app), db
    finally:
        main.app.dependency_overrides.clear()


def reviewed_run(db: Session, reviewers: int) -> tuple[int, list[int]]:
    """A stored run assigned to `reviewers` people."""
    run_id = save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/model", "replacePrevious": True,
        "results": {"huggingface": research("huggingface", "Org"), "paper": research("paper", "Org Research")}}))["runId"]
    ids = []
    for index in range(reviewers):
        ids = [row["id"] for row in save_reviewer(db, ReviewerWrite(name=f"Reviewer {index + 1}"))]
    assign_runs(db, AssignRunsRequest(runIds=[run_id], reviewerIds=ids))
    return run_id, ids


def submit(client: TestClient, run_id: int, reviewer_id: int, **answer) -> dict:
    response = client.put(f"/api/v1/admin/research-runs/{run_id}/reviews/{reviewer_id}",
                          json={"model": model(), "aibom": aibom(), "evidence": []} | answer)
    assert response.status_code == 200, response.text
    return response.json()


def no_ai(monkeypatch) -> None:
    async def fail(payload: dict) -> dict:
        raise AssertionError("The AI must not be asked when every value has a majority.")
    monkeypatch.setattr(review, "complete_json", fail)


def test_equal_answers_ignore_empty_values_key_order_and_number_form() -> None:
    assert canonical({"b": 1.0, "a": "", "c": []}) == canonical({"b": 1})
    assert canonical({"a": [{"x": None}]}) == {"a": [None]}
    unit = Unit(id="aibom.model.capabilities", kind="field", area="model", name="capabilities",
                answers=[(0, [{"description": "chat", "reference": "https://example.test"}]), (1, ["chat"])])
    assert decide(unit).method == "unanimous"  # a stored item and its edited text are the same answer


def test_decide_takes_the_most_chosen_value_and_reports_ties() -> None:
    def unit(*values, passive=False) -> Unit:
        return Unit(id="catalog.supplier", kind="catalog", area="catalog", name="supplier", fields=("supplier",),
                    answers=list(enumerate(values)), passive=passive)

    majority = decide(unit("A", "B", "A"))
    assert (majority.method, majority.value, majority.winners) == ("majority", "A", [0, 2])
    assert decide(unit("A", "A")).method == "unanimous"
    assert decide(unit("A", "B")).method == "tie"
    assert decide(unit("A", "B", "C")).method == "tie"
    assert decide(unit("A", "A", "B", "B", "C")).method == "tie"           # two answers share the lead
    first = decide(unit("B", "A", passive=True))
    assert (first.method, first.value) == ("first", "B")                    # never sent to the AI
    assert decide(unit(ABSENT, {"identity": "d"}, ABSENT)).value is ABSENT   # most reviewers left the item out


def test_units_cover_catalog_groups_area_fields_and_list_items() -> None:
    units = {unit.id: unit for unit in build_units([
        {"model": model(), "aibom": aibom()},
        {"model": model(modelId="org/other"), "aibom": aibom(dataset=[], transformation={"method": ["LoRA"]})}])}
    assert units["catalog.modelId+namespace+modelName"].answers[1][1] == {
        "modelId": "org/other", "namespace": "org", "modelName": "model"}
    assert units["catalog.detailsJson"].passive and not units["catalog.supplier"].passive
    assert [value for _, value in units["aibom.transformation.method"].answers] == [None, ["LoRA"]]
    assert [value for _, value in units["aibom.dataset[org/data]"].answers] == [{"identity": "org/data", "version": "1"}, ABSENT]
    assert "aibom.evaluation[MMLU | accuracy]" in units and "aibom.license_policy[mit]" in units
    # Without any AIBOM answer only the catalog fields are compared.
    assert all(unit.kind == "catalog" for unit in build_units([{"model": model(), "aibom": None}]))


def test_run_is_saved_from_the_majority_once_every_reviewer_submitted(api, monkeypatch) -> None:
    client, db = api
    no_ai(monkeypatch)
    run_id, (first, second, third) = reviewed_run(db, 3)

    waiting = submit(client, run_id, first, model=model(supplier="Org Research"),
                     evidence=[evidence("supplier", "https://example.test/paper")])
    assert (waiting["reviewStatus"], waiting["reviewProgress"]) == ("pending", {"submitted": 1, "total": 3})
    assert db.get(ModelInfo, "org/model") is None  # a review alone writes nothing to the catalog
    submit(client, run_id, second, model=model(supplier="Org Research", description="Second."),
           aibom=aibom(dataset=[{"identity": "org/data", "version": "2"}]),
           evidence=[evidence("supplier", "https://example.test/paper")])
    assert client.get(f"/api/v1/admin/research-runs/{run_id}/reviews/{second}").json()["review"]["model"]["description"] == "Second."
    assert client.post(f"/api/v1/admin/research-runs/{run_id}/finalize").status_code == 422  # one review is missing

    # The last review starts the save; with a majority everywhere it finishes without the AI.
    submit(client, run_id, third, evidence=[evidence("supplier", "https://example.test/hf")])
    saved = client.get(f"/api/v1/admin/research-runs/{run_id}/status").json()
    assert "result" not in saved["results"]["huggingface"]  # the polled status carries no result payload
    assert (saved["reviewStatus"], saved["modelId"], saved["reviewedByName"]) == ("saved", "org/model", None)
    assert [reviewer["status"] for reviewer in saved["reviewers"]] == ["submitted"] * 3

    stored = db.get(ModelInfo, "org/model")
    assert (stored.supplier, stored.description) == ("Org Research", "A model.")  # 2 of 3 each
    stored_aibom = load_model_aibom(db, "org/model")
    assert [(item["identity"], item["version"]) for item in stored_aibom["dataset"]] == [("org/data", "1")]
    assert float(stored_aibom["evaluation"][0]["score"]) == 70.5
    # The evidence follows a reviewer who chose the saved value.
    assert [(row["field"], row["url"]) for row in load_model_evidence(db, "org/model")] == [
        ("supplier", "https://example.test/paper")]

    summary = saved["finalize"]["summary"]
    assert summary["counts"]["aiMerged"] == 0 and summary["ai"] is None
    decided = {item["id"]: item for item in summary["majority"]}
    assert set(decided) == {"catalog.supplier", "catalog.description", "aibom.dataset[org/data]"}
    assert [vote["count"] for vote in decided["catalog.supplier"]["votes"]] == [2, 1]
    assert decided["catalog.supplier"]["votes"][0]["reviewerIds"] == [first, second]
    # A saved run takes no more reviews.
    assert client.put(f"/api/v1/admin/research-runs/{run_id}/reviews/{first}",
                      json={"model": model(), "aibom": aibom(), "evidence": []}).status_code == 409


def test_ties_are_merged_by_the_ai_and_only_the_tied_values_are_sent(api, monkeypatch) -> None:
    client, db = api
    run_id, (first, second) = reviewed_run(db, 2)
    asked: list[dict] = []
    seen_status: list[str] = []

    async def complete(payload: dict) -> dict:
        asked.append(payload)
        seen_status.append(get_research_run(db, run_id)["reviewStatus"])
        units = json.loads(payload["messages"][1]["content"].split("<tied_units>")[1].split("</tied_units>")[0])
        by_target = {unit["target"]: unit for unit in units}
        return {"model": "test/model", "usage": {"cost": 0.01}, "metrics": {"responseTimeMs": 5}, "content": json.dumps({
            "decisions": [
                {"id": by_target["supplier"]["id"], "chosen": "answer_2", "valueJson": None, "rationale": "논문 근거와 일치합니다."},
                {"id": by_target["MODEL · capabilities"]["id"], "chosen": "combined",
                 "valueJson": json.dumps(["answers questions", "writes code"]), "rationale": "두 목록을 합쳤습니다."},
                {"id": by_target["DATASET · org/extra"]["id"], "chosen": "answer_1", "valueJson": None, "rationale": "근거가 없습니다."},
            ]})}
    monkeypatch.setattr(review, "complete_json", complete)

    submit(client, run_id, first)
    submit(client, run_id, second, model=model(supplier="Org Research"),
           aibom=aibom(model={"intended_use": "chat", "capabilities": ["writes code"]},
                       dataset=[{"identity": "org/data", "version": "1"}, {"identity": "org/extra"}]))

    assert seen_status == ["merging"]  # what the UI shows while the AI works
    units = json.loads(asked[0]["messages"][1]["content"].split("<tied_units>")[1].split("</tied_units>")[0])
    assert sorted(unit["target"] for unit in units) == ["DATASET · org/extra", "MODEL · capabilities", "supplier"]
    supplier = next(unit for unit in units if unit["target"] == "supplier")
    assert supplier["answers"] == [{"id": "answer_1", "votes": 1, "value": "Org"},
                                   {"id": "answer_2", "votes": 1, "value": "Org Research"}]
    assert supplier["huggingface"] == {"value": "Org", "evidence": [{"url": "https://example.test/huggingface", "confidence": "high"}]}
    assert supplier["paper"]["value"] == "Org Research"
    extra = next(unit for unit in units if unit["target"] == "DATASET · org/extra")
    assert extra["answers"][0] == {"id": "answer_1", "votes": 1, "value": None, "absent": True}
    assert "Reviewer" not in asked[0]["messages"][1]["content"]  # reviewers are not named to the AI
    assert asked[0]["response_format"]["json_schema"]["strict"] is True and "tools" not in asked[0]

    saved = get_research_run(db, run_id)
    assert saved["reviewStatus"] == "saved"
    assert db.get(ModelInfo, "org/model").supplier == "Org Research"
    stored_aibom = load_model_aibom(db, "org/model")
    assert stored_aibom["model"]["capabilities"] == ["answers questions", "writes code"]
    assert [item["identity"] for item in stored_aibom["dataset"]] == ["org/data"]
    summary = saved["finalize"]["summary"]
    assert summary["counts"]["aiMerged"] == 3 and summary["ai"]["model"] == "test/model"
    merged = {item["label"]: (item["chosen"], item["rationale"]) for item in summary["aiMerged"]}
    assert merged["supplier"] == ("answer_2", "논문 근거와 일치합니다.")
    assert next(item for item in summary["aiMerged"] if item["label"] == "DATASET · org/extra")["absent"] is True


def test_failed_save_is_reported_and_can_be_started_again(api, monkeypatch) -> None:
    client, db = api
    run_id, (first, second) = reviewed_run(db, 2)

    async def unavailable(payload: dict) -> dict:
        raise RuntimeError("OpenRouter HTTP 503: upstream unavailable")
    monkeypatch.setattr(review, "complete_json", unavailable)
    submit(client, run_id, first)
    submit(client, run_id, second, model=model(supplier="Org Research"))

    failed = client.get(f"/api/v1/admin/research-runs/{run_id}").json()
    assert (failed["reviewStatus"], failed["finalize"]["error"]) == ("failed", "OpenRouter HTTP 503: upstream unavailable")
    assert db.get(ModelInfo, "org/model") is None
    assert page_research_runs(db, status="pending")["items"][0]["reviewStatus"] == "failed"

    async def complete(payload: dict) -> dict:
        unit = json.loads(payload["messages"][1]["content"].split("<tied_units>")[1].split("</tied_units>")[0])[0]
        return {"content": json.dumps({"decisions": [
            {"id": unit["id"], "chosen": "paper", "valueJson": None, "rationale": "논문 값입니다."}]})}
    monkeypatch.setattr(review, "complete_json", complete)
    retried = client.post(f"/api/v1/admin/research-runs/{run_id}/finalize")
    assert retried.status_code == 200 and retried.json()["reviewStatus"] == "saving"
    assert get_research_run(db, run_id)["reviewStatus"] == "saved"
    assert db.get(ModelInfo, "org/model").supplier == "Org Research"
    assert client.post(f"/api/v1/admin/research-runs/{run_id}/finalize").status_code == 409  # already saved


def test_an_answer_the_ai_cannot_be_read_from_fails_the_save(api, monkeypatch) -> None:
    client, db = api
    run_id, (first, second) = reviewed_run(db, 2)

    async def complete(payload: dict) -> dict:
        return {"content": json.dumps({"decisions": []})}
    monkeypatch.setattr(review, "complete_json", complete)
    submit(client, run_id, first)
    submit(client, run_id, second, model=model(supplier="Org Research"))
    failed = get_research_run(db, run_id)
    assert failed["reviewStatus"] == "failed" and "supplier" in failed["finalize"]["error"]

    # A reviewer who changes their answer to agree settles it without the AI.
    no_ai(monkeypatch)
    submit(client, run_id, first, model=model(supplier="Org Research"))
    assert get_research_run(db, run_id)["reviewStatus"] == "saved"


def test_item_votes_keep_the_saved_aibom_consistent(api, monkeypatch) -> None:
    client, db = api
    no_ai(monkeypatch)
    run_id, (first, second, third) = reviewed_run(db, 3)
    # Two reviewers dropped the dataset but all keep the evaluation that points at it.
    submit(client, run_id, first)
    submit(client, run_id, second, aibom=aibom(dataset=[]))
    submit(client, run_id, third, aibom=aibom(dataset=[]))
    saved = get_research_run(db, run_id)
    assert saved["reviewStatus"] == "saved", saved["finalize"]
    assert [item["identity"] for item in load_model_aibom(db, "org/model")["dataset"]] == ["org/data"]
    assert "org/data" in saved["finalize"]["summary"]["notes"][0]


def test_runs_get_several_reviewers_and_unassigning_the_last_open_review_saves_the_run(api, monkeypatch) -> None:
    client, db = api
    no_ai(monkeypatch)
    run_id, (first, second, third) = reviewed_run(db, 3)
    other = save_research_results(db, SaveResearchResultsRequest.model_validate({
        "modelName": "org/other", "replacePrevious": True, "results": {"huggingface": research("huggingface", "Org")}}))["runId"]

    shared = distribute_runs(db, [first, second])
    assert shared["assigned"] == 1  # only the run nobody had
    assert sorted(reviewer["id"] for reviewer in get_research_run(db, other)["reviewers"]) == sorted([first, second])
    assert {row["id"]: row["pendingCount"] for row in list_reviewers(db)}[first] >= 1

    submit(client, run_id, first)
    submit(client, run_id, second)
    assert {row["id"]: row["reviewedCount"] for row in list_reviewers(db)}[first] == 1
    assert page_research_runs(db, reviewer=str(third), status="pending")["total"] >= 1
    # The run only waits for the third reviewer; unassigning them completes it.
    removed = client.post("/api/v1/admin/research-runs/assign",
                          json={"runIds": [run_id], "reviewerIds": [third], "mode": "remove"})
    assert removed.json() == {"assigned": 1}
    saved = get_research_run(db, run_id)
    assert (saved["reviewStatus"], [reviewer["id"] for reviewer in saved["reviewers"]]) == ("saved", [first, second])
    assert db.scalar(select(ModelInfo.model_id).where(ModelInfo.model_id == "org/model")) == "org/model"

    # `set` replaces the reviewers of a run; an empty list unassigns everyone.
    assign_runs(db, AssignRunsRequest(runIds=[other], reviewerIds=[third], mode="set"))
    assert [reviewer["id"] for reviewer in get_research_run(db, other)["reviewers"]] == [third]
    assign_runs(db, AssignRunsRequest(runIds=[other], mode="set"))
    assert get_research_run(db, other)["reviewers"] == []
    assert client.get(f"/api/v1/admin/research-runs/{other}/reviews/{third}").status_code == 404
