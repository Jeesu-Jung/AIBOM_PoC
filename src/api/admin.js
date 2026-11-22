const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json", ...options.headers }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const detail = payload?.detail;
    const message = Array.isArray(detail)
      // Name the field of each validation error (`model.artifactFormat: String should have ...`).
      ? detail.map((item) => {
        const field = (item.loc || []).filter((part) => part !== "body").join(".");
        return field ? `${field}: ${item.msg}` : item.msg;
      }).join(" · ")
      : detail || `API request failed (${response.status}).`;
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

const modelPath = (modelId) => modelId.split("/").map(encodeURIComponent).join("/");

export const fetchAdminModels = () => request("/api/v1/admin/models");
async function streamAdminSse(path, body, onEvent, signal) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail || `API request failed (${response.status}).`);
  }
  if (!response.body) throw new Error("브라우저에서 스트리밍 응답을 읽을 수 없습니다.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = null;

  const dispatch = (block) => {
    let event = "message";
    const dataLines = [];
    block.split("\n").forEach((line) => {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;
    let data;
    try { data = JSON.parse(dataLines.join("\n")); } catch { data = { data: dataLines.join("\n") }; }
    onEvent?.({ type: event, data });
    if (event === "complete") completed = data.result;
    if (event === "error") throw new Error(data.message || "모델 조사 중 오류가 발생했습니다.");
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer = (buffer + decoder.decode(value || new Uint8Array(), { stream: !done })).replace(/\r\n/g, "\n");
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    blocks.forEach(dispatch);
    if (done) break;
  }
  if (buffer.trim()) dispatch(buffer);
  if (!completed) throw new Error("OpenRouter 스트림이 결과 없이 종료되었습니다.");
  return completed;
}
export const streamAdminModelResearch = (modelName, onEvent, signal, source = "huggingface") =>
  streamAdminSse("/api/v1/admin/model-research/stream", { modelName, source }, onEvent, signal);
export const streamAdminModelMerge = (modelName, results, onEvent, signal) =>
  streamAdminSse("/api/v1/admin/model-research/merge/stream", { modelName, results }, onEvent, signal);
export const fetchAdminResearchResults = (modelName) =>
  request(`/api/v1/admin/model-research/results?modelName=${encodeURIComponent(modelName)}`);
export const saveAdminResearchResults = (modelName, results, replacePrevious = false, runId = null) =>
  request("/api/v1/admin/model-research/results", { method: "POST", body: JSON.stringify({ modelName, results, replacePrevious, runId }) });
export const fetchResearchRuns = ({ modelName, modelId, limit } = {}) => {
  const params = new URLSearchParams();
  if (modelName) params.set("modelName", modelName);
  if (modelId) params.set("modelId", modelId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString();
  return request(`/api/v1/admin/research-runs${query ? `?${query}` : ""}`);
};
// One page of the research history, filtered on the server: { items, total, nextOffset, counts, stats }.
// label: one result badge as `<source>:<status>` (e.g. `huggingface:not_found`), or "all".
// family: a family name; parent: part of a parent model id; verified: Hugging Face, paper and merged all found.
export const fetchResearchRunPage = ({ status = "all", reviewer = "all", label = "all", family = "", parent = "", verified = false, query = "", searchBy = "model", offset = 0, limit = 100 } = {}) => {
  const params = new URLSearchParams({ status, reviewer, label, searchBy, offset: String(offset), limit: String(limit) });
  if (family) params.set("family", family);
  if (parent) params.set("parent", parent);
  if (verified) params.set("verified", "true");
  if (query) params.set("query", query);
  return request(`/api/v1/admin/research-runs/page?${params}`);
};
// { families, parents }: the family names and parent model ids the stored results hold.
export const fetchResearchFilterOptions = () => request("/api/v1/admin/research-runs/filter-options");
// resolve: results placed in the current catalog tree with evidence rows (what the editor needs).
export const fetchResearchRun = (runId, resolve = false) => request(`/api/v1/admin/research-runs/${runId}${resolve ? "?resolve=true" : ""}`);
// reviewedBy: reviewer who did the review; null records nobody.
export const linkResearchRun = (runId, modelId, reviewedBy = null) => request(`/api/v1/admin/research-runs/${runId}/model`, {
  method: "PUT", body: JSON.stringify({ modelId, reviewedBy })
});
export const fetchReviewers = () => request("/api/v1/admin/reviewers");
export const createReviewer = (reviewer) => request("/api/v1/admin/reviewers", { method: "POST", body: JSON.stringify(reviewer) });
export const updateReviewer = (reviewerId, reviewer) => request(`/api/v1/admin/reviewers/${reviewerId}`, {
  method: "PUT", body: JSON.stringify(reviewer)
});
// reviewerId null removes the assignment; runs that are already saved are skipped.
// Soft delete: hidden and unassigned from pending runs; adding the same name again restores the reviewer.
export const deleteReviewer = (reviewerId) => request(`/api/v1/admin/reviewers/${reviewerId}`, { method: "DELETE" });
export const assignResearchRuns = (runIds, reviewerId) => request("/api/v1/admin/research-runs/assign", {
  method: "POST", body: JSON.stringify({ runIds, reviewerId })
});
// How many of the ids exist and still wait for review ({ found, pending }); nothing is changed.
export const previewAssignRuns = (runIds) => request("/api/v1/admin/research-runs/assign", {
  method: "POST", body: JSON.stringify({ runIds, dryRun: true })
});
export const distributeResearchRuns = () => request("/api/v1/admin/research-runs/distribute", { method: "POST" });
export const deleteResearchRun = (runId) => request(`/api/v1/admin/research-runs/${runId}`, { method: "DELETE" });
export const createAdminModel = (payload) => request("/api/v1/admin/models", {
  method: "POST", body: JSON.stringify(payload)
});
export const updateAdminModel = (modelId, payload) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "PUT", body: JSON.stringify(payload)
});
export const saveAdminModelWithAibom = (modelId, model, aibom) => request(
  modelId ? `/api/v1/admin/models/${modelPath(modelId)}/complete` : "/api/v1/admin/models/complete",
  { method: modelId ? "PUT" : "POST", body: JSON.stringify({ model, aibom }) }
);
export const deleteAdminModel = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "DELETE"
});
export const fetchAdminModelAibom = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}/aibom`);
export const saveAdminModelAibom = (modelId, payload) => request(`/api/v1/admin/models/${modelPath(modelId)}/aibom`, {
  method: "PUT", body: JSON.stringify(payload)
});
export const fetchAdminAibomOptions = () => request("/api/v1/admin/aibom/options");
export const fetchAdminModelEvidence = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}/evidence`);
export const saveAdminModelEvidence = (modelId, items, runId = null) => request(`/api/v1/admin/models/${modelPath(modelId)}/evidence`, {
  method: "PUT", body: JSON.stringify({ runId, items: items.map(({ area, itemKey, field, url, locator, confidence, note, source }) => ({ area, itemKey, field, url, locator, confidence, note, source })) })
});
