# Horizon

A working talent marketplace: clients post briefs, an explainable matching engine ranks
vetted specialists against them, invitations open project rooms, and milestone escrow
tracks the money from funding through release.

Built with **zero runtime dependencies** — Node's built-in `node:sqlite`, `node:http`,
`node:crypto`, and `node:test` do all of the work, and the browser code is plain ES
modules with no build step.

> The original repository was a static prototype: eight HTML pages driven by one
> `app.js`, with form posts appended to a `data.json` file and no accounts, sessions,
> or persistence you could rely on. This version replaces that with a real
> application. See [What changed](#what-changed) for the specifics.

---

## Run it

Requires **Node 22.5 or newer** (that is when `node:sqlite` landed). No `npm install`
step — there are no dependencies.

```bash
npm start          # http://127.0.0.1:3000
npm run dev        # same, with --watch restarts
npm test           # 209 tests: server suites + real-browser smoke tests
npm run test:server    # 171 unit + HTTP integration tests (fast, no browser)
npm run test:browser   # 30 headless-Chrome tests through the real UI
npm run check      # syntax-check server files and every browser module
npm run seed:reset # delete and rebuild data/horizon.db with fresh demo data
npm run screenshots -- shots http://127.0.0.1:3000   # capture every page
```

The database is created and seeded automatically on first boot at `data/horizon.db`.

### Demo accounts

Password for all three: `horizon-demo-2025`

| Role   | Email                  | What you can do                                                        |
| ------ | ---------------------- | ---------------------------------------------------------------------- |
| Client | `alex@northstar.test`  | Post briefs, see ranked shortlists, invite, fund/release milestones     |
| Talent | `maya@horizon.test`    | Edit a profile, answer invitations, submit milestones, watch earnings   |
| Admin  | `admin@horizon.test`   | Approve profiles, read the escrow ledger, triage inquiries, see audit   |

To start from an empty database with no demo data, set `SEED_DEMO_DATA=false`.

---

## What it does

### Accounts and sessions
Signup and login with scrypt-hashed passwords, opaque session cookies
(`HttpOnly`, `SameSite=Lax`, 14 days), a per-session CSRF token required on every
mutation, a same-origin check, and database-backed fixed-window rate limits on login,
signup, inquiry submission, and the API as a whole. Three roles — `client`, `talent`,
`admin` — gate every route.

### Talent profiles with an approval gate
Specialists fill in a headline, bio, skills, rate band, weekly capacity, availability,
and how they want to be paid. A new profile is `pending` and appears nowhere public
until an operator approves it from the admin console. Rejected profiles return to the
queue automatically when edited.

### Searchable directory
Full-text-ish search across name, headline, bio, and location, plus filters for skills
(all-must-match), availability, payout asset and network, rate ceiling, minimum rating,
and verification — with six sort orders and pagination. Public at
`/talent-directory.html`; the same component is reused inside the app.

### Explainable matching
Posting a brief produces a ranked shortlist scored out of 100:

| Component    | Points | Basis                                                          |
| ------------ | -----: | -------------------------------------------------------------- |
| Skills       |     40 | Share of the brief's required skills the person actually has    |
| Availability |     20 | How well their start window matches the brief's                 |
| Budget fit   |     15 | Their rate band against the brief's implied hourly budget       |
| Reputation   |     15 | Rating, review count, completed projects, verification          |
| Settlement   |     10 | Whether they already settle in the brief's asset and network     |

Each match returns its component breakdown, the matched skills, and a plain-English
reason list, so a client can see *why* someone was surfaced. A relevance gate keeps a
candidate with none of the required skills from outranking a genuine specialist on
availability and reputation alone.

### Invitations to project rooms
A client invites from the shortlist; the specialist accepts or declines. Accepting
opens a project room and drafts a three-part milestone plan (25% / 50% / 25%) from the
brief's budget. Declining notifies the client and leaves the brief open.

### Project rooms
Per-project milestones, a message thread, and a payment history — each in its own tab.
Clients add, edit, and remove planned milestones; the assigned specialist submits work
for review. Messages may carry one attachment: a validated `http(s)` link to work
hosted elsewhere, rendered as an external link with `rel="noopener noreferrer"`.
Nothing is uploaded to or proxied by this server, so there is no file store to secure.

### Simulated milestone escrow
A wallet ledger per user, in a chosen asset and network:

```
planned ──fund──▶ funded ──submit──▶ submitted ──release──▶ paid
                     └──────────── refund ────────────▶ planned
                                        │
                                    dispute
                                        ▼
                                    disputed ──admin release──▶ paid
                                        │     ──admin refund───▶ planned
                                        │     ──admin split────▶ resolved
                                        └──withdraw──▶ submitted
```

Funding moves the amount **plus a 3% platform fee** out of the client's available
balance and into escrow. Releasing settles the amount to the specialist and retains
the fee. Refunding returns everything and resets the milestone. When every milestone
is paid or resolved, the project is marked completed.

**This is simulated.** No wallet is connected, no key is held, and nothing is
broadcast to any chain. The asset and network labels describe how a real settlement
*would* be routed; the balances are rows in the local database.

### Disputes and arbitration
When a client will not release a submitted milestone — or a specialist believes the
work is done and nobody is answering — either party freezes it with a written reason
and the outcome they are asking for. A disputed milestone is locked: neither the
release nor the refund path will touch it, so the money can only move once, through an
operator's decision. The counterparty adds their side, and an admin resolves it three
ways from the console:

| Outcome   | Money                                                | Milestone  |
| --------- | ---------------------------------------------------- | ---------- |
| `release` | Full amount to the specialist, fee retained          | `paid`     |
| `refund`  | Amount **and** fee back to the client                | `planned`  |
| `split`   | An explicit share to the specialist, rest to the client, fee retained | `resolved` |

A split must award strictly more than zero and strictly less than the full amount. The
raising party may withdraw an open dispute, which returns the milestone to `submitted`
and unfreezes the normal path. A milestone is arbitrated at most once; both parties see
the reason, the response, and the operator's written rationale.

Every payment row carries `settled_amount` — what actually reached the payee, which is
the full amount on a release, the arbitrated share on a split, and zero while escrowed
or after a refund. Earnings, released totals, and the public settlement figure all sum
that column rather than `amount`, so a split cannot report money that never moved.

### Reviews
After at least one paid milestone, either side can leave a 1–5 rating with a comment.
Publishing recomputes the subject's average rating and review count, which feeds back
into the reputation component of matching.

### Admin console
The dispute arbitration queue with both parties' accounts and the three resolution
actions, the profile approval queue with inline preview, escrow currently held across
all projects, recent briefs with invitation counts, inbound inquiries with status
triage, and an audit trail of every privileged action.

---

## Project layout

```
server.js                  entry point: env → createApp → listen
src/server/
  app.js                   wiring: db, seed, router, security headers, static files
  db.js                    schema DDL, migrations, query helpers (19 tables)
  router.js                pattern router with :param segments
  http.js                  request/response helpers, query parsing, audit
  auth.js                  sessions, CSRF, password hashing, DB rate limiters
  validate.js              declarative body validation → 400 with per-field details
  matching.js              the scoring engine
  escrow.js                fund / submit / release / refund / dispute / arbitrate
  seed.js                  skill catalogue + demo data
  ids.js                   id generation, scrypt hashing, timing-safe compare
  routes/                  auth · talent · briefs · projects · admin
public/
  index.html               marketing page with live stats
  login · signup · talent-directory · talent-profile · 404
  app/*.html               12 workspace pages (thin shells)
  assets/css/              base design system + landing / auth / app
  assets/js/               api client, ui helpers, shell, page modules
scripts/                   reset-db · check-syntax · screenshots · lib/{cdp,websocket}
test/                      unit + auth + api + escrow + browser suites
```

### Design notes

**No build step, on purpose.** Pages load `<script type="module">` and import
directly. The CSP forbids inline scripts, so every page's behaviour lives in an
external module. Styling is a CSS custom-property design system in `base.css`.

**Validation is declarative.** Route handlers call `validate(body, rules)` and get
either a clean object or a 400 whose `details` map field names to messages. The front
end paints those straight onto the matching inputs.

**Errors have one shape.** `{ error: string, details?: { field: message } }`, always.

### Testing

209 tests, no test framework and no browser driver installed:

- **177 server tests** (`test/unit.test.js`, `auth`, `api`, `escrow`) run against an
  in-memory SQLite database on an ephemeral port. They cover validation, password
  hashing, the router, the scoring engine, every endpoint's happy and unhappy paths,
  authorisation, CSRF, the full escrow ledger arithmetic, every dispute outcome
  (including that a rejected split moves nothing and that reported earnings equal the
  money that actually moved), the rate limiter's persistence across a fresh limiter
  instance, and both schema migrations — the CHECK constraint widened by rebuilding a
  table, and the column added and backfilled in place.
- **32 browser tests** (`test/browser.test.js`) drive real headless Chrome over the
  DevTools Protocol: they sign in as each role, post a brief through its dialog,
  assert the shortlist ranks and explains itself, fund a milestone and check the
  wallet moved, edit and save a profile, approve a pending specialist from the admin
  queue, run a dispute end to end (specialist freezes it, client answers, release and
  refund disappear, the dashboard warns about frozen escrow, an admin splits it from
  the console, the ledger shows only the arbitrated share as settled), post a link
  attachment and check it renders safely, watch a locked-out login paint the server's
  retry message, and confirm no page logs a console error. They skip themselves when no
  Chrome binary is present, so `npm test` stays green without one.

`scripts/lib/cdp.js` is a small DevTools Protocol client, and
`scripts/lib/websocket.js` is a minimal RFC 6455 client it sits on. Node's global
`WebSocket` negotiates permessage-deflate, which makes Chrome drop the DevTools
connection with close code 1006 the moment a session-scoped frame arrives; offering
no extensions avoids that. `npm run screenshots` reuses the same client to capture
every page as a PNG.

`npm run check` adds the static half, which matters more than usual with no bundler
to catch things: every server file and browser module parses, every relative import
names a real export, every `api.*` call matches a registered route, and every
`href`/`src` in an HTML page points at a file that exists.

---

## Configuration

Copy `.env.example` to `.env`; every value has a working default.

| Variable          | Default            | Purpose                                             |
| ----------------- | ------------------ | --------------------------------------------------- |
| `PORT`            | `3000`             | HTTP listener port                                  |
| `HOST`            | `127.0.0.1`        | Bind address                                        |
| `DATABASE_FILE`   | `data/horizon.db`  | SQLite file, resolved against the project root      |
| `SEED_DEMO_DATA`  | `true`             | `false` boots an empty database                     |
| `SECURE_COOKIES`  | `false`            | `true` adds `Secure` to the session cookie (HTTPS)  |
| `TRUST_PROXY`     | `false`            | `true` trusts `X-Forwarded-Proto` / `-For`          |

---

## Security posture

Implemented: scrypt password hashing with per-user salts, timing-safe comparison,
opaque session tokens, CSRF tokens on mutations, same-origin enforcement, rate limiting
on auth and public endpoints that lives in the database rather than process memory,
parameterised SQL everywhere, role checks on every privileged route, an audit log, a CSP
with no inline scripts, and HSTS when served over HTTPS. Message attachments are
validated `http(s)` links rendered with `rel="noopener noreferrer"`; nothing is uploaded
to this server, so there is no file store to secure.

Not production-ready as-is: no email verification or password reset, no 2FA, no
CAPTCHA on public forms, and the escrow is a simulation with no custody or ledger
reconciliation — the arbitration flow decides where simulated funds go, not real ones.
Rate limits are per-address fixed windows in SQLite; they survive a restart and are
shared by every process on the same file, but a distributed deployment would want a
shared store with atomic expiry. Behind a proxy, set `TRUST_PROXY=true` and
`SECURE_COOKIES=true`.

## What changed

The prototype this replaces had static HTML pages, one shared `app.js`, form posts
appended to `data.json`, an optional Supabase mirror, and no accounts, sessions, or
authorisation. Added here: SQLite persistence across 19 tables, authentication with
three roles, a REST API, the approval gate, search, the matching engine, invitations,
project rooms with messaging and link attachments, milestone escrow with a fee model,
a dispute and arbitration flow, reviews that feed matching, the admin console with an
audit trail, 209 automated tests, and a rewritten front end. The Supabase path was
removed — the app is self-contained.

## What is worth building next

Real settlement against a custody provider or chain, email delivery for invitations
and notifications, actual file uploads to object storage (today an attachment is a
link), saved searches with alerts, a partial-release path outside the dispute flow,
and time-boxed auto-release so a silent client cannot strand a delivered milestone
indefinitely.
