'use strict';

const auth = require('../auth');
const { validate } = require('../validate');
const { get, run } = require('../db');
const { created, audit } = require('../http');

/**
 * Session lifecycle. Routes here are the only ones allowed to run without a
 * session, and each one sets or clears the session cookie via ApiResponse headers.
 */
function register(router) {
  router.post('/api/auth/signup', ({ db, body, request, setSession }) => {
    const { user, session } = auth.signup(db, body, request.headers['user-agent']);
    setSession(session);
    audit(db, user.id, 'auth.signup', 'user', user.id, { role: user.role });
    return created({ user, csrfToken: session.csrf });
  });

  router.post('/api/auth/login', ({ db, body, request, setSession, clientKey }) => {
    const { user, session } = auth.login(db, body, request.headers['user-agent'], clientKey);
    setSession(session);
    audit(db, user.id, 'auth.login', 'user', user.id, {});
    return { user, csrfToken: session.csrf };
  });

  router.post('/api/auth/logout', ({ db, session, clearSession }) => {
    if (session) {
      auth.destroySession(db, session.sessionId);
      audit(db, session.user.id, 'auth.logout', 'user', session.user.id, {});
    }
    clearSession();
    return { ok: true };
  });

  router.get('/api/auth/me', ({ db, session }) => {
    if (!session) return { user: null, csrfToken: null };
    const wallets = db.prepare('SELECT asset, network, available, in_escrow FROM wallets WHERE user_id = ?').all(session.user.id);
    const unread = get(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [session.user.id]).n;
    const profile = session.user.role === 'talent'
      ? get(db, 'SELECT status, availability, rating, reviews_count FROM talent_profiles WHERE user_id = ?', [session.user.id])
      : null;
    return { user: session.user, csrfToken: session.csrf, wallets, unreadNotifications: unread, profile };
  });

  router.get('/api/auth/sessions', ({ db, session }) => {
    const user = auth.requireUser(session);
    return { sessions: auth.activeSessions(db, user.id), current: session.sessionId };
  });

  router.post('/api/auth/password', ({ db, session, body, clearSession }) => {
    const user = auth.requireUser(session);
    const result = auth.changePassword(db, user, body);
    clearSession();
    audit(db, user.id, 'auth.password_changed', 'user', user.id, {});
    return result;
  });

  router.patch('/api/account', ({ db, session, body }) => {
    const user = auth.requireUser(session);
    const data = validate(body, {
      name: { type: 'string', min: 2, max: 80 },
      company: { type: 'string', max: 120 }
    });
    if (data.name !== undefined) run(db, 'UPDATE users SET name = ? WHERE id = ?', [data.name, user.id]);
    if (data.company !== undefined) run(db, 'UPDATE users SET company = ? WHERE id = ?', [data.company, user.id]);
    return get(db, 'SELECT id, email, name, role, company, avatar_hue AS avatarHue FROM users WHERE id = ?', [user.id]);
  });
}

module.exports = { register };
