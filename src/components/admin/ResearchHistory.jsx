import { useEffect, useMemo, useState } from "react";
import { deleteResearchRun, fetchResearchRun, fetchResearchRuns } from "../../api/admin.js";
import { aibomDraftToView } from "../../domain/aibomView.js";
import { historyFields } from "../../constants/researchFields.js";
import { downloadJson, jsonFilename } from "../../utils/download.js";
import AibomAreas from "../aibom/AibomAreas.jsx";

// Stored "AI로 정보 채우기" runs (model_research_run / model_research_result): every run keeps its
// Hugging Face, paper and merged results, so past research can be compared at any time.

const SOURCES = [["huggingface", "Hugging Face"], ["paper", "논문 · 기술 보고서"], ["merged", "AI 병합"]];
const STATUS = { found: "확인됨", ambiguous: "후보 여러 개", not_found: "찾지 못함" };
const DECISIONS = { huggingface: "HF 값", paper: "논문 값", combined: "두 결과 결합", none: "값 없음" };

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
};
const formatCost = (value) => (value == null ? "-" : `$${value.toFixed(4)}`);
const display = (value) => (value == null || value === "" || (Array.isArray(value) && !value.length)
  ? null : Array.isArray(value) ? value.join(", ") : String(value));

function SourceBadges({ run }) {
  return <span className="research-run-badges">{SOURCES.map(([key, label]) => {
    const item = run.results[key];
    return <b key={key} className={item ? `is-${item.status}` : "is-missing"} title={label}>
      {label.split(" ")[0]} {item ? STATUS[item.status] || item.status : "없음"}
    </b>;
  })}</span>;
}

export function ModelResearchRuns({ modelId, refreshKey }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setRuns(null);
    fetchResearchRuns({ modelId }).then(setRuns).catch((err) => setError(err.message));
  }, [modelId, refreshKey]);

  return (
    <fieldset className="research-runs-inline">
      <legend>AI 조사 이력</legend>
      <p className="admin-help">실행을 누르면 AI 조사 이력 페이지에서 조사 결과를 볼 수 있습니다.</p>
      {error ? <p className="admin-help">조사 이력을 불러오지 못했습니다: {error}</p>
        : !runs ? <p className="admin-help">조사 이력을 불러오는 중입니다...</p>
          : !runs.length ? <p className="admin-help">이 모델로 저장된 AI 조사 결과가 없습니다.</p>
            : <ul className="research-run-list is-compact">{runs.map((run) => (
              <li key={run.runId}><a href={`/admin/research?run=${run.runId}`}>
                <strong>#{run.runId}</strong><span>{formatDateTime(run.createdAt)}</span><SourceBadges run={run} />
                <em>{run.modelId === modelId ? "검토 완료 · 이 실행으로 저장" : run.reviewStatus === "saved" ? `저장됨 → ${run.modelId}` : "검토 대기"}</em>
              </a></li>
            ))}</ul>}
    </fieldset>
  );
}

function SourceDetail({ item, fields, sourceKey }) {
  const [showAibom, setShowAibom] = useState(sourceKey === "merged");
  if (!item) return <p className="ai-result-empty">이 실행에는 결과가 없습니다.</p>;
  const result = item.result || {};
  const draft = result.draft || {};
  const decisions = new Map((result.fieldDecisions || []).map((decision) => [decision.field, decision]));
  const view = result.aibom ? aibomDraftToView(result.aibom, draft.modelId) : null;
  const downloadDraft = () => downloadJson(
    result,
    `${jsonFilename(draft.modelId || "model", "model")}-${sourceKey === "merged" ? "ai-merged-" : `${sourceKey}-`}research-result.json`
  );

  return (
    <div className="research-source-detail">
      <dl className="research-source-meta">
        <div><dt>상태</dt><dd>{STATUS[item.status] || item.status || "-"}</dd></div>
        <div><dt>Research model</dt><dd>{item.researchModel || "-"}</dd></div>
        <div><dt>웹 검색</dt><dd>{item.webSearchRequests ?? "-"}</dd></div>
        <div><dt>비용</dt><dd>{formatCost(item.costUsd)}</dd></div>
        <div><dt>저장 시각</dt><dd>{formatDateTime(item.createdAt)}</dd></div>
      </dl>

      <div className="research-draft-head">
        <h5>모델정보 초안</h5>
        <button type="button" className="json-download-button" onClick={downloadDraft}>JSON 다운로드</button>
      </div>
      <table className="research-draft-table"><tbody>{fields.map(([field, label]) => {
        const decision = decisions.get(field);
        return <tr key={field}><th scope="row">{label}</th><td>{display(draft[field]) || <span className="is-empty">값 없음</span>}
          {decision && <small>{DECISIONS[decision.chosen] || decision.chosen} · {decision.rationale}</small>}</td></tr>;
      })}</tbody></table>

      <div className="research-aibom-in-draft">
        <p className="research-aibom-label">AIBOM
          {result.aibomSummary && <span className="research-aibom-counts">
            평가 {result.aibomSummary.evaluations ?? 0} · 데이터셋 {result.aibomSummary.datasets ?? 0} · 안전 {result.aibomSummary.safety_items ?? 0} · 근거 {result.aibomSummary.references ?? 0}
          </span>}
        </p>
        {result.areaDecisions?.length > 0 && <ul className="ai-area-decisions">{result.areaDecisions.map((decision) => (
          <li key={decision.area}><b>{decision.area}</b> {DECISIONS[decision.chosen] || decision.chosen} · {decision.rationale}</li>
        ))}</ul>}
        {view ? (showAibom
          ? <div className="research-aibom-preview"><AibomAreas aibom={view} /></div>
          : <button type="button" className="admin-secondary" onClick={() => setShowAibom(true)}>AIBOM 8개 영역 펼쳐 보기</button>)
          : <p className="ai-result-empty">AIBOM 초안이 없는 결과입니다(이전 버전에서 저장).</p>}
      </div>

      {result.warnings?.length > 0 && <div className="ai-warning-list is-inset"><strong>검토할 항목</strong>
        <ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}
      {result.sources?.length > 0 && <details className="research-sources"><summary>출처 {result.sources.length}개</summary>
        <ul className="ai-source-list">{result.sources.map((source) => <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url} ↗</a></li>)}</ul></details>}
    </div>
  );
}

const modelLink = (modelId) => `/admin?model=${encodeURIComponent(modelId)}`;
const reviewLink = (runId) => `/admin?run=${runId}`;
const runLink = (runId) => `/admin/research?run=${runId}`;

/** Review state of a run: saved (linked to the registered model) or only cached. */
function ReviewBadge({ run }) {
  if (run.reviewStatus === "saved") return <b className="research-review-badge is-saved">검토 완료 · 저장됨</b>;
  return <b className="research-review-badge is-pending">검토 대기{run.catalogModelId ? " · 카탈로그에 같은 모델 있음" : ""}</b>;
}

const FILTERS = [["all", "전체"], ["pending", "검토 대기"], ["saved", "저장 완료"]];

/**
 * The research history as its own page (/admin/research). Every run is listed with whether a
 * human reviewed and saved it; a run that is only cached can be opened straight in the editor.
 */
export default function ResearchHistoryPage() {
  const params = new URLSearchParams(window.location.search);
  const [runs, setRuns] = useState(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(FILTERS.some(([key]) => key === params.get("status")) ? params.get("status") : "all");
  const [selectedId, setSelectedId] = useState(Number(params.get("run")) || null);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("merged");
  const [error, setError] = useState(null);

  const loadRuns = () => fetchResearchRuns({ limit: 500 }).then(setRuns).catch((err) => setError(err.message));
  useEffect(() => { loadRuns(); }, []);

  const visibleRuns = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (runs || []).filter((run) => (status === "all" || run.reviewStatus === status)
      && (!text || `${run.modelName} ${run.resultModelId || ""} ${run.modelId || ""}`.toLowerCase().includes(text)));
  }, [runs, query, status]);
  const counts = useMemo(() => ({
    all: runs?.length || 0,
    pending: (runs || []).filter((run) => run.reviewStatus === "pending").length,
    saved: (runs || []).filter((run) => run.reviewStatus === "saved").length
  }), [runs]);

  // Keep a run selected that is visible under the current filter.
  useEffect(() => {
    if (!runs) return;
    if (!visibleRuns.some((run) => run.runId === selectedId)) setSelectedId(visibleRuns[0]?.runId ?? null);
  }, [runs, visibleRuns, selectedId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("run", selectedId); else url.searchParams.delete("run");
    if (status === "all") url.searchParams.delete("status"); else url.searchParams.set("status", status);
    window.history.replaceState({}, "", url);
  }, [selectedId, status]);

  useEffect(() => {
    setDetail(null);
    if (!selectedId) return undefined;
    let cancelled = false;
    fetchResearchRun(selectedId).then((data) => {
      if (cancelled) return;
      setDetail(data);
      setTab(data.results.merged ? "merged" : data.results.huggingface ? "huggingface" : "paper");
    }).catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  async function removeRun() {
    if (!detail || !window.confirm(`조사 실행 #${detail.runId}(${detail.modelName})을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await deleteResearchRun(detail.runId);
      setSelectedId(null);
      await loadRuns();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="admin-shell research-page">
      <header className="admin-header">
        <div><p className="eyebrow">AI RESEARCH HISTORY</p><h1>AI 조사 이력</h1>
          <p>“AI로 정보 채우기”를 실행할 때마다 Hugging Face · 논문 조사와 AI 병합 결과가 실행 단위로 저장됩니다. 검토해서 모델로 저장한 실행과, 아직 조사 결과만 남아 있는 실행을 구분해 볼 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><a href="/admin" className="admin-primary">모델 관리</a></div>
      </header>
      <div className="admin-stats">
        <span><strong>{counts.all}</strong> 조사 실행</span>
        <span><strong>{counts.pending}</strong> 검토 대기</span>
        <span><strong>{counts.saved}</strong> 저장 완료</span>
      </div>
      {error && <p className="ai-save-state is-error">{error}</p>}
      <main className="research-page-body">
        <aside className="research-history-list">
          <div className="research-filter-tabs" role="tablist" aria-label="검토 상태">
            {FILTERS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={status === key}
              className={status === key ? "is-active" : ""} onClick={() => setStatus(key)}>{label} <small>{counts[key]}</small></button>)}
          </div>
          <input type="search" placeholder="모델명으로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Filter research runs" />
          {!runs ? <p className="admin-help">불러오는 중...</p> : !visibleRuns.length
            ? <p className="admin-help">{status === "pending" ? "검토를 기다리는 조사 실행이 없습니다." : "조건에 맞는 조사 실행이 없습니다."}</p> : (
              <ul className="research-run-list">{visibleRuns.map((run) => (
                <li key={run.runId}><button type="button" className={run.runId === selectedId ? "is-selected" : ""} onClick={() => setSelectedId(run.runId)}>
                  <strong>#{run.runId} {run.modelName}</strong>
                  <span>{formatDateTime(run.createdAt)} · 검색 {run.totalWebSearches ?? "-"} · {formatCost(run.totalCostUsd)}</span>
                  <SourceBadges run={run} />
                  <ReviewBadge run={run} />
                </button></li>
              ))}</ul>
            )}
        </aside>
        <div className="research-history-detail">
          {!detail ? <p className="admin-help">{selectedId ? "불러오는 중..." : "왼쪽에서 조사 실행을 선택하세요."}</p> : <>
            <div className="research-detail-head">
              <div><h3>#{detail.runId} {detail.modelName}</h3>
                <p><ReviewBadge run={detail} /> {formatDateTime(detail.createdAt)} · 결과 모델 {detail.resultModelId || "-"} · 총 검색 {detail.totalWebSearches ?? "-"} · 총 비용 {formatCost(detail.totalCostUsd)}</p></div>
              <button type="button" className="admin-danger" onClick={removeRun}>이 실행 삭제</button>
            </div>
            <div className={`research-review-panel is-${detail.reviewStatus}`}>
              {detail.reviewStatus === "saved" ? <>
                <p><strong>검토를 마치고 저장된 실행입니다.</strong> 이 조사 결과로 <code>{detail.modelId}</code> 모델이 저장되었습니다.</p>
                <a className="admin-secondary" href={modelLink(detail.modelId)}>저장된 모델 열기</a>
              </> : detail.catalogModelId ? <>
                <p><strong>아직 검토되지 않았습니다.</strong> 카탈로그에 <code>{detail.catalogModelId}</code> 모델이 이미 있어, 그 모델의 편집 화면에서 이 조사 결과의 값을 골라 반영합니다. 저장하면 검토 완료로 표시됩니다.</p>
                <a className="admin-primary" href={reviewLink(detail.runId)}>기존 모델에 반영하며 검토 →</a>
              </> : <>
                <p><strong>아직 검토되지 않았습니다.</strong> 조사 결과만 저장되어 있습니다. 편집 화면에서 값과 근거를 확인하고 모델로 등록할 수 있습니다.</p>
                <a className="admin-primary" href={reviewLink(detail.runId)}>검토 후 저장 →</a>
              </>}
            </div>
            <div className="research-source-tabs" role="tablist">{SOURCES.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
                {label} <small>{detail.results[key] ? STATUS[detail.results[key].status] || detail.results[key].status : "없음"}</small>
              </button>
            ))}</div>
            <SourceDetail key={`${detail.runId}-${tab}`} item={detail.results[tab]} fields={historyFields} sourceKey={tab} />
          </>}
        </div>
      </main>
    </div>
  );
}
