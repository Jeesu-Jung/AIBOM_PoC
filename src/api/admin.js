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
export const createAdminModel = (payload) => request("/api/v1/admin/models", {
  method: "POST", body: JSON.stringify(payload)
});
export const updateAdminModel = (modelId, payload) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "PUT", body: JSON.stringify(payload)
});
export const deleteAdminModel = (modelId) => request(`/api/v1/admin/models/${modelPath(modelId)}`, {
  method: "DELETE"
});
