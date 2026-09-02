'use strict';

const { get, run, all } = require('./db');
const { id, token, hashPassword, verifyPassword, safeEqual } = require('./ids');
const { badRequest, unauthorized, forbidden, conflict, tooMany, validate } = require('./validate');

const SESSION_COOKIE = 'horizon_session';
const SESSION_DAYS = 14;
const ROLES = ['client', 'talent', 'admin'];

function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    jar[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

function sessionCookie(value, { secure, maxAge }) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Fixed-window limiter backed by the `rate_limits` table, so a restart does not
 * hand an attacker a fresh allowance. The upsert makes the whole decision in one
 * statement: a window that has expired resets to 1, otherwise the count grows.
 */
function createDbRateLimiter({ windowMs, max, name }) {
  let lastSweep = 0;

  return function check(db, key) {
    const now = Date.now();
    const bucket = `${name}:${key}`;

    // `get` (not `run`) so the RETURNING row comes back.
    const state = get(db, `
      INSERT INTO rate_limits (bucket, hits, reset_at, updated_at)
      VALUES (?, 1, ?, datetime('now'))
      ON CONFLICT(bucket) DO UPDATE SET
        hits       = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.hits + 1 END,
        reset_at   = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END,
        updated_at = datetime('now')
      RETURNING hits, reset_at
    `, [bucket, now + windowMs, now, now, now + windowMs]);

    // Sweep expired rows occasionally so the table cannot grow without bound.
    if (now - lastSweep > 60_000) {
      lastSweep = now;
      run(db, 'DELETE FROM rate_limits WHERE reset_at <= ?', [now]);
    }

    if (state.hits > max) {
      const seconds = Math.max(1, Math.ceil((state.reset_at - now) / 1000));
      throw tooMany(`Too many attempts. Try again in ${seconds}s.`);
    }
  };
}

const loginLimiter = createDbRateLimiter({ windowMs: 10 * 60 * 1000, max: 12, name: 'login' });
const signupLimiter = createDbRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, name: 'signup' });

function createSession(db, user, userAgent) {
  const sessionId = token(32);
  const csrf = token(24);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  run(db, `INSERT INTO sessions (id, user_id, csrf_token, user_agent, expires_at)
           VALUES (?, ?, ?, ?, ?)`, [sessionId, user.id, csrf, String(userAgent || '').slice(0, 200), expires]);
  run(db, `UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, [user.id]);
  return { sessionId, csrf, expires };
}

function destroySession(db, sessionId) {
  if (sessionId) run(db, 'DELETE FROM sessions WHERE id = ?', [sessionId]);
}

/** Resolves the current user from the request cookie, or null. */
function currentSession(db, request) {
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  const row = get(db, `SELECT s.id AS session_id, s.csrf_token, s.expires_at,
                              u.id, u.email, u.name, u.role, u.company, u.avatar_hue
                       FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.id = ?`, [sessionId]);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(db, sessionId);
    return null;
  }
  return {
    sessionId: row.session_id,
    csrf: row.csrf_token,
    user: {
      id: row.id, email: row.email, name: row.name,
      role: row.role, company: row.company, avatarHue: row.avatar_hue
    }
  };
}

/** Rejects state-changing requests whose CSRF header does not match the session. */
function assertCsrf(session, request) {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  if (!session) throw unauthorized();
  const header = request.headers['x-csrf-token'];
  if (!header || !safeEqual(header, session.csrf)) throw forbidden('Your session expired. Reload the page and try again.');
}

function requireUser(session) {
  if (!session) throw unauthorized();
  return session.user;
}

function requireRole(session, ...roles) {
  const user = requireUser(session);
  if (!roles.includes(user.role)) throw forbidden(`This action is limited to: ${roles.join(', ')}.`);
  return user;
}

function signup(db, body, userAgent) {
  const data = validate(body, {
    name: { type: 'string', required: true, min: 2, max: 80 },
    email: { type: 'email', required: true, max: 160 },
    password: { type: 'string', required: true, min: 10, max: 200, trim: false },
    role: { type: 'enum', required: true, values: ['client', 'talent'] },
    company: { type: 'string', max: 120, default: '' }
  });
  signupLimiter(db, `signup:${data.email}`);

  const existing = get(db, 'SELECT id FROM users WHERE email = ?', [data.email.toLowerCase()]);
  if (existing) throw conflict('An account with that email already exists.');

  const userId = id('usr');
  run(db, `INSERT INTO users (id, email, password_hash, name, role, company, avatar_hue)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, data.email.toLowerCase(), hashPassword(data.password), data.name, data.role, data.company,
      Math.floor(Math.random() * 360)]);

  if (data.role === 'talent') {
    run(db, 'INSERT INTO talent_profiles (user_id) VALUES (?)', [userId]);
  }
  run(db, `INSERT INTO wallets (user_id, asset, network, available, in_escrow)
           VALUES (?, 'USDC', 'Base', ?, 0)`, [userId, data.role === 'client' ? 25000 : 0]);
  run(db, `INSERT INTO notifications (id, user_id, kind, title, body, link)
           VALUES (?, ?, 'info', ?, ?, ?)`,
    [id('ntf'), userId, 'Welcome to Horizon',
      data.role === 'talent' ? 'Complete your profile so we can match you with briefs.'
        : 'Post your first brief to see curated matches.',
      data.role === 'talent' ? '/app/profile.html' : '/app/briefs.html']);

  const user = get(db, 'SELECT id, email, name, role, company, avatar_hue AS avatarHue FROM users WHERE id = ?', [userId]);
  const session = createSession(db, user, userAgent);
  return { user, session };
}

function login(db, body, userAgent, clientKey) {
  const data = validate(body, {
    email: { type: 'email', required: true },
    password: { type: 'string', required: true, trim: false }
  });
  loginLimiter(db, `login:${clientKey}:${data.email}`);

  const row = get(db, 'SELECT * FROM users WHERE email = ?', [data.email.toLowerCase()]);
  // Always run a hash comparison so failures cost the same as successes.
  const ok = verifyPassword(data.password, row ? row.password_hash : hashPassword('placeholder-value'));
  if (!row || !ok) throw badRequest('That email and password combination is not correct.');

  const user = { id: row.id, email: row.email, name: row.name, role: row.role, company: row.company, avatarHue: row.avatar_hue };
  const session = createSession(db, user, userAgent);
  return { user, session };
}

function changePassword(db, user, body) {
  const data = validate(body, {
    current_password: { type: 'string', required: true, trim: false },
    new_password: { type: 'string', required: true, min: 10, max: 200, trim: false }
  });
  const row = get(db, 'SELECT password_hash FROM users WHERE id = ?', [user.id]);
  if (!verifyPassword(data.current_password, row.password_hash)) {
    throw badRequest('Your current password is not correct.');
  }
  run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(data.new_password), user.id]);
  run(db, 'DELETE FROM sessions WHERE user_id = ?', [user.id]);
  return { ok: true };
}

const activeSessions = (db, userId) =>
  all(db, 'SELECT id, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC', [userId]);

module.exports = {
  SESSION_COOKIE, SESSION_DAYS, ROLES,
  parseCookies, sessionCookie, currentSession, createSession, destroySession,
  assertCsrf, requireUser, requireRole,
  signup, login, changePassword, activeSessions, createDbRateLimiter
};
