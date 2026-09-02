'use strict';

/**
 * Shared test harness for the Horizon server.
 *
 * Zero dependencies: only node: built-ins. Everything here is deliberately
 * tolerant of non-2xx responses so tests can assert on status codes instead of
 * catching exceptions.
 */

const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'server');

const { createApp } = require(path.join(SRC, 'app'));
const { DEMO_PASSWORD } = require(path.join(SRC, 'seed'));

const SESSION_COOKIE = 'horizon_session';

/**
 * Boots a fully seeded app on an ephemeral port backed by an in-memory database.
 * @returns {Promise<{ app: object, baseUrl: string, close: () => Promise<void> }>}
 */
async function startServer() {
  const app = createApp({ dbFile: ':memory:', demoData: true, secureCookies: false });
  const address = await app.listen(0, '127.0.0.1');
  return {
    app,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => app.close()
  };
}

/** Cookie-aware, CSRF-aware JSON client. Never throws on HTTP status. */
class Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = '';
    this.csrfToken = '';
  }

  /** Raw request: no cookie jar bookkeeping beyond capture, no CSRF injection. */
  async request(method, requestPath, { body, headers = {}, sendCsrf = true } = {}) {
    const finalHeaders = { accept: 'application/json', ...headers };
    if (this.cookie && finalHeaders.cookie === undefined) finalHeaders.cookie = this.cookie;
    if (body !== undefined) finalHeaders['content-type'] = 'application/json';
    if (sendCsrf && method !== 'GET' && method !== 'HEAD' && this.csrfToken && finalHeaders['x-csrf-token'] === undefined) {
      finalHeaders['x-csrf-token'] = this.csrfToken;
    }

    const response = await fetch(`${this.baseUrl}${requestPath}`, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    for (const setCookie of response.headers.getSetCookie()) {
      if (!setCookie.startsWith(`${SESSION_COOKIE}=`)) continue;
      const pair = setCookie.split(';')[0];
      // A cleared cookie (`horizon_session=`) empties the jar.
      this.cookie = pair.endsWith('=') ? '' : pair;
      if (!this.cookie) this.csrfToken = '';
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get(requestPath, options) { return this.request('GET', requestPath, options); }
  post(requestPath, body, options) { return this.request('POST', requestPath, { body: body ?? {}, ...options }); }
  patch(requestPath, body, options) { return this.request('PATCH', requestPath, { body: body ?? {}, ...options }); }
  put(requestPath, body, options) { return this.request('PUT', requestPath, { body: body ?? {}, ...options }); }
  del(requestPath, options) { return this.request('DELETE', requestPath, options); }

  /**
   * Re-reads /api/auth/me to pick up the CSRF token for the current session.
   * The server only mints a token at login/signup time, so this must run after
   * every session change.
   */
  async refreshCsrf() {
    const me = await this.get('/api/auth/me');
    this.csrfToken = me.body?.csrfToken || '';
    return me;
  }

  /** Signs up, then captures the fresh session's CSRF token. */
  async signup(fields) {
    const response = await this.post('/api/auth/signup', fields);
    if (response.status === 201) {
      this.csrfToken = response.body?.csrfToken || '';
      await this.refreshCsrf();
    }
    return response;
  }
}

const createClient = (baseUrl) => new Client(baseUrl);

/** Logs a demo account in and refreshes its CSRF token. */
async function login(client, email, password = DEMO_PASSWORD) {
  const response = await client.post('/api/auth/login', { email, password });
  if (response.status === 200) await client.refreshCsrf();
  return response;
}

let counter = 0;
/** Unique email per call: the server rate-limits signups per address. */
const uniqueEmail = (prefix = 'user') => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}@example.test`;

const LONG_PASSWORD = 'a-sufficiently-long-password';

module.exports = {
  SRC, SESSION_COOKIE, DEMO_PASSWORD, LONG_PASSWORD,
  startServer, createClient, Client, login, uniqueEmail
};
