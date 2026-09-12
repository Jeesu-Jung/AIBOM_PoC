from fastapi.testclient import TestClient

from app import main
from app.database import get_db


def _fake_db() -> object:
    return object()


def test_model_endpoint_returns_not_found(monkeypatch) -> None:
    monkeypatch.setattr(main, "load_model_row", lambda _db, _model_id: None)
    main.app.dependency_overrides[get_db] = _fake_db
    try:
        response = TestClient(main.app).get("/api/v1/models/example/missing")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 404
    assert response.json()["detail"] == "Model not found."


def test_families_endpoint_returns_lightweight_index(monkeypatch) -> None:
    payload = {
        "items": [{
            "familyKey": "sample",
            "familyName": "Sample",
            "releaseDate": "2026-01-01",
            "modelCount": 12,
            "rootCount": 2,
            "derivedCount": 10,
            "defaultNodeId": "org/root",
        }],
        "summary": {
            "familyCount": 1,
            "modelCount": 12,
            "rootCount": 2,
            "derivedCount": 10,
            "transformationTypeCount": 3,
            "latestRelease": "2026-01-01",
        },
    }
    monkeypatch.setattr(main, "load_family_index", lambda _db: payload)
    main.app.dependency_overrides[get_db] = _fake_db
    try:
        response = TestClient(main.app).get("/api/v1/families")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == payload
    assert "checklistRegistry" not in response.json()


def test_family_hierarchy_does_not_return_checklist_registry(monkeypatch) -> None:
    family = {"id": "sample", "root_nodes": [], "derived_models": []}
    monkeypatch.setattr(
        main,
        "build_catalog",
        lambda _rows: {
            "familyRegistry": {"sample": family},
            "checklistRegistry": {"org/root": {"large": "payload"}},
            "modelCount": 1,
        },
    )
    monkeypatch.setattr(main, "load_model_rows", lambda _db, family_key=None: [])
    main.app.dependency_overrides[get_db] = _fake_db
    try:
        response = TestClient(main.app).get("/api/v1/families/sample/hierarchy")
    finally:
        main.app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == family
