const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const responseCache = new Map();
const pendingRequests = new Map();

async function getJson(path) {
  if (responseCache.has(path)) return responseCache.get(path);
  if (pendingRequests.has(path)) return pendingRequests.get(path);

  const request = fetch(`${API_BASE_URL}${path}`, {
    headers: { Accept: "application/json" }
  }).then(async (response) => {
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail || `API request failed (${response.status}).`);
    }
    const payload = await response.json();
    responseCache.set(path, payload);
    return payload;
  }).finally(() => pendingRequests.delete(path));

  pendingRequests.set(path, request);
  return request;
}

export async function fetchFamilies() {
  const payload = await getJson("/api/v1/families");
  if (!Array.isArray(payload?.items) || !payload?.summary) {
    throw new Error("Family API returned an invalid response.");
  }
  return payload;
}

export async function fetchFamilyHierarchy(familyKey) {
  const payload = await getJson(`/api/v1/families/${encodeURIComponent(familyKey)}/hierarchy`);
  if (!payload?.id || !Array.isArray(payload?.root_nodes) || !Array.isArray(payload?.derived_models)) {
    throw new Error("Family hierarchy API returned an invalid response.");
  }
  return payload;
}

export async function fetchModel(modelId) {
  const payload = await getJson(`/api/v1/models/${modelId.split("/").map(encodeURIComponent).join("/")}`);
  if (!payload?.modelId || !payload?.familyKey) {
    throw new Error("Model API returned an invalid response.");
  }
  return payload;
}
