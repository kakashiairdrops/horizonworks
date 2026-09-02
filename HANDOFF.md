# Where this left off

State: the app runs end to end and all 209 tests pass — 177 server tests plus 32
real-browser smoke tests. Nothing is committed yet; work sits on branch
`feat/full-stack-platform` as uncommitted changes.

## Verify it still works

```bash
npm start              # http://127.0.0.1:3000
npm test               # 209 pass (server + headless Chrome)
npm run test:server    # 177 pass, no browser needed
npm run test:browser   # 32 pass, drives real Chrome
npm run check          # syntax-check server + browser modules
npm run seed:reset     # rebuild data/horizon.db from scratch
npm run screenshots -- shots http://127.0.0.1:3000
```

Demo logins (password `horizon-demo-2025`): `alex@northstar.test` (client),
`maya@horizon.test` (talent), `admin@horizon.test` (admin).

## What the tests cover

Server (177): validation, scrypt hashing, the router, the scoring engine, every
endpoint's happy and unhappy paths, role authorisation, CSRF, escrow arithmetic, all
three dispute outcomes with wallet-level assertions, that reported earnings equal the
money that actually moved, the rate limiter's window and persistence, and both schema
migrations against real files on disk — otherwise all against an in-memory database on
an ephemeral port.

Browser (32): real headless Chrome over the DevTools Protocol. Signs in as each role,
posts a brief through its dialog and asserts the shortlist ranks and explains itself,
funds a milestone and confirms the wallet moved, edits and saves a talent profile,
approves a pending specialist from the admin queue, runs a dispute end to end (the
specialist freezes a submitted milestone, the client answers, release and refund
disappear from the card, the dashboard warns that escrow is frozen, an admin splits the
escrow from the console, the specialist's ledger shows only the arbitrated share as
settled), posts a link attachment and checks it renders as a safe external link, burns
the login allowance and checks the server's retry message lands on the form, checks the
signed-out redirect and the 404 page, and asserts no page logs a console error.

The browser tests skip themselves when no Chrome binary is present, so `npm test`
stays green on a machine without one. Set `CHROME_PATH` to point at a specific binary.

## The three features added in this round

**Disputes and arbitration.** Either party freezes a `submitted` milestone with a
reason (min 20 chars) and a desired outcome. `releaseMilestone` and `refundMilestone`
now refuse a `disputed` milestone with a 409, so escrow can only move once — through
`POST /api/admin/disputes/:id/resolve`. Release pays the specialist in full and retains
the fee; refund returns amount **and** fee and resets the milestone to `planned`; split
awards an explicit share (strictly between 0 and the amount), returns the remainder,
and marks the milestone `resolved` with payment status `split`. The raiser can withdraw
an open dispute, which returns the milestone to `submitted`. `milestones.status` gained
`disputed` and `resolved`; project completion counts `status NOT IN ('paid','resolved')`.

**Message attachments.** The long-dormant `messages.attachment` column is now written.
The rule is `{ type: 'url', max: 400 }` — a validated `http(s)` link only. Nothing is
uploaded or proxied, so there is no file store to secure; the UI renders it as an
external anchor with `target="_blank" rel="noopener noreferrer"` and labels it by host
rather than showing the raw URL.

**Database-backed rate limiting.** `createDbRateLimiter({ windowMs, max, name })` in
`auth.js` replaces the in-memory limiters for login (12/10min), signup (20/hr),
inquiries (15/hr), and the API as a whole (300/min). Each `check(db, key)` is a single
`INSERT … ON CONFLICT DO UPDATE … RETURNING` against the new `rate_limits` table, with
a 60-second sweep of expired rows. Counters survive a restart and are shared by every
process on the same database file. The in-memory `createRateLimiter` was deleted rather
than kept as a fallback — nothing called it, and two limiter implementations invite the
wrong one being used.

**Honest money reporting.** A split settles less than the milestone's amount, and every
earnings figure summed `amount`, so an arbitrated milestone would have reported the full
amount as earned — or, worse, nothing at all, because the sums also filtered on
`status = 'released'`. `payments` gained `settled_amount`: what actually reached the
payee, equal to the amount on a release, the arbitrated share on a split, and 0 while
escrowed or after a refund. Every money query (`/api/stats`, the admin overview, talent
`earned`, client `paid`, and the payments page tiles) now sums that column over
`('released','split')`. A test asserts the reported total equals the wallet movement.

Schema went from 17 to 19 tables (`disputes`, `rate_limits`). `db.js` carries two kinds
of migration, both idempotent:

- `MIGRATIONS` + `migrate(db)` rebuild a table when its stored DDL lacks a needed CHECK
  value. `openDatabase` runs `SCHEMA` → `migrate` → `SCHEMA` again so indexes dropped
  with the old table come back. The copied column list is the intersection of the old and
  new tables, so a dropped column is left behind and an added one takes its default; a
  new `NOT NULL` column with no default aborts with a message that names it rather than a
  bare constraint error. Rows are preserved and `PRAGMA foreign_keys` is restored in a
  `finally` even if the rebuild rolls back.
- `COLUMN_MIGRATIONS` + `addColumns(db)` handle a new column on a table whose constraints
  are already current, since that table is never rebuilt. `ALTER TABLE ... ADD COLUMN`
  plus a one-time backfill, run after the rebuilds so a rebuilt table is not altered
  twice. `settled_amount` backfills from the payment status, reading the arbitrated share
  off the `disputes` row for a split.

## Bugs found and fixed during verification

1. `queryInt()` in `src/server/http.js` returned 0 instead of its fallback for a
   missing parameter (`Number(null) === 0`), so every list endpoint's default page
   size collapsed to one row. Now checks presence before coercing.
2. `GET /api/talent/:userId` served `pending` and `rejected` profiles to anonymous
   callers, contradicting the directory's approval gate. Now 404s unless the viewer
   is the owner or an admin.
3. `openDispute` reported "only a submitted milestone can be disputed" when the
   milestone was already disputed, because the status check ran before the existing
   dispute lookup. The order is reversed, and a withdrawn dispute now reuses its row
   (the `milestone_id` UNIQUE constraint would otherwise block a second attempt).
4. `project.js` declared `OUTCOME_LABEL` after the module's top-level `await load()`,
   so the first render hit its temporal dead zone and the whole project page rendered
   as "Project unavailable". Moved above the boot block. `npm run check` catches the
   duplicate-identifier version of this but not the ordering, which the browser tests
   did.
5. The message composer was not `novalidate`, unlike every other form here, so the
   browser blocked submission of a bad attachment before the server could return its
   per-field message.
6. Every earnings and settlement figure summed `payments.amount` filtered to
   `status = 'released'`, so a split payment vanished from the specialist's "earned"
   total and from the public settlement figure even though the money had moved. Fixed by
   recording `settled_amount` per payment and summing that over `('released','split')`.

All have regression tests.

## Notes on the browser harness

`scripts/lib/websocket.js` is a hand-rolled RFC 6455 client. It exists because Node's
global `WebSocket` negotiates permessage-deflate, and Chrome then drops the DevTools
connection with close code 1006 as soon as a session-scoped frame arrives. Offering no
extensions avoids it entirely.

Chrome is launched with `--no-sandbox --disable-crashpad`: inside a restricted file
sandbox its own sandbox cannot initialise and the process dies about a second after
launch. It only ever loads localhost pages from this repo.

Two harness details worth knowing: `signOutInBrowser()` navigates to `/login.html`
first, because a relative `fetch` needs a real origin and the helper may run before any
navigation. And tests that need a milestone in a particular state create their own
rather than reusing a seeded one — earlier tests consume the seeded `planned`
milestone.

## Deliberate deviations from the original repo

- Removed the Supabase path and the `data.json` store; persistence is SQLite only.
- Deleted the eight prototype HTML pages and `app.js`; `public/` fully replaces them.
- Escrow is simulated — no wallet, no custody, nothing broadcast. Kept explicit in
  the UI copy and the README.
- Attachments are links, not uploads. A real file store is a deliberate non-goal here.

## Next up

1. **Commit on `feat/full-stack-platform`** — nothing is committed yet.
2. **Deployment needs a decision.** Vercel will not work as built: it is serverless
   with an ephemeral filesystem, and this app uses synchronous file-backed
   `node:sqlite` across 26 call sites, so every signup and escrow move would vanish
   between invocations. Either deploy to a host with a persistent disk (Fly.io,
   Railway, Render — the code goes as-is with a volume at `data/`), or port the data
   layer to a network database (Turso, Neon, Postgres) to stay on Vercel. The second
   is a real porting job, not a config change.
3. Email delivery for invitations, notifications, and dispute updates.
4. Actual file uploads to object storage, replacing the link-only attachment.
5. Time-boxed auto-release, so a silent client cannot strand a delivered milestone
   indefinitely without anyone opening a dispute.
6. A partial-release path outside the dispute flow — today a split requires an
   operator, even when both parties agree.
