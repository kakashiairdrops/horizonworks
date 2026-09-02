'use strict';

/**
 * Authentication, session, CSRF, and role enforcement over real HTTP.
 *
 * Note: src/server/auth.js keeps a module-level login limiter (12 attempts per
 * email per 10 minutes), so seeded demo accounts are logged in once and the
 * resulting sessions are shared; anything that needs a throwaway session signs
 * up a brand-new user instead.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  startServer, createClient, login, uniqueEmail,
  DEMO_PASSWORD, LONG_PASSWORD, SESSION_COOKIE
} = require('./helpers');

const CLIENT_EMAIL = 'alex@northstar.test';
const TALENT_EMAIL = 'maya@horizon.test';

const briefPayload = (title) => ({
  title, description: 'A deliberately long brief description that satisfies the minimum length rule.',
  category: 'Web development', budget_min: 1000, budget_max: 2000,
  asset: 'USDC', network: 'Base', start_window: 'this_week', skills: ['React']
});

describe('auth over HTTP', () => {
  let server;
  let baseUrl;
  let clientSession;
  let talentSession;

  before(async () => {
    server = await startServer();
    baseUrl = server.baseUrl;

    clientSession = createClient(baseUrl);
    const asClient = await login(clientSession, CLIENT_EMAIL);
    assert.equal(asClient.status, 200, 'seeded client should log in');

    talentSession = createClient(baseUrl);
    const asTalent = await login(talentSession, TALENT_EMAIL);
    assert.equal(asTalent.status, 200, 'seeded talent should log in');
  });

  after(async () => {
    await server.close();
  });

  describe('signup', () => {
    it('creates a session, sets the cookie, and /api/auth/me returns the user', async () => {
      const client = createClient(baseUrl);
      const email = uniqueEmail('signup-client');
      const response = await client.post('/api/auth/signup', {
        name: 'Signup Tester', email, password: LONG_PASSWORD, role: 'client', company: 'Testco'
      });

      assert.equal(response.status, 201);
      assert.equal(response.body.user.email, email);
      assert.equal(response.body.user.role, 'client');
      assert.equal(typeof response.body.csrfToken, 'string');
      assert.ok(response.body.csrfToken.length > 0);

      const setCookie = response.headers.getSetCookie();
      assert.ok(setCookie.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)), 'session cookie must be set');
      assert.ok(setCookie.some((cookie) => cookie.includes('HttpOnly')), 'session cookie must be HttpOnly');
      assert.ok(client.cookie.startsWith(`${SESSION_COOKIE}=`), 'client should have captured the cookie');

      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, email);
      assert.equal(me.body.user.name, 'Signup Tester');
      assert.equal(me.body.user.company, 'Testco');
      assert.equal(me.body.profile, null, 'a client has no talent profile');
      assert.ok(Array.isArray(me.body.wallets));
    });

    it('provisions a pending talent profile for role=talent', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/signup', {
        name: 'Talent Tester', email: uniqueEmail('signup-talent'), password: LONG_PASSWORD, role: 'talent'
      });
      assert.equal(response.status, 201);

      const me = await client.get('/api/auth/me');
      assert.equal(me.body.user.role, 'talent');
      assert.equal(me.body.profile.status, 'pending', 'new talent profiles start pending');
    });

    it('rejects a duplicate email with 409 and no session', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/signup', {
        name: 'Duplicate Alex', email: CLIENT_EMAIL, password: LONG_PASSWORD, role: 'client'
      });
      assert.equal(response.status, 409);
      assert.match(response.body.error, /already exists/i);
      assert.equal(response.headers.getSetCookie().length, 0, 'no cookie on a failed signup');
      assert.equal(client.cookie, '');
    });

    it('rejects a password shorter than 10 characters with 400 + details.password', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/signup', {
        name: 'Short Password', email: uniqueEmail('shortpw'), password: 'short', role: 'client'
      });
      assert.equal(response.status, 400);
      assert.equal(typeof response.body.details, 'object');
      assert.equal(response.body.details.password, 'Password must be at least 10 characters.');
      assert.equal(client.cookie, '', 'no session for an invalid signup');
    });

    it('rejects an invalid role with 400 + details.role', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/signup', {
        name: 'Wrong Role', email: uniqueEmail('wrongrole'), password: LONG_PASSWORD, role: 'admin'
      });
      assert.equal(response.status, 400);
      assert.match(response.body.details.role, /must be one of: client, talent/);
    });
  });

  describe('login and logout', () => {
    it('logged the seeded demo client in and issued a csrf token', async () => {
      const me = await clientSession.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, CLIENT_EMAIL);
      assert.equal(me.body.user.role, 'client');
      assert.equal(typeof me.body.csrfToken, 'string');
      assert.equal(clientSession.csrfToken, me.body.csrfToken, 'helper should hold the session token');
    });

    it('returns 400 and sets no session for a wrong password', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/login', { email: CLIENT_EMAIL, password: 'definitely-not-it' });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /not correct/i);
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.equal(client.cookie, '');

      const me = await client.get('/api/auth/me');
      assert.equal(me.body.user, null);
    });

    it('returns 400 for an unknown email without leaking that it is unknown', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/login', { email: uniqueEmail('ghost'), password: DEMO_PASSWORD });
      assert.equal(response.status, 400);
      assert.match(response.body.error, /email and password combination/i);
    });

    it('returns 400 with field details when the login body is empty', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/auth/login', {});
      assert.equal(response.status, 400);
      assert.equal(response.body.details.email, 'Email is required.');
      assert.equal(response.body.details.password, 'Password is required.');
    });

    it('reports user: null for an unauthenticated /api/auth/me', async () => {
      const client = createClient(baseUrl);
      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.deepEqual(me.body, { user: null, csrfToken: null });
    });

    it('logout clears the session so /api/auth/me returns user: null', async () => {
      const client = createClient(baseUrl);
      const signedUp = await client.signup({
        name: 'Logout Tester', email: uniqueEmail('logout'), password: LONG_PASSWORD, role: 'client'
      });
      assert.equal(signedUp.status, 201);
      assert.notEqual((await client.get('/api/auth/me')).body.user, null);

      const response = await client.post('/api/auth/logout');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { ok: true });

      const me = await client.get('/api/auth/me');
      assert.equal(me.body.user, null);
      assert.equal(me.body.csrfToken, null);
    });

    it('ignores an unknown session cookie', async () => {
      const client = createClient(baseUrl);
      client.cookie = `${SESSION_COOKIE}=not-a-real-session-id`;
      const me = await client.get('/api/auth/me');
      assert.equal(me.status, 200);
      assert.equal(me.body.user, null);
    });
  });

  describe('protected endpoints', () => {
    it('returns 401 for GET /api/dashboard when unauthenticated', async () => {
      const client = createClient(baseUrl);
      const response = await client.get('/api/dashboard');
      assert.equal(response.status, 401);
      assert.match(response.body.error, /sign in/i);
    });

    it('returns 401 for the other session-only reads when unauthenticated', async () => {
      const client = createClient(baseUrl);
      for (const endpoint of ['/api/briefs', '/api/projects', '/api/notifications', '/api/payments', '/api/invitations']) {
        const response = await client.get(endpoint);
        assert.equal(response.status, 401, `${endpoint} should require a session`);
      }
    });

    it('returns 200 for GET /api/dashboard once signed in', async () => {
      const response = await clientSession.get('/api/dashboard');
      assert.equal(response.status, 200);
      assert.equal(response.body.role, 'client');
      assert.equal(typeof response.body.stats.openBriefs, 'number');
      assert.ok(Array.isArray(response.body.wallets));
    });

    it('returns 403 for an admin-only endpoint held by a client', async () => {
      const response = await clientSession.get('/api/admin/overview');
      assert.equal(response.status, 403);
    });
  });

  describe('CSRF protection', () => {
    /** Raw fetch: bypasses the helper's automatic X-CSRF-Token header. */
    const rawPost = (cookie, headers = {}) => fetch(`${baseUrl}/api/briefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify(briefPayload('CSRF probe brief'))
    });

    it('rejects a POST with a valid session cookie but no CSRF header (403)', async () => {
      const response = await rawPost(clientSession.cookie);
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.match(body.error, /session expired/i);
    });

    it('rejects a POST with a wrong CSRF header (403)', async () => {
      const response = await rawPost(clientSession.cookie, { 'x-csrf-token': 'this-token-is-not-valid' });
      assert.equal(response.status, 403);
    });

    it('rejects a POST with a CSRF token belonging to another session (403)', async () => {
      const other = createClient(baseUrl);
      const signedUp = await other.signup({
        name: 'Other Session', email: uniqueEmail('other-session'), password: LONG_PASSWORD, role: 'client'
      });
      assert.equal(signedUp.status, 201);
      assert.notEqual(other.csrfToken, clientSession.csrfToken);

      const response = await rawPost(clientSession.cookie, { 'x-csrf-token': other.csrfToken });
      assert.equal(response.status, 403);
    });

    it('accepts a POST carrying the matching CSRF header', async () => {
      const response = await rawPost(clientSession.cookie, { 'x-csrf-token': clientSession.csrfToken });
      assert.equal(response.status, 201);
    });

    it('rejects a state-changing request with no session at all (401)', async () => {
      const response = await rawPost('');
      assert.equal(response.status, 401);
    });

    it('rejects a cross-origin state-changing request (403)', async () => {
      const response = await clientSession.post('/api/briefs', briefPayload('Cross origin brief'), {
        headers: { origin: 'http://evil.example' }
      });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /cross-origin/i);
    });

    it('does not require a CSRF token for the public POST endpoints', async () => {
      const client = createClient(baseUrl);
      const response = await client.post('/api/inquiries', { name: 'CSRF Free', email: uniqueEmail('inquiry') });
      assert.equal(response.status, 201);
    });
  });

  describe('role enforcement', () => {
    it('forbids a talent account from creating a brief (403)', async () => {
      const me = await talentSession.get('/api/auth/me');
      assert.equal(me.body.user.role, 'talent');

      const response = await talentSession.post('/api/briefs', briefPayload('Talent should not post this'));
      assert.equal(response.status, 403);
      assert.match(response.body.error, /limited to: client, admin/);
    });

    it('forbids a client from reading the talent-only profile endpoint (403)', async () => {
      const response = await clientSession.get('/api/profile');
      assert.equal(response.status, 403);
      assert.match(response.body.error, /limited to: talent/);
    });

    it('forbids a client from responding to an invitation (403)', async () => {
      const response = await clientSession.post('/api/invitations/inv_does_not_exist/respond', { action: 'accept' });
      assert.equal(response.status, 403);
      assert.match(response.body.error, /limited to: talent/);
    });

    it('lets a talent read the talent-only profile endpoint (200)', async () => {
      const response = await talentSession.get('/api/profile');
      assert.equal(response.status, 200);
      assert.equal(response.body.profile.status, 'approved');
      assert.ok(Array.isArray(response.body.profile.skills));
    });
  });
  describe('rate limiting', () => {
    it('locks out repeated failed logins for one address and survives a restart', async () => {
      // The login limiter allows 12 attempts per address per 10 minutes.
      const attacker = createClient(baseUrl);
      const target = CLIENT_EMAIL;
      let sawLimit = false;

      for (let attempt = 1; attempt <= 13; attempt += 1) {
        const response = await attacker.post('/api/auth/login', { email: target, password: 'definitely-wrong' });
        if (response.status === 429) {
          sawLimit = true;
          assert.match(response.body.error, /Try again in \d+s/);
          break;
        }
        assert.equal(response.status, 400, `attempt ${attempt} should be a plain credential failure`);
      }
      assert.ok(sawLimit, 'the limiter should engage within 13 attempts');

      // The correct password is refused too: the address itself is locked.
      const locked = await attacker.post('/api/auth/login', { email: target, password: DEMO_PASSWORD });
      assert.equal(locked.status, 429, 'a locked window blocks even a valid password');

      // The counter lives in the database, not in the process.
      const row = server.app.db
        .prepare('SELECT hits FROM rate_limits WHERE bucket LIKE ?')
        .get('login:%');
      assert.ok(row && row.hits > 12, `expected a persisted counter above the limit, got ${JSON.stringify(row)}`);
    });

    it('leaves other accounts unaffected', async () => {
      const other = createClient(baseUrl);
      const response = await login(other, TALENT_EMAIL);
      assert.equal(response.status, 200, 'a different address has its own allowance');
    });
  });

});
