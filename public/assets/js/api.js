// Shared API client. Handles CSRF, JSON errors, and field-level validation details.

let csrfToken = null;
let cachedMe = null;

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details || null;
  }
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new ApiError(0, 'Network unavailable. Check your connection and try again.');
  }

  if (response.status === 204) return null;

  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: 'The server returned an unreadable response.' }; }
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error || `Request failed (${response.status}).`, payload?.details);
  }
  if (payload && payload.csrfToken) csrfToken = payload.csrfToken;
  return payload;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  delete: (path) => request('DELETE', path)
};

/** Builds a query string, omitting empty values and expanding arrays. */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, item));
    else search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/** Current session, cached per page load. Pass true to force a refetch. */
export async function me(force = false) {
  if (cachedMe && !force) return cachedMe;
  const data = await api.get('/api/auth/me');
  csrfToken = data.csrfToken;
  cachedMe = data;
  return data;
}

export function setCsrfToken(token) { csrfToken = token; }
export function clearMeCache() { cachedMe = null; }

/**
 * Redirects to the login page unless the visitor is signed in with an allowed role.
 * Returns the session payload when access is granted.
 */
export async function requireSession(roles) {
  const data = await me();
  if (!data.user) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.replace(`/login.html?next=${next}`);
    return null;
  }
  if (roles && roles.length && !roles.includes(data.user.role)) {
    location.replace('/app/dashboard.html');
    return null;
  }
  return data;
}
