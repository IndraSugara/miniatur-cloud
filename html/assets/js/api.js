import { API_BASE, TOKEN_KEY, REFRESH_TOKEN_KEY } from "./config.js";

function readToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function writeToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function readRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

function writeRefreshToken(token) {
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

function normalizeError(payload, fallback) {
  if (!payload) return fallback;
  // Structured bilingual error: {"error": {"code": "...", "message": "..."}}
  if (payload.detail && typeof payload.detail === "object" && payload.detail.message) {
    return payload.detail.message;
  }
  if (typeof payload.detail === "string") return payload.detail;
  if (Array.isArray(payload.detail) && payload.detail.length > 0) {
    const first = payload.detail[0];
    if (typeof first === "string") return first;
    if (first?.msg) return first.msg;
  }
  if (typeof payload.message === "string") return payload.message;
  return fallback;
}

/** Extract machine-readable error code from structured error. */
function extractErrorCode(payload) {
  if (payload?.detail?.code) return payload.detail.code;
  return null;
}

let _isRefreshing = false;
let _refreshPromise = null;

async function tryRefresh() {
  if (_isRefreshing) return _refreshPromise;
  const rt = readRefreshToken();
  if (!rt) return false;

  _isRefreshing = true;
  _refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (data.access_token) {
        writeToken(data.access_token);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      _isRefreshing = false;
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

async function request(path, { method = "GET", body, auth = true, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (auth) {
    const token = readToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
  }

  let payload = body;
  const isForm = body instanceof URLSearchParams || body instanceof FormData;
  if (body && !isForm && typeof body === "object") {
    finalHeaders["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: finalHeaders,
    body: payload,
  });

  // Auto-refresh on 401
  if (response.status === 401 && auth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry with new token
      const newToken = readToken();
      finalHeaders.Authorization = `Bearer ${newToken}`;
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: finalHeaders,
        body: payload,
      });
    }
  }

  const contentType = response.headers.get("content-type") || "";
  const parsed = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new Error(normalizeError(parsed, `HTTP ${response.status}`));
  }

  return parsed;
}

export const auth = {
  hasToken: () => Boolean(readToken()),
  clear: () => clearTokens(),
  async login(username, password) {
    const form = new URLSearchParams();
    form.set("username", username);
    form.set("password", password);
    const result = await request("/auth/token", {
      method: "POST",
      body: form,
      auth: false,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    writeToken(result.access_token);
    if (result.refresh_token) {
      writeRefreshToken(result.refresh_token);
    }
    return result;
  },
  me() {
    return request("/auth/me");
  },
  register(payload) {
    return request("/auth/register", { method: "POST", body: payload });
  },
};

export const adminApi = {
  listUsers: () => request("/admin/users"),
};

export const monitorApi = {
  health: () => request("/health", { auth: false }),
  host: () => request("/monitoring/host"),
  summary: () => request("/monitoring/summary"),
};

export const catalogApi = {
  images: () => request("/catalog/images", { auth: false }),
  types: () => request("/catalog/instance-types", { auth: false }),
};

export const computeApi = {
  listInstances: () => request("/instances"),
  createInstance: (payload) => request("/instances", { method: "POST", body: payload }),
  getInstance: (id) => request(`/instances/${id}`),
  getInstanceStatus: (id) => request(`/instances/${id}/status`),
  getInstanceLogs: (id, tail = 100) => request(`/instances/${id}/logs?tail=${tail}`),
  updateTags: (id, tags) =>
    request(`/instances/${id}/tags`, { method: "PATCH", body: { tags } }),
  action: (id, action) =>
    request(`/instances/${id}/action`, { method: "POST", body: { action } }),
  exec: (id, command) =>
    request(`/instances/${id}/exec`, { method: "POST", body: { command } }),
  updateNetwork: (id, networkId) =>
    request(`/instances/${id}/network`, { method: "POST", body: { network_id: networkId } }),
  updateSecurityGroup: (id, securityGroupId) =>
    request(`/instances/${id}/security-group`, {
      method: "POST",
      body: { security_group_id: securityGroupId },
    }),
  listSnapshots: () => request("/snapshots"),
  createSnapshot: (id, name) =>
    request(`/instances/${id}/snapshot`, { method: "POST", body: { name } }),
  deleteSnapshot: (id) => request(`/snapshots/${id}`, { method: "DELETE" }),
};

export const networkApi = {
  listNetworks: () => request("/networks"),
  createNetwork: (payload) => request("/networks", { method: "POST", body: payload }),
  deleteNetwork: (id) => request(`/networks/${id}`, { method: "DELETE" }),
  listSecurityGroups: () => request("/security-groups"),
  createSecurityGroup: (name) => request("/security-groups", { method: "POST", body: { name } }),
  deleteSecurityGroup: (id) => request(`/security-groups/${id}`, { method: "DELETE" }),
  addSecurityGroupRule: (id, payload) =>
    request(`/security-groups/${id}/rules`, { method: "POST", body: payload }),
  deleteSecurityGroupRule: (id, ruleId) =>
    request(`/security-groups/${id}/rules/${ruleId}`, { method: "DELETE" }),
  // Public Endpoints (formerly Floating IPs)
  listPublicEndpoints: () => request("/public-endpoints"),
  createPublicEndpoint: (instanceId = null) =>
    request("/public-endpoints", { method: "POST", body: { instance_id: instanceId } }),
  attachPublicEndpoint: (id, instanceId) =>
    request(`/public-endpoints/${id}/attach`, { method: "POST", body: { instance_id: instanceId } }),
  detachPublicEndpoint: (id) => request(`/public-endpoints/${id}/detach`, { method: "POST" }),
  deletePublicEndpoint: (id) => request(`/public-endpoints/${id}`, { method: "DELETE" }),
};

export const storageApi = {
  listVolumes: () => request("/volumes"),
  createVolume: (payload) => request("/volumes", { method: "POST", body: payload }),
  deleteVolume: (id) => request(`/volumes/${id}`, { method: "DELETE" }),
  attachVolume: (id, payload) => request(`/volumes/${id}/attach`, { method: "POST", body: payload }),
  detachVolume: (id, payload) =>
    request(`/volumes/${id}/detach`, { method: "POST", body: payload }),
  listBuckets: () => request("/storage/buckets"),
  createBucket: (name) => request("/storage/buckets", { method: "POST", body: { name } }),
  deleteBucket: (name, force = false) =>
    request(`/storage/buckets/${encodeURIComponent(name)}?force=${force ? "true" : "false"}`, {
      method: "DELETE",
    }),
  listObjects: (bucket, prefix = "", limit = 200) =>
    request(
      `/storage/buckets/${encodeURIComponent(bucket)}/objects?prefix=${encodeURIComponent(prefix)}&limit=${limit}`,
    ),
  deleteObject: (bucket, objectKey) =>
    request(`/storage/buckets/${encodeURIComponent(bucket)}/objects?object_key=${encodeURIComponent(objectKey)}`, {
      method: "DELETE",
    }),
  presignUpload: (bucket, payload) =>
    request(`/storage/buckets/${encodeURIComponent(bucket)}/presign/upload`, {
      method: "POST",
      body: payload,
    }),
  presignDownload: (bucket, payload) =>
    request(`/storage/buckets/${encodeURIComponent(bucket)}/presign/download`, {
      method: "POST",
      body: payload,
    }),
};
