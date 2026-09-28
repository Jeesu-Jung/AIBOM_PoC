"""LLM-facing AIBOM draft schema and its conversion to the admin AIBOM payload (AibomWrite).

The research prompts (app/research.py) ask OpenRouter for an `aibom` object next to the catalog
draft. OpenAI-style strict JSON schemas cannot carry free-form dictionaries, so this schema uses
fixed keys (e.g. architecture) and name/value lists (hyperparameters); `aibom_write_from_draft`
turns it into the table-shaped payload that `PUT /api/v1/admin/models/{id}/aibom` accepts.
Every field description doubles as the glossary the research model reads.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field

from .aibom import AibomWrite

RELATION_VOCABULARY: tuple[str, ...] = (
    "pretrained", "continued_pretrained_from", "instruction_tuned_from", "fine_tuned_from",
    "task_fine_tuned_from", "domain_fine_tuned_from", "preference_optimized_from", "adapter_trained_from",
    "context_extended_from", "distilled_from", "merged_from", "quantized_from", "converted_from",
)
DATASET_RELATIONS = Literal["derived_from", "filtered_from", "translated_from", "generated_from", "subset_of"]
Disclosure = Literal["disclosed", "partially_disclosed", "undisclosed"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ArchitectureDraft(_Strict):
    family: str | None = Field(description="Architecture family, e.g. `decoder-only Transformer`, `MoE Transformer`.")
    parameter_count: int | None = Field(
        description="Exact total parameter count as an integer when a source states it (HF safetensors "
                    "metadata or config), e.g. 8030261248. Null instead of rounding a `8B` label.")
    context_length: int | None = Field(description="Maximum context length in tokens as configured in the released artifact.")
    layers: int | None = Field(description="Number of transformer layers (config `num_hidden_layers`).")
    hidden_size: int | None = Field(description="Hidden size (config `hidden_size`).")
    attention_heads: int | None = Field(description="Attention heads (config `num_attention_heads`).")
    kv_heads: int | None = Field(description="Key/value heads (config `num_key_value_heads`).")
    activation: str | None = Field(description="Activation function, e.g. `SwiGLU`.")
    position_embedding: str | None = Field(description="Position embedding, e.g. `RoPE`.")


class TokenizerDraft(_Strict):
    name: str | None = Field(description="Tokenizer type or class, e.g. `tiktoken-based BPE (Llama 3 tokenizer)`.")
    vocab_size: int | None = Field(description="Vocabulary size from the config or paper.")


class ArtifactDraft(_Strict):
    format: str | None = Field(
        description="Primary weight file format of this repository, e.g. `safetensors`, `pytorch`, `gguf`, `mlx`, "
                    "`PEFT LoRA adapter`.")
    tensor_type: str | None = Field(
        description="Weight precision shown on the model page or config, e.g. `BF16`, `FP16`, `Q4_K_M`; repository spelling.")


class ModalityDraft(_Strict):
    input: list[str] = Field(description="Input modalities, e.g. [`text`] or [`text`, `image`].")
    output: list[str] = Field(description="Output modalities.")
    languages: list[str] = Field(description="Officially supported languages as ISO 639-1 codes; empty if unstated.")


class ModelAreaDraft(_Strict):
    architecture: ArchitectureDraft
    tokenizer: TokenizerDraft
    modality: ModalityDraft
    artifact: ArtifactDraft
    intended_use: str | None = Field(
        description="One or two English sentences on the officially intended use and scenarios. Not a pipeline tag.")
    capabilities: list[str] = Field(description="Short phrases for documented capabilities.")
    limitations: list[str] = Field(description="Short phrases for documented limitations.")
    knowledge_cutoff: str | None = Field(description="Knowledge / data cutoff as stated, e.g. `2023-12`; null if unstated.")
    release_date: date | None = Field(description="Release date of THIS model (not the family), ISO date, only when stated.")
    evidence_urls: list[str] = Field(description="URLs supporting the MODEL fields above.")


class ProvenanceDraft(_Strict):
    origin: str | None = Field(description="Root of the lineage, e.g. `Meta Llama 3.1`, `Qwen2.5`.")
    provider: str | None = Field(description="Organisation or user that released THIS model.")
    relation: Literal[RELATION_VOCABULARY] = Field(  # type: ignore[valid-type]
        description="Relation of this model to its direct parent (transformation inputs with role base / "
                    "merge_source); `pretrained` when trained from scratch.")
    disclosure_status: Disclosure = Field(description="How completely the sources disclose this model's lineage.")
    notes: str | None = Field(description="Short English note on lineage caveats or conflicts; null if none.")
    evidence_urls: list[str] = Field(description="URLs that state the lineage.")


class TransformationInputDraft(_Strict):
    model: str = Field(
        description="Exact Hugging Face id (`namespace/name`) of an input model, or a plain name such as "
                    "`GPT-4o` for models outside Hugging Face.")
    role: Literal["base", "merge_source", "teacher", "generator", "verifier", "reward_model"] = Field(
        description="`base`: the checkpoint that was trained/adapted/converted (also for official Instruct "
                    "models, whose base is the pretrained checkpoint). `merge_source` for merges; the other "
                    "roles for models that only produced data, rewards or verification.")


class NameValue(_Strict):
    name: str
    value: str = Field(description="Value as written in the source, e.g. `1e-7`, `3`, `r=8, alpha=16`.")


class TransformationDatasetDraft(_Strict):
    dataset: str = Field(description="`identity` of an entry in `datasets`.")
    role: Literal["pretraining", "finetuning", "preference", "distillation", "calibration", "other"]


class TransformationDraft(_Strict):
    inputs: list[TransformationInputDraft] = Field(description="Empty only for models pretrained from scratch.")
    method: list[str] = Field(description="Ordered training / transformation steps, e.g. [`SFT`, `DPO`] or [`pretraining`].")
    objective: str | None = Field(description="Why the transformation was done.")
    hyperparameters: list[NameValue] = Field(description="Stated training settings, including adapter rank/alpha.")
    datasets: list[TransformationDatasetDraft] = Field(description="Datasets used by this transformation.")
    timestamp: date | None = Field(description="Date the output was trained or released, ISO date, when stated.")
    notes: str | None = Field(description="Short English note, e.g. undisclosed steps; null if none.")
    evidence_urls: list[str]


class DatasetParentDraft(_Strict):
    dataset: str = Field(description="`identity` of another entry in `datasets` this one was derived from.")
    relation: DATASET_RELATIONS


class DatasetDraft(_Strict):
    identity: str = Field(
        description="Hugging Face dataset id when one exists (reuse ids from the catalog context, e.g. "
                    "`cais/mmlu`); otherwise `slug:<lowercase-dashed-name>`. Undisclosed corpora get one "
                    "entry such as `slug:<family>-pretraining-mixture`.")
    name: str
    version: str | None = Field(description="Dataset revision / version as stated; null if unknown.")
    license: str | None = Field(description="Dataset license as declared; null if unknown.")
    provider: str | None
    description: str | None = Field(description="One short sentence.")
    size: str | None = Field(description="Free text, e.g. `40K examples`, `15T tokens`.")
    uri: str | None
    disclosure_status: Disclosure
    processing: list[str] = Field(description="Stated preprocessing / filtering steps.")
    parents: list[DatasetParentDraft]
    evidence_urls: list[str]


class EvaluationDraft(_Strict):
    benchmark: str = Field(description="Benchmark name as reported, including subset, e.g. `MMLU-Pro (Health)`.")
    dataset: str | None = Field(description="`identity` of the matching entry in `datasets`, or null.")
    metric: str | None = Field(description="e.g. `acc`, `pass@1`, `exact_match`, `ASR`.")
    score: float | None = Field(description="Numeric score exactly as reported; null when not a plain number.")
    score_text: str | None = Field(description="Original wording when the score is not a plain number.")
    shots: int | None = Field(description="Few-shot count when stated.")
    configuration_notes: str | None = Field(description="CoT, prompt template, decoding or split details.")
    baseline_model: str | None = Field(description="Model the source compares against (e.g. the parent), exact id.")
    baseline_score: float | None
    evaluator_model: str | None = Field(description="Judge / verifier model used to score, if any.")
    source_url: str = Field(description="URL of the table or card the number comes from.")
    reported_at: date | None = Field(description="Publication date of that source revision when shown.")


class SafetyItemDraft(_Strict):
    description: str
    source_url: str | None


class SafetyDraft(_Strict):
    risk_summary: str | None = Field(description="One sentence summarising the documented risk posture.")
    safety_risk: list[SafetyItemDraft]
    ethical_considerations: list[SafetyItemDraft]
    prohibited_use: list[SafetyItemDraft]
    mitigation: list[SafetyItemDraft]


class LicenseDraft(_Strict):
    license: str = Field(description="Official license name, e.g. `Llama 3.1 Community License`, `Apache License 2.0`.")
    spdx_id: str | None = Field(description="SPDX id when one exists, e.g. `Apache-2.0`.")
    license_uri: str | None
    usage_policy: str | None = Field(description="Separate usage policy name, e.g. `Llama 3.1 Acceptable Use Policy`.")
    usage_policy_uri: str | None
    commercial_use: Literal["allowed", "restricted", "prohibited", "unknown"]
    restrictions: list[str] = Field(description="Explicit restrictions, e.g. MAU thresholds, attribution, naming rules.")
    kind: Literal["declared", "concluded"] = Field(
        description="`declared` when the repository/paper states it; `concluded` when inherited from the base model.")
    scope_note: str | None
    source_url: str | None


class ReferenceDraft(_Strict):
    type: Literal["paper", "technical_report", "model_card", "dataset_card", "repository", "config",
                  "documentation", "license", "blog", "webpage"]
    uri: str
    title: str | None
    revision: str | None = Field(description="Git commit SHA, arXiv version (`v2`) or document version; null if unknown.")


class AibomDraft(_Strict):
    """The model's AIBOM: the 8 areas of the AIBOM schema (MODEL, PROVENANCE, TRANSFORMATION, DATASET,
    EVALUATION, SAFETY_ETHICS, LICENSE_POLICY, REFERENCE), separate from the catalog draft. Every list
    may be empty and every value may be null when the sources are silent; never guess."""

    model: ModelAreaDraft
    provenance: ProvenanceDraft
    transformation: TransformationDraft
    datasets: list[DatasetDraft]
    evaluations: list[EvaluationDraft] = Field(
        description="This model's own reported results (official card / paper tables), up to ~25 rows. "
                    "Never copy the parent model's numbers as this model's results.")
    safety_ethics: SafetyDraft
    license_policy: list[LicenseDraft]
    references: list[ReferenceDraft] = Field(description="Every source document opened, with its revision when shown.")
    unknowns: list[str] = Field(description="English phrases for facts the sources do not disclose.")


# --- conversion ------------------------------------------------------------------------------

def _compact(value: dict[str, Any]) -> dict[str, Any] | None:
    result = {k: v for k, v in value.items() if v not in (None, "", [], {})}
    return result or None


def _norm(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def reference_type(uri: str) -> str:
    host = urlparse(uri).netloc.lower()
    path = urlparse(uri).path.lower()
    if "arxiv.org" in host or "aclanthology" in host or "openreview" in host:
        return "paper"
    if "huggingface.co" in host:
        if path.startswith("/datasets/"):
            return "dataset_card"
        return "config" if path.endswith(".json") or path.startswith("/api/") else "model_card"
    if "github.com" in host or "githubusercontent" in host:
        return "repository"
    return "webpage"


def aibom_write_from_draft(draft: AibomDraft | dict[str, Any]) -> dict[str, Any]:
    """Turn the LLM draft into an `AibomWrite` payload (validated), ready for the admin PUT."""
    d = draft if isinstance(draft, AibomDraft) else AibomDraft.model_validate(draft)
    m, pv, tr, safety = d.model, d.provenance, d.transformation, d.safety_ethics

    references: dict[str, dict[str, Any]] = {}
    for ref in d.references:
        references[ref.uri] = {"type": ref.type, "uri": ref.uri, "revision": ref.revision,
                               "extensions": _compact({"title": ref.title, "source": "ai_research"})}

    def cite(urls: list[str | None]) -> list[str]:
        cited = [u for u in urls if u]
        for uri in cited:
            references.setdefault(uri, {"type": reference_type(uri), "uri": uri,
                                        "extensions": {"source": "ai_research"}})
        return list(dict.fromkeys(cited))

    dataset_ids = {ds.identity for ds in d.datasets}
    datasets = [{
        "identity": ds.identity, "version": ds.version, "processing": ds.processing, "license": ds.license,
        "extensions": _compact({"name": ds.name, "hf_id": None if ds.identity.startswith("slug:") else ds.identity,
                                "uri": ds.uri, "description": ds.description, "size": ds.size,
                                "provider": ds.provider}),
        "provenance": {
            "provider": ds.provider,
            "parent": [p.dataset for p in ds.parents if p.dataset in dataset_ids and p.dataset != ds.identity],
            "relation": next((p.relation for p in ds.parents if p.dataset in dataset_ids), "original"),
            "evidence": cite(ds.evidence_urls),
            "extensions": {"disclosure_status": ds.disclosure_status},
        },
    } for ds in d.datasets]

    # The two research routes often report the same number from different pages, with different metric
    # spellings (`accuracy_percent` / `accuracy (%)`) and dataset keys (HF id / slug). Keep one row per
    # (benchmark, normalized metric, score, shots), prefer a real dataset id, and remember the other sources.
    evaluations: list[EvaluationDraft] = []
    also_reported: dict[int, list[str]] = {}
    seen_evaluations: dict[tuple, int] = {}
    for ev in d.evaluations:
        key = (_norm(ev.benchmark), _norm(ev.metric).replace("percent", ""), ev.score, ev.score_text, ev.shots)
        if key in seen_evaluations:
            index = seen_evaluations[key]
            kept = evaluations[index]
            if ev.dataset and (not kept.dataset or (kept.dataset.startswith("slug:") and not ev.dataset.startswith("slug:"))):
                evaluations[index] = kept.model_copy(update={"dataset": ev.dataset})
            if ev.source_url not in also_reported.setdefault(index, []):
                also_reported[index].append(ev.source_url)
            continue
        seen_evaluations[key] = len(evaluations)
        evaluations.append(ev)

    payload = {
        "model": {
            "architecture": _compact(m.architecture.model_dump()),
            "tokenizer": _compact(m.tokenizer.model_dump()),
            "modality": _compact(m.modality.model_dump()),
            "intended_use": m.intended_use,
            "capabilities": m.capabilities,
            "limitations": m.limitations,
            "extensions": _compact({"knowledge_cutoff": m.knowledge_cutoff,
                                    "release_date": m.release_date.isoformat() if m.release_date else None,
                                    "artifact": _compact(m.artifact.model_dump()),
                                    "unknowns": d.unknowns, "evidence": cite(m.evidence_urls),
                                    "source": "ai_research"}),
        },
        "provenance": {
            "origin": pv.origin, "provider": pv.provider, "relation": pv.relation,
            "evidence": cite(pv.evidence_urls),
            "extensions": _compact({"disclosure_status": pv.disclosure_status, "notes": pv.notes}),
        },
        "transformation": {
            "input": [{"model": i.model, "role": i.role} for i in tr.inputs],
            "method": tr.method,
            "objective": tr.objective,
            "hyperparameters": {hp.name: hp.value for hp in tr.hyperparameters} or None,
            "datasets": [{"dataset": x.dataset, "role": x.role} for x in tr.datasets if x.dataset in dataset_ids],
            "timestamp": tr.timestamp.isoformat() if tr.timestamp else None,
            "extensions": _compact({"notes": tr.notes, "evidence": cite(tr.evidence_urls)}),
        },
        "evaluation": [{
            "dataset": ev.dataset if ev.dataset in dataset_ids else None,
            "configuration": _compact({"benchmark": ev.benchmark, "shots": ev.shots, "notes": ev.configuration_notes}),
            "metric": ev.metric,
            "score": ev.score,
            "timestamp": ev.reported_at.isoformat() if ev.reported_at else None,
            "extensions": _compact({"score_text": ev.score_text, "baseline_model": ev.baseline_model,
                                    "baseline_score": ev.baseline_score, "evaluator_model": ev.evaluator_model,
                                    "reference": (cite([ev.source_url]) or [None])[0],
                                    "also_reported_in": [u for u in cite(also_reported.get(index, []))
                                                         if u != ev.source_url]}),
        } for index, ev in enumerate(evaluations)],
        "safety_ethics": None if not any([safety.safety_risk, safety.ethical_considerations, safety.prohibited_use,
                                          safety.mitigation, safety.risk_summary]) else {
            field: [_compact({"description": item.description, "reference": (cite([item.source_url]) or [None])[0]})
                    for item in getattr(safety, field)]
            for field in ("safety_risk", "ethical_considerations", "prohibited_use", "mitigation")
        } | {"extensions": _compact({"risk_summary": safety.risk_summary})},
        "license_policy": [{
            "license": lic.license, "usage_policy": lic.usage_policy, "restrictions": lic.restrictions,
            "extensions": _compact({"spdx_id": lic.spdx_id, "license_uri": lic.license_uri,
                                    "usage_policy_uri": lic.usage_policy_uri, "kind": lic.kind,
                                    "scope_note": lic.scope_note, "commercial_use": lic.commercial_use,
                                    "source": (cite([lic.source_url]) or [None])[0]}),
        } for lic in {lic.license: lic for lic in d.license_policy}.values()],
        "dataset": datasets,
    }
    payload["reference"] = list(references.values())
    # Like scripts/aibom/load_research.py: every opened source is evidence of the model record, with the
    # MODEL-field sources first.
    payload["model"]["extensions"] = _compact({**(payload["model"]["extensions"] or {}),
                                               "evidence": list(dict.fromkeys(cite(m.evidence_urls) + list(references)))})
    write = AibomWrite.model_validate(payload).model_dump(mode="json")
    for ev in write["evaluation"]:  # Decimal dumps as a string in JSON mode; keep scores numeric
        ev["score"] = float(ev["score"]) if ev["score"] is not None else None
    return write


def parameter_scale(count: int | None) -> str | None:
    """8030261248 -> `8.03B` (the catalog's compact parameterScale form)."""
    if not count:
        return None
    for size, unit in ((1e12, "T"), (1e9, "B"), (1e6, "M")):
        if count >= size:
            return f"{count / size:.2f}".rstrip("0").rstrip(".") + unit
    return str(count)


def catalog_fields_from_aibom(draft: AibomDraft) -> dict[str, Any]:
    """Catalog (model_info) columns that are no longer researched separately but derived from the AIBOM."""
    declared = [lic for lic in draft.license_policy if lic.kind == "declared"] or draft.license_policy
    licenses = list(dict.fromkeys((lic.spdx_id or lic.license).lower() for lic in declared))
    return {
        "licenseReported": licenses or None,
        "artifactFormat": draft.model.artifact.format,
        "tensorType": draft.model.artifact.tensor_type,
        "parameterScale": parameter_scale(draft.model.architecture.parameter_count),
        "artifactRevision": None,
    }


def summarize_aibom(write: dict[str, Any] | None) -> dict[str, int]:
    """Counts per area, for the admin review screen."""
    if not write:
        return {}
    tr = write.get("transformation") or {}
    safety = write.get("safety_ethics") or {}
    return {
        "transformation_inputs": len(tr.get("input") or []),
        "method_steps": len(tr.get("method") or []),
        "datasets": len(write.get("dataset") or []),
        "evaluations": len(write.get("evaluation") or []),
        "safety_items": sum(len(safety.get(k) or []) for k in ("safety_risk", "ethical_considerations",
                                                               "prohibited_use", "mitigation")),
        "licenses": len(write.get("license_policy") or []),
        "references": len(write.get("reference") or []),
    }
