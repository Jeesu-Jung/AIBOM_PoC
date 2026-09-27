"""AIBOM area tables: per-model read model, admin writes, and lineage sync with the catalog.

The 8 areas of AIBOM_스키마_설계안.md live in their own tables (sql/004). model_info /
model_hierarchy stay the catalog that drives the UI tree; this module keeps the two consistent:
creating a model or changing its parent in the admin also updates provenance / transformation,
and deleting a model removes the AIBOM rows keyed by `model:<id>` (they carry no FK).
"""
from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any, Literal

from fastapi import HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .models import (
    AibomModel,
    Dataset,
    Evaluation,
    LicensePolicy,
    ModelInfo,
    Provenance,
    Reference,
    SafetyEthics,
    Transformation,
)

PARENT_ROLES = {"base", "merge_source"}
INPUT_ROLES = Literal["base", "merge_source", "teacher", "generator", "verifier", "reward_model"]
DATASET_ROLES = Literal["pretraining", "finetuning", "preference", "distillation", "calibration", "other"]
REFERENCE_TYPES = Literal["paper", "technical_report", "model_card", "dataset_card", "repository", "config",
                          "documentation", "license", "blog", "webpage"]
# transformation.datasets[].role -> dataset.role (the design's pretraining / finetuning / evaluation)
DATASET_ROLE_GROUP = {"pretraining": "pretraining"}


def model_subject(model_id: str) -> str:
    return f"model:{model_id}"


def dataset_subject(dataset_id: str) -> str:
    return f"dataset:{dataset_id}"


def relation_from_hierarchy(relationship_type: str | None) -> str | None:
    """model_hierarchy uses camelCase (fineTunedFrom); provenance.relation uses snake_case."""
    if not relationship_type:
        return None
    return re.sub(r"(?<!^)(?=[A-Z])", "_", relationship_type).lower()


def _json(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, date):
        return value.isoformat()
    return value


# --- read ----------------------------------------------------------------------------------------

def _reference_dict(ref: Reference) -> dict[str, Any]:
    return {"id": ref.id, "type": ref.type, "uri": ref.uri, "revision": ref.revision,
            "retrieved_at": _json(ref.retrieved_at), "hash": ref.hash, "extensions": ref.extensions}


def _provenance_dict(row: Provenance | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"id": row.id, "subject": row.subject, "origin": row.origin, "provider": row.provider,
            "parent": row.parent or [], "relation": row.relation, "evidence": row.evidence or [],
            "extensions": row.extensions}


def load_model_aibom(session: Session, model_id: str) -> dict[str, Any] | None:
    """All 8 areas for one model, field names as in the design document. None if nothing is stored."""
    model = session.get(AibomModel, model_id)
    provenance = session.scalar(select(Provenance).where(Provenance.subject == model_subject(model_id)))
    transformation = session.scalar(select(Transformation).where(Transformation.output == model_id))
    evaluations = list(session.scalars(select(Evaluation).where(Evaluation.model == model_id).order_by(Evaluation.id)))
    safety = session.get(SafetyEthics, model_id)
    licenses = list(session.scalars(select(LicensePolicy).where(LicensePolicy.subject == model_subject(model_id))
                                    .order_by(LicensePolicy.id)))
    if not any([model, provenance, transformation, evaluations, safety, licenses]):
        return None

    dataset_ids = [d.get("dataset") for d in (transformation.datasets or [])] if transformation else []
    dataset_ids += [e.dataset for e in evaluations if e.dataset]
    dataset_ids = list(dict.fromkeys(i for i in dataset_ids if i))
    datasets = {d.identity: d for d in session.scalars(select(Dataset).where(Dataset.identity.in_(dataset_ids)))} \
        if dataset_ids else {}
    dataset_provenance = {p.id: p for p in session.scalars(
        select(Provenance).where(Provenance.id.in_([d.provenance for d in datasets.values() if d.provenance])))} \
        if datasets else {}

    ref_ids = set((provenance.evidence or []) if provenance else []) | set(((model.extensions or {}).get("evidence") or [])
                                                                          if model else [])
    ref_uris = {(e.extensions or {}).get("reference") for e in evaluations}
    if transformation:
        ref_uris |= set((transformation.extensions or {}).get("evidence") or [])
    if safety:
        for field in ("safety_risk", "ethical_considerations", "prohibited_use", "mitigation"):
            ref_uris |= {item.get("reference") for item in getattr(safety, field) or [] if isinstance(item, dict)}
    ref_uris.discard(None)
    references = []
    if ref_ids or ref_uris:
        query = select(Reference).where((Reference.id.in_(ref_ids)) | (Reference.uri.in_(ref_uris)))
        references = [_reference_dict(r) for r in session.scalars(query.order_by(Reference.id))]

    return {
        "model": None if model is None else {
            "identity": model.identity, "architecture": model.architecture, "tokenizer": model.tokenizer,
            "modality": model.modality, "intended_use": model.intended_use, "capabilities": model.capabilities or [],
            "limitations": model.limitations or [], "provenance": model.provenance, "extensions": model.extensions,
        },
        "provenance": _provenance_dict(provenance),
        "transformation": None if transformation is None else {
            "id": transformation.id, "input": transformation.input or [], "output": transformation.output,
            "method": transformation.method or [], "objective": transformation.objective,
            "hyperparameters": transformation.hyperparameters, "datasets": transformation.datasets or [],
            "timestamp": _json(transformation.timestamp), "extensions": transformation.extensions,
        },
        "dataset": [{
            "identity": d.identity, "version": d.version,
            "role": [r for r in (d.role or "").split(",") if r],
            "processing": d.processing or [], "license": d.license, "extensions": d.extensions,
            "provenance": _provenance_dict(dataset_provenance.get(d.provenance)),
        } for d in (datasets[i] for i in dataset_ids if i in datasets)],
        "evaluation": [{
            "id": e.id, "model": e.model, "dataset": e.dataset, "configuration": e.configuration,
            "metric": e.metric, "score": _json(e.score), "timestamp": _json(e.timestamp), "extensions": e.extensions,
        } for e in evaluations],
        "safety_ethics": None if safety is None else {
            "subject": safety.subject, "safety_risk": safety.safety_risk or [],
            "ethical_considerations": safety.ethical_considerations or [],
            "prohibited_use": safety.prohibited_use or [], "mitigation": safety.mitigation or [],
            "extensions": safety.extensions,
        },
        "license_policy": [{
            "id": lic.id, "subject": lic.subject, "license": lic.license, "usage_policy": lic.usage_policy,
            "restrictions": lic.restrictions or [], "extensions": lic.extensions,
        } for lic in licenses],
        "reference": references,
    }


def load_aibom_options(session: Session) -> dict[str, Any]:
    """Datasets and references an admin can point to from an AIBOM payload."""
    return {
        "datasets": [{"identity": d.identity, "name": (d.extensions or {}).get("name") or d.identity,
                      "role": [r for r in (d.role or "").split(",") if r]}
                     for d in session.scalars(select(Dataset).order_by(Dataset.identity))],
        "references": [{"id": r.id, "type": r.type, "uri": r.uri, "title": (r.extensions or {}).get("title")}
                       for r in session.scalars(select(Reference).order_by(Reference.id))],
    }


# --- write ---------------------------------------------------------------------------------------

class _Area(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelArea(_Area):
    architecture: dict[str, Any] | None = None
    tokenizer: dict[str, Any] | None = None
    modality: dict[str, Any] | None = None
    intended_use: str | None = None
    capabilities: list[Any] = Field(default_factory=list)
    limitations: list[Any] = Field(default_factory=list)
    extensions: dict[str, Any] | None = None


class ProvenanceArea(_Area):
    origin: str | None = Field(default=None, max_length=255)
    provider: str | None = Field(default=None, max_length=255)
    relation: str | None = Field(default=None, max_length=50)
    evidence: list[int | str] = Field(default_factory=list,
                                      description="reference ids, or URIs (unknown URIs become new references)")
    extensions: dict[str, Any] | None = None


class TransformationInput(_Area):
    model: str = Field(min_length=1, max_length=512)
    role: INPUT_ROLES = "base"


class TransformationDataset(_Area):
    dataset: str = Field(min_length=1, max_length=255)
    role: DATASET_ROLES = "other"


class TransformationArea(_Area):
    input: list[TransformationInput] = Field(default_factory=list)
    method: list[Any] = Field(default_factory=list)
    objective: str | None = None
    hyperparameters: dict[str, Any] | None = None
    datasets: list[TransformationDataset] = Field(default_factory=list)
    timestamp: date | None = None
    extensions: dict[str, Any] | None = None


class EvaluationArea(_Area):
    dataset: str | None = Field(default=None, max_length=255)
    configuration: dict[str, Any] | None = None
    metric: str | None = Field(default=None, max_length=255)
    score: Decimal | None = None
    timestamp: date | None = None
    extensions: dict[str, Any] | None = None


class SafetyEthicsArea(_Area):
    safety_risk: list[Any] = Field(default_factory=list)
    ethical_considerations: list[Any] = Field(default_factory=list)
    prohibited_use: list[Any] = Field(default_factory=list)
    mitigation: list[Any] = Field(default_factory=list)
    extensions: dict[str, Any] | None = None


class LicensePolicyArea(_Area):
    license: str = Field(min_length=1, max_length=200)
    usage_policy: str | None = Field(default=None, max_length=255)
    restrictions: list[Any] = Field(default_factory=list)
    extensions: dict[str, Any] | None = None


class DatasetProvenanceArea(_Area):
    origin: str | None = Field(default=None, max_length=255)
    provider: str | None = Field(default=None, max_length=255)
    parent: list[str] = Field(default_factory=list, description="parent dataset identities (not `dataset:` subjects)")
    relation: str | None = Field(default=None, max_length=50)
    evidence: list[int | str] = Field(default_factory=list)
    extensions: dict[str, Any] | None = None


class DatasetArea(_Area):
    identity: str = Field(min_length=1, max_length=255)
    version: str | None = Field(default=None, max_length=255)
    processing: list[Any] = Field(default_factory=list)
    license: str | None = Field(default=None, max_length=255)
    extensions: dict[str, Any] | None = None
    provenance: DatasetProvenanceArea | None = Field(
        default=None, description="Replaces the dataset's PROVENANCE row when given; kept as-is when omitted.")


class ReferenceArea(_Area):
    type: REFERENCE_TYPES = "webpage"
    uri: str = Field(min_length=1, max_length=1000)
    revision: str | None = Field(default=None, max_length=255)
    retrieved_at: date | None = None
    hash: str | None = Field(default=None, max_length=64)
    extensions: dict[str, Any] | None = None


class AibomWrite(_Area):
    """Full replacement of one model's AIBOM rows. `dataset` / `reference` are upserted (shared rows)."""

    model: ModelArea = Field(default_factory=ModelArea)
    provenance: ProvenanceArea = Field(default_factory=ProvenanceArea)
    transformation: TransformationArea | None = None
    evaluation: list[EvaluationArea] = Field(default_factory=list)
    safety_ethics: SafetyEthicsArea | None = None
    license_policy: list[LicensePolicyArea] = Field(default_factory=list)
    dataset: list[DatasetArea] = Field(default_factory=list)
    reference: list[ReferenceArea] = Field(default_factory=list)


def _unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def _upsert_reference(session: Session, uri: str, area: ReferenceArea | None = None) -> Reference:
    ref = session.scalar(select(Reference).where(Reference.uri == uri))
    if ref is None:
        ref = Reference(uri=uri, type=area.type if area else "webpage", retrieved_at=date.today())
        session.add(ref)
    if area is not None:
        ref.type = area.type
        ref.revision = area.revision or ref.revision
        ref.retrieved_at = area.retrieved_at or ref.retrieved_at
        ref.hash = area.hash or ref.hash
        ref.extensions = area.extensions or ref.extensions
    session.flush()
    return ref


def _resolve_evidence(session: Session, items: list[int | str]) -> list[int]:
    ids: list[int] = []
    for item in items:
        if isinstance(item, int):
            if session.get(Reference, item) is None:
                raise _unprocessable(f"Reference #{item} does not exist.")
            ids.append(item)
        else:
            ids.append(_upsert_reference(session, item).id)
    return sorted(set(ids))


def refresh_dataset_roles(session: Session, dataset_ids: set[str]) -> None:
    """DATASET.role = every role the dataset plays across the catalog."""
    if not dataset_ids:
        return
    roles: dict[str, set[str]] = {i: set() for i in dataset_ids}
    for tr in session.scalars(select(Transformation)):
        for item in tr.datasets or []:
            if item.get("dataset") in roles:
                roles[item["dataset"]].add(DATASET_ROLE_GROUP.get(item.get("role"), "finetuning"))
    for (dataset_id,) in session.execute(select(Evaluation.dataset).where(Evaluation.dataset.in_(dataset_ids))):
        roles[dataset_id].add("evaluation")
    for dataset in session.scalars(select(Dataset).where(Dataset.identity.in_(dataset_ids))):
        dataset.role = ",".join(sorted(roles[dataset.identity])) or None


def save_model_aibom(session: Session, model_id: str, payload: AibomWrite) -> dict[str, Any]:
    info = session.get(ModelInfo, model_id)
    if info is None:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_id}")

    for ref in payload.reference:
        _upsert_reference(session, ref.uri, ref)
    payload_datasets = {ds.identity for ds in payload.dataset}
    for ds in payload.dataset:
        row = session.get(Dataset, ds.identity) or Dataset(identity=ds.identity)
        row.version, row.processing, row.license, row.extensions = ds.version, ds.processing, ds.license, ds.extensions
        session.add(row)
    session.flush()
    for ds in payload.dataset:
        if ds.provenance is not None:
            _replace_dataset_provenance(session, ds.identity, ds.provenance, payload_datasets)

    known_models = set(session.scalars(select(ModelInfo.model_id)))
    tr = payload.transformation
    referenced = {d.dataset for d in (tr.datasets if tr else [])} | {e.dataset for e in payload.evaluation if e.dataset}
    existing = set(session.scalars(select(Dataset.identity).where(Dataset.identity.in_(referenced)))) if referenced else set()
    if missing := sorted(referenced - existing):
        raise _unprocessable(f"Unknown dataset(s): {', '.join(missing)}. Add them under `dataset` first.")
    if tr and any(i.model == model_id for i in tr.input):
        raise _unprocessable("A model cannot be an input of its own transformation.")

    old_datasets = _model_dataset_ids(session, model_id)
    _delete_model_rows(session, model_id)

    pv = payload.provenance
    inputs = [{"model": i.model, "role": i.role, "external": i.model not in known_models} for i in (tr.input if tr else [])]
    provenance = Provenance(
        subject=model_subject(model_id), origin=pv.origin, provider=pv.provider, relation=pv.relation,
        parent=[model_subject(i["model"]) for i in inputs if i["role"] in PARENT_ROLES] or None,
        evidence=_resolve_evidence(session, pv.evidence) or None, extensions=pv.extensions)
    session.add(provenance)
    session.flush()

    m = payload.model
    model_extensions = dict(m.extensions or {}) or None
    if model_extensions and model_extensions.get("evidence"):
        # MODEL field evidence may be given as URIs (AI research); store reference ids like the loader does.
        model_extensions["evidence"] = _resolve_evidence(session, model_extensions["evidence"])
    session.add(AibomModel(identity=model_id, architecture=m.architecture, tokenizer=m.tokenizer, modality=m.modality,
                           intended_use=m.intended_use, capabilities=m.capabilities or None,
                           limitations=m.limitations or None, provenance=provenance.id, extensions=model_extensions))
    if tr is not None:
        session.add(Transformation(
            input=inputs or None, output=model_id, method=tr.method, objective=tr.objective,
            hyperparameters=tr.hyperparameters, datasets=[d.model_dump() for d in tr.datasets] or None,
            timestamp=tr.timestamp, extensions=tr.extensions))
    for ev in payload.evaluation:
        session.add(Evaluation(model=model_id, dataset=ev.dataset, configuration=ev.configuration, metric=ev.metric,
                               score=ev.score, timestamp=ev.timestamp, extensions=ev.extensions))
    if payload.safety_ethics is not None:
        s = payload.safety_ethics
        session.add(SafetyEthics(subject=model_id, safety_risk=s.safety_risk or None,
                                 ethical_considerations=s.ethical_considerations or None,
                                 prohibited_use=s.prohibited_use or None, mitigation=s.mitigation or None,
                                 extensions=s.extensions))
    seen_licenses: set[str] = set()
    for lic in payload.license_policy:
        if lic.license in seen_licenses:
            raise _unprocessable(f"License '{lic.license}' is listed twice.")
        seen_licenses.add(lic.license)
        session.add(LicensePolicy(subject=model_subject(model_id), license=lic.license, usage_policy=lic.usage_policy,
                                  restrictions=lic.restrictions or None, extensions=lic.extensions))
    session.flush()
    refresh_dataset_roles(session, old_datasets | referenced)
    session.commit()
    return load_model_aibom(session, model_id) or {}


def _replace_dataset_provenance(session: Session, dataset_id: str, area: DatasetProvenanceArea,
                                payload_datasets: set[str]) -> None:
    parents = [p for p in dict.fromkeys(area.parent) if p != dataset_id]
    known = payload_datasets | set(session.scalars(select(Dataset.identity).where(Dataset.identity.in_(parents))))         if parents else payload_datasets
    if missing := [p for p in parents if p not in known]:
        raise _unprocessable(f"Unknown parent dataset(s) for {dataset_id}: {', '.join(missing)}.")
    dataset = session.get(Dataset, dataset_id)
    subject = dataset_subject(dataset_id)
    dataset.provenance = None
    session.flush()
    session.execute(delete(Provenance).where(Provenance.subject == subject))
    row = Provenance(subject=subject, origin=area.origin, provider=area.provider,
                     parent=[dataset_subject(p) for p in parents] or None, relation=area.relation,
                     evidence=_resolve_evidence(session, area.evidence) or None, extensions=area.extensions)
    session.add(row)
    session.flush()
    dataset.provenance = row.id


# --- catalog <-> AIBOM consistency ------------------------------------------------------------

def _model_dataset_ids(session: Session, model_id: str) -> set[str]:
    ids = {e for (e,) in session.execute(select(Evaluation.dataset).where(Evaluation.model == model_id)) if e}
    tr = session.scalar(select(Transformation).where(Transformation.output == model_id))
    if tr:
        ids |= {d.get("dataset") for d in tr.datasets or [] if d.get("dataset")}
    return ids


def _delete_model_rows(session: Session, model_id: str) -> None:
    # Explicit deletes (not FK cascades) so SQLite and MySQL behave the same.
    session.execute(delete(Evaluation).where(Evaluation.model == model_id))
    session.execute(delete(Transformation).where(Transformation.output == model_id))
    session.execute(delete(SafetyEthics).where(SafetyEthics.subject == model_id))
    session.execute(delete(LicensePolicy).where(LicensePolicy.subject == model_subject(model_id)))
    session.execute(delete(AibomModel).where(AibomModel.identity == model_id))
    session.execute(delete(Provenance).where(Provenance.subject == model_subject(model_id)))
    session.flush()


def models_using_as_input(session: Session, model_id: str) -> list[str]:
    return sorted(tr.output for tr in session.scalars(select(Transformation))
                  if tr.output != model_id and any(i.get("model") == model_id for i in tr.input or []))


def delete_model_aibom(session: Session, model_id: str) -> None:
    """Called before a catalog model is deleted; refuses when other transformations consume it."""
    if users := models_using_as_input(session, model_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"This model is an input of other transformations ({', '.join(users)}). Update their AIBOM first.",
        )
    datasets = _model_dataset_ids(session, model_id)
    _delete_model_rows(session, model_id)
    refresh_dataset_roles(session, datasets)


def sync_catalog_lineage(session: Session, info: ModelInfo, parent_id: str | None, relationship_type: str | None,
                         parent_changed: bool) -> None:
    """Mirror a catalog create / re-parent into provenance.parent and transformation.input.

    Only runs on create or when the catalog parent actually changed, so AIBOM lineage that
    deliberately differs from the UI tree (e.g. an Instruct root whose base is recorded in the
    AIBOM) is not overwritten by unrelated edits.
    """
    model_id = info.model_id
    subject = model_subject(model_id)
    provenance = session.scalar(select(Provenance).where(Provenance.subject == subject))
    created = provenance is None
    if created:
        provenance = Provenance(subject=subject, origin=info.family_name, provider=info.supplier,
                                extensions={"disclosure_status": "disclosed", "source": "catalog"})
        session.add(provenance)
    elif not parent_changed:
        return

    transformation = session.scalar(select(Transformation).where(Transformation.output == model_id))
    others = [i for i in (transformation.input or [] if transformation else []) if i.get("role") not in PARENT_ROLES]
    inputs = ([{"model": parent_id, "role": "base", "external": False}] if parent_id else []) + others
    provenance.parent = [model_subject(parent_id)] if parent_id else None
    provenance.relation = relation_from_hierarchy(relationship_type) or ("pretrained" if not parent_id else None)
    if transformation is None and parent_id:
        transformation = Transformation(output=model_id, method=[], extensions={"source": "catalog"})
        session.add(transformation)
    if transformation is not None:
        transformation.input = inputs or None
    session.flush()

    if session.get(AibomModel, model_id) is None:
        # primary_purpose is a pipeline tag (e.g. text-generation), not MODEL.intended_use; leave it empty.
        session.add(AibomModel(identity=model_id, provenance=provenance.id))
    if created and info.family_license_name and not session.scalar(
            select(LicensePolicy).where(LicensePolicy.subject == subject)):
        session.add(LicensePolicy(subject=subject, license=info.family_license_name[:200],
                                  extensions={"source": "catalog"}))
    session.flush()


def count_relation_types(session: Session) -> int:
    relations = {r for (r,) in session.execute(select(Provenance.relation).where(Provenance.subject.like("model:%")))}
    relations.discard(None)
    relations.discard("pretrained")
    return len(relations)
