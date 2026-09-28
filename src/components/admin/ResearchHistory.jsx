import { useEffect, useMemo, useState } from "react";
import { deleteResearchRun, fetchResearchRun, fetchResearchRuns } from "../../api/admin.js";
import { aibomDraftToView } from "../../domain/aibomView.js";
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

export function ModelResearchRuns({ modelId, refreshKey, onOpen }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    setRuns(null);
    fetchResearchRuns({ modelId }).then(setRuns).catch((err) => setError(err.message));
  }, [modelId, refreshKey]);

  return (
    <fieldset className="research-runs-inline">
      <legend>AI 조사 이력</legend>
      {error ? <p className="admin-help">조사 이력을 불러오지 못했습니다: {error}</p>
        : !runs ? <p className="admin-help">조사 이력을 불러오는 중입니다...</p>
          : !runs.length ? <p className="admin-help">이 모델로 저장된 AI 조사 결과가 없습니다.</p>
            : <ul className="research-run-list is-compact">{runs.map((run) => (
              <li key={run.runId}><button type="button" onClick={() => onOpen(run.runId)}>
                <strong>#{run.runId}</strong><span>{formatDateTime(run.createdAt)}</span><SourceBadges run={run} />
                <em>{run.modelId === modelId ? "이 실행으로 등록" : run.modelName}</em>
              </button></li>
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

  return (
    <div className="research-source-detail">
      <dl className="research-source-meta">
        <div><dt>상태</dt><dd>{STATUS[item.status] || item.status || "-"}</dd></div>
        <div><dt>Research model</dt><dd>{item.researchModel || "-"}</dd></div>
        <div><dt>웹 검색</dt><dd>{item.webSearchRequests ?? "-"}</dd></div>
        <div><dt>비용</dt><dd>{formatCost(item.costUsd)}</dd></div>
        <div><dt>저장 시각</dt><dd>{formatDateTime(item.createdAt)}</dd></div>
      </dl>

      <h5>카탈로그 초안</h5>
      <table className="research-draft-table"><tbody>{fields.map(([field, label]) => {
        const decision = decisions.get(field);
        return <tr key={field}><th scope="row">{label}</th><td>{display(draft[field]) || <span className="is-empty">값 없음</span>}
          {decision && <small>{DECISIONS[decision.chosen] || decision.chosen} · {decision.rationale}</small>}</td></tr>;
      })}</tbody></table>

      <h5>AIBOM 초안 {result.aibomSummary && <span className="research-aibom-counts">
        평가 {result.aibomSummary.evaluations ?? 0} · 데이터셋 {result.aibomSummary.datasets ?? 0} · 안전 {result.aibomSummary.safety_items ?? 0} · 근거 {result.aibomSummary.references ?? 0}
      </span>}</h5>
      {result.areaDecisions?.length > 0 && <ul className="ai-area-decisions">{result.areaDecisions.map((decision) => (
        <li key={decision.area}><b>{decision.area}</b> {DECISIONS[decision.chosen] || decision.chosen} · {decision.rationale}</li>
      ))}</ul>}
      {view ? (showAibom
        ? <div className="research-aibom-preview"><AibomAreas aibom={view} /></div>
        : <button type="button" className="admin-secondary" onClick={() => setShowAibom(true)}>AIBOM 8개 영역 펼쳐 보기</button>)
        : <p className="ai-result-empty">AIBOM 초안이 없는 결과입니다(이전 버전에서 저장).</p>}

      {result.warnings?.length > 0 && <div className="ai-warning-list is-inset"><strong>검토할 항목</strong>
        <ul>{result.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}
      {result.sources?.length > 0 && <details className="research-sources"><summary>출처 {result.sources.length}개</summary>
        <ul className="ai-source-list">{result.sources.map((source) => <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url} ↗</a></li>)}</ul></details>}
    </div>
  );
}

export default function ResearchHistoryDialog({ initialRunId = null, fields, onClose, onChanged }) {
  const [runs, setRuns] = useState(null);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState(initialRunId);
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("merged");
  const [error, setError] = useState(null);

  const loadRuns = () => fetchResearchRuns({ limit: 500 }).then((data) => {
    setRuns(data);
    setSelectedId((current) => current ?? data[0]?.runId ?? null);
  }).catch((err) => setError(err.message));

  useEffect(() => { loadRuns(); }, []);
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setDetail(null);
    fetchResearchRun(selectedId).then((data) => {
      setDetail(data);
      setTab(data.results.merged ? "merged" : data.results.huggingface ? "huggingface" : "paper");
    }).catch((err) => setError(err.message));
  }, [selectedId]);

  const visibleRuns = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (runs || []).filter((run) => !query
      || `${run.modelName} ${run.resultModelId || ""} ${run.modelId || ""}`.toLowerCase().includes(query));
  }, [runs, filter]);

  async function removeRun() {
    if (!detail || !window.confirm(`조사 실행 #${detail.runId}(${detail.modelName})을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await deleteResearchRun(detail.runId);
      setSelectedId(null);
      await loadRuns();
      onChanged?.();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="research-history-dialog" role="dialog" aria-modal="true" aria-labelledby="research-history-title">
        <header className="research-history-head">
          <div><p className="eyebrow">AI RESEARCH HISTORY</p><h2 id="research-history-title">AI 조사 이력</h2>
            <p>“AI로 정보 채우기”를 실행할 때마다 Hugging Face · 논문 조사와 AI 병합 결과가 실행 단위로 저장됩니다
              (<code>model_research_run</code>, <code>model_research_result</code>). 새로 조사해도 이전 실행은 지워지지 않습니다.</p></div>
          <button type="button" className="create-close" aria-label="닫기" onClick={onClose}>×</button>
        </header>
        {error && <p className="ai-save-state is-error">{error}</p>}
        <div className="research-history-body">
          <aside className="research-history-list">
            <input type="search" placeholder="모델명으로 찾기" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter research runs" />
            {!runs ? <p className="admin-help">불러오는 중...</p> : !visibleRuns.length ? <p className="admin-help">저장된 조사 실행이 없습니다.</p> : (
              <ul className="research-run-list">{visibleRuns.map((run) => (
                <li key={run.runId}><button type="button" className={run.runId === selectedId ? "is-selected" : ""} onClick={() => setSelectedId(run.runId)}>
                  <strong>#{run.runId} {run.modelName}</strong>
                  <span>{formatDateTime(run.createdAt)} · 검색 {run.totalWebSearches ?? "-"} · {formatCost(run.totalCostUsd)}</span>
                  <SourceBadges run={run} />
                  {run.modelId && <em>등록됨 → {run.modelId}</em>}
                </button></li>
              ))}</ul>
            )}
          </aside>
          <div className="research-history-detail">
            {!detail ? <p className="admin-help">{selectedId ? "불러오는 중..." : "왼쪽에서 조사 실행을 선택하세요."}</p> : <>
              <div className="research-detail-head">
                <div><h3>#{detail.runId} {detail.modelName}</h3>
                  <p>{formatDateTime(detail.createdAt)} · 결과 모델 {detail.resultModelId || "-"} · {detail.modelId ? `카탈로그 등록: ${detail.modelId}` : "아직 카탈로그에 등록되지 않음"} · 총 검색 {detail.totalWebSearches ?? "-"} · 총 비용 {formatCost(detail.totalCostUsd)}</p></div>
                <button type="button" className="admin-danger" onClick={removeRun}>이 실행 삭제</button>
              </div>
              <div className="research-source-tabs" role="tablist">{SOURCES.map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
                  {label} <small>{detail.results[key] ? STATUS[detail.results[key].status] || detail.results[key].status : "없음"}</small>
                </button>
              ))}</div>
              <SourceDetail key={`${detail.runId}-${tab}`} item={detail.results[tab]} fields={fields} sourceKey={tab} />
            </>}
          </div>
        </div>
      </section>
    </div>
  );
}
