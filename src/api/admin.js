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
      ? detail.map((item) => item.msg).join(" · ")
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
export const fetchResearchRun = (runId) => request(`/api/v1/admin/research-runs/${runId}`);
export const linkResearchRun = (runId, modelId) => request(`/api/v1/admin/research-runs/${runId}/model`, {
  method: "PUT", body: JSON.stringify({ modelId })
});
export const deleteResearchRun = (runId) => request(`/api/v1/admin/research-runs/${runId}`, { method: "DELETE" });
export const createAdminModel = (payload) => request("/api/v1/admin/models", {
  method: "POST", body: JSON.stringify(payload)
});
export const updateAdminModel = (modelId, payload) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "PUT", body: JSON.stringify(payload)
});
export const deleteAdminModel = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "DELETE"
});
export const fetchAdminModelAibom = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}/aibom`);
export const saveAdminModelAibom = (modelId, payload) => request(`/api/v1/admin/models/${modelPath(modelId)}/aibom`, {
  method: "PUT", body: JSON.stringify(payload)
});
export const fetchAdminAibomOptions = () => request("/api/v1/admin/aibom/options");
