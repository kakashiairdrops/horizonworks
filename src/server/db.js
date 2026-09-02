'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('client', 'talent', 'admin')),
  company       TEXT,
  avatar_hue    INTEGER NOT NULL DEFAULT 82,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS skills (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS talent_profiles (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline        TEXT NOT NULL DEFAULT '',
  bio             TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  rate_min        INTEGER NOT NULL DEFAULT 0,
  rate_max        INTEGER NOT NULL DEFAULT 0,
  availability    TEXT NOT NULL DEFAULT 'available_now'
                  CHECK (availability IN ('available_now', 'two_weeks', 'next_month', 'unavailable')),
  weekly_capacity INTEGER NOT NULL DEFAULT 20,
  payout_asset    TEXT NOT NULL DEFAULT 'USDC',
  payout_network  TEXT NOT NULL DEFAULT 'Base',
  wallet_address  TEXT NOT NULL DEFAULT '',
  portfolio_url   TEXT NOT NULL DEFAULT '',
  years_experience INTEGER NOT NULL DEFAULT 0,
  rating          REAL NOT NULL DEFAULT 0,
  reviews_count   INTEGER NOT NULL DEFAULT 0,
  jobs_completed  INTEGER NOT NULL DEFAULT 0,
  verified        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS talent_skills (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  level    INTEGER NOT NULL DEFAULT 3,
  PRIMARY KEY (user_id, skill_id)
);

CREATE TABLE IF NOT EXISTS briefs (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT 'Web development',
  budget_min   INTEGER NOT NULL DEFAULT 0,
  budget_max   INTEGER NOT NULL DEFAULT 0,
  asset        TEXT NOT NULL DEFAULT 'USDC',
  network      TEXT NOT NULL DEFAULT 'Base',
  start_window TEXT NOT NULL DEFAULT 'this_week'
               CHECK (start_window IN ('this_week', 'two_weeks', 'flexible')),
  engagement   TEXT NOT NULL DEFAULT 'project'
               CHECK (engagement IN ('project', 'retainer', 'hourly')),
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('draft', 'open', 'matched', 'closed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_briefs_client ON briefs(client_id);

CREATE TABLE IF NOT EXISTS brief_skills (
  brief_id TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (brief_id, skill_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id         TEXT PRIMARY KEY,
  brief_id   TEXT NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  talent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL DEFAULT 0,
  message    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'sent'
             CHECK (status IN ('sent', 'accepted', 'declined', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (brief_id, talent_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  brief_id   TEXT REFERENCES briefs(id) ON DELETE SET NULL,
  client_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  talent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  asset      TEXT NOT NULL DEFAULT 'USDC',
  network    TEXT NOT NULL DEFAULT 'Base',
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'in_review', 'completed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_projects_talent ON projects(talent_id);

CREATE TABLE IF NOT EXISTS milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 1,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount      REAL NOT NULL DEFAULT 0,
  due_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'planned'
              CHECK (status IN ('planned', 'funded', 'submitted', 'approved', 'disputed', 'resolved', 'paid')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  attachment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

CREATE TABLE IF NOT EXISTS wallets (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset     TEXT NOT NULL,
  network   TEXT NOT NULL,
  available REAL NOT NULL DEFAULT 0,
  in_escrow REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, asset, network)
);

CREATE TABLE IF NOT EXISTS payments (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
  payer_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payee_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount       REAL NOT NULL,
  fee          REAL NOT NULL DEFAULT 0,
  -- What actually reached the payee. Equal to the amount on a full release, the
  -- arbitrated share on a split, and 0 while escrowed or after a refund. Money
  -- reporting sums this column, never amount, so a split cannot overstate earnings.
  settled_amount REAL NOT NULL DEFAULT 0,
  asset        TEXT NOT NULL,
  network      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'escrow_funded'
               CHECK (status IN ('escrow_funded', 'released', 'refunded', 'split')),
  tx_ref       TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_project ON payments(project_id);

-- A submitted milestone the client will not release goes here for admin arbitration.
CREATE TABLE IF NOT EXISTS disputes (
  id            TEXT PRIMARY KEY,
  milestone_id  TEXT NOT NULL UNIQUE REFERENCES milestones(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  raised_by     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,
  desired       TEXT NOT NULL DEFAULT 'refund'
                CHECK (desired IN ('release', 'refund', 'split')),
  response      TEXT NOT NULL DEFAULT '',
  responded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  responded_at  TEXT,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'answered', 'resolved', 'withdrawn')),
  outcome       TEXT CHECK (outcome IN ('release', 'refund', 'split')),
  talent_share  REAL,
  resolution    TEXT NOT NULL DEFAULT '',
  resolved_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  entity_id  TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiries (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'client',
  service    TEXT NOT NULL DEFAULT '',
  settlement TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'new'
             CHECK (status IN ('new', 'contacted', 'closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fixed-window rate limit counters. Persisted so limits survive a restart,
-- which an in-memory Map cannot do.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  hits       INTEGER NOT NULL DEFAULT 0,
  reset_at   INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset ON rate_limits(reset_at);
`;

/**
 * A SQLite CHECK constraint is part of the table definition, so
 * `CREATE TABLE IF NOT EXISTS` cannot widen one on a database that already
 * exists. Each migration rebuilds a table in place when its stored DDL is
 * missing a value the current code writes.
 *
 * Only the constraint matters here, so the copied column list is computed as
 * the intersection of the old and new tables rather than hardcoded — an older
 * database may predate columns the current schema has, and vice versa.
 */
const MIGRATIONS = [
  { table: 'milestones', needs: "'disputed'" },
  { table: 'payments', needs: "'split'" }
];

/**
 * Column metadata for a table, in declaration order. `notnull` is a SQLite
 * keyword, so it has to be quoted to be read as a column name.
 */
const columnsOf = (db, table) =>
  all(db, `SELECT name, "notnull" AS not_null, dflt_value FROM pragma_table_info(?)`, [table]);

function migrate(db) {
  for (const { table, needs } of MIGRATIONS) {
    const existing = get(db, 'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]);
    if (!existing || existing.sql.includes(needs)) continue;

    // Extract this table's CREATE statement from the schema and build it under a temp name.
    const wanted = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(SCHEMA);
    if (!wanted) throw new Error(`Cannot migrate ${table}: no definition found in SCHEMA.`);

    // SQLite's own documented rebuild procedure: constraints off for the swap.
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(`CREATE TABLE ${table}__new (${wanted[1]}\n)`);
        const before = columnsOf(db, table).map((column) => column.name);
        const target = columnsOf(db, `${table}__new`);
        const shared = target.filter((column) => before.includes(column.name));
        if (!shared.length) throw new Error(`Cannot migrate ${table}: no columns in common.`);

        // A column the old table lacks must be fillable, or the copy fails on a
        // constraint with an error that says nothing about migrating.
        const unfillable = target.filter((column) =>
          !before.includes(column.name) && column.not_null === 1 && column.dflt_value === null);
        if (unfillable.length) {
          throw new Error(`Cannot migrate ${table}: ${unfillable.map((column) => column.name).join(', ')} ` +
            'is NOT NULL with no default and absent from the existing table. Add a default to the schema.');
        }

        const list = shared.map((column) => column.name).join(', ');
        db.exec(`INSERT INTO ${table}__new (${list}) SELECT ${list} FROM ${table}`);
        db.exec(`DROP TABLE ${table}`);
        db.exec(`ALTER TABLE ${table}__new RENAME TO ${table}`);
      });
    } finally {
      // Restore the pragma even if the rebuild rolled back, or every later
      // write on this connection would silently skip its foreign keys.
      db.exec('PRAGMA foreign_keys = ON');
    }

    // Dropping the table dropped its indexes; SCHEMA recreates them below.
  }
}

/**
 * Additive column migrations. `CREATE TABLE IF NOT EXISTS` will not add a column
 * to a table that already exists, and rebuilding the whole table for a new
 * nullable-or-defaulted column would be heavy-handed, so these are `ALTER TABLE
 * ... ADD COLUMN` plus an optional one-time backfill.
 */
const COLUMN_MIGRATIONS = [
  {
    table: 'payments',
    column: 'settled_amount',
    definition: 'REAL NOT NULL DEFAULT 0',
    backfill: [
      // A released payment settled its full amount.
      `UPDATE payments SET settled_amount = amount WHERE status = 'released'`,
      // A split settled whatever the arbitration awarded the specialist.
      `UPDATE payments SET settled_amount = COALESCE(
         (SELECT d.talent_share FROM disputes d WHERE d.milestone_id = payments.milestone_id), 0)
       WHERE status = 'split'`
    ]
  }
];

function addColumns(db) {
  for (const { table, column, definition, backfill = [] } of COLUMN_MIGRATIONS) {
    if (!get(db, 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', table])) continue;
    if (columnsOf(db, table).some((existing) => existing.name === column)) continue;

    transaction(db, () => {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      for (const statement of backfill) db.exec(statement);
    });
  }
}

/**
 * Opens (and migrates) the SQLite database.
 * @param {string} file Absolute path, or ':memory:' for tests.
 */
function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  migrate(db);
  db.exec(SCHEMA); // Recreates any index a rebuilt table lost.
  addColumns(db);  // After the rebuilds, so a rebuilt table is not altered twice.
  return db;
}

/** Runs `fn` inside a transaction, rolling back on any thrown error. */
function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* rollback of a failed tx is best effort */ }
    throw error;
  }
}

const all = (db, sql, params = []) => db.prepare(sql).all(...params);
const get = (db, sql, params = []) => db.prepare(sql).get(...params);
const run = (db, sql, params = []) => db.prepare(sql).run(...params);

module.exports = { openDatabase, transaction, all, get, run, SCHEMA };
