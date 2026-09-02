'use strict';

/**
 * Pure unit tests — no HTTP server, no database.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { SRC } = require('./helpers');

const { validate, HttpError } = require(path.join(SRC, 'validate'));
const { hashPassword, verifyPassword, id, token } = require(path.join(SRC, 'ids'));
const { Router } = require(path.join(SRC, 'router'));
const { scoreTalent } = require(path.join(SRC, 'matching'));

describe('validate()', () => {
  it('returns a cleaned object for valid input', () => {
    const data = validate(
      { name: '  Ada Lovelace  ', email: 'ADA@example.com', role: 'client' },
      {
        name: { type: 'string', required: true, min: 2, max: 80 },
        email: { type: 'email', required: true },
        role: { type: 'enum', required: true, values: ['client', 'talent'] }
      }
    );
    assert.deepEqual(data, { name: 'Ada Lovelace', email: 'ADA@example.com', role: 'client' });
  });

  it('throws HttpError(400) with per-field details for missing required fields', () => {
    let error;
    try {
      validate({}, { name: { type: 'string', required: true }, email: { type: 'email', required: true } });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof HttpError, 'expected an HttpError');
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Please correct the highlighted fields.');
    assert.equal(typeof error.details, 'object');
    assert.equal(error.details.name, 'Name is required.');
    assert.equal(error.details.email, 'Email is required.');
  });

  it('rejects strings shorter than min and longer than max', () => {
    assert.throws(
      () => validate({ headline: 'ab' }, { headline: { type: 'string', min: 6 } }),
      (error) => error.status === 400 && error.details.headline === 'Headline must be at least 6 characters.'
    );
    assert.throws(
      () => validate({ headline: 'abcdefghij' }, { headline: { type: 'string', max: 4 } }),
      (error) => error.status === 400 && error.details.headline === 'Headline must be 4 characters or fewer.'
    );
  });

  it('rejects malformed email addresses and accepts well-formed ones', () => {
    for (const bad of ['nope', 'a@b', 'a b@example.com', '@example.com']) {
      assert.throws(
        () => validate({ email: bad }, { email: { type: 'email', required: true } }),
        (error) => error.status === 400 && error.details.email === 'Enter a valid email address.',
        `expected ${bad} to be rejected`
      );
    }
    assert.equal(validate({ email: 'dev@horizon.test' }, { email: { type: 'email' } }).email, 'dev@horizon.test');
  });

  it('rejects values outside an enum and lists the allowed values', () => {
    assert.throws(
      () => validate({ start_window: 'someday' }, { start_window: { type: 'enum', values: ['this_week', 'flexible'] } }),
      (error) => error.details.start_window === 'Start window must be one of: this_week, flexible.'
    );
  });

  it('coerces integers from currency-formatted strings', () => {
    assert.deepEqual(
      validate({ budget_max: '$3,000' }, { budget_max: { type: 'int', required: true } }),
      { budget_max: 3000 }
    );
    assert.deepEqual(validate({ amount: ' 42 ' }, { amount: { type: 'number' } }), { amount: 42 });
  });

  it('rejects non-numeric and non-integer numbers, and enforces numeric bounds', () => {
    assert.throws(
      () => validate({ budget_min: 'abc' }, { budget_min: { type: 'int' } }),
      (error) => error.details.budget_min === 'Budget min must be a number.'
    );
    assert.throws(
      () => validate({ budget_min: '10.5' }, { budget_min: { type: 'int' } }),
      (error) => error.details.budget_min === 'Budget min must be a whole number.'
    );
    assert.throws(
      () => validate({ rate_min: 1 }, { rate_min: { type: 'int', min: 5 } }),
      (error) => error.details.rate_min === 'Rate min must be at least 5.'
    );
    assert.throws(
      () => validate({ rate_min: 9000 }, { rate_min: { type: 'int', max: 2000 } }),
      (error) => error.details.rate_min === 'Rate min must be at most 2000.'
    );
  });

  it('applies defaults for absent, null, and empty-string fields', () => {
    const rules = { engagement: { type: 'enum', values: ['project', 'hourly'], default: 'project' } };
    assert.deepEqual(validate({}, rules), { engagement: 'project' });
    assert.deepEqual(validate({ engagement: null }, rules), { engagement: 'project' });
    assert.deepEqual(validate({ engagement: '' }, rules), { engagement: 'project' });
  });

  it('omits optional fields that have no default', () => {
    const data = validate({}, { company: { type: 'string', max: 120 } });
    assert.deepEqual(data, {});
    assert.equal('company' in data, false);
  });

  it('honours trim: false so passwords keep their whitespace', () => {
    assert.equal(validate({ password: '  spaced pw  ' }, { password: { type: 'string', trim: false } }).password, '  spaced pw  ');
    assert.equal(validate({ password: '  spaced pw  ' }, { password: { type: 'string' } }).password, 'spaced pw');
  });

  it('normalises stringArray input and enforces its minimum length', () => {
    assert.deepEqual(
      validate({ skills: 'React, Node.js ,, Next.js' }, { skills: { type: 'stringArray', required: true, min: 1 } }).skills,
      ['React', 'Node.js', 'Next.js']
    );
    assert.throws(
      () => validate({ skills: [' ', ''] }, { skills: { type: 'stringArray', required: true, min: 1 } }),
      (error) => error.status === 400 && error.details.skills === 'Select at least 1.'
    );
  });

  it('coerces booleans from the usual truthy encodings', () => {
    const rules = { verified: { type: 'boolean' } };
    assert.equal(validate({ verified: 'true' }, rules).verified, true);
    assert.equal(validate({ verified: 1 }, rules).verified, true);
    assert.equal(validate({ verified: '1' }, rules).verified, true);
    assert.equal(validate({ verified: 'no' }, rules).verified, false);
  });

  it('rejects non-object bodies outright', () => {
    for (const body of [null, [], 'string', 7]) {
      assert.throws(
        () => validate(body, { name: { type: 'string' } }),
        (error) => error instanceof HttpError && error.status === 400 && error.message === 'Expected a JSON object body.'
      );
    }
  });

  it('reports every failing field at once', () => {
    assert.throws(
      () => validate({ name: 'x', email: 'bad', budget_min: 'nope' }, {
        name: { type: 'string', required: true, min: 2 },
        email: { type: 'email', required: true },
        budget_min: { type: 'int', required: true }
      }),
      (error) => Object.keys(error.details).length === 3
    );
  });
});

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', stored), true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery stapl', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  it('produces a different hash each time (random salt)', () => {
    const first = hashPassword('same-password-twice');
    const second = hashPassword('same-password-twice');
    assert.notEqual(first, second);
    assert.equal(verifyPassword('same-password-twice', first), true);
    assert.equal(verifyPassword('same-password-twice', second), true);
  });

  it('encodes the scheme and scrypt parameters in the stored hash', () => {
    const parts = hashPassword('parameters-travel-with-hash').split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    assert.deepEqual(parts.slice(1, 4), ['16384', '8', '1']);
  });

  it('returns false — never throws — for malformed stored hashes', () => {
    for (const stored of ['', 'garbage', 'scrypt$only$three', 'bcrypt$16384$8$1$aaaa$bbbb', null, undefined, '$$$$$']) {
      assert.equal(verifyPassword('anything', stored), false, `expected false for ${String(stored)}`);
    }
  });
});

describe('ids', () => {
  it('prefixes generated ids and keeps them unique', () => {
    const first = id('usr');
    const second = id('usr');
    assert.match(first, /^usr_[0-9a-z]+$/);
    assert.notEqual(first, second);
  });

  it('emits url-safe tokens of the requested byte length', () => {
    const value = token(24);
    assert.match(value, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(value, 'base64url').length, 24);
  });
});

describe('Router.find', () => {
  const listTalent = () => 'list';
  const oneTalent = () => 'one';
  const patchTalent = () => 'patch';

  const router = new Router()
    .get('/api/talent', listTalent)
    .get('/api/talent/:userId', oneTalent)
    .patch('/api/talent/:userId', patchTalent);

  it('matches an exact static path with no params', () => {
    const match = router.find('GET', '/api/talent');
    assert.equal(match.handler, listTalent);
    assert.deepEqual(match.params, {});
  });

  it('extracts and URL-decodes :param segments', () => {
    const match = router.find('GET', '/api/talent/usr%20123');
    assert.equal(match.handler, oneTalent);
    assert.deepEqual(match.params, { userId: 'usr 123' });
  });

  it('dispatches the same path to different handlers per method', () => {
    assert.equal(router.find('PATCH', '/api/talent/usr_1').handler, patchTalent);
    assert.equal(router.find('GET', '/api/talent/usr_1').handler, oneTalent);
  });

  it('returns null when nothing matches', () => {
    assert.equal(router.find('GET', '/api/nope'), null);
    assert.equal(router.find('GET', '/api/talent/usr_1/extra'), null);
  });

  it('returns { allowed } and no handler when only the method is wrong', () => {
    const match = router.find('DELETE', '/api/talent/usr_1');
    assert.ok(match, 'expected a path-only match object');
    assert.equal(match.handler, undefined);
    assert.ok(Array.isArray(match.allowed));
    assert.deepEqual([...match.allowed].sort(), ['GET', 'PATCH']);
  });

  it('ignores empty segments from leading and trailing slashes', () => {
    assert.equal(router.find('GET', '/api/talent/').handler, listTalent);
  });
});

describe('scoreTalent()', () => {
  const brief = {
    skills: ['React', 'Node.js'],
    category: 'Web development',
    budget_min: 3000,
    budget_max: 5000,
    asset: 'USDC',
    network: 'Base',
    start_window: 'this_week',
    engagement: 'project'
  };

  const talent = {
    skills: ['React', 'Node.js'],
    availability: 'available_now',
    rate_min: 80,
    rate_max: 120,
    rating: 4.9,
    reviews_count: 18,
    verified: 1,
    payout_asset: 'USDC',
    payout_network: 'Base'
  };

  it('scores full skill overlap higher than partial overlap', () => {
    const full = scoreTalent(brief, talent);
    const partial = scoreTalent(brief, { ...talent, skills: ['React'] });
    assert.ok(full.score > partial.score, `${full.score} should beat ${partial.score}`);
    assert.equal(full.breakdown.skills, 40);
    assert.equal(partial.breakdown.skills, 20);
    assert.deepEqual(full.matchedSkills, ['React', 'Node.js']);
    assert.deepEqual(partial.matchedSkills, ['React']);
  });

  it('awards zero skill points when nothing overlaps', () => {
    const none = scoreTalent(brief, { ...talent, skills: ['Solidity'] });
    assert.equal(none.breakdown.skills, 0);
    assert.deepEqual(none.matchedSkills, []);
    assert.ok(
      none.reasons.some((reason) => /no overlap|no exact skill overlap/i.test(reason)),
      `expected a "no overlap" reason, got ${JSON.stringify(none.reasons)}`
    );
  });

  it('gates the total for a candidate with none of the required skills', () => {
    const none = scoreTalent(brief, { ...talent, skills: ['Solidity'] });
    const some = scoreTalent(brief, { ...talent, skills: ['React'] });
    assert.equal(none.relevanceGated, true, 'no overlap on a skilled brief is ranked down');
    assert.equal(some.relevanceGated, false);

    const subtotal = Object.values(none.breakdown).reduce((total, value) => total + value, 0);
    assert.ok(none.score < subtotal, 'the gate must reduce the raw subtotal');
    assert.ok(none.score < some.score, 'a gated candidate cannot outrank one with overlap');
    assert.ok(none.reasons.some((reason) => /ranked down/i.test(reason)), 'the gate is explained in reasons');
  });

  it('does not gate a brief that names no required skills', () => {
    const result = scoreTalent({ ...brief, skills: [] }, { ...talent, skills: ['Solidity'] });
    assert.equal(result.relevanceGated, false);
    const subtotal = Object.values(result.breakdown).reduce((total, value) => total + value, 0);
    assert.equal(result.score, Math.min(100, subtotal));
  });

  it('gives an unavailable talent 0 availability points', () => {
    const result = scoreTalent(brief, { ...talent, availability: 'unavailable' });
    assert.equal(result.breakdown.availability, 0);
    assert.equal(scoreTalent(brief, talent).breakdown.availability, 20);
  });

  it('tapers availability points as the start gap widens', () => {
    assert.equal(scoreTalent(brief, { ...talent, availability: 'two_weeks' }).breakdown.availability, 12);
    assert.equal(scoreTalent(brief, { ...talent, availability: 'next_month' }).breakdown.availability, 6);
  });

  it('gives the full 10 settlement points on an exact asset+network match', () => {
    const exact = scoreTalent(brief, talent);
    assert.equal(exact.breakdown.settlement, 10);
    assert.ok(exact.reasons.includes('Already settles in USDC on Base'));

    assert.equal(scoreTalent(brief, { ...talent, payout_network: 'Solana' }).breakdown.settlement, 7);
    assert.equal(scoreTalent(brief, { ...talent, payout_asset: 'ETH', payout_network: 'Ethereum' }).breakdown.settlement, 4);
  });

  it('scores budget fit from the implied hourly rate', () => {
    assert.equal(scoreTalent(brief, { ...talent, rate_min: 80 }).breakdown.budget, 15);
    assert.equal(scoreTalent(brief, { ...talent, rate_min: 140 }).breakdown.budget, 9);
    assert.equal(scoreTalent(brief, { ...talent, rate_min: 400 }).breakdown.budget, 3);
  });

  it('falls back to category affinity when the brief lists no skills', () => {
    const briefNoSkills = { ...brief, skills: [] };
    assert.equal(scoreTalent(briefNoSkills, { ...talent, category: 'Web development' }).breakdown.skills, 28);
    assert.equal(scoreTalent(briefNoSkills, { ...talent, category: 'Web3' }).breakdown.skills, 18);
  });

  it('caps reputation at 15 and the total score at 0..100', () => {
    const best = scoreTalent(brief, { ...talent, rating: 5, reviews_count: 500, verified: 1, rate_min: 5 });
    assert.equal(best.breakdown.reputation, 15);
    assert.ok(best.score <= 100, 'score must be clamped at 100');
    assert.equal(best.score, 100);

    const worst = scoreTalent(brief, {
      skills: [], availability: 'unavailable', rate_min: 9999, rating: 0,
      reviews_count: 0, verified: 0, payout_asset: 'BTC', payout_network: 'Bank'
    });
    assert.ok(worst.score >= 0, 'score must be clamped at 0');
    assert.ok(worst.score <= 100);
  });

  it('always returns a non-empty reasons array', () => {
    for (const candidate of [talent, { ...talent, skills: [] }, { ...talent, availability: 'unavailable' }]) {
      const result = scoreTalent(brief, candidate);
      assert.ok(Array.isArray(result.reasons));
      assert.ok(result.reasons.length > 0, 'reasons should explain the score');
      for (const reason of result.reasons) assert.equal(typeof reason, 'string');
    }
  });

  it('reports a breakdown whose components sum to the score', () => {
    const result = scoreTalent(brief, { ...talent, skills: ['React'], availability: 'two_weeks' });
    const sum = Object.values(result.breakdown).reduce((total, value) => total + value, 0);
    assert.equal(sum, result.score);
    assert.deepEqual(Object.keys(result.breakdown).sort(), ['availability', 'budget', 'reputation', 'settlement', 'skills']);
  });

  it('is deterministic for identical inputs', () => {
    assert.deepEqual(scoreTalent(brief, talent), scoreTalent(brief, talent));
  });
});

describe('createDbRateLimiter', () => {
  const { openDatabase, get } = require(path.join(SRC, 'db'));
  const { createDbRateLimiter } = require(path.join(SRC, 'auth'));

  /** A fresh in-memory database per limiter so counters never leak between tests. */
  const fixture = ({ max = 3, windowMs = 60_000 } = {}) => ({
    db: openDatabase(':memory:'),
    check: createDbRateLimiter({ windowMs, max, name: 'test' })
  });

  it('allows exactly `max` attempts, then throws 429', () => {
    const { db, check } = fixture({ max: 3 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      assert.doesNotThrow(() => check(db, 'a'), `attempt ${attempt} should pass`);
    }
    assert.throws(() => check(db, 'a'), (error) => error instanceof HttpError && error.status === 429);
    db.close();
  });

  it('reports how long the caller has to wait', () => {
    const { db, check } = fixture({ max: 1, windowMs: 30_000 });
    check(db, 'a');
    assert.throws(() => check(db, 'a'), (error) => /Try again in \d+s/.test(error.message));
    db.close();
  });

  it('keeps separate keys independent', () => {
    const { db, check } = fixture({ max: 1 });
    check(db, 'first');
    assert.throws(() => check(db, 'first'));
    assert.doesNotThrow(() => check(db, 'second'), 'a different key has its own allowance');
    db.close();
  });

  it('persists its counter, so a new limiter instance sees prior attempts', () => {
    const db = openDatabase(':memory:');
    const first = createDbRateLimiter({ windowMs: 60_000, max: 2, name: 'test' });
    first(db, 'a');
    first(db, 'a');

    // Simulates a process restart: same database, brand-new limiter closure.
    const second = createDbRateLimiter({ windowMs: 60_000, max: 2, name: 'test' });
    assert.throws(() => second(db, 'a'), (error) => error.status === 429,
      'a restart must not hand out a fresh allowance');
    db.close();
  });

  it('resets once the window has passed', () => {
    const db = openDatabase(':memory:');
    const check = createDbRateLimiter({ windowMs: 60_000, max: 1, name: 'test' });
    check(db, 'a');
    assert.throws(() => check(db, 'a'));

    // Expire the window by hand rather than waiting a minute.
    db.prepare('UPDATE rate_limits SET reset_at = ? WHERE bucket = ?').run(Date.now() - 1000, 'test:a');
    assert.doesNotThrow(() => check(db, 'a'), 'an expired window starts over');
    assert.equal(get(db, 'SELECT hits FROM rate_limits WHERE bucket = ?', ['test:a']).hits, 1);
    db.close();
  });

  it('namespaces buckets by limiter name', () => {
    const db = openDatabase(':memory:');
    const login = createDbRateLimiter({ windowMs: 60_000, max: 1, name: 'login' });
    const signup = createDbRateLimiter({ windowMs: 60_000, max: 1, name: 'signup' });
    login(db, 'same-key');
    assert.doesNotThrow(() => signup(db, 'same-key'), 'different limiters do not share a counter');
    assert.throws(() => login(db, 'same-key'));
    db.close();
  });
});

describe('schema migration', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { DatabaseSync } = require('node:sqlite');
  const { openDatabase, all, get } = require(path.join(SRC, 'db'));

  /**
   * Writes a database shaped like the pre-dispute release: narrow CHECK
   * constraints, and no `disputes` or `rate_limits` table. A file is required —
   * the whole point is upgrading a database that already exists on disk.
   */
  function legacyDatabase() {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-migrate-')), 'horizon.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
        description TEXT DEFAULT '', amount REAL NOT NULL, due_date TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','funded','submitted','paid')),
        legacy_note TEXT, created_at TEXT DEFAULT (datetime('now')));
      CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, milestone_id TEXT,
        payer_id TEXT NOT NULL, payee_id TEXT NOT NULL,
        amount REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, asset TEXT NOT NULL, network TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('escrow_funded','released','refunded')),
        settled_at TEXT, created_at TEXT DEFAULT (datetime('now')));
    `);
    db.prepare(`INSERT INTO milestones (id, project_id, position, title, amount, status, legacy_note)
                VALUES ('m1', 'p1', 1, 'Legacy milestone', 500, 'submitted', 'keep me')`).run();
    db.prepare(`INSERT INTO payments (id, project_id, milestone_id, payer_id, payee_id, amount, fee, asset, network, status)
                VALUES ('pay1', 'p1', 'm1', 'u1', 'u2', 500, 15, 'USDC', 'Base', 'escrow_funded')`).run();
    db.close();
    return file;
  }

  it('widens the CHECK constraints an older database was created with', () => {
    const file = legacyDatabase();
    const db = openDatabase(file);

    const milestoneDdl = get(db, `SELECT sql FROM sqlite_master WHERE name = 'milestones'`).sql;
    assert.match(milestoneDdl, /'disputed'/);
    assert.match(milestoneDdl, /'resolved'/);
    assert.match(get(db, `SELECT sql FROM sqlite_master WHERE name = 'payments'`).sql, /'split'/);

    // The widened constraint has to actually accept the new value.
    assert.doesNotThrow(() => db.prepare(`UPDATE milestones SET status = 'disputed' WHERE id = 'm1'`).run());
    assert.doesNotThrow(() => db.prepare(`UPDATE payments SET status = 'split' WHERE id = 'pay1'`).run());
    assert.throws(() => db.prepare(`UPDATE milestones SET status = 'nonsense' WHERE id = 'm1'`).run(),
      'the constraint is widened, not removed');

    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('preserves rows, restores indexes, and leaves foreign keys enforced', () => {
    const file = legacyDatabase();
    const db = openDatabase(file);

    const milestone = get(db, `SELECT title, amount, status FROM milestones WHERE id = 'm1'`);
    assert.equal(milestone.title, 'Legacy milestone');
    assert.equal(milestone.amount, 500);
    assert.equal(milestone.status, 'submitted');
    assert.equal(get(db, `SELECT fee FROM payments WHERE id = 'pay1'`).fee, 15);

    assert.ok(get(db, `SELECT name FROM sqlite_master WHERE name = 'idx_milestones_project'`),
      'an index dropped with the rebuilt table must come back');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1,
      'the rebuild must not leave foreign keys switched off');

    // The tables added in this release are created, not migrated.
    const tables = all(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .map((row) => row.name);
    assert.ok(tables.includes('disputes'));
    assert.ok(tables.includes('rate_limits'));

    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('is idempotent: reopening changes nothing', () => {
    const file = legacyDatabase();
    const first = openDatabase(file);
    const before = all(first, `SELECT name, sql FROM sqlite_master ORDER BY name`);
    first.close();

    const second = openDatabase(file);
    const after = all(second, `SELECT name, sql FROM sqlite_master ORDER BY name`);
    assert.deepEqual(after, before, 'a second open must not rebuild anything');
    assert.equal(get(second, `SELECT title FROM milestones WHERE id = 'm1'`).title, 'Legacy milestone');
    second.close();

    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('drops a column the current schema no longer has, and defaults one it added', () => {
    const file = legacyDatabase();
    const db = openDatabase(file);

    const columns = all(db, `SELECT name FROM pragma_table_info('milestones')`).map((row) => row.name);
    assert.ok(!columns.includes('legacy_note'), 'a column absent from the current schema is dropped');

    // tx_ref is NOT NULL DEFAULT '' in the current schema and absent from the old
    // payments table, so the copy has to rely on the default.
    assert.equal(get(db, `SELECT tx_ref FROM payments WHERE id = 'pay1'`).tx_ref, '');

    db.close();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  });

  it('refuses to migrate when a required new column cannot be filled', () => {
    // A payments table missing payer_id, which is NOT NULL with no default.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-bad-'));
    const file = path.join(dir, 'horizon.db');
    const seedDb = new DatabaseSync(file);
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, amount REAL NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('escrow_funded','released','refunded')));
    `);
    seedDb.prepare(`INSERT INTO payments (id, project_id, amount, status) VALUES ('p','p1',1,'released')`).run();
    seedDb.close();

    assert.throws(() => openDatabase(file), /payer_id|payee_id/,
      'the failure should name the column, not surface a bare constraint error');

    // The original table must survive a refused migration intact.
    const check = new DatabaseSync(file);
    assert.equal(check.prepare(`SELECT count(*) AS n FROM payments`).get().n, 1);
    check.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does nothing to a database created by the current schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-fresh-'));
    const file = path.join(dir, 'horizon.db');
    const first = openDatabase(file);
    const before = all(first, `SELECT name, sql FROM sqlite_master ORDER BY name`);
    first.close();

    const second = openDatabase(file);
    assert.deepEqual(all(second, `SELECT name, sql FROM sqlite_master ORDER BY name`), before);
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A table whose CHECK constraints are already current does not get rebuilt, so
   * a newly added column has to arrive by ALTER TABLE and be backfilled from the
   * rows already there.
   */
  describe('added columns', () => {
    /** A payments table with the widened CHECK but no settled_amount. */
    function beforeSettledAmount() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horizon-column-'));
      const file = path.join(dir, 'horizon.db');
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE IF NOT EXISTS milestones (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, position INTEGER NOT NULL, title TEXT NOT NULL,
          description TEXT DEFAULT '', amount REAL NOT NULL, due_date TEXT,
          status TEXT NOT NULL DEFAULT 'planned'
            CHECK (status IN ('planned','funded','submitted','approved','disputed','resolved','paid')),
          created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, milestone_id TEXT,
          payer_id TEXT NOT NULL, payee_id TEXT NOT NULL,
          amount REAL NOT NULL, fee REAL NOT NULL DEFAULT 0, asset TEXT NOT NULL, network TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('escrow_funded','released','refunded','split')),
          tx_ref TEXT NOT NULL DEFAULT '', settled_at TEXT, created_at TEXT DEFAULT (datetime('now')));
        CREATE TABLE IF NOT EXISTS disputes (
          id TEXT PRIMARY KEY, milestone_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
          raised_by TEXT NOT NULL, reason TEXT NOT NULL, desired TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open', outcome TEXT, talent_share REAL,
          created_at TEXT DEFAULT (datetime('now')));
      `);
      const insert = `INSERT INTO payments (id, project_id, milestone_id, payer_id, payee_id, amount, fee, asset, network, status)
                      VALUES (?, 'p1', ?, 'u1', 'u2', ?, ?, 'USDC', 'Base', ?)`;
      db.prepare(insert).run('pay-released', 'm1', 800, 24, 'released');
      db.prepare(insert).run('pay-split', 'm2', 1000, 30, 'split');
      db.prepare(insert).run('pay-escrow', 'm3', 500, 15, 'escrow_funded');
      db.prepare(insert).run('pay-refunded', 'm4', 400, 12, 'refunded');
      db.prepare(`INSERT INTO disputes (id, milestone_id, project_id, raised_by, reason, desired, status, outcome, talent_share)
                  VALUES ('d1', 'm2', 'p1', 'u2', 'a reason', 'split', 'resolved', 'split', 620)`).run();
      db.close();
      return file;
    }

    it('adds settled_amount without rebuilding the table', () => {
      const file = beforeSettledAmount();
      const db = openDatabase(file);

      const columns = all(db, `SELECT name FROM pragma_table_info('payments')`).map((row) => row.name);
      assert.ok(columns.includes('settled_amount'), 'the new column should be added');
      assert.equal(get(db, `SELECT count(*) AS n FROM payments`).n, 4, 'every row survives');

      db.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it('backfills settled_amount from the status and the arbitrated share', () => {
      const file = beforeSettledAmount();
      const db = openDatabase(file);

      const settled = (id) => get(db, `SELECT settled_amount FROM payments WHERE id = ?`, [id]).settled_amount;
      assert.equal(settled('pay-released'), 800, 'a release settled its full amount');
      assert.equal(settled('pay-split'), 620, 'a split settled the arbitrated share, not the amount');
      assert.equal(settled('pay-escrow'), 0, 'escrowed money has not settled');
      assert.equal(settled('pay-refunded'), 0, 'a refund settled nothing to the payee');

      db.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });

    it('does not backfill a second time when reopened', () => {
      const file = beforeSettledAmount();
      const first = openDatabase(file);
      // A later release on the same row must not be reverted by the backfill.
      first.prepare(`UPDATE payments SET settled_amount = 111 WHERE id = 'pay-released'`).run();
      first.close();

      const second = openDatabase(file);
      assert.equal(get(second, `SELECT settled_amount FROM payments WHERE id = 'pay-released'`).settled_amount, 111,
        'the backfill runs once, when the column is added');
      second.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    });
  });
});
