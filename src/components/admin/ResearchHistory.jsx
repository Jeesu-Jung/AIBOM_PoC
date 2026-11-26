import { useEffect, useMemo, useRef, useState } from "react";
import { assignResearchRuns, createReviewer, deleteResearchRun, deleteReviewer, distributeResearchRuns, fetchResearchFilterOptions, fetchResearchRun, fetchResearchRunPage, fetchResearchRunStatus, fetchResearchRuns, fetchReviewers, finalizeResearchRun, previewAssignRuns, updateReviewer } from "../../api/admin.js";
import { aibomDraftToView } from "../../domain/aibomView.js";
import { historyFields } from "../../constants/researchFields.js";
import { downloadJson, jsonFilename } from "../../utils/download.js";
import AibomAreas from "../aibom/AibomAreas.jsx";

// Stored "AI로 정보 채우기" runs (model_research_run / model_research_result): every run keeps its
// Hugging Face, paper and merged results, so past research can be compared at any time.

const SOURCES = [["huggingface", "Hugging Face"], ["paper", "논문 · 기술 보고서"], ["merged", "AI 병합"]];
const STATUS = { found: "확인됨", ambiguous: "후보 여러 개", not_found: "찾지 못함" };
// Short source names for the result badges of a run and for the badge filter.
const SOURCE_SHORT = { huggingface: "HF", paper: "논문", merged: "AI" };
const BADGE_STATES = [...Object.entries(STATUS), ["missing", "없음"]];

/** Narrow the run list to one result badge: value `<source>:<status>`, as the server expects. */
function BadgeFilter({ value, onChange }) {
  return <select className="research-reviewer-filter" value={value} onChange={(event) => onChange(event.target.value)} aria-label="조사 결과 배지로 찾기">
    <option value="all">조사 결과 전체</option>
    {SOURCES.map(([key, label]) => <optgroup key={key} label={label}>
      {BADGE_STATES.map(([state, text]) => <option key={state} value={`${key}:${state}`}>{SOURCE_SHORT[key]} {text}</option>)}
    </optgroup>)}
  </select>;
}

/**
 * Narrow the run list by what the research found: the model's family, its parent model, and
 * whether all three results (Hugging Face, paper, merge) were found. Shared by both workspaces;
 * `labelled` puts a caption before each control (the narrow review sidebar).
 */
function LineageFilters({ options, family, parent, verified, onFamily, onParent, onVerified, active, onReset, labelled }) {
  const same = (name) => name.toLowerCase() === family.toLowerCase();
  // A family from an old link that no result has any more still shows as the chosen one.
  const families = family && !options.families.some(same) ? [family, ...options.families] : options.families;
  const familySelect = <select className="research-reviewer-filter" value={families.find(same) || ""} onChange={(event) => onFamily(event.target.value)} aria-label="Family name으로 찾기">
    <option value="">Family 전체</option>
    {families.map((name) => <option key={name} value={name}>{name}</option>)}
  </select>;
  const parentInput = <>
    <input type="search" className="research-parent-filter" list="research-parent-options" value={parent} onChange={(event) => onParent(event.target.value)}
      placeholder={labelled ? "모델 ID 일부 또는 목록에서 선택" : "Parent 모델 ID 일부 또는 목록에서 선택"} aria-label="Parent 모델로 찾기" />
    <datalist id="research-parent-options">{options.parents.map((id) => <option key={id} value={id} />)}</datalist>
  </>;
  return <>
    {labelled ? <label className="research-owner-filter">Family {familySelect}</label> : familySelect}
    {labelled ? <label className="research-owner-filter">Parent {parentInput}</label> : parentInput}
    <div className="research-filter-foot">
      <label className="research-verified-filter" title="Hugging Face · 논문 · AI 병합 결과가 모두 ‘확인됨’인 실행만 봅니다.">
        <input type="checkbox" checked={verified} onChange={(event) => onVerified(event.target.checked)} /> HF · 논문 · AI 모두 확인됨만
      </label>
      {active && <button type="button" className="research-filter-reset" onClick={onReset}>필터 초기화</button>}
    </div>
  </>;
}
const DECISIONS = { huggingface: "HF 값", paper: "논문 값", combined: "두 결과 결합", none: "값 없음" };

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
};
const formatCost = (value) => (value == null ? "-" : `$${value.toFixed(4)}`);
const formatDuration = (ms) => (ms == null ? "-" : ms < 60000 ? `${(ms / 1000).toFixed(1)}초`
  : `${Math.floor(ms / 60000)}분 ${Math.round((ms % 60000) / 1000)}초`);
const formatCount = (value, unit) => (value == null ? "-" : `${value.toLocaleString()}${unit}`);
const display = (value) => (value == null || value === "" || (Array.isArray(value) && !value.length)
  ? null : Array.isArray(value) ? value.join(", ") : String(value));

function SourceBadges({ run }) {
  return <span className="research-run-badges">{SOURCES.map(([key, label]) => {
    const item = run.results[key];
    return <b key={key} className={item ? `is-${item.status}` : "is-missing"} title={label}>
      {SOURCE_SHORT[key]} {item ? STATUS[item.status] || item.status : "없음"}
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
                <em>{run.modelId === modelId ? "검토 완료 · 이 실행으로 저장" : run.reviewStatus === "saved" ? `저장됨 → ${run.modelId}` : REVIEW_STATE[run.reviewStatus] || "검토 대기"}
                  {" · "}{run.reviewStatus === "saved" ? `검토자 ${savedReviewers(run)}` : `담당 ${assignedReviewers(run) || "미배정"}`}</em>
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
        <div><dt>응답 시간</dt><dd>{formatDuration(item.responseTimeMs)}</dd></div>
        <div><dt>이벤트 수</dt><dd>{formatCount(item.eventCount, "개")}</dd></div>
        <div><dt title="모델이 생성한 답변 본문의 문자 수">생성 문자 수</dt><dd>{formatCount(item.contentCharacters, "자")}</dd></div>
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
// `reviewerId`: who the review opens as (the reviewer the list is filtered to).
const reviewLink = (runId, reviewerId) => `/admin?run=${runId}${reviewerId ? `&reviewer=${reviewerId}` : ""}`;
const runLink = (runId) => `/admin/research?run=${runId}`;

// A run is saved by the server once every assigned reviewer has submitted: `saving`, or `merging`
// while the AI merges the values the reviewers tied on.
const REVIEW_STATE = { saving: "저장 중…", merging: "AI 병합 중…", failed: "저장 실패" };
const isFinalizing = (run) => run?.reviewStatus === "saving" || run?.reviewStatus === "merging";
const reviewerName = (reviewer) => reviewer.name || "삭제된 작업자";
/** "Kim ✓ · Lee": who reviews the run, with a mark for those who submitted. */
const assignedReviewers = (run) => (run.reviewers || []).map((reviewer) => `${reviewerName(reviewer)}${reviewer.status === "submitted" ? " ✓" : ""}`).join(" · ");
/** Who the saved values come from: the reviewers who submitted, or the one who saved directly. */
const savedReviewers = (run) => run.reviewedByName
  || (run.reviewers || []).filter((reviewer) => reviewer.status === "submitted").map(reviewerName).join(", ") || "기록 없음";

/** Review state of a run: saved (linked to the registered model), being saved, or still waiting for reviews. */
function ReviewBadge({ run }) {
  if (run.reviewStatus === "saved") return <b className="research-review-badge is-saved">검토 완료 · 저장됨</b>;
  if (isFinalizing(run)) return <b className="research-review-badge is-working">{REVIEW_STATE[run.reviewStatus]}</b>;
  if (run.reviewStatus === "failed") return <b className="research-review-badge is-failed">저장 실패</b>;
  const { submitted = 0, total = 0 } = run.reviewProgress || {};
  return <b className="research-review-badge is-pending">검토 대기{total ? ` · ${submitted}/${total} 제출` : ""}{run.catalogModelId ? " · 카탈로그에 같은 모델 있음" : ""}</b>;
}

const CHOSEN = { huggingface: "HF 값", paper: "논문 값", combined: "값 결합" };
const preview = (value, absent) => {
  if (absent) return "항목 없음";
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "값 없음";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 700 ? `${text.slice(0, 700)}…` : text;
};

/** One decided value: what was saved, and what each group of reviewers had answered. */
function DecidedValue({ item, names }) {
  return <li>
    <p><b>{item.label}</b>{item.chosen && <em>{CHOSEN[item.chosen] || "검토자 답 선택"}</em>}{item.tieBreak && <em>먼저 제출한 값</em>}</p>
    {item.rationale && <p className="consensus-rationale">{item.rationale}</p>}
    <pre className="consensus-value">{preview(item.value, item.absent)}</pre>
    <ul className="consensus-votes">{item.votes.map((vote, index) => <li key={index}>
      <span>{vote.count}표 · {vote.reviewerIds.map((id) => names[id] || `#${id}`).join(", ")}</span>
      <pre>{preview(vote.value, vote.absent)}</pre>
    </li>)}</ul>
  </li>;
}

/** How a run saved from several reviews was decided: unanimous, by majority, or merged by the AI. */
function ConsensusSummary({ summary, reviewers }) {
  const names = Object.fromEntries(reviewers.map((reviewer) => [reviewer.id, reviewerName(reviewer)]));
  const { counts } = summary;
  return <div className="consensus-summary">
    <p className="consensus-counts">비교한 값 <b>{counts.units}</b>개 · 만장일치 <b>{counts.unanimous}</b> · 다수결 <b>{counts.majority}</b> · AI 병합 <b>{counts.aiMerged}</b></p>
    {summary.aiMerged.length > 0 && <details open><summary>AI 병합으로 정한 값 {summary.aiMerged.length}개 <small>동점이어서 검토자 답 · HF · 논문 값을 보고 AI가 정했습니다{summary.ai?.model ? ` (${summary.ai.model})` : ""}</small></summary>
      <ul className="consensus-list">{summary.aiMerged.map((item) => <DecidedValue key={item.id} item={item} names={names} />)}</ul></details>}
    {summary.majority.length > 0 && <details><summary>다수결로 정한 값 {summary.majority.length}개 <small>검토자 답이 갈렸고 가장 많이 선택된 값을 저장했습니다</small></summary>
      <ul className="consensus-list">{summary.majority.map((item) => <DecidedValue key={item.id} item={item} names={names} />)}</ul></details>}
    {summary.notes?.length > 0 && <ul className="consensus-notes">{summary.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
  </div>;
}

/** The reviewers of a run and whether each has submitted. */
function ReviewerChips({ reviewers }) {
  return <span className="reviewer-chips">{reviewers.map((reviewer) => <b key={reviewer.id} className={reviewer.status === "submitted" ? "is-submitted" : ""}
    title={reviewer.status === "submitted" ? `제출 ${formatDateTime(reviewer.submittedAt)}` : "아직 제출하지 않음"}>
    {reviewerName(reviewer)} {reviewer.status === "submitted" ? "✓ 제출" : "검토 중"}</b>)}</span>;
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
// The page has two workspaces: reviewing runs (everyone) and handing them out (project manager).
const VIEWS = [["review", "검토 작업", "조사 결과를 확인하고 모델로 저장"], ["manage", "배정 · 작업자 관리", "프로젝트 관리자용"]];

/** Who a run belongs to: its reviewers while it waits (✓ = submitted), the people whose reviews were saved after. */
function RunReviewer({ run }) {
  if (run.reviewStatus === "saved") return <span className="research-run-reviewer">검토자 {savedReviewers(run)}</span>;
  const assigned = assignedReviewers(run);
  return <span className={`research-run-reviewer${assigned ? "" : " is-unassigned"}`}>{assigned ? `담당 ${assigned}` : "미배정"}</span>;
}

/** Add, rename and delete reviewers. Deleting is soft: past reviews keep the name, and adding the
 *  same name again brings the reviewer back. */
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
    run(updateReviewer(editing.id, { name: editing.name, email: reviewer.email })).then(() => setEditing(null));
  };
  const remove = (reviewer) => {
    const waiting = reviewer.pendingCount ? ` 아직 제출하지 않은 검토 ${reviewer.pendingCount}건은 배정이 해제됩니다.` : "";
    if (window.confirm(`검토 작업자 '${reviewer.name}'을(를) 삭제할까요?${waiting} 이미 검토한 기록은 그대로 남고, 같은 이름으로 다시 추가하면 복구됩니다.`)) run(deleteReviewer(reviewer.id));
  };
  return <section className="reviewer-manager">
    <h2>검토 작업자 <small>{reviewers.length}명</small></h2>
    <ul>{reviewers.map((reviewer) => <li key={reviewer.id}>
      {editing?.id === reviewer.id
        ? <form onSubmit={rename}><input autoFocus value={editing.name} maxLength="100" onChange={(event) => setEditing({ ...editing, name: event.target.value })} aria-label="작업자 이름" /><button type="submit">저장</button><button type="button" onClick={() => setEditing(null)}>취소</button></form>
        : <>
          <strong>{reviewer.name}</strong>
          <small>대기 {reviewer.pendingCount} · 검토 {reviewer.reviewedCount}</small>
          <button type="button" onClick={() => setEditing({ id: reviewer.id, name: reviewer.name })}>이름 변경</button>
          <button type="button" className="is-danger" onClick={() => remove(reviewer)}>삭제</button>
        </>}
    </li>)}</ul>
    {!reviewers.length && <p className="admin-help">등록된 검토 작업자가 없습니다. 이름을 추가하면 조사 실행을 배정할 수 있습니다.</p>}
    <form className="reviewer-add" onSubmit={add}><input value={name} maxLength="100" placeholder="새 작업자 이름" onChange={(event) => setName(event.target.value)} aria-label="새 작업자 이름" /><button type="submit" disabled={!name.trim()}>추가</button></form>
    <p className="admin-help">삭제한 작업자는 목록에서 사라지고 아직 제출하지 않은 검토는 배정이 해제됩니다. 이미 제출한 검토에는 이름이 남으며, 같은 이름을 다시 추가하면 복구됩니다.</p>
  </section>;
}

const PAGE_SIZE = 100;   // runs per request; the next page loads when the end of the list scrolls into view
const MAX_ASSIGN = 500;  // run ids the assign API takes in one call
const NO_COUNTS = { all: 0, pending: 0, saved: 0, unassigned: 0 };

/** End of a paged list: asks for the next page once it scrolls into view. */
function LoadMore({ hasMore, loading, shown, total, onLoad }) {
  const ref = useRef(null);
  const load = useRef(onLoad);
  load.current = onLoad;
  // Re-observed after every page, so a list that still does not fill the screen keeps loading.
  useEffect(() => {
    if (!hasMore || !ref.current) return undefined;
    const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) load.current(); }, { rootMargin: "200px" });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [hasMore, shown]);
  if (!hasMore) return total > PAGE_SIZE ? <p className="research-load-more">{total.toLocaleString()}건을 모두 불러왔습니다.</p> : null;
  return <p className="research-load-more" ref={ref}>{shown.toLocaleString()} / {total.toLocaleString()}건 ·{" "}
    {loading ? "더 불러오는 중..." : <button type="button" onClick={onLoad}>더 불러오기</button>}</p>;
}

/**
 * The research history as its own page (/admin/research). Every run is listed with whether a
 * human reviewed and saved it; a run that is only cached can be opened straight in the editor.
 * Review work is shared between reviewers: runs are assigned by hand, or every unassigned run is given to the chosen reviewers, and
 * the list can be narrowed to one reviewer's runs.
 * The list is filtered and paged on the server (PAGE_SIZE runs at a time).
 */
export default function ResearchHistoryPage() {
  const params = new URLSearchParams(window.location.search);
  const [runs, setRuns] = useState(null); // the pages loaded so far under the current filter
  const [page, setPage] = useState({ total: 0, nextOffset: null, counts: NO_COUNTS, stats: NO_COUNTS });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reviewers, setReviewers] = useState([]);
  const [view, setView] = useState(params.get("view") === "manage" ? "manage" : "review");
  const managing = view === "manage";
  const [searchBy, setSearchBy] = useState("model"); // model: requested / result model name, id: run number
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(""); // `query` once typing pauses: what the server is asked for
  const [status, setStatus] = useState(FILTERS.some(([key]) => key === params.get("status")) ? params.get("status") : "all");
  const [reviewerFilter, setReviewerFilter] = useState(params.get("reviewer") || "all"); // all | none | reviewer id
  const [badgeFilter, setBadgeFilter] = useState("all"); // all | <source>:<status> (one result badge)
  const [filterOptions, setFilterOptions] = useState({ families: [], parents: [] });
  const [family, setFamily] = useState(params.get("family") || "");       // family name, "" = all
  const [parentText, setParentText] = useState(params.get("parent") || ""); // part of a parent model id
  const [parent, setParent] = useState(parentText.trim());                // `parentText` once typing pauses
  const [verifiedOnly, setVerifiedOnly] = useState(params.get("verified") === "1"); // Hugging Face, paper and merge all found
  const [selectedId, setSelectedId] = useState(Number(params.get("run")) || null);
  const [checked, setChecked] = useState(() => new Set());
  const [assignTo, setAssignTo] = useState(() => new Set()); // reviewer ids the bulk assignment names
  const [assignMode, setAssignMode] = useState("add");       // add | set | clear (unassign everyone)
  const [distributeTo, setDistributeTo] = useState(() => new Set()); // reviewers who all get every unassigned run
  const [retrying, setRetrying] = useState(false);
  const [rangeText, setRangeText] = useState("");
  const [rangePreview, setRangePreview] = useState(null); // { found, pending } of the typed id range
  const [detail, setDetail] = useState(null);
  const [tab, setTab] = useState("merged");
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const loadReviewers = () => fetchReviewers().then(setReviewers).catch((err) => setError(err.message));
  const loadFilterOptions = () => fetchResearchFilterOptions().then(setFilterOptions).catch((err) => setError(err.message));
  useEffect(() => { loadReviewers(); loadFilterOptions(); }, []);
  useEffect(() => {
    const timer = setTimeout(() => setParent(parentText.trim()), 250);
    return () => clearTimeout(timer);
  }, [parentText]);
  // Filters on what the research found (the reviewer, status and search stay as they are when reset).
  const resultFiltered = badgeFilter !== "all" || Boolean(family || parentText || verifiedOnly);
  const resetResultFilters = () => { setBadgeFilter("all"); setFamily(""); setParentText(""); setParent(""); setVerifiedOnly(false); };
  const lineageFilters = (labelled) => <LineageFilters options={filterOptions} family={family} parent={parentText} verified={verifiedOnly}
    onFamily={setFamily} onParent={setParentText} onVerified={setVerifiedOnly} active={resultFiltered} onReset={resetResultFilters} labelled={labelled} />;
  const filteredReviewer = /^\d+$/.test(reviewerFilter) ? reviewerFilter : ""; // the reviewer filter names a person
  const activeReviewers = reviewers; // the API lists only reviewers that can be given work

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  // Only pending runs can be handed out, so the manage view lists just those.
  const listStatus = managing ? "pending" : status;
  const ticket = useRef(0);            // the newest list request wins
  const reloading = useRef(false);     // a first-page load is running: no "next page" meanwhile
  const keepSelection = useRef(true);  // keep the selected run even when the loaded pages do not hold it (?run= link)

  /** Load from `offset`: 0 replaces the list (`limit` re-reads what is on screen), otherwise appends. */
  async function loadRuns({ offset = 0, limit = PAGE_SIZE, keep = true } = {}) {
    const mine = ++ticket.current;
    if (!offset) reloading.current = true;
    try {
      const data = await fetchResearchRunPage({ status: listStatus, reviewer: reviewerFilter, label: badgeFilter, family, parent, verified: verifiedOnly, query: search, searchBy, offset, limit });
      if (mine !== ticket.current) return;
      setRuns((current) => {
        if (!offset) return data.items;
        const loaded = new Set((current || []).map((run) => run.runId)); // a run saved meanwhile shifts the pages
        return [...(current || []), ...data.items.filter((run) => !loaded.has(run.runId))];
      });
      setPage({ total: data.total, nextOffset: data.nextOffset, counts: data.counts, stats: data.stats });
      if (!offset && !managing) {
        setSelectedId((current) => (current != null && (keep || data.items.some((run) => run.runId === current))
          ? current : data.items[0]?.runId ?? null));
      }
    } catch (err) {
      if (mine === ticket.current) setError(err.message);
    } finally {
      if (mine === ticket.current) reloading.current = false;
    }
  }
  // A changed filter starts again from the first page.
  useEffect(() => {
    loadRuns({ keep: keepSelection.current });
    keepSelection.current = false;
  }, [listStatus, reviewerFilter, badgeFilter, search, searchBy, family, parent, verifiedOnly]);
  async function loadMore() {
    if (page.nextOffset == null || loadingMore || reloading.current) return;
    setLoadingMore(true);
    try { await loadRuns({ offset: page.nextOffset }); } finally { setLoadingMore(false); }
  }

  const visibleRuns = runs || [];
  const counts = page.stats;      // every stored run
  const tabCounts = page.counts;  // inside the reviewer filter, which is the outermost one

  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId) url.searchParams.set("run", selectedId); else url.searchParams.delete("run");
    if (status === "all") url.searchParams.delete("status"); else url.searchParams.set("status", status);
    if (reviewerFilter === "all") url.searchParams.delete("reviewer"); else url.searchParams.set("reviewer", reviewerFilter);
    if (managing) url.searchParams.set("view", "manage"); else url.searchParams.delete("view");
    if (family) url.searchParams.set("family", family); else url.searchParams.delete("family");
    if (parent) url.searchParams.set("parent", parent); else url.searchParams.delete("parent");
    if (verifiedOnly) url.searchParams.set("verified", "1"); else url.searchParams.delete("verified");
    window.history.replaceState({}, "", url);
  }, [selectedId, status, reviewerFilter, managing, family, parent, verifiedOnly]);
  const switchView = (next) => {
    setView(next); setChecked(new Set()); setMessage(null); setError(null);
    if (next === "review") setSelectedId((current) => current ?? runs?.[0]?.runId ?? null);
  };
  // Opens a pending run from the manage view. The reviewer filter stays unless it would hide the run.
  const openRun = (runId) => {
    const run = runs.find((item) => item.runId === runId);
    const shown = reviewerFilter === "all" || (reviewerFilter === UNASSIGNED ? !run?.reviewers.length
      : run?.reviewers.some((reviewer) => String(reviewer.id) === reviewerFilter));
    if (!shown) setReviewerFilter("all");
    keepSelection.current = true;
    setQuery(""); setSearch(""); setStatus("all"); setSelectedId(runId); switchView("review");
  };

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

  // The server saves a run once its last review arrives. While that runs ("저장 중" / "AI 병합 중") the
  // detail is re-read every 2s; a run still waiting for reviewers is re-read now and then.
  const detailState = detail && detail.runId === selectedId ? detail.reviewStatus : null;
  const awaitingReviews = detailState === "pending" && detail.reviewers.length > 0;
  useEffect(() => {
    if (!isFinalizing({ reviewStatus: detailState }) && !awaitingReviews) return undefined;
    const runId = selectedId;
    const timer = setInterval(() => fetchResearchRunStatus(runId).then((state) => {
      setDetail((current) => (current?.runId === runId ? { ...current, ...state, results: current.results } : current));
      if (state.reviewStatus !== detailState) refreshList();
    }).catch(() => {}), awaitingReviews ? 15000 : 2000);
    return () => clearInterval(timer);
  }, [selectedId, detailState, awaitingReviews]);
  async function retryFinalize() {
    setError(null); setRetrying(true);
    try {
      const state = await finalizeResearchRun(detail.runId);
      setDetail((current) => (current?.runId === state.runId ? { ...current, ...state } : current));
      refreshList();
    } catch (err) { setError(err.message); } finally { setRetrying(false); }
  }

  // Only pending runs can be (re)assigned; saved ones keep who reviewed them.
  const assignable = visibleRuns.filter((run) => run.reviewStatus === "pending");
  const checkedIds = assignable.filter((run) => checked.has(run.runId)).map((run) => run.runId);
  // Bulk assignment by run id range: every pending run in the range, whatever the list is filtered
  // to or has loaded. The server counts what the range covers.
  const rangeIds = useMemo(() => (rangeText.trim() ? parseRunIdRange(rangeText.trim()) : new Set()), [rangeText]);
  const rangeList = useMemo(() => (rangeIds ? [...rangeIds] : []), [rangeIds]);
  const rangeTooLong = rangeList.length > MAX_ASSIGN;
  useEffect(() => {
    setRangePreview(null);
    if (!rangeList.length || rangeTooLong) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => previewAssignRuns(rangeList)
      .then((data) => { if (!cancelled) setRangePreview(data); })
      .catch((err) => { if (!cancelled) setError(err.message); }), 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [rangeList]);
  const rangePending = rangePreview?.pending || 0;
  const toggle = (runId) => setChecked((current) => {
    const next = new Set(current);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });
  // Re-reads what is on screen in one request, so the scroll position and the loaded pages stay.
  const refreshList = () => Promise.all([loadRuns({ limit: Math.min(Math.max(runs?.length || 0, PAGE_SIZE), 500) }), loadReviewers(), loadFilterOptions()]);
  const refresh = async () => {
    await refreshList();
    if (selectedId) loadDetail(selectedId).then(setDetail).catch(() => {});
  };
  /** Change who reviews the runs: mode "add" | "remove" | "set" (see assignResearchRuns). */
  async function assign(runIds, reviewerIds, mode = "add") {
    setError(null); setMessage(null);
    try {
      let changed = 0;
      for (let start = 0; start < runIds.length; start += MAX_ASSIGN) {
        changed += (await assignResearchRuns(runIds.slice(start, start + MAX_ASSIGN), reviewerIds, mode)).assigned;
      }
      const names = reviewerIds.map((id) => reviewers.find((reviewer) => reviewer.id === id)?.name).filter(Boolean).join(", ");
      setMessage(mode === "add" ? `${changed}건에 ${names}을(를) 배정했습니다.`
        : mode === "remove" ? `${changed}건에서 ${names}의 배정을 해제했습니다.`
          : reviewerIds.length ? `${changed}건의 검토자를 ${names}(으)로 바꿨습니다.` : `${changed}건의 배정을 모두 해제했습니다.`);
      setChecked(new Set());
      setRangeText("");
      await refresh();
    } catch (err) { setError(err.message); }
  }
  // The bulk controls: the chosen reviewers are added, replace the current ones, or everyone is unassigned.
  const bulkReviewers = assignMode === "clear" ? [] : reviewers.filter((reviewer) => assignTo.has(reviewer.id)).map((reviewer) => reviewer.id);
  const bulkReady = assignMode === "clear" || bulkReviewers.length > 0;
  const bulkAssign = (runIds) => assign(runIds, bulkReviewers, assignMode === "add" ? "add" : "set");
  const toggleAssignTo = (reviewerId) => setAssignTo((current) => {
    const next = new Set(current);
    if (next.has(reviewerId)) next.delete(reviewerId); else next.add(reviewerId);
    return next;
  });
  const unassign = (run, reviewer) => {
    if (reviewer.status === "submitted" && !window.confirm(`${reviewerName(reviewer)}은(는) #${run.runId} 검토를 이미 제출했습니다. 배정을 해제하면 제출한 검토 내용도 지워집니다. 해제할까요?`)) return;
    assign([run.runId], [reviewer.id], "remove");
  };
  const distributeIds = reviewers.filter((reviewer) => distributeTo.has(reviewer.id)).map((reviewer) => reviewer.id);
  const toggleDistributeTo = (reviewerId) => setDistributeTo((current) => {
    const next = new Set(current);
    if (next.has(reviewerId)) next.delete(reviewerId); else next.add(reviewerId);
    return next;
  });
  async function distribute() {
    const names = reviewers.filter((reviewer) => distributeTo.has(reviewer.id)).map((reviewer) => reviewer.name).join(", ");
    if (!window.confirm(`미배정 ${counts.unassigned}건 전부를 ${names} ${distributeIds.length}명 모두에게 배정할까요?`)) return;
    setError(null); setMessage(null);
    try {
      const result = await distributeResearchRuns(distributeIds);
      setMessage(result.assigned
        ? `미배정 ${result.assigned}건을 ${result.reviewers.map((item) => item.name).join(", ")} ${result.reviewers.length}명 모두에게 배정했습니다.`
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
          <p>“AI로 정보 채우기”를 실행할 때마다 Hugging Face · 논문 조사와 AI 병합 결과가 실행 단위로 저장됩니다. 검토해서 모델로 저장한 실행과, 아직 조사 결과만 남아 있는 실행을 구분해 보고 검토할 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><a href="/admin" className="admin-primary">모델 관리</a></div>
      </header>
      <div className="admin-stats">
        <span><strong>{counts.all}</strong> 조사 실행</span>
        <span><strong>{counts.pending}</strong> 검토 대기</span>
        <span><strong>{counts.unassigned}</strong> 미배정</span>
        <span><strong>{counts.saved}</strong> 저장 완료</span>
      </div>
      <nav className="research-view-tabs" role="tablist" aria-label="작업 화면">
        {VIEWS.map(([key, label, hint]) => <button key={key} type="button" role="tab" aria-selected={view === key}
          className={view === key ? "is-active" : ""} onClick={() => switchView(key)}>{label}<small>{hint}</small></button>)}
      </nav>
      {error && <p className="ai-save-state is-error">{error}</p>}
      {message && <p className="ai-save-state is-saved">{message}</p>}
      {managing ? <main className="research-manage">
        <ReviewerManager reviewers={reviewers} onChange={() => refresh()} onError={setError} />
        <section className="research-assign">
          <div className="research-assign-head">
            <div><h2>검토 대기 배정</h2>
              <p className="admin-help">검토 대기 {counts.pending}건 중 미배정 {counts.unassigned}건. 한 실행에 여러 명을 배정할 수 있고, 배정된 사람이 모두 검토를 제출하면 다수결로 저장됩니다(동점인 값은 AI가 병합). 저장된 실행은 다시 배정하지 않습니다.</p></div>
            <div className="research-distribute">
              <span className="research-distribute-label">미배정 전체 배정</span>
              <span className="research-assign-reviewers" role="group" aria-label="미배정 실행을 모두 배정할 검토 작업자">
                {activeReviewers.map((reviewer) => <label key={reviewer.id} className={distributeTo.has(reviewer.id) ? "is-checked" : ""}>
                  <input type="checkbox" checked={distributeTo.has(reviewer.id)} onChange={() => toggleDistributeTo(reviewer.id)} /> {reviewer.name}</label>)}
                {!activeReviewers.length && <small>검토 작업자를 먼저 추가하세요.</small>}
              </span>
              <button type="button" className="admin-primary" disabled={!counts.unassigned || !distributeIds.length} onClick={distribute}
                title="아직 아무도 배정되지 않은 검토 대기 실행 전부를, 체크한 검토 작업자 모두에게 배정합니다. 이미 배정된 실행은 바꾸지 않습니다.">
                {distributeIds.length ? `미배정 ${counts.unassigned}건을 ${distributeIds.length}명 모두에게 배정` : "배정할 검토자를 체크하세요"}</button>
            </div>
          </div>
          <div className="research-assign-filters">
            <div className="research-search">
              <select value={searchBy} onChange={(event) => { setSearchBy(event.target.value); setQuery(""); }} aria-label="검색 기준">
                <option value="model">모델명</option><option value="id">실행 ID</option>
              </select>
              <input type="search" inputMode={searchBy === "id" ? "numeric" : "text"} placeholder={searchBy === "id" ? "실행 번호 (예: 5)" : "모델명으로 찾기"}
                value={query} onChange={(event) => setQuery(event.target.value)} aria-label="조사 실행 검색" />
            </div>
            <select className="research-reviewer-filter" value={reviewerFilter} onChange={(event) => setReviewerFilter(event.target.value)} aria-label="담당자로 찾기">
              <option value="all">모든 담당자</option>
              <option value={UNASSIGNED}>미배정만</option>
              {reviewers.map((reviewer) => <option key={reviewer.id} value={String(reviewer.id)}>{reviewer.name} · 대기 {reviewer.pendingCount}</option>)}
            </select>
            <BadgeFilter value={badgeFilter} onChange={setBadgeFilter} />
            {lineageFilters(false)}
          </div>
          {runs && <p className="research-assign-count">조건에 맞는 검토 대기 <strong>{page.total.toLocaleString()}</strong>건</p>}
          <div className="research-assign-bar">
            <div className="research-assign-target">
              <label>일괄 배정
                <select value={assignMode} onChange={(event) => setAssignMode(event.target.value)} aria-label="일괄 배정 방식">
                  <option value="add">검토자 추가</option>
                  <option value="set">검토자 교체</option>
                  <option value="clear">배정 모두 해제</option>
                </select>
              </label>
              {assignMode !== "clear" && <span className="research-assign-reviewers" role="group" aria-label="배정할 검토 작업자">
                {activeReviewers.map((reviewer) => <label key={reviewer.id} className={assignTo.has(reviewer.id) ? "is-checked" : ""}>
                  <input type="checkbox" checked={assignTo.has(reviewer.id)} onChange={() => toggleAssignTo(reviewer.id)} /> {reviewer.name}</label>)}
                {!activeReviewers.length && <small>검토 작업자를 먼저 추가하세요.</small>}
              </span>}
            </div>
            <button type="button" disabled={!checkedIds.length || !bulkReady} onClick={() => bulkAssign(checkedIds)}>선택 {checkedIds.length}건 {assignMode === "clear" ? "해제" : "배정"}</button>
            <span className="research-assign-or">또는</span>
            <div className="research-range">
              <input value={rangeText} onChange={(event) => setRangeText(event.target.value)} placeholder="실행 ID 범위 (예: 10-25 또는 3, 5, 8-12)" aria-label="배정할 실행 ID 범위" />
              <button type="button" disabled={!rangePending || !bulkReady} onClick={() => bulkAssign(rangeList)}>범위 {rangePending}건 {assignMode === "clear" ? "해제" : "배정"}</button>
            </div>
            {rangeText.trim() && <small className={`research-range-note${rangeIds && !rangeTooLong ? "" : " is-error"}`}>{!rangeIds
              ? "숫자와 범위만 입력할 수 있습니다. 예: 10-25 또는 3, 5, 8-12"
              : rangeTooLong ? `한 번에 ${MAX_ASSIGN}개 ID까지 배정할 수 있습니다. 범위를 나눠 입력하세요.`
                : !rangePreview ? "범위를 확인하는 중..."
                  : !rangePreview.found ? "이 범위에 해당하는 조사 실행이 없습니다."
                    : `범위 안의 실행 ${rangePreview.found}건 중 검토 대기 ${rangePending}건에 적용됩니다${rangePreview.found > rangePending ? ` (저장된 ${rangePreview.found - rangePending}건은 제외)` : ""}.${bulkReady ? "" : " 작업자를 선택하세요."}`}</small>}
          </div>
          {!runs ? <p className="admin-help">불러오는 중...</p> : !visibleRuns.length
            ? <p className="admin-help">{counts.pending ? "조건에 맞는 검토 대기 실행이 없습니다." : "배정할 검토 대기 실행이 없습니다."}</p>
            : <><table className="research-assign-table">
              <thead><tr>
                <th><input type="checkbox" checked={checkedIds.length === assignable.length}
                  onChange={(event) => setChecked(event.target.checked ? new Set(assignable.map((run) => run.runId)) : new Set())} aria-label={`불러온 ${assignable.length}건 전체 선택`} title="지금 불러온 행을 모두 선택합니다" /></th>
                <th>실행</th><th>모델</th><th>Family / Parent</th><th>조사 시각</th><th>담당</th><th></th>
              </tr></thead>
              <tbody>{visibleRuns.map((run) => <tr key={run.runId} className={checked.has(run.runId) ? "is-checked" : ""}>
                <td><input type="checkbox" checked={checked.has(run.runId)} onChange={() => toggle(run.runId)} aria-label={`#${run.runId} 선택`} /></td>
                <td>#{run.runId}</td>
                <td><strong>{run.modelName}</strong></td>
                <td className="research-assign-lineage">{run.familyName || "-"}<small>{run.parentModelId || "parent 없음"}</small></td>
                <td>{formatDateTime(run.createdAt)}</td>
                <td>{run.reviewStatus !== "pending" && run.reviewStatus !== "failed" ? <ReviewBadge run={run} /> : <div className="research-assignees">
                  {run.reviewers.map((reviewer) => <span key={reviewer.id} className={reviewer.status === "submitted" ? "is-submitted" : ""}>
                    {reviewerName(reviewer)}{reviewer.status === "submitted" ? " ✓" : ""}
                    <button type="button" onClick={() => unassign(run, reviewer)} aria-label={`#${run.runId}에서 ${reviewerName(reviewer)} 배정 해제`} title="배정 해제">×</button></span>)}
                  {run.reviewStatus === "failed" && <ReviewBadge run={run} />}
                  <select className={run.reviewers.length ? "" : "is-unassigned"} value="" aria-label={`#${run.runId} 검토자 추가`}
                    onChange={(event) => event.target.value && assign([run.runId], [Number(event.target.value)], "add")}>
                    <option value="">{run.reviewers.length ? "+ 추가" : "미배정 · 추가"}</option>
                    {reviewers.filter((reviewer) => !run.reviewers.some((item) => item.id === reviewer.id)).map((reviewer) => <option key={reviewer.id} value={reviewer.id}>{reviewer.name}</option>)}
                  </select>
                </div>}</td>
                <td><button type="button" className="research-assign-open" onClick={() => openRun(run.runId)}>결과 보기 →</button></td>
              </tr>)}</tbody>
            </table>
            <LoadMore hasMore={page.nextOffset != null} loading={loadingMore} shown={visibleRuns.length} total={page.total} onLoad={loadMore} /></>}
        </section>
      </main> : <main className="research-page-body">
        <aside className="research-history-list">
          <label className="research-owner-filter">담당자
            <select className="research-reviewer-filter" value={reviewerFilter} onChange={(event) => setReviewerFilter(event.target.value)} aria-label="담당자로 찾기">
              <option value="all">담당자 전체</option>
              <option value={UNASSIGNED}>미배정</option>
              {reviewers.map((reviewer) => <option key={reviewer.id} value={String(reviewer.id)}>{reviewer.name} · 대기 {reviewer.pendingCount}</option>)}
            </select>
          </label>
          <label className="research-owner-filter">결과
            <BadgeFilter value={badgeFilter} onChange={setBadgeFilter} />
          </label>
          {lineageFilters(true)}
          <div className="research-filter-tabs" role="tablist" aria-label="검토 상태">
            {FILTERS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={status === key}
              className={status === key ? "is-active" : ""} onClick={() => setStatus(key)}>{label} <small>{tabCounts[key]}</small></button>)}
          </div>
          <div className="research-search">
            <select value={searchBy} onChange={(event) => { setSearchBy(event.target.value); setQuery(""); }} aria-label="검색 기준">
              <option value="model">모델명</option><option value="id">실행 ID</option>
            </select>
            <input type="search" inputMode={searchBy === "id" ? "numeric" : "text"} placeholder={searchBy === "id" ? "실행 번호 (예: 5)" : "모델명으로 찾기"}
              value={query} onChange={(event) => setQuery(event.target.value)} aria-label="조사 실행 검색" />
          </div>

          {!runs ? <p className="admin-help">불러오는 중...</p> : !visibleRuns.length
            ? <p className="admin-help">{!counts.all ? "아직 AI 조사 실행이 없습니다. 모델 관리의 “+ 새 모델 → AI로 정보 채우기”로 조사하면 여기에 쌓입니다." : status === "pending" ? "조건에 맞는 검토 대기 실행이 없습니다." : "조건에 맞는 조사 실행이 없습니다."}</p> : (
              <ul className="research-run-list">{visibleRuns.map((run) => (
                <li key={run.runId}>
                  <button type="button" className={run.runId === selectedId ? "is-selected" : ""} onClick={() => setSelectedId(run.runId)}>
                    <strong>#{run.runId} {run.modelName}</strong>
                    <span>{formatDateTime(run.createdAt)} · 검색 {run.totalWebSearches ?? "-"} · {formatCost(run.totalCostUsd)}</span>
                    <SourceBadges run={run} />
                    <span className="research-run-foot"><ReviewBadge run={run} /><RunReviewer run={run} /></span>
                  </button>
                </li>
              ))}</ul>
            )}
          {runs && <LoadMore hasMore={page.nextOffset != null} loading={loadingMore} shown={visibleRuns.length} total={page.total} onLoad={loadMore} />}
        </aside>
        <div className="research-history-detail">
          {!detail ? <p className="admin-help">{selectedId ? "불러오는 중..." : runs && !counts.all ? "조사 실행이 생기면 여기에서 결과를 확인하고 검토할 수 있습니다." : "왼쪽에서 조사 실행을 선택하세요."}</p> : <>
            <div className="research-detail-head">
              <div><h3>#{detail.runId} {detail.modelName}</h3>
                <p><ReviewBadge run={detail} /> {formatDateTime(detail.createdAt)} · 결과 모델 {detail.resultModelId || "-"} · 총 검색 {detail.totalWebSearches ?? "-"} · 총 비용 {formatCost(detail.totalCostUsd)}</p></div>
              <button type="button" className="admin-danger" onClick={removeRun}>이 실행 삭제</button>
            </div>
            <div className={`research-review-panel is-${detail.reviewStatus}`} aria-live="polite">
              {detail.reviewStatus === "saved" ? <>
                <p><strong>검토를 마치고 저장된 실행입니다.</strong> 이 조사 결과로 <code>{detail.modelId}</code> 모델이 저장되었습니다.
                  <br />검토자 <b>{savedReviewers(detail)}</b> · 저장 {formatDateTime(detail.reviewedAt)}{detail.finalize.summary ? ` · 검토자 ${detail.finalize.summary.reviewerIds.length}명의 답을 다수결로 저장` : ""}</p>
                <a className="admin-secondary" href={modelLink(detail.modelId)}>저장된 모델 열기</a>
              </> : isFinalizing(detail) ? <>
                <span className="review-spinner" aria-hidden="true" />
                <p><strong>{detail.reviewStatus === "merging" ? "AI 병합 중…" : "저장 중…"}</strong> {detail.reviewStatus === "merging"
                  ? "검토자들의 답이 동점인 값을 AI가 검토자 답 · HF · 논문 값을 보고 병합하고 있습니다. 끝나면 자동으로 저장됩니다."
                  : "모든 검토가 제출되어 다수결 결과를 저장하고 있습니다."}
                  <br /><ReviewerChips reviewers={detail.reviewers} /></p>
                {detail.finalize.stale && <button type="button" className="admin-secondary" disabled={retrying} onClick={retryFinalize}>다시 시도</button>}
              </> : detail.reviewStatus === "failed" ? <>
                <p><strong>검토 결과를 저장하지 못했습니다.</strong> {detail.finalize.error}
                  <br /><ReviewerChips reviewers={detail.reviewers} /> 다시 시도하거나, 검토자가 답을 고쳐 다시 제출하면 저장을 다시 시작합니다.</p>
                <div className="research-review-actions">
                  <a className="admin-secondary" href={reviewLink(detail.runId, filteredReviewer)}>검토 화면 열기</a>
                  <button type="button" className="admin-primary" disabled={retrying} onClick={retryFinalize}>{retrying ? "시작하는 중…" : "다시 시도"}</button>
                </div>
              </> : detail.reviewers.length ? <>
                <p><strong>검토 중입니다 ({detail.reviewProgress.submitted}/{detail.reviewProgress.total} 제출).</strong> 배정된 검토자가 모두 제출하면 가장 많이 선택된 값으로 자동 저장됩니다. 동점인 값만 AI가 병합합니다.{detail.catalogModelId
                  ? <> 카탈로그에 <code>{detail.catalogModelId}</code> 모델이 이미 있어 그 모델에 반영됩니다.</> : ""}
                  <br /><ReviewerChips reviewers={detail.reviewers} /></p>
                <div className="research-review-actions">
                  {detail.reviewProgress.submitted === detail.reviewProgress.total
                    && <button type="button" className="admin-secondary" disabled={retrying} onClick={retryFinalize}>저장 시작</button>}
                  <a className="admin-primary" href={reviewLink(detail.runId, filteredReviewer)}>검토하기 →</a>
                </div>
              </> : <>
                <p><strong>아직 검토되지 않았습니다.</strong> 배정된 검토자가 없습니다. “배정 · 작업자 관리”에서 검토자를 배정하면 여러 명이 검토한 뒤 다수결로 저장됩니다. {detail.catalogModelId
                  ? <>카탈로그에 <code>{detail.catalogModelId}</code> 모델이 이미 있어, 배정 없이 열면 그 모델의 편집 화면에서 값을 골라 바로 저장합니다.</>
                  : "배정 없이 열면 편집 화면에서 값과 근거를 확인하고 바로 모델로 등록합니다."}</p>
                <div className="research-review-actions">
                  <span className="research-review-owner is-unassigned">담당 <b>미배정</b></span>
                  <a className="admin-primary" href={reviewLink(detail.runId)}>{detail.catalogModelId ? "기존 모델에 반영하며 바로 저장 →" : "배정 없이 바로 저장 →"}</a>
                </div>
              </>}
            </div>
            {detail.reviewStatus === "saved" && detail.finalize.summary && <ConsensusSummary summary={detail.finalize.summary} reviewers={detail.reviewers} />}
            <div className="research-source-tabs" role="tablist">{SOURCES.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "is-active" : ""} onClick={() => setTab(key)}>
                {label} <small>{detail.results[key] ? STATUS[detail.results[key].status] || detail.results[key].status : "없음"}</small>
              </button>
            ))}</div>
            <SourceDetail key={`${detail.runId}-${tab}`} item={detail.results[tab]} fields={historyFields} sourceKey={tab} />
          </>}
        </div>
      </main>}
    </div>
  );
}
