from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.admin import AdminModelWrite, create_admin_model, delete_admin_model, update_admin_model
from app.models import Base, ModelHierarchy


def session() -> Session:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine, expire_on_commit=False)


def payload(model_id: str, parent_id: str | None = None) -> AdminModelWrite:
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
        "detailsJson": {},
    })


def test_create_and_reparent_recalculates_entire_subtree() -> None:
    db = session()
    create_admin_model(db, payload("org/root-a"))
    create_admin_model(db, payload("org/root-b"))
    create_admin_model(db, payload("org/child", "org/root-a"))
    create_admin_model(db, payload("org/grandchild", "org/child"))

    update_admin_model(db, "org/child", payload("org/child", "org/root-b"))

    depths = dict(db.execute(select(ModelHierarchy.model_id, ModelHierarchy.hierarchy_depth)).tuples().all())
    assert depths["org/child"] == 1
    assert depths["org/grandchild"] == 2


def test_parent_with_children_cannot_be_deleted() -> None:
    db = session()
    create_admin_model(db, payload("org/root"))
    create_admin_model(db, payload("org/child", "org/root"))

    try:
        delete_admin_model(db, "org/root")
        assert False, "Expected deletion to be rejected"
    except Exception as error:
        assert getattr(error, "status_code", None) == 409


def test_cycle_is_rejected() -> None:
    db = session()
    create_admin_model(db, payload("org/root"))
    create_admin_model(db, payload("org/child", "org/root"))
    create_admin_model(db, payload("org/grandchild", "org/child"))

    try:
        update_admin_model(db, "org/root", payload("org/root", "org/grandchild"))
        assert False, "Expected hierarchy cycle to be rejected"
    except Exception as error:
        assert getattr(error, "status_code", None) == 422
