import { useEffect, useMemo, useState } from "react";
import { assignResearchRuns, createReviewer, deleteResearchRun, distributeResearchRuns, fetchResearchRun, fetchResearchRuns, fetchReviewers, updateReviewer } from "../../api/admin.js";
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
                <em>{run.modelId === modelId ? "검토 완료 · 이 실행으로 저장" : run.reviewStatus === "saved" ? `저장됨 → ${run.modelId}` : "검토 대기"}
                  {" · "}{run.reviewStatus === "saved" ? `검토자 ${run.reviewedByName || "기록 없음"}` : `담당 ${run.reviewerName || "미배정"}`}</em>
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
          : <button type="button" className="admin-secondary" onClick={() => setShowAibom(true)}>AIBOM 펼쳐 보기</button>)
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
 * Run ids from text such as "10-25", "3, 5, 8-12" or "#7". Returns a Set, or null when a part is
 * not a number or a range.
 */
export function parseRunIdRange(text) {
  const ids = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const match = part.match(/^#?(\d+)(?:\s*[-~]\s*#?(\d+))?$/);
    if (!match) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (Math.abs(to - from) > 100000) return null;
    for (let id = Math.min(from, to); id <= Math.max(from, to); id += 1) ids.add(id);
  }
  return ids;
}
const UNASSIGNED = "none";

/** Who a run belongs to: the assignee while it waits, the person who reviewed it once saved. */
function RunReviewer({ run }) {
  if (run.reviewStatus === "saved") return <span className="research-run-reviewer">검토자 {run.reviewedByName || "기록 없음"}</span>;
  return <span className={`research-run-reviewer${run.reviewerName ? "" : " is-unassigned"}`}>{run.reviewerName ? `담당 ${run.reviewerName}` : "미배정"}</span>;
}

/** Add, rename and (de)activate reviewers. They are never deleted, so past reviews keep their name. */
function ReviewerManager({ reviewers, onChange, onError }) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(null); // { id, name }
  const run = (action) => action.then(onChange).catch((err) => onError(err.message));
  const add = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    run(createReviewer({ name })).then(() => setName(""));
  };
  const rename = (event) => {
    event.preventDefault();
    const reviewer = reviewers.find((item) => item.id === editing.id);
    run(updateReviewer(editing.id, { name: editing.name, email: reviewer.email, isActive: reviewer.isActive })).then(() => setEditing(null));
  };
  return <details className="reviewer-manager">
    <summary>검토 작업자 관리 <small>{reviewers.filter((item) => item.isActive).length}명 활성</small></summary>
    <ul>{reviewers.map((reviewer) => <li key={reviewer.id} className={reviewer.isActive ? "" : "is-inactive"}>
      {editing?.id === reviewer.id
        ? <form onSubmit={rename}><input autoFocus value={editing.name} maxLength="100" onChange={(event) => setEditing({ ...editing, name: event.target.value })} aria-label="작업자 이름" /><button type="submit">저장</button><button type="button" onClick={() => setEditing(null)}>취소</button></form>
        : <>
          <strong>{reviewer.name}</strong>
          <small>대기 {reviewer.pendingCount} · 검토 {reviewer.reviewedCount}{reviewer.isActive ? "" : " · 비활성"}</small>
          <button type="button" onClick={() => setEditing({ id: reviewer.id, name: reviewer.name })}>이름 변경</button>
          <button type="button" onClick={() => run(updateReviewer(reviewer.id, { name: reviewer.name, email: reviewer.email, isActive: !reviewer.isActive }))}>{reviewer.isActive ? "비활성화" : "활성화"}</button>
        </>}
    </li>)}</ul>
    {!reviewers.length && <p className="admin-help">등록된 검토 작업자가 없습니다. 이름을 추가하면 조사 실행을 배정할 수 있습니다.</p>}
    <form className="reviewer-add" onSubmit={add}><input value={name} maxLength="100" placeholder="새 작업자 이름" onChange={(event) => setName(event.target.value)} aria-label="새 작업자 이름" /><button type="submit" disabled={!name.trim()}>추가</button></form>
    <p className="admin-help">비활성화한 작업자는 새로 배정받지 않지만, 이미 맡은 실행과 검토 기록은 그대로 남습니다.</p>
  </details>;
}

/**
 * The research history as its own page (/admin/research). Every run is listed with whether a
 * human reviewed and saved it; a run that is only cached can be opened straight in the editor.
 * Review work is shared between reviewers: runs are assigned by hand or distributed evenly, and
 * the list can be narrowed to one reviewer's runs.
 */
export default function ResearchHistoryPage() {
  const params = new URLSearchParams(window.location.search);
  const [runs, setRuns] = useState(null);
  const [reviewers, setReviewers] = useState([]);
  const [searchBy, setSearchBy] = useState("model"); // model: requested / result model name, id: run number
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(FILTERS.some(([key]) => key === params.get("status")) ? params.get("status") : "all");
  const [reviewerFilter, setReviewerFilter] = useState(params.get("reviewer") || "all"); // all | none | reviewer id
  const [selectedId, setSelectedId] = useState(Number(params.get("run")) || null);
  const [checked, setChecked] = useState(() => new Set());
  const [assignTo, setAssignTo] = useState("");
  const [rangeText, setRangeText] = useState("");
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("merged");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const loadRuns = () => fetchResearchRuns({ limit: 500 }).then(setRuns).catch((err) => setError(err.message));
  const loadReviewers = () => fetchReviewers().then(setReviewers).catch((err) => setError(err.message));
  useEffect(() => { loadRuns(); loadReviewers(); }, []);
  const activeReviewers = useMemo(() => reviewers.filter((reviewer) => reviewer.isActive), [reviewers]);

  // The reviewer filter follows the run's current owner: the assignee while pending, the reviewer once saved.
  const ownerId = (run) => (run.reviewStatus === "saved" ? run.reviewedById : run.reviewerId);
  const visibleRuns = useMemo(() => {
    const text = query.trim().toLowerCase();
    const matchesQuery = (run) => !text || (searchBy === "id"
      ? String(run.runId) === text.replace(/^#/, "")
      : `${run.modelName} ${run.resultModelId || ""} ${run.modelId || ""}`.toLowerCase().includes(text));
    const matchesReviewer = (run) => reviewerFilter === "all"
      || (reviewerFilter === UNASSIGNED ? ownerId(run) == null : String(ownerId(run)) === reviewerFilter);
    return (runs || []).filter((run) => (status === "all" || run.reviewStatus === status) && matchesReviewer(run) && matchesQuery(run));
  }, [runs, query, searchBy, status, reviewerFilter]);
  const counts = useMemo(() => ({
    all: runs?.length || 0,
    pending: (runs || []).filter((run) => run.reviewStatus === "pending").length,
    saved: (runs || []).filter((run) => run.reviewStatus === "saved").length,
    unassigned: (runs || []).filter((run) => run.reviewStatus === "pending" && run.reviewerId == null).length
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
    if (reviewerFilter === "all") url.searchParams.delete("reviewer"); else url.searchParams.set("reviewer", reviewerFilter);
    window.history.replaceState({}, "", url);
  }, [selectedId, status, reviewerFilter]);

  const loadDetail = (runId) => fetchResearchRun(runId);
  useEffect(() => {
    setDetail(null);
    if (!selectedId) return undefined;
    let cancelled = false;
    loadDetail(selectedId).then((data) => {
      if (cancelled) return;
      setDetail(data);
      setTab(data.results.merged ? "merged" : data.results.huggingface ? "huggingface" : "paper");
    }).catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selectedId]);

  // Only pending runs can be (re)assigned; saved ones keep who reviewed them.
  const assignable = visibleRuns.filter((run) => run.reviewStatus === "pending");
  const checkedIds = assignable.filter((run) => checked.has(run.runId)).map((run) => run.runId);
  // Bulk assignment by run id range: every pending run in the range, whatever the list is filtered to.
  const rangeIds = useMemo(() => (rangeText.trim() ? parseRunIdRange(rangeText.trim()) : new Set()), [rangeText]);
  const rangeRuns = useMemo(() => (rangeIds ? (runs || []).filter((run) => rangeIds.has(run.runId)) : []), [runs, rangeIds]);
  const rangePendingIds = rangeRuns.filter((run) => run.reviewStatus === "pending").map((run) => run.runId);
  const toggle = (runId) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });
  const refresh = async () => {
    await Promise.all([loadRuns(), loadReviewers()]);
    if (selectedId) loadDetail(selectedId).then(setDetail).catch(() => {});
  };
  async function assign(runIds, reviewerId) {
    setError(null); setMessage(null);
    try {
      const result = await assignResearchRuns(runIds, reviewerId);
      const name = reviewers.find((reviewer) => reviewer.id === reviewerId)?.name;
      setMessage(reviewerId == null ? `${result.assigned}건의 배정을 해제했습니다.` : `${result.assigned}건을 ${name}에게 배정했습니다.`);
      setChecked(new Set());
      setRangeText("");
      await refresh();
    } catch (err) { setError(err.message); }
  }
  async function distribute() {
    setError(null); setMessage(null);
    try {
      const result = await distributeResearchRuns();
      setMessage(result.assigned
        ? `미배정 ${result.assigned}건을 나눠 배정했습니다: ${result.byReviewer.map((item) => `${item.name} ${item.assigned}건`).join(", ")}`
        : "배정할 미배정 실행이 없습니다.");
      await refresh();
    } catch (err) { setError(err.message); }
  }

  async function removeRun() {
    if (!detail || !window.confirm(`조사 실행 #${detail.runId}(${detail.modelName})을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      await deleteResearchRun(detail.runId);
      setSelectedId(null);
      await refresh();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="admin-shell research-page">
      <header className="admin-header">
        <div><p className="eyebrow">AI RESEARCH HISTORY</p><h1>AI 조사 이력</h1>
          <p>“AI로 정보 채우기”를 실행할 때마다 Hugging Face · 논문 조사와 AI 병합 결과가 실행 단위로 저장됩니다. 검토해서 모델로 저장한 실행과, 아직 조사 결과만 남아 있는 실행을 구분해 보고, 검토 작업자에게 나눠 배정할 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><a href="/admin" className="admin-primary">모델 관리</a></div>
      </header>
      <div className="admin-stats">
        <span><strong>{counts.all}</strong> 조사 실행</span>
        <span><strong>{counts.pending}</strong> 검토 대기</span>
        <span><strong>{counts.unassigned}</strong> 미배정</span>
        <span><strong>{counts.saved}</strong> 저장 완료</span>
      </div>
      {error && <p className="ai-save-state is-error">{error}</p>}
      {message && <p className="ai-save-state is-saved">{message}</p>}
      <main className="research-page-body">
        <aside className="research-history-list">
          <div className="research-filter-tabs" role="tablist" aria-label="검토 상태">
            {FILTERS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={status === key}
              className={status === key ? "is-active" : ""} onClick={() => setStatus(key)}>{label} <small>{counts[key]}</small></button>)}
          </div>
          <div className="research-search">
            <select value={searchBy} onChange={(event) => { setSearchBy(event.target.value); setQuery(""); }} aria-label="검색 기준">
              <option value="model">모델명</option><option value="id">실행 ID</option>
            </select>
            <input type="search" inputMode={searchBy === "id" ? "numeric" : "text"} placeholder={searchBy === "id" ? "실행 번호 (예: 5)" : "모델명으로 찾기"}
              value={query} onChange={(event) => setQuery(event.target.value)} aria-label="조사 실행 검색" />
          </div>
          <select className="research-reviewer-filter" value={reviewerFilter} onChange={(event) => setReviewerFilter(event.target.value)} aria-label="검토 작업자로 찾기">
            <option value="all">모든 검토 작업자</option>
            <option value={UNASSIGNED}>미배정 / 검토자 기록 없음</option>
            {reviewers.map((reviewer) => <option key={reviewer.id} value={String(reviewer.id)}>{reviewer.name}{reviewer.isActive ? "" : " (비활성)"} · 대기 {reviewer.pendingCount}</option>)}
          </select>

          <div className="research-assign-bar">
            <label><input type="checkbox" disabled={!assignable.length} checked={assignable.length > 0 && checkedIds.length === assignable.length}
              onChange={(event) => setChecked(event.target.checked ? new Set(assignable.map((run) => run.runId)) : new Set())} /> 대기 {assignable.length}건 전체 선택</label>
            <div>
              <select value={assignTo} onChange={(event) => setAssignTo(event.target.value)} aria-label="배정할 검토 작업자">
                <option value="">작업자 선택</option>
                {activeReviewers.map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}
                <option value={UNASSIGNED}>배정 해제</option>
              </select>
              <button type="button" disabled={!checkedIds.length || !assignTo} onClick={() => assign(checkedIds, assignTo === UNASSIGNED ? null : Number(assignTo))}>선택 {checkedIds.length}건 배정</button>
            </div>
            <div className="research-range">
              <input value={rangeText} onChange={(event) => setRangeText(event.target.value)} placeholder="실행 ID 범위 (예: 10-25 또는 3, 5, 8-12)" aria-label="배정할 실행 ID 범위" />
              <button type="button" disabled={!rangePendingIds.length || !assignTo} onClick={() => assign(rangePendingIds, assignTo === UNASSIGNED ? null : Number(assignTo))}>범위 {rangePendingIds.length}건 배정</button>
            </div>
            {rangeText.trim() && <small className={`research-range-note${rangeIds ? "" : " is-error"}`}>{!rangeIds
              ? "숫자와 범위만 입력할 수 있습니다. 예: 10-25 또는 3, 5, 8-12"
              : !rangeRuns.length ? "이 범위에 해당하는 조사 실행이 없습니다."
                : `범위 안의 실행 ${rangeRuns.length}건 중 검토 대기 ${rangePendingIds.length}건이 배정됩니다${rangeRuns.length > rangePendingIds.length ? ` (저장된 ${rangeRuns.length - rangePendingIds.length}건은 제외)` : ""}.${assignTo ? "" : " 위에서 작업자를 선택하세요."}`}</small>}
            <button type="button" className="research-distribute" disabled={!counts.unassigned || !activeReviewers.length} onClick={distribute}
              title="미배정 검토 대기 실행을 활성 작업자에게, 대기 건이 적은 사람부터 고르게 나눕니다.">미배정 {counts.unassigned}건 자동 분배</button>
          </div>
          <ReviewerManager reviewers={reviewers} onChange={() => refresh()} onError={setError} />

          {!runs ? <p className="admin-help">불러오는 중...</p> : !visibleRuns.length
            ? <p className="admin-help">{status === "pending" ? "조건에 맞는 검토 대기 실행이 없습니다." : "조건에 맞는 조사 실행이 없습니다."}</p> : (
              <ul className="research-run-list has-checks">{visibleRuns.map((run) => (
                <li key={run.runId}>
                  <input type="checkbox" checked={checked.has(run.runId)} disabled={run.reviewStatus !== "pending"} onChange={() => toggle(run.runId)}
                    aria-label={`#${run.runId} 선택`} title={run.reviewStatus === "pending" ? "배정할 실행으로 선택" : "저장된 실행은 다시 배정하지 않습니다"} />
                  <button type="button" className={run.runId === selectedId ? "is-selected" : ""} onClick={() => setSelectedId(run.runId)}>
                    <strong>#{run.runId} {run.modelName}</strong>
                    <span>{formatDateTime(run.createdAt)} · 검색 {run.totalWebSearches ?? "-"} · {formatCost(run.totalCostUsd)}</span>
                    <SourceBadges run={run} />
                    <span className="research-run-foot"><ReviewBadge run={run} /><RunReviewer run={run} /></span>
                  </button>
                </li>
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
                <p><strong>검토를 마치고 저장된 실행입니다.</strong> 이 조사 결과로 <code>{detail.modelId}</code> 모델이 저장되었습니다.
                  <br />검토자 <b>{detail.reviewedByName || "기록 없음"}</b> · 저장 {formatDateTime(detail.reviewedAt)}{detail.reviewerName && detail.reviewerName !== detail.reviewedByName ? ` · 배정 ${detail.reviewerName}` : ""}</p>
                <a className="admin-secondary" href={modelLink(detail.modelId)}>저장된 모델 열기</a>
              </> : <>
                <p><strong>아직 검토되지 않았습니다.</strong> {detail.catalogModelId
                  ? <>카탈로그에 <code>{detail.catalogModelId}</code> 모델이 이미 있어, 그 모델의 편집 화면에서 이 조사 결과의 값을 골라 반영합니다. 저장하면 검토 완료로 표시됩니다.</>
                  : "조사 결과만 저장되어 있습니다. 편집 화면에서 값과 근거를 확인하고 모델로 등록할 수 있습니다."}</p>
                <div className="research-review-actions">
                  <label>담당 <select value={detail.reviewerId ?? ""} onChange={(event) => assign([detail.runId], event.target.value ? Number(event.target.value) : null)}>
                    <option value="">미배정</option>
                    {reviewers.filter((reviewer) => reviewer.isActive || reviewer.id === detail.reviewerId).map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}
                  </select></label>
                  <a className="admin-primary" href={reviewLink(detail.runId)}>{detail.catalogModelId ? "기존 모델에 반영하며 검토 →" : "검토 후 저장 →"}</a>
                </div>
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
