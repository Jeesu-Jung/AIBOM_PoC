import { useEffect, useMemo, useRef, useState } from "react";
import AibomEditor from "./components/admin/AibomEditor.jsx";
import { createAdminModel, deleteAdminModel, fetchAdminModels, fetchAdminResearchResults, saveAdminModelAibom, saveAdminResearchResults, streamAdminModelMerge, streamAdminModelResearch, updateAdminModel } from "./api/admin.js";

const EMPTY_MODEL = {
  modelId: "", namespace: "", modelName: "", familyKey: "", familyName: "", modelRole: "DERIVED",
  supplier: "", familyDeveloper: "", familyReleaseDate: "", familyLicenseName: "", primaryPurpose: "",
  modelVersion: "", packageUrl: "", modelUrl: "", licenseReported: null, artifactFormat: "", tensorType: "",
  parameterScale: "", artifactRevision: "", description: "", bomFormat: "CycloneDX", bomSpecVersion: "1.6",
  bomSerialNumber: "", bomVersion: "1", checklistPresentFields: null, checklistTotalFields: null,
  checklistScore: null, checklistPenaltyFactor: null, sourceGeneratedAt: null, detailsJson: {}, parentModelId: null,
  relationshipType: null, hierarchyDepth: 0, siblingOrder: 0, changeDetailsJson: null
};

const textFields = [
  ["supplier", "Supplier"], ["familyDeveloper", "Family developer"], ["familyLicenseName", "Family license"],
  ["primaryPurpose", "Primary purpose"], ["modelVersion", "Model version"], ["artifactFormat", "Artifact format"],
  ["tensorType", "Tensor type"], ["parameterScale", "Parameter scale"], ["artifactRevision", "Artifact revision"],
  ["packageUrl", "Package URL"], ["bomFormat", "BOM format"], ["bomSpecVersion", "BOM spec version"],
  ["bomSerialNumber", "BOM serial number"], ["bomVersion", "BOM version"]
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

function Field({ label, children, wide = false }) {
  return <label className={`admin-field${wide ? " admin-field-wide" : ""}`}><span>{label}</span>{children}</label>;
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

const mergeFields = [
  ["modelId", "Model ID"], ["namespace", "Namespace"], ["modelName", "Model name"], ["familyKey", "Family key"],
  ["familyName", "Family name"], ["modelRole", "Role"], ["supplier", "Supplier"], ["familyDeveloper", "Family developer"],
  ["familyReleaseDate", "Family release date"], ["familyLicenseName", "Family license"], ["primaryPurpose", "Primary purpose"],
  ["modelVersion", "Model version"], ["packageUrl", "Package URL"], ["modelUrl", "Model URL"], ["licenseReported", "License reported"],
  ["artifactFormat", "Artifact format"], ["tensorType", "Tensor type"], ["parameterScale", "Parameter scale"],
  ["artifactRevision", "Artifact revision"], ["description", "Description"]
];
const linkedFieldGroups = [["modelId", "namespace", "modelName"], ["familyKey", "familyName"]];
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

function AibomDraftSummary({ results, chosenKey }) {
  const columns = [...researchSources, { value: "merged", label: "AI 병합" }].filter((option) => results[option.value]);
  if (!columns.some((option) => results[option.value]?.aibom)) {
    return <div className="ai-result-section"><div className="ai-result-heading"><strong>AIBOM 초안</strong></div>
      <p className="ai-result-empty">이 조사 결과에는 AIBOM 초안이 없습니다(이전 버전에서 저장된 결과). 다시 검색하면 AIBOM까지 조사합니다.</p></div>;
  }
  const decisions = results.merged?.areaDecisions || [];
  return <div className="ai-result-section">
    <div className="ai-result-heading"><strong>AIBOM 초안 (8개 영역)</strong><span>등록 시 {sourceLabel(chosenKey)} 초안이 함께 저장됩니다</span></div>
    <div className="ai-aibom-table" role="table" style={{ "--aibom-columns": columns.length }}>
      <div className="ai-aibom-row is-head" role="row"><span>영역</span>{columns.map((option) => <span key={option.value}>{option.label}</span>)}</div>
      {aibomSummaryFields.map(([key, label]) => <div className="ai-aibom-row" role="row" key={key}>
        <span>{label}</span>
        {columns.map((option) => <span key={option.value} className={option.value === chosenKey ? "is-chosen" : ""}>{results[option.value]?.aibomSummary?.[key] ?? "-"}</span>)}
      </div>)}
    </div>
    {decisions.length > 0 && <ul className="ai-area-decisions">{decisions.map((item) => <li key={item.area}><b>{aibomAreaLabels[item.area] || item.area}</b> {decisionLabels[item.chosen] || item.chosen} · {item.rationale}</li>)}</ul>}
    <p className="ai-merge-hint">AIBOM은 모델 등록 후 편집 화면 하단의 AIBOM 섹션에서 영역별로 수정할 수 있습니다.</p>
  </div>;
}

function ValueCell({ result, run, field, state, onSelect, sourceName }) {
  if (!result) return <div className="ai-merge-cell is-unavailable" data-source={sourceName}><span>{run.status === "error" ? "조사 실패" : "결과 없음"}</span></div>;
  const value = displayValue(result.draft?.[field]);
  const evidence = evidenceFor(result, field);
  return <button type="button" className={`ai-merge-cell${state ? ` is-${state}` : ""}${value ? "" : " is-empty"}`} data-source={sourceName} onClick={onSelect} aria-pressed={state === "selected"} title={state === "selected" ? "현재 병합 값과 동일" : "이 값으로 바꾸기"}>
    <strong>{value || "값 없음"}</strong>
    {evidence && <small>근거 {evidence.confidence}{evidence.urls?.length ? ` · 출처 ${evidence.urls.length}` : ""}</small>}
  </button>;
}

function CreateModelDialog({ mode, onModeChange, onManual, onUseDraft, onClose }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("input");
  const [runs, setRuns] = useState(initialRuns);
  const [results, setResults] = useState({ huggingface: null, paper: null, merged: null });
  const [overrides, setOverrides] = useState({});
  const [searchError, setSearchError] = useState(null);
  const [stored, setStored] = useState(null);
  const [checkingStore, setCheckingStore] = useState(false);
  const [loadedFromStore, setLoadedFromStore] = useState(false);
  const [saveState, setSaveState] = useState({ status: "idle", message: "" });
  const abortRef = useRef(null);

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
    setSearchError(null);
    setStored(null);
    setLoadedFromStore(false);
    setSaveState({ status: "idle", message: "" });
    setStage("input");
  };

  const persist = async (modelName, payload, replacePrevious) => {
    setSaveState({ status: "saving", message: "조사 결과를 저장하고 있습니다." });
    try {
      const saved = await saveAdminResearchResults(modelName, payload, replacePrevious);
      setSaveState({ status: "saved", message: `조사 결과를 저장했습니다 (${formatDateTime(saved.latestCreatedAt)}).` });
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
    setRuns({ huggingface: { ...emptyRun(), status: "loading" }, paper: { ...emptyRun(), status: "loading" }, merged: emptyRun() });
    setStage("working");
    const controller = new AbortController();
    abortRef.current = controller;

    const runSource = async (key) => {
      try {
        const payload = await streamAdminModelResearch(modelName, streamHandler(key), controller.signal, key);
        updateRun(key, { status: "done" });
        setResults((current) => ({ ...current, [key]: payload }));
        return payload;
      } catch (error) {
        updateRun(key, { status: "error", error: error.name === "AbortError" ? "취소됨" : error.message });
        return null;
      }
    };

    const [huggingface, paper] = await Promise.all(sourceKeys.map(runSource));
    if (controller.signal.aborted) return;
    if (!huggingface && !paper) {
      abortRef.current = null;
      setSearchError("두 조사 방식 모두 결과를 얻지 못했습니다. 모델명을 확인하고 다시 시도해 주세요.");
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
    const ai = { ...(baseResult.draft.detailsJson?.ai_research || {}), reviewed: false };
    if (Object.keys(overrides).length) ai.manualOverrides = { ...overrides };
    draft.detailsJson = {
      ...(baseResult.draft.detailsJson || {}),
      model: { ...(baseResult.draft.detailsJson?.model || {}), id: draft.modelId, title: draft.modelId, subtitle: draft.description },
      ai_research: ai
    };
    return draft;
  }, [stage, baseResult, overrides, results]);

  const aibomKey = results.merged?.aibom ? "merged" : ["huggingface", "paper"].find((key) => results[key]?.aibom) || null;
  const finalAibom = aibomKey ? results[aibomKey].aibom : null;
  const overrideCount = Object.keys(overrides).length;
  const workingTitle = runs.merged.status === "loading" ? "두 조사 결과를 AI가 병합하고 있습니다" : `“${query}” 정보를 찾고 있습니다`;

  return (
    <div className="admin-modal-backdrop create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && stage !== "working") onClose(); }}>
      <section className={`create-dialog ${mode === "ai" ? "is-ai" : ""}`} role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
        <div className="create-dialog-head">
          <div><p className="eyebrow">CREATE MODEL</p><h2 id="create-dialog-title">새 모델을 어떻게 등록할까요?</h2></div>
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
          <div className="ai-existing-banner"><span>↺</span><div><strong>“{stored.modelName}” 의 이전 조사 결과가 있습니다</strong><p>마지막 저장 {formatDateTime(stored.latestCreatedAt)}. 저장된 결과를 불러오거나 새로 조사할 수 있습니다. 새로 조사하면 조사가 끝나 저장되는 시점에 이전 결과가 삭제됩니다.</p></div></div>
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
            <div className="ai-result-heading"><strong>항목별 병합 결과</strong>
              <div className="ai-merge-actions">
                {overrideCount > 0 && <button type="button" onClick={() => setOverrides({})}>AI 병합값으로 되돌리기</button>}
                {results.merged && sourceKeys.map((key) => <button key={key} type="button" disabled={!results[key]} onClick={() => { const next = {}; mergeFields.forEach(([field]) => { next[field] = key; }); setOverrides(next); }}>모두 {sourceLabel(key)}</button>)}
              </div>
            </div>
            <div className="ai-merge-table is-three" role="table">
              <div className="ai-merge-row is-head" role="row"><span>항목</span>{researchSources.map((option) => <span key={option.value}>{option.label}</span>)}<span>병합 결과</span></div>
              {mergeFields.map(([field, label]) => {
                const decision = decisions[field];
                const value = displayValue(finalValue(field));
                const overridden = Boolean(overrides[field]);
                return <div key={field} className={`ai-merge-row${conflicts.has(field) ? " is-conflict" : ""}`} role="row">
                  <span className="ai-merge-label">{label}{conflicts.has(field) && <em>충돌</em>}</span>
                  {researchSources.map((option) => <ValueCell key={option.value} sourceName={option.label} result={results[option.value]} run={runs[option.value]} field={field} state={cellState(field, option.value)} onSelect={() => setOverride(field, overrides[field] === option.value ? null : option.value)} />)}
                  <div className={`ai-merge-final${overridden ? " is-override" : ""}${value ? "" : " is-empty"}`} data-source="병합 결과">
                    <strong>{value || "값 없음"}</strong>
                    <small>{overridden ? <b>수동 선택 · {sourceLabel(overrides[field])}</b> : decision ? <><b>{decisionLabels[decision.chosen] || decision.chosen}</b>{decision.rationale ? ` · ${decision.rationale}` : ""}</> : results.merged ? "결정 정보 없음" : sourceLabel(results.huggingface ? "huggingface" : "paper")}</small>
                    {overridden && <button type="button" onClick={() => setOverride(field, null)}>AI 값으로</button>}
                  </div>
                </div>;
              })}
            </div>
            <p className="ai-merge-hint">Model ID·Namespace·Model name, Family key·Family name은 함께 바뀝니다. 병합 결과 열의 이유는 AI가 남긴 선택 근거입니다.</p>
          </div>

          <AibomDraftSummary results={results} chosenKey={aibomKey} />

          {baseResult.parentCandidates?.length > 0 && <div className="ai-result-section"><div className="ai-result-heading"><strong>부모 모델 후보</strong><span>{baseResult.parentCandidates.length}</span></div><ul className="ai-parent-list">{baseResult.parentCandidates.map((candidate) => <li key={`${candidate.modelId}-${candidate.relationshipType}`}><strong>{candidate.modelId}</strong><span>{candidate.relationshipType} · 신뢰도 {candidate.confidence}</span></li>)}</ul></div>}

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

          <div className="create-dialog-actions"><button type="button" className="admin-secondary" onClick={resetSearch}>다시 검색</button><button type="button" className="admin-primary" onClick={() => onUseDraft(finalDraft, finalAibom)}>편집 화면에서 검토</button></div>
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
  const [createMode, setCreateMode] = useState(null);
  const [aiDraft, setAiDraft] = useState(false);
  const [aibomRefresh, setAibomRefresh] = useState(0);
  const [pendingAibom, setPendingAibom] = useState(null);

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
      if (data[0]) selectModel(data[0]);
    }).catch((error) => setNotice({ type: "error", text: error.message })).finally(() => setLoading(false));
  }, []);

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
    setNotice(null);
  }

  function startCreate() {
    const family = familyFilter !== "all" ? families.find(([key]) => key === familyFilter) : null;
    const fresh = { ...EMPTY_MODEL, familyKey: family?.[0] || "", familyName: family?.[1] || "" };
    setSelectedId(null); setForm(normalizeForForm(fresh)); setDetailsText("{}"); setChangeText(""); setLicenseText(""); setNotice(null); setCreateMode(null); setAiDraft(false); setPendingAibom(null);
  }

  function useAiDraft(draft, aibom = null) {
    setSelectedId(null);
    setPendingAibom(aibom);
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

  async function save(event) {
    event.preventDefault();
    setSaving(true); setNotice(null);
    try {
      const parentId = form.parentModelId || null;
      const payload = {
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
        familyReleaseDate: form.familyReleaseDate || null
      };
      const saved = selectedId ? await updateAdminModel(selectedId, payload) : await createAdminModel(payload);
      let aibomNote = "";
      if (!selectedId && pendingAibom) {
        // The AI draft's AIBOM is saved right after the catalog record exists.
        try {
          await saveAdminModelAibom(saved.modelId, pendingAibom);
          aibomNote = " AI가 조사한 AIBOM도 함께 저장했습니다.";
        } catch (error) {
          aibomNote = ` 다만 AIBOM 저장에 실패했습니다: ${error.message} 편집 화면 하단 AIBOM 섹션에서 다시 저장해 주세요.`;
        }
      }
      setPendingAibom(null);
      await reload(saved.modelId);
      setAibomRefresh((value) => value + 1);
      setNotice({ type: aibomNote.includes("실패") ? "error" : "success", text: (selectedId ? "모델 정보가 수정되었습니다." : "새 모델이 등록되었습니다.") + aibomNote });
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
      {createMode && <CreateModelDialog mode={createMode} onModeChange={setCreateMode} onManual={startCreate} onUseDraft={useAiDraft} onClose={() => setCreateMode(null)} />}
      <header className="admin-header">
        <div><p className="eyebrow">AIBOM ADMIN</p><h1>Model catalog</h1><p>등록된 모델 정보와 모델 간 연결 관계를 조회하고 수정할 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><button type="button" className="admin-primary" onClick={() => setCreateMode("method")}>+ 새 모델</button></div>
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
            )) : <p className="admin-empty">조건에 맞는 모델이 없습니다.</p>}
          </div>
        </aside>

        <section className="admin-editor">
          <div className="admin-editor-title">
            <div><p className="eyebrow">{selectedId ? "EDIT MODEL" : "CREATE MODEL"}</p><h2>{selectedId || "새 모델 등록"}</h2></div>
            {selectedId && <span className="admin-depth">Depth {form.hierarchyDepth}</span>}
          </div>
          {aiDraft && <div className="ai-draft-banner"><span>✦</span><div><strong>AI가 작성한 초안입니다</strong><p>내용과 출처를 확인하고 필요한 항목을 수정한 뒤 등록해 주세요.{pendingAibom ? ` 등록하면 AI가 조사한 AIBOM(평가 ${pendingAibom.evaluation?.length || 0}건 · 데이터셋 ${pendingAibom.dataset?.length || 0}개 · 근거 ${pendingAibom.reference?.length || 0}개)도 함께 저장됩니다.` : ""}</p></div><em>검토 필요</em></div>}
          <form onSubmit={save}>
            <fieldset><legend>기본 정보</legend><div className="admin-form-grid">
              <Field label="Model ID"><Input field="modelId" form={form} setForm={setForm} required disabled={Boolean(selectedId)} /></Field>
              <Field label="Namespace"><Input field="namespace" form={form} setForm={setForm} required /></Field>
              <Field label="Model name"><Input field="modelName" form={form} setForm={setForm} required /></Field>
              <Field label="Role"><select value={form.modelRole} onChange={(e) => setForm({ ...form, modelRole: e.target.value })}><option>BASE</option><option>INSTRUCT</option><option>DERIVED</option></select></Field>
              <Field label="Family key"><Input field="familyKey" form={form} setForm={setForm} required /></Field>
              <Field label="Family name"><Input field="familyName" form={form} setForm={setForm} required /></Field>
              <Field label="Model URL" wide><Input field="modelUrl" form={form} setForm={setForm} type="url" required /></Field>
              <Field label="Description" wide><textarea value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows="3" /></Field>
            </div></fieldset>

            <fieldset><legend>계층 구조</legend><p className="admin-help">부모를 바꾸면 현재 모델과 모든 하위 모델의 depth가 자동으로 재계산됩니다.</p><div className="admin-form-grid">
              <Field label="Parent model"><select value={form.parentModelId || ""} onChange={(e) => setForm({ ...form, parentModelId: e.target.value || null })}>
                <option value="">없음 (Root)</option>{models.filter((model) => !descendants.has(model.modelId) && (!form.familyKey || model.familyKey === form.familyKey)).map((model) => <option value={model.modelId} key={model.modelId}>{model.modelName} — {model.modelId}</option>)}
              </select></Field>
              <Field label="Relationship type"><Input field="relationshipType" form={form} setForm={setForm} disabled={!form.parentModelId} placeholder="fineTunedFrom" required={Boolean(form.parentModelId)} /></Field>
              <Field label="Sibling order"><Input field="siblingOrder" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Change details JSON" wide><textarea className="code-input" value={changeText} onChange={(e) => setChangeText(e.target.value)} rows="5" placeholder={'{\n  "added_task": "..."\n}'} /></Field>
            </div></fieldset>

            <fieldset><legend>모델 메타데이터</legend><div className="admin-form-grid">
              <Field label="Family release date"><Input field="familyReleaseDate" form={form} setForm={setForm} type="date" /></Field>
              {textFields.map(([field, label]) => <Field label={label} key={field} wide={field === "packageUrl"}><Input field={field} form={form} setForm={setForm} /></Field>)}
              <Field label="License reported JSON" wide><textarea className="code-input" value={licenseText} onChange={(e) => setLicenseText(e.target.value)} rows="3" placeholder='"apache-2.0" 또는 ["license-a"]' /></Field>
            </div></fieldset>

            <fieldset><legend>품질 및 원본 데이터</legend><div className="admin-form-grid">
              <Field label="Checklist present"><Input field="checklistPresentFields" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Checklist total"><Input field="checklistTotalFields" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Checklist score"><Input field="checklistScore" form={form} setForm={setForm} type="number" min="0" max="100" step="0.01" /></Field>
              <Field label="Penalty factor"><Input field="checklistPenaltyFactor" form={form} setForm={setForm} type="number" min="0" max="1" step="0.0001" /></Field>
              <Field label="Source generated at"><Input field="sourceGeneratedAt" form={form} setForm={setForm} type="datetime-local" step="any" /></Field>
              <Field label="Details JSON" wide><textarea className="code-input" value={detailsText} onChange={(e) => setDetailsText(e.target.value)} rows="14" required /></Field>
            </div></fieldset>

            <div className="admin-form-actions">
              {selectedId && <button type="button" className="admin-danger" onClick={remove} disabled={saving}>삭제</button>}
              <span />
              <button type="button" className="admin-secondary" onClick={() => selectedId ? selectModel(models.find((m) => m.modelId === selectedId)) : startCreate()} disabled={saving}>변경 취소</button>
              <button type="submit" className="admin-primary" disabled={saving}>{saving ? "저장 중..." : selectedId ? "변경사항 저장" : aiDraft ? "검토 완료 및 모델 등록" : "모델 등록"}</button>
            </div>
          </form>
          {selectedId && <AibomEditor modelId={selectedId} refreshKey={aibomRefresh} onNotice={setNotice} />}
        </section>
      </main>
    </div>
  );
}
