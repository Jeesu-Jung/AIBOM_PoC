import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AibomEditor from "./components/admin/AibomEditor.jsx";
import { ModelResearchRuns } from "./components/admin/ResearchHistory.jsx";
import { aibomDerivedFields, mergeFields } from "./constants/researchFields.js";
import AibomAreas from "./components/aibom/AibomAreas.jsx";
import { aibomDraftToView } from "./domain/aibomView.js";
import { composeEvidence, datasetsWithoutEvidence, describeEvidence, pruneEvidence, rekeyEvidence, swapEvidence } from "./domain/evidence.js";
import EvidenceLinks from "./components/admin/EvidenceLinks.jsx";
import { focusInputOnLabelClick } from "./utils/labelClick.js";
import SourcePicker, { MANUAL, RESEARCH_SOURCES, sourceLabel as chipLabel } from "./components/admin/SourcePicker.jsx";
import { createAdminModel, deleteAdminModel, fetchAdminModels, fetchAdminResearchResults, fetchAdminModelEvidence, fetchResearchRun, fetchResearchRunStatus, fetchResearchRuns, fetchRunReview, finalizeResearchRun, linkResearchRun, saveAdminModelEvidence, saveAdminModelWithAibom, saveAdminResearchResults, streamAdminModelMerge, streamAdminModelResearch, submitRunReview, updateAdminModel } from "./api/admin.js";

const EMPTY_MODEL = {
  modelId: "", namespace: "", modelName: "", familyKey: "", familyName: "", modelRole: "DERIVED",
  supplier: "", releaseDate: "", primaryPurpose: "",
  modelVersion: "", packageUrl: "", modelUrl: "", licenseReported: null, artifactFormat: "", tensorType: "",
  parameterScale: "", artifactRevision: "", description: "", bomFormat: null, bomSpecVersion: null,
  bomSerialNumber: null, bomVersion: null, checklistPresentFields: null, checklistTotalFields: null,
  checklistScore: null, checklistPenaltyFactor: null, sourceGeneratedAt: null, detailsJson: {}, parentModelId: null,
  relationshipType: null, hierarchyDepth: 0, siblingOrder: 0, changeDetailsJson: null
};

const textFields = [
  ["supplier", "Supplier"],
  ["primaryPurpose", "Primary purpose"], ["modelVersion", "Model version"], ["artifactFormat", "Artifact format"],
  ["tensorType", "Tensor type"], ["parameterScale", "Parameter scale"], ["artifactRevision", "Artifact revision"],
  ["packageUrl", "Package URL"]
];

function treeOrder(models) {
  const byParent = new Map();
  models.forEach((model) => {
    const key = model.parentModelId || "__root__";
    byParent.set(key, [...(byParent.get(key) || []), model]);
  });
  byParent.forEach((items) => items.sort((a, b) => a.siblingOrder - b.siblingOrder || a.modelId.localeCompare(b.modelId)));
  const result = [];
  const visited = new Set();
  const visit = (model, depth) => {
    if (visited.has(model.modelId)) return;
    visited.add(model.modelId);
    result.push({ model, depth });
    (byParent.get(model.modelId) || []).forEach((child) => visit(child, depth + 1));
  };
  (byParent.get("__root__") || []).forEach((root) => visit(root, 0));
  models.filter((model) => !visited.has(model.modelId)).forEach((model) => visit(model, model.hierarchyDepth || 0));
  return result;
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeForForm(model) {
  const next = { ...EMPTY_MODEL, ...model };
  Object.keys(next).forEach((key) => { if (next[key] === null && typeof EMPTY_MODEL[key] === "string") next[key] = ""; });
  return next;
}

// `evidence`: evidence rows of this value (AI research), listed right under the input.
// `picker`: chips to take the value from a research result (see `pk` in AdminApp).
function Field({ label, children, wide = false, evidence = null, picker = null }) {
  return <label className={`admin-field${wide ? " admin-field-wide" : ""}`} onClick={focusInputOnLabelClick}><span>{label}</span>{picker}{children}<EvidenceLinks rows={evidence} /></label>;
}

function Input({ field, form, setForm, ...props }) {
  return <input value={form[field] ?? ""} onChange={(event) => setForm({ ...form, [field]: event.target.value })} {...props} />;
}

const stageLabels = {
  researching: "웹 검색 및 분석",
  merging: "AI 병합",
  validating: "응답 검증"
};

const researchSources = [
  { value: "huggingface", label: "Hugging Face", short: "HF", hint: "저장소 페이지와 모델 카드 메타데이터에서 정보를 수집합니다." },
  { value: "paper", label: "논문 · 기술 보고서", short: "논문", hint: "arXiv 등에서 공식 논문을 찾아 개발사, 공개일, 규모, 계보를 수집합니다." }
];
const sourceKeys = researchSources.map((option) => option.value);
const sourceLabel = (key) => (key === "merged" ? "AI 병합" : researchSources.find((option) => option.value === key)?.label || key || "-");

/**
 * The draft a research run gives without any manual choice: the AI merge when there is one, else
 * the single result. Used to open a stored run in the editor (`/admin?run=<id>`).
 */
function draftFromResults(results) {
  const baseKey = ["merged", "huggingface", "paper"].find((key) => results[key]?.draft);
  if (!baseKey) return null;
  const aibomKey = ["merged", "huggingface", "paper"].find((key) => results[key]?.aibom) || null;
  const draft = { ...results[baseKey].draft };
  aibomDerivedFields.forEach((field) => { draft[field] = results[aibomKey]?.draft?.[field] ?? draft[field] ?? null; });
  return {
    draft,
    aibom: aibomKey ? results[aibomKey].aibom : null,
    evidence: composeEvidence({
      results, baseKey, aibomKey, catalogFields: mergeFields.map(([field]) => field),
      overrides: {}, aibomOverrides: {}, aibomFieldOverrides: {}
    })
  };
}

const linkedFieldGroups = [["modelId", "namespace", "modelName"], ["familyKey", "familyName"]];
const identityFields = linkedFieldGroups[0];
// Catalog fields that research results carry a value for (hierarchy fields are set by the tree, not picked).
const pickableFields = new Set([...mergeFields.map(([field]) => field), ...aibomDerivedFields.filter((field) => field !== "licenseReported")]);
const statusLabels = { found: "확인됨", ambiguous: "후보 여러 개", not_found: "찾지 못함" };
const decisionLabels = { huggingface: "HF 값", paper: "논문 값", combined: "두 결과 결합", none: "값 없음" };
const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
};

const isEmptyValue = (value) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const displayValue = (value) => (isEmptyValue(value) ? null : Array.isArray(value) ? value.join(", ") : String(value));
const evidenceFor = (result, field) => result?.fieldEvidence?.find((item) => item.fields?.includes(field)) || null;
// Family fields taken from the catalog parent instead of the research sources (backend: resolve_catalog_lineage).
const isInherited = (result, field) => Boolean(result?.catalogLineage?.inheritedFields?.includes(field));

function ResearchStreamLog({ events, partialContent, live = false }) {
  const publicEvents = events.filter((item) => item.type !== "provider_event");
  const providerEvents = events.filter((item) => item.type === "provider_event");
  return <div className="research-stream-log">
    <div className="research-stream-head"><strong>실시간 조사 로그</strong><span className={live ? "is-live" : ""}>{live ? "LIVE" : "완료"}</span></div>
    <ol className="research-event-list">
      {publicEvents.map((item, index) => <li key={`${item.type}-${index}`}>
        <span className={item.type === "error" ? "error" : item.type === "complete" ? "done" : ""}>{item.type === "complete" ? "✓" : item.type === "error" ? "!" : index + 1}</span>
        <div><strong>{item.type === "status" ? stageLabels[item.data.stage] || "진행 상태" : item.type === "activity" ? "도구 실행" : item.type === "complete" ? "초안 생성 완료" : "오류"}</strong><p>{item.data.message || (item.type === "complete" ? "구조화된 결과를 검증했습니다." : "")}</p></div>
      </li>)}
      {live && <li><span className="stream-pulse" /><div><strong>응답 수신 중</strong><p>{partialContent ? `${partialContent.length.toLocaleString()}자 생성됨` : "검색 결과를 기다리고 있습니다."}</p></div></li>}
    </ol>
    {partialContent && <details className="research-stream-detail"><summary>생성 중인 JSON 보기</summary><pre>{partialContent}</pre></details>}
    <details className="research-stream-detail"><summary>OpenRouter 원본 이벤트 {providerEvents.length}개</summary><pre>{providerEvents.length ? providerEvents.map((item) => JSON.stringify(item.data)).join("\n") : "아직 수신된 이벤트가 없습니다."}</pre></details>
  </div>;
}

const emptyRun = () => ({ status: "idle", events: [], partialContent: "", error: null });
const initialRuns = () => ({ huggingface: emptyRun(), paper: emptyRun(), merged: emptyRun() });

function RunStatusChip({ run, result }) {
  if (run.status === "loading") return <span className="ai-run-chip is-loading">진행 중</span>;
  if (run.status === "error") return <span className="ai-run-chip is-error">실패</span>;
  if (run.status === "skipped") return <span className="ai-run-chip">건너뜀</span>;
  if (result) return <span className={`ai-run-chip is-${result.status || "found"}`}>{statusLabels[result.status] || "완료"}</span>;
  if (run.status === "done") return <span className="ai-run-chip is-found">완료</span>;
  return <span className="ai-run-chip">대기</span>;
}

function PipelineSteps({ runs, results }) {
  const steps = [
    { key: "huggingface", label: "Hugging Face 조사" },
    { key: "paper", label: "논문 조사" },
    { key: "merged", label: "AI 병합" }
  ];
  return <ol className="ai-pipeline">
    {steps.map((step, index) => {
      const run = runs[step.key];
      const state = run.status === "loading" ? "active" : run.status === "done" ? "done" : run.status === "error" ? "error" : run.status === "skipped" ? "skipped" : "pending";
      return <li key={step.key} className={`is-${state}`}>
        <span>{state === "done" ? "✓" : state === "error" ? "!" : state === "skipped" ? "–" : index + 1}</span>
        <div><strong>{step.label}</strong><small>{state === "active" ? "진행 중" : state === "done" ? (results[step.key] ? statusLabels[results[step.key].status] || "완료" : "완료") : state === "error" ? run.error || "실패" : state === "skipped" ? "한 경로만 성공해 생략" : "대기"}</small></div>
      </li>;
    })}
  </ol>;
}

function ResultMiniSummary({ result }) {
  if (!result) return null;
  return <dl className="ai-mini-summary">
    <div><dt>Model ID</dt><dd>{result.draft.modelId}</dd></div>
    <div><dt>Family</dt><dd>{result.draft.familyName || "-"}</dd></div>
    <div><dt>Role</dt><dd>{result.draft.modelRole}</dd></div>
    <div><dt>출처</dt><dd>{result.sources?.length || 0}개{result.research?.webSearchRequests != null ? ` · 검색 ${result.research.webSearchRequests}회` : ""}</dd></div>
  </dl>;
}

const aibomSummaryFields = [
  ["transformation_inputs", "Transformation inputs"], ["method_steps", "Method steps"], ["datasets", "Datasets"],
  ["evaluations", "Evaluations"], ["safety_items", "Safety items"], ["licenses", "Licenses"], ["references", "References"]
];
const aibomAreaLabels = {
  model: "MODEL", provenance: "PROVENANCE", transformation: "TRANSFORMATION", datasets: "DATASET",
  evaluations: "EVALUATION", safety_ethics: "SAFETY_ETHICS", license_policy: "LICENSE_POLICY", references: "REFERENCE"
};

const aibomComparisonFields = [
  ["MODEL", "model", ["architecture", "tokenizer", "modality", "intended_use", "capabilities", "limitations"]],
  ["PROVENANCE", "provenance", ["origin", "provider", "relation", "evidence"]],
  ["TRANSFORMATION", "transformation", ["input", "method", "objective", "hyperparameters", "datasets", "timestamp"]],
  ["DATASET", "dataset", ["identity", "version", "role", "processing", "license"]],
  ["EVALUATION", "evaluation", ["dataset", "configuration", "metric", "score", "timestamp"]],
  ["SAFETY_ETHICS", "safety_ethics", ["safety_risk", "ethical_considerations", "prohibited_use", "mitigation"]],
  ["LICENSE_POLICY", "license_policy", ["license", "usage_policy", "restrictions"]],
  ["REFERENCE", "reference", ["type", "uri", "revision", "retrieved_at", "hash"]]
];
const aibomValue = (value) => {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "—";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

// EVALUATION as one table: a row per reported result (benchmark, metric, shots), a column per research
// result. The per-field view showed each field as a separate JSON array, so a score could not be read
// next to its benchmark and dataset. The area is still picked as a whole, by column.
// The values inside one table cell, each under its field name, so a value is never shown without it.
function CellFields({ fields, title }) {
  return <dl className="ai-cell-fields" title={title || undefined}>{fields.map(([label, value]) => <div key={label}>
    <dt>{label}</dt>
    <dd>{value == null || value === "" || (Array.isArray(value) && !value.length) ? <i>—</i>
      : Array.isArray(value) ? <ul>{value.map((text, index) => <li key={index}>{text}</li>)}</ul> : value}</dd>
  </div>)}</dl>;
}

// Column headings of those tables: one button per research result, picking the whole area from it.
function AibomSourceHeads({ results, columns, area, selected, onSelect }) {
  return columns.map((option) => {
    const count = results[option.value]?.aibom ? (results[option.value].aibom[area] || []).length : null;
    return <th key={option.value} className={`ai-source-head${selected === option.value ? " is-selected" : ""}`}>
      <button type="button" disabled={count === null} aria-pressed={selected === option.value} onClick={() => onSelect(option.value)}
        title={`${option.label}의 ${area.toUpperCase()} 전체를 초안에 쓰기`}>{selected === option.value ? "✓ " : ""}{option.label}<small>{count === null ? "AIBOM 없음" : `${count}건`}</small></button>
    </th>;
  });
}

// DATASET as one table: a row per dataset identity, a column per research result. Each cell also says
// what that result uses the dataset for (its TRANSFORMATION role, how many EVALUATION rows point at it).
function AibomDatasetTable({ results, columns, selected, onSelect }) {
  const rows = [];
  const byId = new Map();
  [...columns].sort((a, b) => (b.value === "merged") - (a.value === "merged")).forEach((option) => {
    const aibom = results[option.value]?.aibom;
    (aibom?.dataset || []).forEach((item) => {
      if (!byId.has(item.identity)) { byId.set(item.identity, { id: item.identity, cells: {} }); rows.push(byId.get(item.identity)); }
      const roles = [...new Set((aibom.transformation?.datasets || []).filter((use) => use.dataset === item.identity).map((use) => use.role))];
      const evaluations = (aibom.evaluation || []).filter((evaluation) => evaluation.dataset === item.identity).length;
      const uses = [...roles, ...(evaluations ? [`evaluation ${evaluations}건`] : [])];
      const parents = item.provenance?.parent || [];
      byId.get(item.identity).cells[option.value] = {
        name: item.extensions?.name || item.identity,
        uses,
        facts: [
          ["version", item.version], ["license", item.license], ["size", item.extensions?.size],
          ["disclosure", item.provenance?.extensions?.disclosure_status],
          ["parent", parents.length ? `${item.provenance.relation || "derived"} ← ${parents.map((parent) => parent.replace(/^dataset:/, "")).join(", ")}` : null]
        ],
        processing: item.processing || [],
        description: item.extensions?.description
      };
    });
  });
  const signature = (cell) => JSON.stringify([cell.uses, cell.facts, cell.processing]);
  const marked = rows.map((row) => ({
    ...row,
    differs: new Set(columns.map((option) => row.cells[option.value]).filter(Boolean).map(signature)).size > 1,
    partial: columns.some((option) => results[option.value]?.aibom && !row.cells[option.value])
  }));
  if (!rows.length) return <p className="ai-result-empty">어느 조사 결과에도 데이터셋이 없습니다.</p>;
  return <div className="ai-eval-table-wrap">
    <p className="ai-eval-summary">데이터셋 <b>{rows.length}</b>개 · 내용이 서로 다른 행 <b>{marked.filter((row) => row.differs).length}</b> · 일부 결과에만 있는 행 <b>{marked.filter((row) => row.partial).length}</b>. 열 제목을 누르면 DATASET 영역 전체가 그 결과의 값으로 정해집니다. 같은 데이터셋이라도 identity가 다르면(HF id / slug) 다른 행으로 나옵니다.</p>
    <table className="ai-eval-table">
      <thead><tr>
        <th>Dataset identity</th>
        <AibomSourceHeads results={results} columns={columns} area="dataset" selected={selected} onSelect={onSelect} />
      </tr></thead>
      <tbody>{marked.map((row) => <tr key={row.id} className={row.differs ? "is-diff" : ""}>
        <th scope="row">{row.id}{row.differs && <em>내용 다름</em>}</th>
        {columns.map((option) => {
          const cell = row.cells[option.value];
          return <td key={option.value} className={`ai-eval-cell ai-dataset-cell${selected === option.value ? " is-selected" : ""}${cell ? "" : " is-missing"}`}>
            {cell ? <CellFields title={cell.description} fields={[
              ["name", cell.name],
              ["사용처", cell.uses.length ? <span className="ai-dataset-uses">{cell.uses.map((use) => <b key={use}>{use}</b>)}</span> : null],
              ...cell.facts,
              ["processing", cell.processing]
            ]} /> : <span>없음</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

// REFERENCE as one table: a row per source URL, a column per research result. Each cell says how that
// result filed the source (type, revision) and how many of its values cite it.
function AibomReferenceTable({ results, columns, selected, onSelect }) {
  const rows = [];
  const byId = new Map();
  const urlKey = (uri) => String(uri || "").trim().replace(/\/+$/, "");
  [...columns].sort((a, b) => (b.value === "merged") - (a.value === "merged")).forEach((option) => {
    const result = results[option.value];
    (result?.aibom?.reference || []).forEach((item) => {
      const id = urlKey(item.uri);
      if (!byId.has(id)) { byId.set(id, { id, uri: item.uri, title: null, cells: {} }); rows.push(byId.get(id)); }
      const row = byId.get(id);
      row.title = row.title || item.extensions?.title || null;
      row.cells[option.value] = {
        type: item.type || "webpage", revision: item.revision || null,
        cited: (result.evidence || []).filter((evidence) => urlKey(evidence.url) === id).length
      };
    });
  });
  const marked = rows.map((row) => ({
    ...row,
    differs: new Set(columns.map((option) => row.cells[option.value]).filter(Boolean).map((cell) => `${cell.type}|${cell.revision || ""}`)).size > 1,
    partial: columns.some((option) => results[option.value]?.aibom && !row.cells[option.value])
  }));
  if (!rows.length) return <p className="ai-result-empty">어느 조사 결과에도 참조 자료가 없습니다.</p>;
  return <div className="ai-eval-table-wrap">
    <p className="ai-eval-summary">참조 자료 <b>{rows.length}</b>개 · 유형·리비전이 서로 다른 행 <b>{marked.filter((row) => row.differs).length}</b> · 일부 결과에만 있는 행 <b>{marked.filter((row) => row.partial).length}</b>. 열 제목을 누르면 REFERENCE 영역 전체가 그 결과의 값으로 정해집니다.</p>
    <table className="ai-eval-table">
      <thead><tr>
        <th className="is-wide">Source</th>
        <AibomSourceHeads results={results} columns={columns} area="reference" selected={selected} onSelect={onSelect} />
      </tr></thead>
      <tbody>{marked.map((row) => <tr key={row.id} className={row.differs ? "is-diff" : ""}>
        <th scope="row" className="ai-reference-source">{row.title && <span>{row.title}</span>}<a href={row.uri} target="_blank" rel="noreferrer">{row.uri} ↗</a>{row.differs && <em>유형·리비전 다름</em>}</th>
        {columns.map((option) => {
          const cell = row.cells[option.value];
          return <td key={option.value} className={`ai-eval-cell ai-dataset-cell${selected === option.value ? " is-selected" : ""}${cell ? "" : " is-missing"}`}>
            {cell ? <CellFields fields={[["type", cell.type], ["revision", cell.revision], ["인용", cell.cited ? `값 근거 ${cell.cited}곳` : "인용되지 않음"]]} /> : <span>없음</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

// LICENSE_POLICY as one table: a row per license name, a column per research result.
function AibomLicenseTable({ results, columns, selected, onSelect }) {
  const rows = [];
  const byId = new Map();
  [...columns].sort((a, b) => (b.value === "merged") - (a.value === "merged")).forEach((option) => {
    (results[option.value]?.aibom?.license_policy || []).forEach((item) => {
      const id = evaluationToken(item.license);
      if (!byId.has(id)) { byId.set(id, { id, license: item.license || "-", cells: {} }); rows.push(byId.get(id)); }
      const extensions = item.extensions || {};
      byId.get(id).cells[option.value] = {
        fields: [["spdx_id", extensions.spdx_id], ["kind", extensions.kind], ["commercial_use", extensions.commercial_use],
                 ["usage_policy", item.usage_policy], ["restrictions", item.restrictions || []]],
        tooltip: [extensions.scope_note, extensions.license_uri, extensions.usage_policy_uri, extensions.source].filter(Boolean).join("\n")
      };
    });
  });
  const marked = rows.map((row) => ({
    ...row,
    differs: new Set(columns.map((option) => row.cells[option.value]).filter(Boolean).map((cell) => JSON.stringify(cell.fields))).size > 1,
    partial: columns.some((option) => results[option.value]?.aibom && !row.cells[option.value])
  }));
  if (!rows.length) return <p className="ai-result-empty">어느 조사 결과에도 라이선스 정보가 없습니다.</p>;
  return <div className="ai-eval-table-wrap">
    <p className="ai-eval-summary">라이선스 <b>{rows.length}</b>개 · 내용이 서로 다른 행 <b>{marked.filter((row) => row.differs).length}</b> · 일부 결과에만 있는 행 <b>{marked.filter((row) => row.partial).length}</b>. 열 제목을 누르면 LICENSE_POLICY 영역 전체가 그 결과의 값으로 정해집니다.</p>
    <table className="ai-eval-table">
      <thead><tr>
        <th>License</th>
        <AibomSourceHeads results={results} columns={columns} area="license_policy" selected={selected} onSelect={onSelect} />
      </tr></thead>
      <tbody>{marked.map((row) => <tr key={row.id} className={row.differs ? "is-diff" : ""}>
        <th scope="row">{row.license}{row.differs && <em>내용 다름</em>}</th>
        {columns.map((option) => {
          const cell = row.cells[option.value];
          return <td key={option.value} className={`ai-eval-cell ai-dataset-cell${selected === option.value ? " is-selected" : ""}${cell ? "" : " is-missing"}`}>
            {cell ? <CellFields fields={cell.fields} title={cell.tooltip} /> : <span>없음</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

const evaluationToken = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const evaluationScore = (item) => item.score ?? item.extensions?.score_text ?? "—";
function AibomEvaluationTable({ results, columns, selected, onSelect }) {
  const rows = [];
  const byId = new Map();
  // The selected-by-default merge decides the row order; rows only the inputs have follow.
  [...columns].sort((a, b) => (b.value === "merged") - (a.value === "merged")).forEach((option) => {
    (results[option.value]?.aibom?.evaluation || []).forEach((item) => {
      const configuration = item.configuration || {};
      const id = [evaluationToken(configuration.benchmark), evaluationToken(item.metric).replace("percent", ""), configuration.shots ?? ""].join("|");
      if (!byId.has(id)) {
        byId.set(id, { id, benchmark: configuration.benchmark || "-", metric: item.metric || "-", shots: configuration.shots, cells: {} });
        rows.push(byId.get(id));
      }
      const cells = byId.get(id).cells;
      cells[option.value] = [...(cells[option.value] || []), item];
    });
  });
  const distinct = (row, read) => new Set(columns.map((option) => row.cells[option.value]).filter(Boolean)
    .map((items) => items.map(read).join(" / "))).size > 1;
  const marked = rows.map((row) => ({
    ...row,
    scoreDiffers: distinct(row, (item) => String(evaluationScore(item))),
    datasetDiffers: distinct(row, (item) => item.dataset || ""),
    partial: columns.some((option) => results[option.value]?.aibom && !row.cells[option.value])
  }));
  if (!rows.length) return <p className="ai-result-empty">어느 조사 결과에도 평가 결과가 없습니다.</p>;
  return <div className="ai-eval-table-wrap">
    <p className="ai-eval-summary">평가 결과 <b>{rows.length}</b>행 · 점수가 서로 다른 행 <b>{marked.filter((row) => row.scoreDiffers).length}</b> · 일부 결과에만 있는 행 <b>{marked.filter((row) => row.partial).length}</b>. 열 제목을 누르면 EVALUATION 영역 전체가 그 결과의 값으로 정해집니다.</p>
    <table className="ai-eval-table">
      <thead><tr>
        <th>Benchmark</th><th className="is-narrow">Metric</th><th className="is-tiny">Shots</th>
        <AibomSourceHeads results={results} columns={columns} area="evaluation" selected={selected} onSelect={onSelect} />
      </tr></thead>
      <tbody>{marked.map((row) => <tr key={row.id} className={row.scoreDiffers ? "is-diff" : ""}>
        <th scope="row">{row.benchmark}{row.scoreDiffers && <em>점수 다름</em>}{!row.scoreDiffers && row.datasetDiffers && <em className="is-soft">데이터셋 다름</em>}</th>
        <td>{row.metric}</td>
        <td>{row.shots ?? "—"}</td>
        {columns.map((option) => {
          const items = row.cells[option.value];
          return <td key={option.value} className={`ai-eval-cell${selected === option.value ? " is-selected" : ""}${items ? "" : " is-missing"}`}>
            {items ? items.map((item, index) => <div key={index} title={[item.configuration?.notes, item.extensions?.reference, item.extensions?.reference_locator].filter(Boolean).join("\n") || undefined}>
              <strong>{String(evaluationScore(item))}</strong>
              <small>dataset: {item.dataset || "미연결"}</small>
            </div>) : <span>없음</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

const AIBOM_TABLES = { evaluation: AibomEvaluationTable, dataset: AibomDatasetTable, reference: AibomReferenceTable, license_policy: AibomLicenseTable };
const AIBOM_AREA_ONLY = new Set(["dataset", "evaluation", "license_policy", "reference"]);
function AibomFullComparison({ results, columns, overrides, fieldOverrides, onSelect, onFieldSelect }) {
  return <div className="ai-aibom-full-comparison">
    {aibomComparisonFields.map(([label, key, fields]) => <details key={key} open>
      <summary>{label} <span>{AIBOM_TABLES[key] ? "결과별 비교 표" : `${fields.length} fields`}</span></summary>
      <div className="ai-aibom-area-actions"><span>이 영역 전체를 한 결과로 고르기</span>{columns.map((option) => <button type="button" key={option.value} className={overrides[key] === option.value ? "is-selected" : ""} onClick={() => onSelect(key, overrides[key] === option.value ? null : option.value)}>{overrides[key] === option.value ? "✓ " : ""}{option.label}</button>)}{overrides[key] && <button type="button" onClick={() => onSelect(key, null)}>AI 병합으로</button>}</div>
      {AIBOM_TABLES[key] ? createElement(AIBOM_TABLES[key], {
        results, columns, onSelect: (source) => onSelect(key, source),
        selected: overrides[key] || (columns.some((option) => option.value === "merged") ? "merged" : null)
      })
      : <div className="ai-aibom-full-table" style={{ "--aibom-columns": columns.length }}>
        <div className="ai-aibom-full-row is-head"><span>Field</span>{columns.map((option) => <span key={option.value}>{option.label}</span>)}</div>
        {fields.map((field) => <div className="ai-aibom-full-row" key={field}>{(() => {
          const fieldKey = key + "." + field;
          const areaOnly = AIBOM_AREA_ONLY.has(key);
          return <><strong>{field}{areaOnly && <small>영역 선택</small>}{!areaOnly && <small>필드 선택 가능</small>}</strong>{columns.map((option) => {
          const area = results[option.value]?.aibom?.[key];
          const value = Array.isArray(area) ? area.map((item) => item?.[field]) : area?.[field];
          const source = areaOnly ? overrides[key] : (fieldOverrides[fieldKey] || overrides[key]);
          const selected = source === option.value || (!source && option.value === "merged");
          // REFERENCE rows are the sources themselves; every other value shows the URLs behind it.
          const evidence = key === "reference" ? { label: null, tooltip: null }
            : describeEvidence(results[option.value]?.evidence, key, field, { listArea: areaOnly });
          const action = option.label + (areaOnly ? " " + key.toUpperCase() + " 영역" : " " + field) + "을 저장값으로 선택";
          return <button type="button" key={option.value} className={"ai-aibom-value-card" + (selected ? " is-selected" : "") + (option.value === "merged" ? " is-merged" : "")}
            onClick={() => areaOnly ? onSelect(key, option.value) : onFieldSelect(fieldKey, option.value)} title={evidence.tooltip ? action + "\n\n" + evidence.tooltip : action}>
            {selected && <span className="ai-aibom-card-check" aria-label="선택됨">✓</span>}<pre>{aibomValue(value)}</pre>
            {evidence.label && <small className="ai-aibom-evidence">{evidence.label}</small>}
          </button>;
        })}</>;
        })()}</div>)}
      </div>}
    </details>)}
  </div>;
}

function AibomDraftSummary({ results, chosenKey, overrides, fieldOverrides, onSelect, onFieldSelect }) {
  const [preview, setPreview] = useState(false);
  const chosen = chosenKey ? results[chosenKey] : null;
  const columns = [...researchSources, { value: "merged", label: "AI 병합" }].filter((option) => results[option.value]);
  if (!columns.some((option) => results[option.value]?.aibom)) {
    return <div className="ai-result-section"><div className="ai-result-heading"><strong>AIBOM 초안</strong></div>
      <p className="ai-result-empty">이 조사 결과에는 AIBOM 초안이 없습니다(이전 버전에서 저장된 결과). 다시 검색하면 AIBOM까지 조사합니다.</p></div>;
  }
  const decisions = results.merged?.areaDecisions || [];
  return <div className="ai-result-section">
    <div className="ai-result-heading"><strong>AIBOM 값 고르기</strong><span>칸을 누르면 그 값이 초안에 들어갑니다</span></div>
    <AibomFullComparison results={results} columns={columns} overrides={overrides} fieldOverrides={fieldOverrides} onSelect={onSelect} onFieldSelect={onFieldSelect} />
    {decisions.length > 0 && <ul className="ai-area-decisions">{decisions.map((item) => <li key={item.area}><b>{aibomAreaLabels[item.area] || item.area}</b> {decisionLabels[item.chosen] || item.chosen} · {item.rationale}</li>)}</ul>}
    {chosen?.aibom && <div className="ai-aibom-preview">
      <button type="button" className="admin-secondary" onClick={() => setPreview((value) => !value)} aria-expanded={preview}>
        {preview ? "AIBOM 미리보기 접기" : `${sourceLabel(chosenKey)} AIBOM 미리보기`}
      </button>
      {preview && <AibomAreas aibom={aibomDraftToView(chosen.aibom, chosen.draft?.modelId)} />}
    </div>}
    <p className="ai-merge-hint">“필드 선택 가능” 항목은 칸마다, “영역 선택” 항목(DATASET · EVALUATION · LICENSE_POLICY · REFERENCE)은 영역 전체를 한 결과로 고릅니다.</p>
  </div>;
}

function ValueCell({ result, run, field, state, onSelect, sourceName }) {
  if (!result) return <div className="ai-merge-cell is-unavailable" data-source={sourceName}><span>{run.status === "error" ? "조사 실패" : "결과 없음"}</span></div>;
  const value = displayValue(result.draft?.[field]);
  const inherited = isInherited(result, field);
  // An inherited value was not researched: the URLs the AI gave backed the family it suggested instead.
  const evidence = inherited ? null : evidenceFor(result, field);
  const lineage = result.catalogLineage || {};
  // Native tooltip: the action hint, then the evidence URLs (and the AI's note) behind "출처 N".
  const hint = [
    state === "selected" ? "현재 병합 값과 동일" : "이 값으로 바꾸기",
    inherited ? `부모 모델 ${lineage.parentModelId} 에서 상속한 값입니다.\nAI가 제안한 값: ${displayValue(lineage.suggestedFamily?.[field]) || "없음"}` : null,
    evidence?.urls?.length ? `출처 ${evidence.urls.length}개 (근거 ${evidence.confidence})\n${evidence.urls.map((url) => `• ${url}`).join("\n")}` : null,
    evidence?.note ? `메모: ${evidence.note}` : null
  ].filter(Boolean).join("\n\n");
  return <button type="button" className={`ai-merge-cell${state ? ` is-${state}` : ""}${value ? "" : " is-empty"}`} data-source={sourceName} onClick={onSelect} aria-pressed={state === "selected"} title={hint}>
    <strong>{value || "값 없음"}</strong>
    {inherited && <small className="is-inherited">부모 모델에서 상속</small>}
    {evidence && <small>근거 {evidence.confidence}{evidence.urls?.length ? ` · 출처 ${evidence.urls.length}` : ""}</small>}
  </button>;
}

function CreateModelDialog({ mode, onModeChange, onManual, onUseDraft, onClose }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("input");
  const [runs, setRuns] = useState(initialRuns);
  const [results, setResults] = useState({ huggingface: null, paper: null, merged: null });
  const [overrides, setOverrides] = useState({});
  const [aibomOverrides, setAibomOverrides] = useState({});
  const [aibomFieldOverrides, setAibomFieldOverrides] = useState({});
  const [searchError, setSearchError] = useState(null);
  const [stored, setStored] = useState(null);
  const [checkingStore, setCheckingStore] = useState(false);
  const [loadedFromStore, setLoadedFromStore] = useState(false);
  const [saveState, setSaveState] = useState({ status: "idle", message: "" });
  const [runId, setRunId] = useState(null);
  const runIdRef = useRef(null);
  const abortRef = useRef(null);
  const trackRun = (id) => { runIdRef.current = id; setRunId(id); };

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === "Escape" && stage !== "working") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [stage, onClose]);

  const updateRun = (key, patch) => setRuns((current) => ({ ...current, [key]: { ...current[key], ...(typeof patch === "function" ? patch(current[key]) : patch) } }));
  const streamHandler = (key) => (streamEvent) => {
    if (streamEvent.type === "content") updateRun(key, (run) => ({ partialContent: run.partialContent + (streamEvent.data.delta || "") }));
    else updateRun(key, (run) => ({ events: [...run.events, streamEvent] }));
  };

  const resetSearch = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRuns(initialRuns());
    setResults({ huggingface: null, paper: null, merged: null });
    setOverrides({});
    setAibomOverrides({});
    setAibomFieldOverrides({});
    setSearchError(null);
    setStored(null);
    setLoadedFromStore(false);
    setSaveState({ status: "idle", message: "" });
    trackRun(null);
    setStage("input");
  };

  // replacePrevious starts a new run; later saves (the merge) go into the same run. Runs are never overwritten.
  const persist = async (modelName, payload, replacePrevious) => {
    setSaveState({ status: "saving", message: "조사 결과를 저장하고 있습니다." });
    try {
      const saved = await saveAdminResearchResults(modelName, payload, replacePrevious, replacePrevious ? null : runIdRef.current);
      trackRun(saved.runId);
      setSaveState({ status: "saved", message: `조사 결과를 AI 조사 이력 #${saved.runId}에 저장했습니다 (${formatDateTime(saved.latestCreatedAt)}). 상단 “AI 조사 이력”에서 언제든 다시 볼 수 있습니다.` });
      return true;
    } catch (error) {
      setSaveState({ status: "error", message: `조사 결과 저장에 실패했습니다: ${error.message}` });
      return false;
    }
  };

  const runMerge = async (modelName, research, controller) => {
    updateRun("merged", { ...emptyRun(), status: "loading" });
    try {
      const merged = await streamAdminModelMerge(modelName, research, streamHandler("merged"), controller.signal);
      if (controller.signal.aborted) return null;
      updateRun("merged", { status: "done" });
      return merged;
    } catch (error) {
      if (controller.signal.aborted) return null;
      updateRun("merged", { status: "error", error: error.message });
      return null;
    }
  };

  const beginSearch = async (event) => {
    event.preventDefault();
    const modelName = query.trim();
    if (!modelName || checkingStore) return;
    setSearchError(null);
    setCheckingStore(true);
    try {
      const existing = await fetchAdminResearchResults(modelName);
      if (existing?.exists) {
        setStored(existing);
        trackRun(existing.runId);
        setStage("existing");
        return;
      }
    } catch (error) {
      setSearchError(`이전 조사 결과를 확인하지 못했습니다: ${error.message}`);
      return;
    } finally {
      setCheckingStore(false);
    }
    await startResearch(modelName);
  };

  const startResearch = async (modelName) => {
    setSearchError(null);
    setStored(null);
    setLoadedFromStore(false);
    setSaveState({ status: "idle", message: "" });
    setResults({ huggingface: null, paper: null, merged: null });
    setOverrides({});
    setAibomOverrides({});
    setAibomFieldOverrides({});
    setRuns({ huggingface: { ...emptyRun(), status: "loading" }, paper: { ...emptyRun(), status: "loading" }, merged: emptyRun() });
    setStage("working");
    const controller = new AbortController();
    abortRef.current = controller;

    const failures = {};
    const runSource = async (key) => {
      try {
        const payload = await streamAdminModelResearch(modelName, streamHandler(key), controller.signal, key);
        updateRun(key, { status: "done" });
        setResults((current) => ({ ...current, [key]: payload }));
        return payload;
      } catch (error) {
        failures[key] = error.name === "AbortError" ? "취소됨" : error.message;
        updateRun(key, { status: "error", error: failures[key] });
        return null;
      }
    };

    const [huggingface, paper] = await Promise.all(sourceKeys.map(runSource));
    if (controller.signal.aborted) return;
    if (!huggingface && !paper) {
      abortRef.current = null;
      // Show why each route failed: a bad model name and a server / provider problem need different fixes.
      setSearchError(`두 조사 방식 모두 결과를 얻지 못했습니다. ${sourceKeys.map((key) => `${sourceLabel(key)}: ${failures[key] || "알 수 없는 오류"}`).join(" / ")}`);
      setStage("input");
      return;
    }

    await persist(modelName, { huggingface, paper }, true);
    if (controller.signal.aborted) return;

    let merged = null;
    if (huggingface && paper) {
      merged = await runMerge(modelName, { huggingface, paper }, controller);
      if (controller.signal.aborted) return;
      if (merged) await persist(modelName, { merged }, false);
    } else {
      updateRun("merged", { status: "skipped" });
    }
    if (abortRef.current === controller) abortRef.current = null;
    setResults({ huggingface, paper, merged });
    if (merged || !(huggingface && paper)) setStage("review");
  };

  const useStored = async () => {
    if (!stored) return;
    const huggingface = stored.results.huggingface?.result || null;
    const paper = stored.results.paper?.result || null;
    let merged = stored.results.merged?.result || null;
    const modelName = stored.modelName || query.trim();
    setSearchError(null);
    setLoadedFromStore(true);
    setSaveState({ status: "idle", message: "" });
    setOverrides({});
    setAibomOverrides({});
    setAibomFieldOverrides({});
    setRuns({
      huggingface: { ...emptyRun(), status: huggingface ? "done" : "error", error: huggingface ? null : "저장된 결과 없음" },
      paper: { ...emptyRun(), status: paper ? "done" : "error", error: paper ? null : "저장된 결과 없음" },
      merged: { ...emptyRun(), status: merged ? "done" : "idle" }
    });
    setResults({ huggingface, paper, merged });
    if (!merged && huggingface && paper) {
      setStage("working");
      const controller = new AbortController();
      abortRef.current = controller;
      merged = await runMerge(modelName, { huggingface, paper }, controller);
      if (controller.signal.aborted) return;
      if (abortRef.current === controller) abortRef.current = null;
      if (merged) await persist(modelName, { merged }, false);
      setResults({ huggingface, paper, merged });
      if (!merged) return;
    } else if (!merged) {
      updateRun("merged", { status: "skipped" });
    }
    setStage("review");
  };

  const retryMerge = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    const merged = await runMerge(query.trim(), { huggingface: results.huggingface, paper: results.paper }, controller);
    if (controller.signal.aborted) return;
    if (abortRef.current === controller) abortRef.current = null;
    if (merged) {
      await persist(query.trim(), { merged }, false);
      setResults((current) => ({ ...current, merged }));
      setStage("review");
    }
  };

  const proceedWithSingle = (key) => {
    updateRun("merged", { status: "skipped", error: null });
    setResults((current) => ({ ...current, merged: null, [key === "huggingface" ? "paper" : "huggingface"]: null }));
    setStage("review");
  };

  const cancelSearch = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRuns(initialRuns());
    setSearchError("검색을 취소했습니다.");
    setStage("input");
  };

  // ---- review helpers ----
  const baseResult = results.merged || results.huggingface || results.paper;
  const aibomKey = results.merged?.aibom ? "merged" : ["huggingface", "paper"].find((key) => results[key]?.aibom) || null;
  const finalAibom = useMemo(() => {
    const base = aibomKey ? results[aibomKey].aibom : null;
    if (!base) return null;
    const selected = Object.fromEntries(Object.entries(base).map(([area, value]) => {
      const source = aibomOverrides[area];
      return [area, source && results[source]?.aibom?.[area] !== undefined ? results[source].aibom[area] : value];
    }));
    Object.entries(aibomFieldOverrides).forEach(([fieldKey, source]) => {
      const [area, field] = fieldKey.split(".");
      if (Array.isArray(selected[area]) || !results[source]?.aibom?.[area]) return;
      selected[area] = { ...selected[area], [field]: results[source].aibom[area][field] };
    });
    return selected;
  }, [aibomKey, aibomOverrides, aibomFieldOverrides, results]);
  const decisions = useMemo(() => {
    const map = {};
    (results.merged?.fieldDecisions || []).forEach((item) => { map[item.field] = item; });
    return map;
  }, [results.merged]);

  const setOverride = (field, sourceKey) => {
    const group = linkedFieldGroups.find((items) => items.includes(field)) || [field];
    setOverrides((current) => {
      const next = { ...current };
      group.forEach((item) => { if (sourceKey) next[item] = sourceKey; else delete next[item]; });
      return next;
    });
  };

  const finalValue = (field) => {
    const source = overrides[field];
    if (source && results[source]) return results[source].draft?.[field] ?? null;
    return baseResult?.draft?.[field] ?? null;
  };

  const cellState = (field, sourceKey) => {
    const candidate = results[sourceKey]?.draft?.[field];
    if (overrides[field] === sourceKey) return "override";
    if (sameValue(candidate, finalValue(field))) return "selected";
    return "";
  };

  const conflicts = useMemo(() => {
    if (!results.huggingface || !results.paper) return new Set();
    return new Set(mergeFields.filter(([field]) => {
      const hf = results.huggingface.draft?.[field];
      const paper = results.paper.draft?.[field];
      return !isEmptyValue(hf) && !isEmptyValue(paper) && !sameValue(hf, paper);
    }).map(([field]) => field));
  }, [results]);

  const finalDraft = useMemo(() => {
    if (stage !== "review" || !baseResult) return null;
    const draft = { ...baseResult.draft };
    mergeFields.forEach(([field]) => { draft[field] = finalValue(field); });
    const aibomSource = results[aibomKey] || baseResult;
    aibomDerivedFields.forEach((field) => { draft[field] = aibomSource?.draft?.[field] ?? draft[field] ?? null; });
    const ai = { ...(baseResult.draft.detailsJson?.ai_research || {}), reviewed: false };
    if (Object.keys(overrides).length) ai.manualOverrides = { ...overrides };
    draft.detailsJson = {
      ...(baseResult.draft.detailsJson || {}),
      model: { ...(baseResult.draft.detailsJson?.model || {}), id: draft.modelId, title: draft.modelId, subtitle: draft.description },
      ai_research: ai
    };
    return draft;
  }, [stage, baseResult, overrides, results, aibomKey]);

  const finalEvidence = useMemo(() => {
    if (stage !== "review" || !baseResult) return [];
    const baseKey = results.merged ? "merged" : results.huggingface ? "huggingface" : "paper";
    return composeEvidence({
      results, baseKey, aibomKey, catalogFields: mergeFields.map(([field]) => field),
      overrides, aibomOverrides, aibomFieldOverrides
    });
  }, [stage, baseResult, results, aibomKey, overrides, aibomOverrides, aibomFieldOverrides]);

  // The dialog only prepares a draft: the heading says which step this is, so the review step is not
  // mistaken for the registration itself.
  const dialogHead = mode !== "ai" ? { eyebrow: "CREATE MODEL", title: "새 모델을 어떻게 등록할까요?" }
    : stage === "review" ? { eyebrow: "CREATE MODEL · 2/3 값 고르기", title: results.merged ? "항목별로 초안에 쓸 값을 고르세요" : "조사 결과를 확인하세요" }
    : stage === "working" ? { eyebrow: "CREATE MODEL · 1/3 AI 조사", title: "AI가 모델 정보를 조사하고 있습니다" }
    : { eyebrow: "CREATE MODEL · 1/3 AI 조사", title: "어떤 모델을 조사할까요?" };
  const overrideCount = Object.keys(overrides).length;
  const workingTitle = runs.merged.status === "loading" ? "두 조사 결과를 AI가 병합하고 있습니다" : `“${query}” 정보를 찾고 있습니다`;

  return (
    <div className="admin-modal-backdrop create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && stage !== "working") onClose(); }}>
      <section className={`create-dialog ${mode === "ai" ? "is-ai" : ""}`} role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
        <div className="create-dialog-head">
          <div><p className="eyebrow">{dialogHead.eyebrow}</p><h2 id="create-dialog-title">{dialogHead.title}</h2></div>
          {stage !== "working" && <button type="button" className="create-close" aria-label="닫기" onClick={onClose}>×</button>}
        </div>

        {mode === "method" && <div className="create-methods">
          <button type="button" className="create-method-card featured" onClick={() => onModeChange("ai")}>
            <span className="create-method-icon">✦</span><span className="create-method-copy"><strong>AI로 정보 채우기</strong><small>모델명만 입력하면 Hugging Face와 논문을 동시에 조사하고 AI가 하나의 초안으로 병합합니다.</small><em>추천</em></span><span className="create-arrow">→</span>
          </button>
          <button type="button" className="create-method-card" onClick={onManual}>
            <span className="create-method-icon manual">＋</span><span className="create-method-copy"><strong>직접 입력하기</strong><small>빈 양식에서 모델 정보와 계층 관계를 하나씩 입력합니다.</small></span><span className="create-arrow">→</span>
          </button>
        </div>}

        {mode === "ai" && stage === "input" && <form className="ai-search-form" onSubmit={beginSearch}>
          <button type="button" className="create-back" onClick={() => onModeChange("method")}>← 등록 방식 다시 선택</button>
          <div className="ai-intro"><span className="ai-spark">✦</span><div><h3>AI 모델 정보 검색</h3><p>모델 ID나 모델명을 입력하면 Hugging Face와 논문 두 경로로 동시에 조사한 뒤, AI가 항목별로 근거를 비교해 하나의 초안으로 병합합니다.</p></div></div>
          <ul className="ai-source-summary">
            {researchSources.map((option) => <li key={option.value}><strong>{option.label}</strong><small>{option.hint}</small></li>)}
            <li><strong>AI 병합</strong><small>두 결과를 항목별로 비교해 근거가 강한 값을 고르고 선택 이유를 남깁니다.</small></li>
          </ul>
          <label><span>모델명 또는 모델 ID</span><div className="ai-search-input"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="예: mistralai/Mistral-7B-Instruct-v0.3" /><button type="submit" disabled={!query.trim() || checkingStore}>{checkingStore ? "확인 중…" : "조사 시작"}</button></div></label>
          {searchError && <div className="ai-search-error" role="alert"><strong>검색하지 못했습니다.</strong><span>{searchError}</span></div>}
          <p className="ai-beta-note">OpenRouter가 공개 웹 자료를 검색합니다. 검색 결과는 저장 전에 반드시 검토해 주세요.</p>
        </form>}

        {mode === "ai" && stage === "existing" && stored && <div className="ai-existing">
          <button type="button" className="create-back" onClick={() => { setStored(null); setStage("input"); }}>← 모델명 다시 입력</button>
          <div className="ai-existing-banner"><span>↺</span><div><strong>“{stored.modelName}” 의 이전 조사 결과가 있습니다</strong><p>최근 실행 #{stored.runId} · 마지막 저장 {formatDateTime(stored.latestCreatedAt)} · 저장된 실행 {stored.runCount}개. 최근 결과를 불러오거나 새로 조사할 수 있습니다. 새로 조사하면 새 실행으로 저장되고, 이전 실행은 AI 조사 이력에 그대로 남습니다.</p></div></div>
          <div className="ai-run-summary">
            {[...researchSources, { value: "merged", label: "AI 병합" }].map((option) => {
              const row = stored.results[option.value];
              return <div key={option.value} className={`ai-run-card${row ? "" : " is-failed"}`}>
                <header><strong>{option.label}</strong>{row ? <span className={`ai-run-chip is-${row.status || "found"}`}>{statusLabels[row.status] || "저장됨"}</span> : <span className="ai-run-chip">없음</span>}</header>
                {row ? <dl>
                  <div><dt>Model ID</dt><dd>{row.resultModelId || "-"}</dd></div>
                  <div><dt>Research model</dt><dd>{row.researchModel || "-"}</dd></div>
                  <div><dt>저장 시각</dt><dd>{formatDateTime(row.createdAt)}</dd></div>
                </dl> : <p className="ai-run-note">저장된 결과가 없습니다.</p>}
              </div>;
            })}
          </div>
          {!stored.results.merged && stored.results.huggingface && stored.results.paper && <p className="ai-beta-note">저장된 병합 결과가 없어, 불러오면 AI 병합을 다시 실행합니다.</p>}
          <div className="create-dialog-actions">
            <button type="button" className="admin-secondary" onClick={() => startResearch(stored.modelName || query.trim())}>새로 조사하기</button>
            <button type="button" className="admin-primary" onClick={useStored}>저장된 결과 불러오기</button>
          </div>
        </div>}

        {mode === "ai" && stage === "working" && <div className="ai-loading ai-loading-dual" aria-live="polite">
          <div className="ai-orbit"><span>✦</span></div><h3>{workingTitle}</h3><p>{runs.merged.status === "loading" ? "항목별로 근거를 비교해 하나의 초안을 만들고 있습니다." : "Hugging Face와 논문 경로를 동시에 조사하고 있습니다. 두 조사가 끝나면 AI 병합이 자동으로 시작됩니다."}</p>
          <PipelineSteps runs={runs} results={results} />
          {saveState.status !== "idle" && <p className={`ai-save-state is-${saveState.status}`}>{saveState.message}</p>}
          <div className="ai-run-columns">
            {researchSources.map((option) => {
              const run = runs[option.value];
              const result = results[option.value];
              return <section key={option.value} className={`ai-run-column is-${run.status}`}>
                <header><strong>{option.label}</strong><RunStatusChip run={run} result={result} /></header>
                {run.error && <p className="ai-run-error">{run.error}</p>}
                <ResultMiniSummary result={result} />
                <ResearchStreamLog events={run.events} partialContent={run.partialContent} live={run.status === "loading"} />
              </section>;
            })}
          </div>
          {runs.merged.status !== "idle" && <section className={`ai-run-column ai-merge-column is-${runs.merged.status}`}>
            <header><strong>AI 병합</strong><RunStatusChip run={runs.merged} result={results.merged} /></header>
            {runs.merged.status === "error" && <div className="ai-run-error ai-merge-fallback">
              <p>{runs.merged.error || "병합에 실패했습니다."}</p>
              <div>
                <button type="button" className="admin-primary" onClick={retryMerge}>병합 다시 시도</button>
                {sourceKeys.map((key) => <button key={key} type="button" className="admin-secondary" onClick={() => proceedWithSingle(key)}>{sourceLabel(key)} 결과만 사용</button>)}
              </div>
            </div>}
            {runs.merged.status === "skipped" && <p className="ai-run-note">한 경로만 성공해 병합 없이 해당 결과를 사용합니다.</p>}
            {runs.merged.status !== "skipped" && <ResearchStreamLog events={runs.merged.events} partialContent={runs.merged.partialContent} live={runs.merged.status === "loading"} />}
          </section>}
          {runs.merged.status !== "error" && <button type="button" className="admin-secondary stream-cancel" onClick={cancelSearch}>취소</button>}
        </div>}

        {mode === "ai" && stage === "review" && finalDraft && <div className="ai-review">
          <div className="ai-review-banner"><span>✓</span><div>
            <strong>{results.merged ? "AI 병합 초안이 준비되었습니다" : `${sourceLabel(results.huggingface ? "huggingface" : "paper")} 결과로 초안을 만들었습니다`}</strong>
            <p>{loadedFromStore ? `저장된 조사 결과(${formatDateTime(stored?.latestCreatedAt)})를 불러왔습니다. ` : ""}{results.merged ? `충돌한 항목 ${conflicts.size}개를 AI가 근거 기준으로 정리했습니다. 다른 쪽 값을 누르면 바꿀 수 있습니다.` : "다른 경로는 결과를 얻지 못했습니다. 편집 화면에서 빈 항목을 채워 주세요."}{overrideCount ? ` 수동으로 바꾼 항목 ${overrideCount}개.` : ""}</p>
          </div><em>{loadedFromStore ? "SAVED" : results.merged ? "AI MERGED" : "AI DRAFT"}</em></div>

          <div className="ai-pick-guide"><strong>값 고르기</strong>{results.merged
            ? <p>항목마다 <b>HF · 논문 · AI 병합</b> 값을 나란히 보여줍니다. <b>칸을 누르면 그 값이 초안에 들어가고</b>, 강조(✓)된 칸이 지금 선택된 값입니다. 아무것도 누르지 않은 항목은 AI 병합 값을 씁니다.</p>
            : <p>한 경로의 결과만 있어 비교해서 고를 값이 없습니다. 내용을 확인한 뒤 편집 화면에서 직접 고쳐 주세요.</p>}</div>

          <PipelineSteps runs={runs} results={results} />
          {saveState.status !== "idle" && <p className={`ai-save-state is-${saveState.status}`}>{saveState.message}</p>}

          <div className="ai-run-summary">
            {[...researchSources, { value: "merged", label: "AI 병합" }].map((option) => {
              const result = results[option.value];
              const run = runs[option.value];
              if (option.value === "merged" && run.status === "skipped") return null;
              return <div key={option.value} className={`ai-run-card${result ? "" : " is-failed"}`}>
                <header><strong>{option.label}</strong><RunStatusChip run={run} result={result} /></header>
                {result ? <dl>
                  <div><dt>Model ID</dt><dd>{result.draft.modelId}</dd></div>
                  <div><dt>Research model</dt><dd>{result.research?.model || "OpenRouter"}</dd></div>
                  {option.value !== "merged" && <div><dt>Web searches</dt><dd>{result.research?.webSearchRequests ?? "-"}</dd></div>}
                  <div><dt>Sources</dt><dd>{result.sources?.length || 0}</dd></div>
                </dl> : <p className="ai-run-error">{run.error || "결과를 받지 못했습니다."}</p>}
              </div>;
            })}
          </div>

          <div className="ai-result-section">
            <div className="ai-result-heading"><strong>모델 정보 값 고르기</strong>
              <div className="ai-merge-actions">
                {overrideCount > 0 && <button type="button" onClick={() => setOverrides({})}>AI 병합값으로 되돌리기</button>}
                {results.merged && sourceKeys.map((key) => <button key={key} type="button" disabled={!results[key]} onClick={() => { const next = {}; mergeFields.forEach(([field]) => { next[field] = key; }); setOverrides(next); }}>모두 {sourceLabel(key)}</button>)}
              </div>
            </div>
            <div className="ai-merge-table is-three" role="table">
              <div className="ai-merge-row is-head" role="row"><span>항목</span>{researchSources.map((option) => <span key={option.value}>{option.label}</span>)}<span>선택된 값</span></div>
              {mergeFields.map(([field, label]) => {
                const decision = decisions[field];
                const value = displayValue(finalValue(field));
                const overridden = Boolean(overrides[field]);
                return <div key={field} className={`ai-merge-row${conflicts.has(field) ? " is-conflict" : ""}`} role="row">
                  <span className="ai-merge-label">{label}{conflicts.has(field) && <em>충돌</em>}</span>
                  {researchSources.map((option) => <ValueCell key={option.value} sourceName={option.label} result={results[option.value]} run={runs[option.value]} field={field} state={cellState(field, option.value)} onSelect={() => setOverride(field, overrides[field] === option.value ? null : option.value)} />)}
                  <div className={`ai-merge-final${overridden ? " is-override" : ""}${value ? "" : " is-empty"}`} data-source="선택된 값">
                    <strong>{value || "값 없음"}</strong>
                    <small>{overridden ? <b>수동 선택 · {sourceLabel(overrides[field])}</b> : isInherited(baseResult, field) ? <><b className="is-inherited">부모 모델에서 상속</b> · {baseResult.catalogLineage.parentModelId}</> : decision ? <><b>{decisionLabels[decision.chosen] || decision.chosen}</b>{decision.rationale ? ` · ${decision.rationale}` : ""}</> : results.merged ? "결정 정보 없음" : sourceLabel(results.huggingface ? "huggingface" : "paper")}</small>
                    {overridden && <button type="button" onClick={() => setOverride(field, null)}>AI 값으로</button>}
                  </div>
                </div>;
              })}
            </div>
            <p className="ai-merge-hint">HF · 논문 칸을 누르면 “선택된 값”이 그 값으로 바뀌고, 다시 누르면 AI 병합 값으로 돌아갑니다. Model ID·Namespace·Model name, Family key·Family name은 함께 바뀝니다. “선택된 값” 열의 이유는 AI가 남긴 선택 근거입니다.</p>
          </div>

          <AibomDraftSummary results={results} chosenKey={aibomKey} overrides={aibomOverrides}
            fieldOverrides={aibomFieldOverrides}
            onSelect={(area, source) => setAibomOverrides((current) => ({ ...current, [area]: source }))}
            onFieldSelect={(field, source) => setAibomFieldOverrides((current) => ({ ...current, [field]: source }))} />

          {baseResult.parentCandidates?.length > 0 && <div className="ai-result-section"><div className="ai-result-heading"><strong>부모 모델 후보</strong><span>{baseResult.parentCandidates.length}</span></div><ul className="ai-parent-list">{baseResult.parentCandidates.map((candidate) => <li key={`${candidate.modelId}-${candidate.relationshipType}`}><strong>{candidate.modelId}</strong><span>{candidate.relationshipType} · 신뢰도 {candidate.confidence}{candidate.modelId.toLowerCase() === (finalDraft.parentModelId || "").toLowerCase() ? ` · 부모로 연결됨 (Depth ${finalDraft.hierarchyDepth})` : ""}</span></li>)}</ul></div>}

          {baseResult.warnings?.length > 0 && <div className="ai-warning-list"><strong>검토할 항목</strong><ul>{baseResult.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}

          {[...researchSources, { value: "merged", label: "AI 병합" }].map((option) => {
            const result = results[option.value];
            if (!result) return null;
            return <details key={option.value} className="ai-result-section ai-result-details">
              <summary className="ai-result-heading"><strong>{option.label} 출처 · 경고 · 로그</strong><span>{(result.sources?.length || 0) + (result.warnings?.length || 0)}</span></summary>
              {option.value !== "merged" && result.warnings?.length > 0 && <div className="ai-warning-list is-inset"><strong>검토할 항목</strong><ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}
              {result.sources?.length ? <ul className="ai-source-list">{result.sources.map((source) => <li key={`${source.source || option.value}-${source.url}`}>{source.source && <b className="ai-source-tag">{sourceLabel(source.source)}</b>}<a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url} ↗</a>{source.excerpt && <p>{source.excerpt}</p>}</li>)}</ul> : <p className="ai-result-empty">응답에서 URL 출처를 확인하지 못했습니다.</p>}
              <ResearchStreamLog events={runs[option.value].events} partialContent="" />
            </details>;
          })}

          <p className="ai-merge-hint ai-next-step"><b>아직 카탈로그에 등록되지 않았습니다.</b> 여기서 고른 값이 편집 화면(3/3)의 초기값이 되고, 편집 화면에서도 항목마다 HF / 논문 / AI 병합 값으로 다시 바꾸거나 직접 고칠 수 있습니다. 모델은 편집 화면에서 저장할 때 등록됩니다. 조사 결과 자체는 AI 조사 이력에 이미 저장되어 있어, 창을 닫아도 다시 불러올 수 있습니다.</p>
          <div className="create-dialog-actions"><button type="button" className="admin-secondary" onClick={resetSearch}>다시 검색</button><button type="button" className="admin-primary" onClick={() => onUseDraft(finalDraft, finalAibom, runId, finalEvidence, results)}>이 초안으로 편집 화면 열기 →</button></div>
        </div>}
      </section>
    </div>
  );
}

function NoticeModal({ notice, onClose }) {
  useEffect(() => {
    if (!notice) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [notice, onClose]);

  if (!notice) return null;
  const success = notice.type === "success";
  return (
    <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`admin-modal ${notice.type}`} role="alertdialog" aria-modal="true" aria-labelledby="admin-modal-title" aria-describedby="admin-modal-message">
        <div className="admin-modal-icon" aria-hidden="true">{success ? "✓" : "!"}</div>
        <div className="admin-modal-copy">
          <p className="eyebrow">{success ? "SUCCESS" : "ERROR"}</p>
          <h2 id="admin-modal-title">{success ? "저장이 완료되었습니다" : "요청을 처리하지 못했습니다"}</h2>
          <p id="admin-modal-message">{notice.text}</p>
        </div>
        <button type="button" className="admin-primary" autoFocus onClick={onClose}>확인</button>
      </section>
    </div>
  );
}

// Asked before every save of the editor form. Enter in a form input submits the form, so without this
// a stray Enter saved the model. Enter does nothing here: the choice has to be clicked.
function ConfirmSaveModal({ open, title, message, warningItems = [], confirmLabel, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
      else if (event.key === "Escape") onCancel();
    };
    document.body.style.overflow = "hidden";
    // Focus leaves the form input (and stays off the buttons, which Enter would press).
    dialogRef.current?.focus();
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey, true);
      previousFocus?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section ref={dialogRef} tabIndex={-1} className="admin-modal confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-save-title" aria-describedby="admin-modal-message">
        <div className="admin-modal-icon" aria-hidden="true">?</div>
        <div className="admin-modal-copy">
          <p className="eyebrow">CONFIRM</p>
          <h2 id="confirm-save-title">{title}</h2>
          <p id="admin-modal-message">{message}</p>
          {warningItems.length > 0 && <div className="admin-modal-warning" role="alert">
            <strong>근거가 없는 데이터셋이 {warningItems.length}개 있습니다. 확정하시겠습니까?</strong>
            <ul>{warningItems.map((item, index) => <li key={index}>{item}</li>)}</ul>
          </div>}
        </div>
        <div className="admin-modal-actions">
          <button type="button" className="admin-secondary" onClick={onCancel}>취소</button>
          <button type="button" className="admin-primary" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}

// The reviewer this browser last reviewed as (the app has no login).
const REVIEWER_KEY = "aibom.reviewerId";
const rememberedReviewer = () => { try { return window.localStorage.getItem(REVIEWER_KEY) || ""; } catch { return ""; } };
const rememberReviewer = (reviewerId) => { try { window.localStorage.setItem(REVIEWER_KEY, String(reviewerId)); } catch { /* private mode */ } };
// The part of a run the review mode needs.
const reviewStateOf = (run) => ({ runId: run.runId, modelId: run.modelId, reviewStatus: run.reviewStatus, reviewers: run.reviewers || [],
  reviewProgress: run.reviewProgress || { submitted: 0, total: 0 }, finalize: run.finalize || {} });
const reviewerNames = (reviewers, submittedOnly = false) => (reviewers || [])
  .filter((reviewer) => !submittedOnly || reviewer.status === "submitted").map((reviewer) => reviewer.name || "삭제된 작업자").join(", ");

export default function AdminApp() {
  const [models, setModels] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(normalizeForForm(EMPTY_MODEL));
  const [detailsText, setDetailsText] = useState("{}");
  const [changeText, setChangeText] = useState("");
  const [licenseText, setLicenseText] = useState("");
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmingSave, setConfirmingSave] = useState(false);
  const cancelSave = useCallback(() => setConfirmingSave(false), []);
  // Datasets without any evidence, listed in the save confirmation.
  const [unevidencedDatasets, setUnevidencedDatasets] = useState([]);
  const [createMode, setCreateMode] = useState(null);
  const [aiDraft, setAiDraft] = useState(false);
  const [aibomRefresh, setAibomRefresh] = useState(0);
  const [pendingAibom, setPendingAibom] = useState(null);
  const [pendingRunId, setPendingRunId] = useState(null);
  const [pendingEvidence, setPendingEvidence] = useState(null);
  const [storedEvidence, setStoredEvidence] = useState(null);
  const [evidenceDirty, setEvidenceDirty] = useState(false);
  // Research results ({ huggingface, paper, merged }) whose values the editor can switch between.
  const [candidates, setCandidates] = useState(null);
  const [candidateRunId, setCandidateRunId] = useState(null);
  // Review state of that run ({ runId, reviewStatus, reviewers, reviewedByName }), shown next to the model title.
  const [modelRun, setModelRun] = useState(null);
  // Result last picked per catalog field; decides the marked chip when several results agree.
  const [pickedSource, setPickedSource] = useState({});
  // A stored run opened from the research history for review: { runId, modelId } once its catalog model is known.
  const [reviewRun, setReviewRun] = useState(null);
  // A run with assigned reviewers is reviewed, not saved: everyone submits an answer and the server
  // saves the majority (see reviewStateOf). `reviewerId` is who this browser reviews as ("" = not chosen).
  const [reviewInfo, setReviewInfo] = useState(null);
  const [reviewerId, setReviewerId] = useState("");
  const [retrying, setRetrying] = useState(false);
  const aibomEditorRef = useRef(null);

  const reload = async (preferredId = selectedId) => {
    const data = await fetchAdminModels();
    setModels(data);
    if (preferredId) {
      const selected = data.find((model) => model.modelId === preferredId);
      if (selected) selectModel(selected);
    }
    return data;
  };

  useEffect(() => {
    fetchAdminModels().then((data) => {
      setModels(data);
      // Keep edit links shareable: /admin?model=namespace%2Fmodel-name.
      // An invalid or deleted model falls back to the first catalog entry.
      const params = new URLSearchParams(window.location.search);
      const requestedId = params.get("model");
      const selected = data.find((model) => model.modelId === requestedId) || data[0];
      // /admin?run=<id>: review a stored research run (from the research history page).
      const runId = Number(params.get("run"));
      // &reviewer=<id>: review as that reviewer (the research history's reviewer filter).
      if (runId) return openRunForReview(runId, data, params.get("reviewer")).catch((error) => {
        setNotice({ type: "error", text: `AI 조사 #${runId} 결과를 불러오지 못했습니다: ${error.message}` });
        if (selected) selectModel(selected);
      });
      if (selected) selectModel(selected);
      return undefined;
    }).catch((error) => setNotice({ type: "error", text: error.message })).finally(() => setLoading(false));
  }, []);

  // The run under review for what is on screen: a registered model's, or the unsaved draft's.
  const activeReviewRunId = selectedId ? (reviewRun?.modelId === selectedId ? reviewRun.runId : null) : (aiDraft ? pendingRunId : null);
  useEffect(() => {
    if (loading) return;
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("model", selectedId);
    else url.searchParams.delete("model");
    if (activeReviewRunId) url.searchParams.set("run", activeReviewRunId);
    else url.searchParams.delete("run");
    window.history.replaceState({}, "", url);
  }, [selectedId, activeReviewRunId, loading]);

  // Review mode: the run on screen has assigned reviewers, so "save" hands in one reviewer's answer.
  const reviewMode = Boolean(activeReviewRunId && reviewInfo?.runId === activeReviewRunId && reviewInfo.reviewers.length);
  const me = reviewMode ? reviewInfo.reviewers.find((reviewer) => String(reviewer.id) === reviewerId) || null : null;
  const mySubmitted = me?.status === "submitted";
  // Whether this submission is the one the run is still waiting for.
  const lastReview = reviewMode && reviewInfo.reviewers.every((reviewer) => reviewer.status === "submitted" || reviewer === me);
  const reviewBusy = reviewMode && (reviewInfo.reviewStatus === "saving" || reviewInfo.reviewStatus === "merging");
  // While the server saves the run ("저장 중" / "AI 병합 중") its state is polled; a submitted review
  // that still waits for the other reviewers is checked now and then.
  const reviewPoll = !reviewMode ? 0 : reviewBusy ? 2000 : reviewInfo.reviewStatus === "pending" && mySubmitted ? 10000 : 0;
  useEffect(() => {
    if (!reviewPoll) return undefined;
    const runId = activeReviewRunId;
    const timer = setInterval(() => fetchResearchRunStatus(runId).then((run) => {
      if (run.reviewStatus === "saved") return finishReview(run);
      return setReviewInfo((current) => (current?.runId === runId ? reviewStateOf(run) : current));
    }).catch(() => {}), reviewPoll);
    return () => clearInterval(timer);
  }, [reviewPoll, activeReviewRunId]);
  // Review as someone else (or start over as the same reviewer): everything is loaded again.
  function switchReviewer(nextId) {
    if (nextId) rememberReviewer(nextId);
    setReviewerId(nextId);
    openRunForReview(activeReviewRunId, models, nextId || "").catch((error) => setNotice({ type: "error", text: error.message }));
  }

  // Open a stored research run for review. When the catalog already has the researched model the
  // review happens on that model (its values can be switched to the run's); otherwise the run
  // becomes a new-model draft.
  // A run with assigned reviewers opens in review mode as `asReviewer` (default: the reviewer this
  // browser reviewed as last); an answer they already submitted is loaded so they can go on from it.
  async function openRunForReview(runId, catalog = models, asReviewer = null) {
    const run = await fetchResearchRun(runId, true);
    const results = Object.fromEntries(RESEARCH_SOURCES.map(([key]) => [key, run.results[key]?.result || null]));
    const reviewing = run.reviewers?.length > 0;
    if (reviewing && run.reviewStatus === "saved") {
      // Already saved from its reviews: nothing left to review, show the model.
      const saved = catalog.find((model) => model.modelId === run.modelId);
      setReviewInfo(null); setReviewRun(null);
      if (!saved) throw new Error("이 실행으로 저장된 모델을 찾지 못했습니다.");
      selectModel(saved);
      return;
    }
    const known = (id) => run.reviewers.some((reviewer) => String(reviewer.id) === String(id));
    const me = !reviewing || asReviewer === "" ? "" : asReviewer != null && known(asReviewer) ? String(asReviewer)
      : known(rememberedReviewer()) ? rememberedReviewer() : run.reviewers.length === 1 ? String(run.reviewers[0].id) : "";
    setReviewInfo(reviewing ? reviewStateOf(run) : null);
    setReviewerId(me);
    const existing = catalog.find((model) => model.modelId === run.catalogModelId);
    if (existing) {
      setReviewRun({ runId, modelId: existing.modelId });
      selectModel(existing);
      setAibomRefresh((value) => value + 1); // back to the stored AIBOM and evidence when the reviewer changes
    } else {
      const prepared = draftFromResults(results);
      if (!prepared) throw new Error("이 실행에는 초안으로 쓸 조사 결과가 없습니다.");
      useAiDraft(prepared.draft, prepared.aibom, runId, prepared.evidence, results);
    }
    if (me && run.reviewers.find((reviewer) => String(reviewer.id) === me)?.status === "submitted") {
      const mine = await fetchRunReview(runId, me);
      if (mine.review) applySubmittedReview(mine.review, Boolean(existing));
    }
  }

  // Show the answer a reviewer already submitted in place of the starting values.
  function applySubmittedReview(review, registered) {
    setForm((current) => normalizeForForm({ ...current, ...review.model }));
    setDetailsText(jsonText(review.model.detailsJson || {}));
    setChangeText(review.model.changeDetailsJson ? jsonText(review.model.changeDetailsJson) : "");
    setLicenseText(review.model.licenseReported == null ? "" : jsonText(review.model.licenseReported));
    if (review.aibom) setPendingAibom(review.aibom);
    (registered ? setStoredEvidence : setPendingEvidence)(review.evidence || []);
    setPickedSource({});
  }

  // Evidence of the researched values: stored rows for a registered model, the draft's rows before that.
  useEffect(() => {
    setStoredEvidence(null);
    setEvidenceDirty(false);
    if (!selectedId) return undefined;
    let cancelled = false;
    // A reviewer's submitted answer (applySubmittedReview) may already be in place: it stays.
    fetchAdminModelEvidence(selectedId).then((rows) => { if (!cancelled) setStoredEvidence((current) => current ?? rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, aibomRefresh]);
  const evidenceRows = selectedId ? storedEvidence : pendingEvidence;
  const updateEvidence = useCallback((change) => {
    (selectedId ? setStoredEvidence : setPendingEvidence)((rows) => change(rows || []));
    setEvidenceDirty(true);
  }, [selectedId]);
  const cev = (field) => evidenceRows?.filter((row) => row.area === "catalog" && row.field === field) || null;

  // A registered model can still be edited against its research: the latest run linked to it (or naming it).
  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setCandidates(null); setCandidateRunId(null); setModelRun(null);
    const reviewing = reviewRun?.modelId === selectedId ? reviewRun.runId : null;
    (reviewing ? Promise.resolve([{ runId: reviewing }]) : fetchResearchRuns({ modelId: selectedId, limit: 1 }))
      .then((runs) => (runs[0] ? fetchResearchRun(runs[0].runId, true) : null))
      .then((run) => {
        if (cancelled || !run) return;
        setCandidates(Object.fromEntries(RESEARCH_SOURCES.map(([key]) => [key, run.results[key]?.result || null])));
        setCandidateRunId(run.runId);
        setModelRun({ runId: run.runId, reviewStatus: run.reviewStatus, reviewers: run.reviewers, reviewedByName: run.reviewedByName });
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId, aibomRefresh, reviewRun]);

  // Catalog fields: chips to take the value (and its evidence) from a research result.
  const catalogValue = (value) => (Array.isArray(value) ? value.join(", ") : String(value ?? ""));
  const pickCatalog = (field, source) => {
    // "수동 입력": only the mode changes; the value and its evidence stay until the reviewer edits them.
    if (source === MANUAL) { setPickedSource((current) => ({ ...current, [field]: MANUAL })); return; }
    const draft = candidates?.[source]?.draft;
    if (!draft) return;
    // Model ID parts and family key / name only make sense together; a registered model keeps its ID.
    const group = (linkedFieldGroups.find((items) => items.includes(field)) || [field])
      .filter((item) => !(selectedId && identityFields.includes(item)));
    setForm((current) => ({ ...current, ...Object.fromEntries(group.map((item) => [item, draft[item] ?? ""])) }));
    setPickedSource((current) => ({ ...current, ...Object.fromEntries(group.map((item) => [item, source])) }));
    updateEvidence((rows) => group.reduce((next, item) => swapEvidence(next, candidates[source].evidence, "catalog", item), rows));
  };
  // `manual: false` leaves out the "수동 입력" chip (기본 정보: taken from a research result).
  const pk = (field, { manual = true } = {}) => {
    if (!candidates || !pickableFields.has(field) || (selectedId && identityFields.includes(field))) return null;
    // The merge chip names the input its value came from: the AI's own field decision, or the
    // catalog parent for an inherited family field.
    const merged = candidates.merged;
    const mergeOrigin = merged?.catalogLineage?.inheritedFields?.includes(field) ? "inherited"
      : merged?.fieldDecisions?.find((item) => item.field === field)?.chosen;
    const options = RESEARCH_SOURCES.filter(([key]) => candidates[key]?.draft).map(([key, label]) => {
      const value = candidates[key].draft[field];
      return { key, label: key === "merged" ? chipLabel(label, mergeOrigin) : label, value,
               matches: catalogValue(value) === catalogValue(form[field]) };
    });
    return <SourcePicker options={options} preferred={pickedSource[field]} manual={manual} onPick={(source) => pickCatalog(field, source)} />;
  };
  const pkOnly = (field) => pk(field, { manual: false });
  // 기본 정보 with research results to choose from: the value is set by the chips only, not typed.
  const chipOnly = (field) => Boolean(candidates && pickableFields.has(field) && !(selectedId && identityFields.includes(field))
    && RESEARCH_SOURCES.some(([key]) => candidates[key]?.draft));
  // An AI draft is placed in the tree from its parent candidates; the reviewer only reads it here.
  const hierarchyLocked = !selectedId && aiDraft;
  const pickAibomEvidence = useCallback((area, field, source) => {
    updateEvidence((rows) => swapEvidence(rows, candidates?.[source]?.evidence, area, field));
  }, [candidates, updateEvidence]);

  const families = useMemo(() => [...new Map(models.map((model) => [model.familyKey, model.familyName])).entries()], [models]);
  const visibleModels = useMemo(() => models.filter((model) => {
    const query = search.trim().toLowerCase();
    return (familyFilter === "all" || model.familyKey === familyFilter)
      && (!query || `${model.modelId} ${model.modelName} ${model.supplier || ""}`.toLowerCase().includes(query));
  }), [models, search, familyFilter]);
  const orderedModels = useMemo(() => treeOrder(visibleModels), [visibleModels]);
  const descendants = useMemo(() => {
    if (!selectedId) return new Set();
    const found = new Set([selectedId]);
    let changed = true;
    while (changed) {
      changed = false;
      models.forEach((model) => {
        if (model.parentModelId && found.has(model.parentModelId) && !found.has(model.modelId)) {
          found.add(model.modelId); changed = true;
        }
      });
    }
    return found;
  }, [models, selectedId]);

  function selectModel(model) {
    setSelectedId(model.modelId);
    setForm(normalizeForForm(model));
    setDetailsText(jsonText(model.detailsJson || {}));
    setChangeText(model.changeDetailsJson ? jsonText(model.changeDetailsJson) : "");
    setLicenseText(model.licenseReported == null ? "" : jsonText(model.licenseReported));
    setAiDraft(false);
    setPendingAibom(null);
    setPendingEvidence(null);
    setNotice(null);
    if (model.modelId !== selectedId) { setCandidates(null); setCandidateRunId(null); }
    setPickedSource({});
  }

  function startCreate() {
    const family = familyFilter !== "all" ? families.find(([key]) => key === familyFilter) : null;
    const fresh = { ...EMPTY_MODEL, familyKey: family?.[0] || "", familyName: family?.[1] || "" };
    setSelectedId(null); setForm(normalizeForForm(fresh)); setDetailsText("{}"); setChangeText(""); setLicenseText(""); setNotice(null); setCreateMode(null); setAiDraft(false); setPendingAibom(null); setPendingEvidence(null); setCandidates(null); setCandidateRunId(null); setPickedSource({});
  }

  function useAiDraft(draft, aibom = null, runId = null, evidence = null, results = null) {
    setSelectedId(null);
    setPendingAibom(aibom);
    setPendingRunId(runId);
    setPendingEvidence(evidence);
    // The three results stay available in the editor, so a value can still be switched there.
    setCandidates(results);
    setCandidateRunId(runId);
    setPickedSource({});
    setForm(normalizeForForm(draft));
    setDetailsText(jsonText(draft.detailsJson || {}));
    setChangeText("");
    setLicenseText(draft.licenseReported == null ? "" : jsonText(draft.licenseReported));
    setCreateMode(null);
    setAiDraft(true);
  }

  function parseJson(value, label, fallback) {
    if (!value.trim()) return fallback;
    try { return JSON.parse(value); } catch { throw new Error(`${label} JSON 형식이 올바르지 않습니다.`); }
  }

  // Submitting the form (the save button, or Enter in an input) only asks; `save` runs once confirmed.
  function requestSave(event) {
    event.preventDefault();
    if (saving) return;
    const renames = aibomEditorRef.current?.getEvidenceRenames() || [];
    setUnevidencedDatasets(datasetsWithoutEvidence(aibomEditorRef.current?.getValue(), rekeyEvidence(evidenceRows || [], renames)));
    setConfirmingSave(true);
  }

  // The model form as the API takes it.
  function modelPayload() {
    const parentId = form.parentModelId || null;
    return {
      ...form,
      parentModelId: parentId,
      relationshipType: parentId ? (form.relationshipType || null) : null,
      siblingOrder: Number(form.siblingOrder || 0),
      detailsJson: parseJson(detailsText, "Details", {}),
      changeDetailsJson: parseJson(changeText, "Change details", null),
      licenseReported: parseJson(licenseText, "License reported", null),
      checklistPresentFields: form.checklistPresentFields === "" ? null : Number(form.checklistPresentFields),
      checklistTotalFields: form.checklistTotalFields === "" ? null : Number(form.checklistTotalFields),
      checklistScore: form.checklistScore === "" ? null : Number(form.checklistScore),
      checklistPenaltyFactor: form.checklistPenaltyFactor === "" ? null : Number(form.checklistPenaltyFactor),
      sourceGeneratedAt: form.sourceGeneratedAt || null,
      releaseDate: form.releaseDate || null
    };
  }

  // Review mode: hand in this reviewer's answer. Nothing is written to the catalog here; the server
  // saves the run once every assigned reviewer has submitted (majority, ties merged by the AI).
  async function submitReview() {
    setConfirmingSave(false);
    setSaving(true); setNotice(null);
    try {
      const aibomPayload = aibomEditorRef.current?.getValue();
      const renames = aibomEditorRef.current?.getEvidenceRenames() || [];
      const evidence = aibomPayload ? pruneEvidence(rekeyEvidence(evidenceRows || [], renames), aibomPayload) : evidenceRows || [];
      rememberReviewer(reviewerId);
      const run = await submitRunReview(activeReviewRunId, Number(reviewerId), { model: modelPayload(), aibom: aibomPayload, evidence });
      if (run.reviewStatus === "saved") await finishReview(run);
      else setReviewInfo(reviewStateOf(run));
      window.scrollTo({ top: 0, behavior: "smooth" }); // the review bar at the top says what happens next
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally { setSaving(false); }
  }

  // The run was saved from its reviews: leave review mode and show the saved model.
  async function finishReview(run) {
    const merged = run.finalize?.summary?.counts?.aiMerged || 0;
    setReviewInfo(null); setReviewRun(null);
    setPendingAibom(null); setPendingRunId(null); setPendingEvidence(null);
    await reload(run.modelId);
    setAibomRefresh((value) => value + 1);
    setNotice({ type: "success", text: `AI 조사 #${run.runId}의 검토가 모두 끝나 다수결 결과가 '${run.modelId}' 모델로 저장되었습니다.${merged ? ` 동점이던 값 ${merged}개는 AI 병합 결과로 저장했습니다.` : ""}` });
  }

  async function retryFinalize() {
    setRetrying(true);
    try { setReviewInfo(reviewStateOf(await finalizeResearchRun(reviewInfo.runId))); }
    catch (error) { setNotice({ type: "error", text: error.message }); }
    finally { setRetrying(false); }
  }

  async function save() {
    setConfirmingSave(false);
    setSaving(true); setNotice(null);
    try {
      const payload = modelPayload();
      const aibomPayload = aibomEditorRef.current?.getValue();
      const evidenceRenames = aibomEditorRef.current?.getEvidenceRenames() || [];
      const savedResult = aibomPayload
        ? await saveAdminModelWithAibom(selectedId, payload, aibomPayload)
        : { model: selectedId ? await updateAdminModel(selectedId, payload) : await createAdminModel(payload) };
      const saved = savedResult.model;
      if (activeReviewRunId) {
        // Remember which research run this catalog record was saved from: the research history
        // shows the run as reviewed and saved.
        await linkResearchRun(activeReviewRunId, saved.modelId, null).catch(() => {});
      }
      setReviewRun(null);
      let evidenceError = null;
      if (evidenceRows?.length && (aibomPayload || !selectedId)) {
        // Keep the evidence per model in step with the saved values: rows follow list items whose key was
        // edited and are dropped for items that were removed.
        const kept = pruneEvidence(rekeyEvidence(evidenceRows, evidenceRenames), aibomPayload);
        if (!selectedId || evidenceDirty || evidenceRenames.length || kept.length !== evidenceRows.length) {
          const runId = selectedId ? evidenceRows.find((row) => row.runId)?.runId ?? candidateRunId : pendingRunId;
          await saveAdminModelEvidence(saved.modelId, kept, runId).catch((error) => { evidenceError = error.message; });
        }
      }
      setPendingAibom(null);
      setPendingRunId(null);
      setPendingEvidence(null);
      await reload(saved.modelId);
      setAibomRefresh((value) => value + 1);
      setNotice(evidenceError
        ? { type: "error", text: `모델은 저장되었지만 값별 근거를 저장하지 못했습니다: ${evidenceError}` }
        : { type: "success", text: selectedId ? "변경사항이 저장되었습니다." : "새 모델이 등록되었습니다." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!selectedId || !window.confirm(`'${selectedId}' 모델을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setSaving(true); setNotice(null);
    try {
      await deleteAdminModel(selectedId);
      const data = await reload(null);
      setSelectedId(null); startCreate();
      setModels(data);
      setNotice({ type: "success", text: "모델이 삭제되었습니다." });
    } catch (error) { setNotice({ type: "error", text: error.message }); }
    finally { setSaving(false); }
  }

  if (loading) return <main className="app-state"><p>모델 카탈로그를 불러오는 중입니다...</p></main>;

  return (
    <div className="admin-shell">
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
      {reviewMode
        ? <ConfirmSaveModal open={confirmingSave} onConfirm={submitReview} onCancel={cancelSave}
          title={mySubmitted ? "검토를 다시 제출할까요?" : "검토를 완료할까요?"}
          message={`AI 조사 #${activeReviewRunId}에 대한 ${me?.name || "검토자"}의 검토 결과를 제출합니다. ${lastReview
            ? "마지막 검토입니다. 제출하면 다수결 결과가 바로 저장되고, 동점인 값이 있으면 AI 병합을 거칩니다."
            : `배정된 검토자 ${reviewInfo.reviewers.length}명이 모두 제출하면 다수결 결과가 자동으로 저장됩니다. 그 전까지는 다시 제출할 수 있습니다.`}`}
          warningItems={unevidencedDatasets} confirmLabel={mySubmitted ? "다시 제출" : "검토 완료"} />
        : <ConfirmSaveModal open={confirmingSave} onConfirm={save} onCancel={cancelSave}
          title={selectedId ? "변경사항을 저장할까요?" : "모델을 등록할까요?"}
          message={selectedId ? `'${selectedId}' 모델에 지금 편집한 내용을 저장합니다.` : `'${form.modelId}' 모델을 카탈로그에 새로 등록합니다.`}
          warningItems={unevidencedDatasets} confirmLabel={selectedId ? "저장" : "등록"} />}
      {createMode && <CreateModelDialog mode={createMode} onModeChange={setCreateMode} onManual={startCreate} onUseDraft={(...draft) => { setReviewInfo(null); useAiDraft(...draft); }} onClose={() => setCreateMode(null)} />}
      <header className="admin-header">
        <div><p className="eyebrow">AIBOM ADMIN</p><h1>Model catalog</h1><p>등록된 모델 정보와 모델 간 연결 관계를 조회하고 수정할 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><a href="/admin/research" className="admin-secondary">AI 조사 이력</a><button type="button" className="admin-primary" onClick={() => setCreateMode("method")}>+ 새 모델</button></div>
      </header>
      <div className="admin-stats">
        <span><strong>{models.length}</strong> Models</span><span><strong>{families.length}</strong> Families</span>
        <span><strong>{models.filter((model) => !model.parentModelId).length}</strong> Roots</span>
      </div>
      <main className="admin-layout">
        <aside className="admin-tree-panel">
          <div className="admin-tree-head"><h2>Hierarchy</h2><span>{visibleModels.length}</span></div>
          <div className="admin-filters">
            <input type="search" aria-label="Search models" placeholder="모델명 또는 공급자 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Filter by family" value={familyFilter} onChange={(e) => setFamilyFilter(e.target.value)}>
              <option value="all">모든 패밀리</option>{families.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </div>
          <div className="admin-tree" role="tree" aria-label="Model hierarchy">
            {orderedModels.length ? orderedModels.map(({ model, depth }) => (
              <button type="button" role="treeitem" aria-selected={selectedId === model.modelId} className={selectedId === model.modelId ? "is-selected" : ""}
                style={{ "--tree-depth": depth }} key={model.modelId} onClick={() => selectModel(model)}>
                <span className={`admin-tree-dot ${model.parentModelId ? "derived" : "root"}`} />
                <span><strong>{model.modelName}</strong><small>{model.modelId}</small></span>
                <em>{model.modelRole}</em>
              </button>
            )) : <p className="admin-empty">{models.length ? "조건에 맞는 모델이 없습니다." : "아직 등록된 모델이 없습니다. 오른쪽 양식이나 상단의 “+ 새 모델”로 첫 모델을 등록하세요."}</p>}
          </div>
        </aside>

        <section className="admin-editor">
          <div className="admin-editor-title">
            <div><p className="eyebrow">{selectedId ? "EDIT MODEL" : "CREATE MODEL"}</p><h2>{selectedId || "새 모델 등록"}</h2></div>
            {selectedId && <div className="admin-title-badges">
              {modelRun && <a className={`admin-owner is-${modelRun.reviewStatus}`} href={`/admin/research?run=${modelRun.runId}`}
                title={`AI 조사 #${modelRun.runId} · ${modelRun.reviewStatus === "saved" ? "검토 완료 · 저장됨" : "검토 대기"} (눌러서 조사 이력 보기)`}>
                {modelRun.reviewStatus === "saved"
                  ? <>검토자 <b>{modelRun.reviewedByName || reviewerNames(modelRun.reviewers, true) || "기록 없음"}</b></>
                  : <>담당 <b>{reviewerNames(modelRun.reviewers) || "미배정"}</b></>}
                <small>AI 조사 #{modelRun.runId}</small>
              </a>}
              <span className="admin-depth">Depth {form.hierarchyDepth}</span>
            </div>}
          </div>
          {reviewMode && <div className="review-bar" aria-live="polite">
            <div className="review-bar-row">
              <label>검토자
                <select className={reviewerId ? "" : "is-missing"} value={reviewerId} disabled={saving || reviewBusy}
                  onChange={(event) => switchReviewer(event.target.value)} aria-label="검토자 선택">
                  <option value="">내 이름을 선택하세요</option>
                  {reviewInfo.reviewers.map((reviewer) => <option key={reviewer.id} value={String(reviewer.id)}>{reviewer.name || "삭제된 작업자"}{reviewer.status === "submitted" ? " (제출함)" : ""}</option>)}
                </select>
              </label>
              <small>AI 조사 #{activeReviewRunId} · 검토 {reviewInfo.reviewProgress.submitted}/{reviewInfo.reviewProgress.total} 제출 · {reviewInfo.reviewers.map((reviewer) => `${reviewer.name || "삭제된 작업자"}${reviewer.status === "submitted" ? " ✓" : ""}`).join(" · ")}</small>
            </div>
            {reviewInfo.reviewStatus === "merging" ? <p className="review-state is-merging"><span className="review-spinner" aria-hidden="true" />AI 병합 중… 검토자들의 답이 동점인 값을 AI가 병합하고 있습니다. 끝나면 자동으로 저장됩니다.</p>
              : reviewInfo.reviewStatus === "saving" ? <p className="review-state is-saving"><span className="review-spinner" aria-hidden="true" />저장 중… 모든 검토가 제출되어 다수결 결과를 저장하고 있습니다.</p>
                : reviewInfo.reviewStatus === "failed" ? <p className="review-state is-failed">저장하지 못했습니다: {reviewInfo.finalize.error} 답을 고쳐 다시 제출하거나 다시 시도하세요.
                  <button type="button" className="admin-secondary" disabled={retrying} onClick={retryFinalize}>{retrying ? "시작하는 중…" : "다시 시도"}</button></p>
                  : mySubmitted ? <p className="review-state is-submitted">검토를 제출했습니다. 다른 검토자 {reviewInfo.reviewProgress.total - reviewInfo.reviewProgress.submitted}명이 제출하면 다수결 결과가 자동으로 저장됩니다. 그 전까지는 값을 고쳐 다시 제출할 수 있습니다.</p>
                    : <p className="review-state">{reviewerId ? "값과 근거를 확인해 고른 뒤 아래 “검토 완료”를 누르세요. 카탈로그에는 배정된 검토자가 모두 제출한 뒤 다수결로 저장됩니다(동점인 값은 AI가 병합)." : "검토를 시작하려면 먼저 검토자(내 이름)를 선택하세요."}</p>}
          </div>}
          {selectedId && activeReviewRunId && <div className="ai-draft-banner"><span>✦</span><div><strong>AI 조사 #{activeReviewRunId} 결과를 검토하고 있습니다</strong><p>이미 등록된 모델이라 새로 만들지 않고 이 모델에 반영합니다. 각 항목 위의 HF / 논문 / AI 병합 칩으로 조사 값을 골라 넣{reviewMode ? "은 뒤 검토를 제출하세요." : "고 저장하면, 이 조사 실행이 검토 완료로 표시됩니다."}</p></div><em>검토 중</em></div>}
          {aiDraft && <div className="ai-draft-banner"><span>✦</span><div><strong>AI가 작성한 초안입니다</strong><p>내용과 출처를 확인하고 필요한 항목을 수정한 뒤 {reviewMode ? "검토를 제출해 주세요" : "등록해 주세요"}. 각 항목 위의 HF / 논문 / AI 병합 칩으로 다른 조사 결과의 값으로 바꿀 수 있습니다.{pendingAibom && !reviewMode ? ` AIBOM(평가 ${pendingAibom.evaluation?.length || 0}건 · 데이터셋 ${pendingAibom.dataset?.length || 0}개 · 근거 ${pendingAibom.reference?.length || 0}개)을 포함한 전체 정보가 한 번에 저장됩니다.` : ""}</p></div><em>검토 필요</em></div>}
          <form onSubmit={requestSave}>
            <fieldset><legend>기본 정보</legend><div className="admin-form-grid">
              <Field label="Model ID" evidence={cev("modelId")} picker={pkOnly("modelId")}><Input field="modelId" form={form} setForm={setForm} required disabled={Boolean(selectedId)} readOnly={chipOnly("modelId")} /></Field>
              <Field label="Namespace" evidence={cev("namespace")} picker={pkOnly("namespace")}><Input field="namespace" form={form} setForm={setForm} required readOnly={chipOnly("namespace")} /></Field>
              <Field label="Model name" evidence={cev("modelName")} picker={pkOnly("modelName")}><Input field="modelName" form={form} setForm={setForm} required readOnly={chipOnly("modelName")} /></Field>
              <Field label="Role" evidence={cev("modelRole")} picker={pkOnly("modelRole")}><select disabled={chipOnly("modelRole")} value={form.modelRole} onChange={(e) => setForm({ ...form, modelRole: e.target.value })}><option>BASE</option><option>DERIVED</option></select></Field>
              <Field label="Family key" evidence={cev("familyKey")} picker={pkOnly("familyKey")}><Input field="familyKey" form={form} setForm={setForm} required readOnly={chipOnly("familyKey")} /></Field>
              <Field label="Family name" evidence={cev("familyName")} picker={pkOnly("familyName")}><Input field="familyName" form={form} setForm={setForm} required readOnly={chipOnly("familyName")} /></Field>
              <Field label="Model URL" wide evidence={cev("modelUrl")} picker={pkOnly("modelUrl")}><Input field="modelUrl" form={form} setForm={setForm} type="url" required readOnly={chipOnly("modelUrl")} /></Field>
              <Field label="Description" wide evidence={cev("description")} picker={pk("description")}><textarea value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows="3" /></Field>
            </div></fieldset>

            <fieldset><legend>계층 구조</legend><p className="admin-help">{hierarchyLocked ? "AI 조사 결과의 부모 후보와 카탈로그를 대조해 자동으로 정해진 값입니다. 여기서는 조회만 할 수 있습니다." : "부모를 바꾸면 현재 모델과 모든 하위 모델의 depth가 자동으로 재계산됩니다."}</p><div className="admin-form-grid">
              <Field label="Parent model"><select disabled={hierarchyLocked} value={form.parentModelId || ""} onChange={(e) => setForm({ ...form, parentModelId: e.target.value || null })}>
                <option value="">없음 (Root)</option>{models.filter((model) => !descendants.has(model.modelId) && (!form.familyKey || model.familyKey === form.familyKey))
                  .sort((a, b) => a.modelName.localeCompare(b.modelName, "en", { sensitivity: "base" }) || a.modelId.localeCompare(b.modelId, "en", { sensitivity: "base" }))
                  .map((model) => <option value={model.modelId} key={model.modelId}>{model.modelName} — {model.modelId}</option>)}
              </select></Field>
              <Field label="Relationship type" evidence={cev("relationshipType")} picker={hierarchyLocked ? null : pk("relationshipType")}><Input field="relationshipType" form={form} setForm={setForm} disabled={hierarchyLocked || !form.parentModelId} placeholder="fineTunedFrom" required={Boolean(form.parentModelId)} /></Field>
              <Field label="Change details JSON" wide><textarea className="code-input" readOnly={hierarchyLocked} value={changeText} onChange={(e) => setChangeText(e.target.value)} rows="5" placeholder={'{\n  "added_task": "..."\n}'} /></Field>
            </div></fieldset>

            <fieldset><legend>모델 메타데이터</legend><div className="admin-form-grid">
              <Field label="Release date" evidence={cev("releaseDate")} picker={pk("releaseDate")}><Input field="releaseDate" form={form} setForm={setForm} type="date" /></Field>
              {textFields.map(([field, label]) => <Field label={label} key={field} wide={field === "packageUrl"} evidence={cev(field)} picker={pk(field)}><Input field={field} form={form} setForm={setForm} /></Field>)}
              <Field label="License reported JSON" wide><textarea className="code-input" value={licenseText} onChange={(e) => setLicenseText(e.target.value)} rows="3" placeholder='"apache-2.0" 또는 ["license-a"]' /></Field>
            </div></fieldset>

            {(selectedId || pendingAibom) && <AibomEditor ref={aibomEditorRef} modelId={selectedId} initialAibom={pendingAibom} refreshKey={aibomRefresh} disabled={saving || reviewBusy} evidence={evidenceRows} candidates={candidates} onPickEvidence={pickAibomEvidence} />}

            <div className="admin-form-actions">
              {reviewMode ? <i aria-hidden="true" /> : selectedId && <button type="button" className="admin-danger" onClick={remove} disabled={saving}>삭제</button>}
              <span className="review-action-state" aria-live="polite">{!reviewMode ? "" : reviewInfo.reviewStatus === "merging" ? "AI 병합 중… 끝나면 자동으로 저장됩니다."
                : reviewInfo.reviewStatus === "saving" ? "저장 중…" : mySubmitted ? `제출 완료 · ${reviewInfo.reviewProgress.submitted}/${reviewInfo.reviewProgress.total}명 제출` : ""}</span>
              {reviewMode ? <>
                <button type="button" className="admin-secondary" onClick={() => switchReviewer(reviewerId)} disabled={saving || reviewBusy}>변경 취소</button>
                <button type="submit" className="admin-primary" disabled={saving || reviewBusy || !reviewerId}
                  title={reviewerId ? undefined : "먼저 위에서 검토자(내 이름)를 선택하세요."}>
                  {saving ? "제출 중..." : reviewInfo.reviewStatus === "merging" ? "AI 병합 중…" : reviewInfo.reviewStatus === "saving" ? "저장 중…" : mySubmitted ? "검토 다시 제출" : "검토 완료"}</button>
              </> : <>
                <button type="button" className="admin-secondary" onClick={() => selectedId ? selectModel(models.find((m) => m.modelId === selectedId)) : startCreate()} disabled={saving}>변경 취소</button>
                <button type="submit" className="admin-primary" disabled={saving}>{saving ? "저장 중..." : selectedId ? "변경사항 저장" : aiDraft ? "검토 완료 및 모델 등록" : "모델 등록"}</button>
              </>}
            </div>
          </form>
          {selectedId && <ModelResearchRuns modelId={selectedId} refreshKey={aibomRefresh} />}
        </section>
      </main>
    </div>
  );
}
