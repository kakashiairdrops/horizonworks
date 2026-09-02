'use strict';

/**
 * Browser smoke tests: drives real headless Chrome over the DevTools Protocol to
 * prove each page actually renders with live data and no console errors.
 *
 * The unit and API suites cover the server; this suite covers the part they
 * cannot reach — that the ES modules load, the pages paint, and the flows work
 * through the UI rather than through curl.
 *
 * Skips itself when no Chrome/Chromium binary is present, so `npm test` stays
 * green on machines without one. Set CHROME_PATH to point at a specific binary.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, DEMO_PASSWORD } = require('./helpers');
const { launch, findChrome } = require('../scripts/lib/cdp');

const CLIENT_EMAIL = 'alex@northstar.test';
const TALENT_EMAIL = 'maya@horizon.test';
const ADMIN_EMAIL = 'admin@horizon.test';

const chromePath = findChrome();

describe('browser smoke tests', { skip: chromePath ? false : 'no Chrome/Chromium binary found (set CHROME_PATH)' }, () => {
  let server;
  let browser;
  let page;

  before(async () => {
    server = await startServer();
    browser = await launch();
    page = await browser.newPage();
  });

  after(async () => {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close();
    if (server) await server.close();
  });

  /**
   * Navigates, then asserts the page painted and logged nothing alarming.
   * `allowStatusErrors` covers pages whose own HTTP status is the point (the 404
   * page), where Chrome logs the response as a console error by design.
   */
  async function visit(pathname, { waitFor, allowStatusErrors = false } = {}) {
    page.clearErrors();
    await page.goto(`${server.baseUrl}${pathname}`);
    if (waitFor) await page.waitFor(waitFor);
    let errors = page.hardErrors();
    if (allowStatusErrors) {
      errors = errors.filter((text) => !/Failed to load resource/i.test(text));
    }
    assert.deepEqual(errors, [], `${pathname} logged errors: ${errors.join(' | ')}`);
    return page;
  }

  async function signIn(email) {
    page.clearErrors();
    await page.goto(`${server.baseUrl}/login.html`);
    await page.waitFor(`!!document.querySelector('#form')`);
    await page.type('#form [name="email"]', email);
    await page.type('#form [name="password"]', DEMO_PASSWORD);
    await page.click('#form button[type="submit"]');
    await page.waitFor(`location.pathname.startsWith('/app/')`, { timeout: 15000 });
    const errors = page.hardErrors();
    assert.deepEqual(errors, [], `signing in as ${email} logged errors: ${errors.join(' | ')}`);
  }

  /**
   * Ends the browser session. A relative fetch needs a real origin, so this
   * lands on the login page first — which is where signing out belongs anyway,
   * and keeps the helper safe to call before any navigation has happened.
   */
  async function signOutInBrowser() {
    await page.goto(`${server.baseUrl}/login.html`);
    await page.waitFor(`!!document.querySelector('#form')`);
    await page.eval(`
      const me = await (await fetch('/api/auth/me', { headers: { accept: 'application/json' } })).json();
      if (me.csrfToken) {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken } });
      }
      return true;
    `);
  }

  describe('public pages', () => {
    it('the landing page renders live network stats from the API', async () => {
      await visit('/', { waitFor: `document.querySelector('#stat-talent').textContent.trim() !== '\u2014'` });

      const stats = await page.eval(`
        return ['talent', 'available', 'settled', 'projects', 'countries']
          .map((key) => document.querySelector('#stat-' + key).textContent.trim());
      `);
      assert.equal(stats.length, 5, 'the hero shows five live stats');
      assert.ok(stats.every((value) => value && value !== '\u2014'), `stats did not fill in: ${JSON.stringify(stats)}`);
      assert.equal(stats[0], '10', 'ten specialists are seeded and approved');

      const categories = await page.eval('return document.querySelectorAll("#category-grid a, #category-grid article").length;');
      assert.ok(categories > 0, 'the category grid should render');

      const featured = await page.eval('return document.querySelectorAll("#featured-talent .talent-card").length;');
      assert.equal(featured, 3, 'the landing page features three available specialists');
    });

    it('the public directory lists approved specialists and filters them', async () => {
      await visit('/talent-directory.html', { waitFor: 'document.querySelectorAll(".person").length > 0' });

      const initial = await page.eval('return document.querySelectorAll(".person").length;');
      assert.equal(initial, 9, 'the first page shows the default nine cards');

      const total = await page.eval(`
        const meta = document.querySelector('.result-meta');
        return meta ? meta.textContent : '';
      `);
      assert.match(total, /10 specialists/, `result meta read: ${total}`);

      // Narrow to a single skill and confirm the grid actually shrinks.
      await page.eval(`
        const chip = [...document.querySelectorAll('.chip')].find((node) => node.textContent.trim() === 'Solidity');
        chip.click();
      `);
      await page.waitFor('document.querySelectorAll(".person").length > 0 && document.querySelectorAll(".person").length < 9');
      const filtered = await page.eval(`
        return [...document.querySelectorAll('.person h3')].map((node) => node.textContent.trim());
      `);
      assert.ok(filtered.length < initial, 'filtering by Solidity should narrow the results');
      assert.deepEqual(page.hardErrors(), []);
    });

    it('a specialist profile page renders their skills and reviews', async () => {
      await visit('/talent-directory.html', { waitFor: 'document.querySelectorAll(".person").length > 0' });
      const href = await page.eval(`
        return document.querySelector('.person a[href^="/talent-profile.html"]').getAttribute('href');
      `);

      await visit(href, { waitFor: '!!document.querySelector(".profile-hero h1")' });
      const name = await page.eval('return document.querySelector(".profile-hero h1").textContent.trim();');
      assert.ok(name.length > 0, 'the profile should show a name');

      const skills = await page.eval('return document.querySelectorAll(".chip-set .tag").length;');
      assert.ok(skills > 0, 'the profile should list skills');
    });

    it('an unknown URL serves the 404 page', async () => {
      await visit('/definitely-not-a-page', { allowStatusErrors: true });
      const heading = await page.eval('return document.querySelector("h1").textContent;');
      assert.match(heading, /moved on/i);
    });

    it('signed-out workspace pages redirect to the login screen', async () => {
      page.clearErrors();
      await page.goto(`${server.baseUrl}/app/dashboard.html`);
      await page.waitFor('location.pathname === "/login.html"', { timeout: 10000 });
      const next = await page.eval('return new URL(location.href).searchParams.get("next");');
      assert.equal(next, '/app/dashboard.html', 'the login page should remember where to return');
    });
  });

  describe('client workspace', () => {
    before(async () => { await signIn(CLIENT_EMAIL); });

    it('the dashboard renders stats, wallet, and activity', async () => {
      await visit('/app/dashboard.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });
      const tiles = await page.eval(`
        return [...document.querySelectorAll('.stat strong')].map((node) => node.textContent.trim());
      `);
      assert.ok(tiles.length >= 4, `expected several stat tiles, got ${tiles.length}`);
      assert.ok(tiles.every((value) => value.length > 0), 'every tile should have a value');

      const shell = await page.eval(`
        return !!document.querySelector('.sidebar a[aria-current="page"]');
      `);
      assert.ok(shell, 'the sidebar should mark the current page');
    });

    it('the briefs page lists every brief the client owns', async () => {
      await visit('/app/briefs.html', { waitFor: 'document.querySelectorAll(".brief-card").length > 0' });
      const count = await page.eval('return document.querySelectorAll(".brief-card").length;');
      assert.equal(count, 2, 'the seeded client owns two briefs');
    });

    it('posting a brief through the dialog lands on its shortlist', async () => {
      await visit('/app/briefs.html', { waitFor: 'document.querySelectorAll(".brief-card").length > 0' });

      await page.eval(`
        const button = [...document.querySelectorAll('button, a')].find((node) => /new brief/i.test(node.textContent));
        button.click();
      `);
      await page.waitFor('!!document.querySelector("dialog[open] #brief-form")');

      await page.type('#brief-form [name="title"]', 'Browser-tested launch site');
      await page.type('#brief-form [name="description"]',
        'We need a marketing site with a CMS, built to be fast and easy for a small team to keep updated after launch.');
      await page.eval(`
        const form = document.querySelector('#brief-form');
        form.elements.category.value = 'Web development';
        form.elements.category.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      await page.type('#brief-form [name="budget_min"]', '9000');
      await page.type('#brief-form [name="budget_max"]', '16000');

      // Pick a skill chip so the match engine has something to score against.
      await page.waitFor(`document.querySelectorAll('#brief-form .chip').length > 0`);
      await page.eval(`
        const chip = [...document.querySelectorAll('#brief-form .chip')].find((node) => node.textContent.trim() === 'Next.js')
          || document.querySelector('#brief-form .chip');
        chip.click();
        return true;
      `);

      await page.click('#brief-form button[type="submit"]');
      await page.waitFor('location.pathname === "/app/matches.html"', { timeout: 12000 });

      await page.waitFor('document.querySelectorAll(".match-card").length > 0');
      const errors = page.hardErrors();
      assert.deepEqual(errors, [], `posting a brief logged errors: ${errors.join(' | ')}`);

      const scores = await page.eval(`
        return [...document.querySelectorAll('.match-card .score strong')].map((node) => Number(node.textContent.trim()));
      `);
      assert.ok(scores.length > 1, 'the shortlist should rank several people');
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'scores must descend');
      assert.ok(scores[0] > 0 && scores[0] <= 100);

      const reasons = await page.eval('return document.querySelectorAll(".match-card .reasons li").length;');
      assert.ok(reasons > 0, 'each match should explain itself');

      const bars = await page.eval('return document.querySelectorAll(".match-card .score-breakdown .bar i").length;');
      assert.ok(bars > 0, 'the score breakdown should render its bars');
    });

    it('the talent directory inside the app offers an invite action', async () => {
      await visit('/app/talent.html', { waitFor: 'document.querySelectorAll(".person").length > 0' });
      const invites = await page.eval(`
        return [...document.querySelectorAll('.person button')].filter((node) => /invite/i.test(node.textContent)).length;
      `);
      assert.ok(invites > 0, 'a client with open briefs should see invite buttons');
    });

    it('the project room renders milestones, messages, and payments', async () => {
      await visit('/app/projects.html', { waitFor: 'document.querySelectorAll(".brief-card").length > 0' });
      const href = await page.eval(`
        return document.querySelector('a[href^="/app/project.html"]').getAttribute('href');
      `);

      await visit(href, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });
      const milestones = await page.eval('return document.querySelectorAll(".milestone").length;');
      assert.equal(milestones, 3, 'the seeded project has three milestones');

      // Messages tab.
      await page.eval(`
        [...document.querySelectorAll('.tab')].find((node) => /messages/i.test(node.textContent)).click();
        return true;
      `);
      await page.waitFor('!!document.querySelector(".thread")');
      const bubbles = await page.eval('return document.querySelectorAll(".thread .bubble").length;');
      assert.ok(bubbles > 0, 'the seeded project has messages');

      // Payments tab.
      await page.eval(`
        [...document.querySelectorAll('.tab')].find((node) => /payments/i.test(node.textContent)).click();
        return true;
      `);
      await page.waitFor('!!document.querySelector("table.ledger")');
      const rows = await page.eval('return document.querySelectorAll("table.ledger tbody tr").length;');
      assert.ok(rows > 0, 'the payments tab should list escrow activity');

      assert.deepEqual(page.hardErrors(), []);
    });

    it('funding a milestone through the UI moves money into escrow', async () => {
      await visit('/app/projects.html', { waitFor: 'document.querySelectorAll(".brief-card").length > 0' });
      const href = await page.eval(`
        return document.querySelector('a[href^="/app/project.html"]').getAttribute('href');
      `);
      await visit(href, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });

      const before = await page.eval(`
        const response = await fetch('/api/payments', { headers: { accept: 'application/json' } });
        const data = await response.json();
        return data.wallets[0];
      `);

      const planned = await page.eval(`
        const button = [...document.querySelectorAll('.milestone button')].find((node) => /^Fund /.test(node.textContent.trim()));
        if (!button) return null;
        button.click();
        return button.textContent.trim();
      `);
      assert.ok(planned, 'the seeded project should have a planned milestone to fund');

      await page.waitFor('!!document.querySelector("dialog[open]")');
      await page.eval(`
        const dialog = document.querySelector('dialog[open]');
        const confirm = [...dialog.querySelectorAll('button')].find((node) => /escrow|confirm|fund/i.test(node.textContent));
        confirm.click();
        return true;
      `);

      await page.waitFor(`
        const response = await fetch('/api/payments', { headers: { accept: 'application/json' } });
        const data = await response.json();
        return data.wallets[0].in_escrow > ${before.in_escrow};
      `, { timeout: 12000 });

      const after = await page.eval(`
        const response = await fetch('/api/payments', { headers: { accept: 'application/json' } });
        const data = await response.json();
        return data.wallets[0];
      `);
      assert.ok(after.in_escrow > before.in_escrow, 'escrow should grow');
      assert.ok(after.available < before.available, 'available balance should fall');

      const errors = page.hardErrors();
      assert.deepEqual(errors, [], `funding logged errors: ${errors.join(' | ')}`);
    });

    it('the payments ledger renders wallet tiles and rows', async () => {
      await visit('/app/payments.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });
      const rows = await page.eval('return document.querySelectorAll("table.ledger tbody tr").length;');
      assert.ok(rows > 0, 'the client has escrow history by now');
      const wallet = await page.eval('return !!document.querySelector(".wallet-tile");');
      assert.ok(wallet, 'a wallet tile should render');
    });

    it('settings renders the account form and active sessions', async () => {
      await visit('/app/settings.html', { waitFor: '!!document.querySelector("#account-form")' });
      const name = await page.eval(`
        return document.querySelector('#account-form [name="name"]').value;
      `);
      assert.equal(name, 'Alex Morgan');
      await page.waitFor('!!document.querySelector("#session-list")');
      const sessions = await page.eval(`
        return document.querySelector('#session-list').textContent.includes('This device');
      `);
      assert.ok(sessions, 'the current session should be listed');
    });

    it('a validation error paints onto the offending field', async () => {
      await visit('/app/briefs.html', { waitFor: 'document.querySelectorAll(".brief-card").length > 0' });
      await page.eval(`
        const button = [...document.querySelectorAll('button, a')].find((node) => /new brief/i.test(node.textContent));
        button.click();
      `);
      await page.waitFor('!!document.querySelector("dialog[open] #brief-form")');

      // Budget max below min: the server rejects it with a per-field detail.
      await page.type('#brief-form [name="title"]', 'Deliberately invalid budget');
      await page.type('#brief-form [name="description"]',
        'This description is comfortably long enough to satisfy the minimum length rule for a brief body.');
      await page.type('#brief-form [name="budget_min"]', '20000');
      await page.type('#brief-form [name="budget_max"]', '500');
      await page.eval(`
        const chip = document.querySelector('#brief-form .chip');
        if (chip) chip.click();
        return true;
      `);
      await page.click('#brief-form button[type="submit"]');

      await page.waitFor(`
        const field = document.querySelector('#brief-form [name="budget_max"]');
        const wrapper = field && field.closest('.field');
        const error = wrapper && wrapper.querySelector('.field-error');
        return !!(error && error.textContent.trim());
      `);
      const message = await page.eval(`
        const field = document.querySelector('#brief-form [name="budget_max"]');
        return field.closest('.field').querySelector('.field-error').textContent.trim();
      `);
      assert.match(message, /minimum/i, `unexpected field error: ${message}`);
      assert.equal(await page.eval('return location.pathname;'), '/app/briefs.html', 'a rejected form must not navigate');
    });
  });

  describe('talent workspace', () => {
    before(async () => {
      await page.eval(`
        const token = (await (await fetch('/api/auth/me', { headers: { accept: 'application/json' } })).json()).csrfToken;
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': token || '' } });
        return true;
      `);
      await signIn(TALENT_EMAIL);
    });

    it('the dashboard shows talent-specific stats', async () => {
      await visit('/app/dashboard.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });
      const text = await page.eval('return document.querySelector("#page").textContent;');
      assert.match(text, /earn|escrow/i, 'a talent dashboard should talk about earnings or escrow');
    });

    it('the profile editor loads the saved profile with its skills selected', async () => {
      await visit('/app/profile.html', { waitFor: '!!document.querySelector("#profile-form")' });
      const headline = await page.eval(`
        return document.querySelector('[name="headline"]').value;
      `);
      assert.match(headline, /web developer/i);
      const chosen = await page.eval(`
        return [...document.querySelectorAll('#skill-groups .chip[aria-pressed="true"]')].map((node) => node.textContent.trim());
      `);
      assert.ok(chosen.includes('Next.js'), `expected Next.js preselected, got ${JSON.stringify(chosen)}`);
    });

    it('saving the profile persists a change', async () => {
      await visit('/app/profile.html', { waitFor: '!!document.querySelector("#profile-form")' });
      const updated = `Senior web developer & design engineer (${Date.now().toString(36)})`;
      await page.type('#profile-form [name="headline"]', updated);
      await page.click('#profile-form button[type="submit"]');
      await page.waitFor(`
        const response = await fetch('/api/profile', { headers: { accept: 'application/json' } });
        const data = await response.json();
        return data.profile.headline === ${JSON.stringify(updated)};
      `, { timeout: 10000 });
      assert.deepEqual(page.hardErrors(), []);
    });

    it('opportunities lists briefs that match the profile skills', async () => {
      await visit('/app/opportunities.html', { waitFor: '!!document.querySelector("#page .brief-card, #page .empty")' });
      const cards = await page.eval('return document.querySelectorAll(".brief-card").length;');
      assert.ok(cards > 0, 'this specialist should match at least one open brief');
    });

    it('invitations render with accept and decline actions', async () => {
      await visit('/app/invitations.html', { waitFor: '!!document.querySelector("#page .brief-card, #page .empty")' });
      const text = await page.eval('return document.querySelector("#page").textContent;');
      assert.ok(text.length > 0);
    });

    it('the earnings page renders without client-only controls', async () => {
      await visit('/app/payments.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });
      const heading = await page.eval('return document.querySelector("h1").textContent;');
      assert.match(heading, /earnings/i);
    });

    it('talent cannot reach the admin console', async () => {
      page.clearErrors();
      await page.goto(`${server.baseUrl}/app/admin.html`);
      await page.waitFor('location.pathname !== "/app/admin.html"', { timeout: 10000 });
      const pathname = await page.eval('return location.pathname;');
      assert.notEqual(pathname, '/app/admin.html', 'a talent must be redirected away from admin');
    });
  });

  describe('admin console', () => {
    before(async () => {
      await signOutInBrowser();
      await signIn(ADMIN_EMAIL);
    });

    it('renders counts, the escrow ledger, inquiries, and the audit trail', async () => {
      await visit('/app/admin.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });

      const tiles = await page.eval('return document.querySelectorAll(".stat").length;');
      assert.ok(tiles >= 6, `expected six admin tiles, got ${tiles}`);

      const audit = await page.eval('return document.querySelectorAll(".audit-item").length;');
      assert.ok(audit > 0, 'the audit trail should have entries by now');

      const text = await page.eval('return document.querySelector("#page").textContent;');
      assert.match(text, /inquir/i, 'the inquiries panel should render');
      assert.match(text, /escrow/i, 'the escrow panel should render');
    });

    it('approving a pending profile publishes it to the directory', async () => {
      // Create a pending profile through the API, then approve it through the UI.
      const email = `browser-approval-${Date.now().toString(36)}@example.test`;
      const created = await page.eval(`
        const signup = await fetch('/api/auth/signup', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Browser Approval', email: ${JSON.stringify(email)},
            password: 'a-sufficiently-long-password', role: 'talent' })
        });
        const body = await signup.json();
        const token = (await (await fetch('/api/auth/me')).json()).csrfToken;
        await fetch('/api/profile', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-csrf-token': token },
          body: JSON.stringify({
            headline: 'Approval flow specialist', location: 'Lisbon, PT', timezone: 'Europe/Lisbon',
            bio: 'A profile created by the browser test suite to exercise the operator approval queue end to end.',
            rate_min: 70, rate_max: 100, availability: 'available_now', weekly_capacity: 20,
            payout_asset: 'USDC', payout_network: 'Base', years_experience: 6, skills: ['Next.js']
          })
        });
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': token } });
        return body.user.id;
      `);
      assert.ok(created, 'the pending specialist should have been created');

      await signIn(ADMIN_EMAIL);
      await visit('/app/admin.html', { waitFor: 'document.querySelectorAll(".review-row").length > 0' });

      const queued = await page.eval(`
        return [...document.querySelectorAll('.review-row h3')].map((node) => node.textContent.trim());
      `);
      assert.ok(queued.includes('Browser Approval'), `the queue should list the new profile: ${JSON.stringify(queued)}`);

      await page.eval(`
        const row = [...document.querySelectorAll('.review-row')]
          .find((node) => node.textContent.includes('Browser Approval'));
        [...row.querySelectorAll('button')].find((node) => /^Approve$/i.test(node.textContent.trim())).click();
        return true;
      `);
      await page.waitFor('!!document.querySelector("dialog[open]")');
      await page.eval(`
        const dialog = document.querySelector('dialog[open]');
        [...dialog.querySelectorAll('button')].find((node) => /approve/i.test(node.textContent)).click();
        return true;
      `);

      await page.waitFor(`
        const response = await fetch('/api/talent?limit=50&q=Browser%20Approval', { headers: { accept: 'application/json' } });
        const data = await response.json();
        return data.total === 1;
      `, { timeout: 10000 });

      const errors = page.hardErrors();
      assert.deepEqual(errors, [], `approval logged errors: ${errors.join(' | ')}`);
    });
  });

  describe('the dispute flow through the UI', () => {
    let projectPath;
    let projectApi;
    let milestoneTitle;

    it('the specialist freezes a submitted milestone from the project room', async () => {
      // Create a milestone of its own rather than reusing a seeded one: an
      // earlier test funds the planned milestone, so none may be left.
      await signOutInBrowser();
      await signIn(CLIENT_EMAIL);

      milestoneTitle = `Disputed scope ${Date.now().toString(36)}`;
      const prepared = await page.eval(`
        const token = (await (await fetch('/api/auth/me', { headers: { accept: 'application/json' } })).json()).csrfToken;
        const json = { 'content-type': 'application/json', 'x-csrf-token': token };
        const projects = await (await fetch('/api/projects', { headers: { accept: 'application/json' } })).json();
        const projectId = projects.projects[0].id;

        const created = await (await fetch('/api/projects/' + projectId + '/milestones', {
          method: 'POST', headers: json,
          body: JSON.stringify({ title: ${JSON.stringify(milestoneTitle)}, amount: 1200,
            description: 'A milestone created by the browser suite to exercise arbitration.' })
        })).json();

        await fetch('/api/milestones/' + created.milestone.id + '/fund', { method: 'POST', headers: json });
        return { projectId, milestoneId: created.milestone.id };
      `);
      assert.ok(prepared?.milestoneId, 'the test milestone should have been created and funded');
      projectPath = `/app/project.html?id=${prepared.projectId}`;
      projectApi = `/api/projects/${prepared.projectId}`;

      await signOutInBrowser();
      await signIn(TALENT_EMAIL);
      await page.eval(`
        const token = (await (await fetch('/api/auth/me', { headers: { accept: 'application/json' } })).json()).csrfToken;
        await fetch('/api/milestones/${prepared.milestoneId}/submit', {
          method: 'POST', headers: { 'x-csrf-token': token }
        });
        return true;
      `);

      await visit(projectPath, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });
      await page.eval(`
        const card = [...document.querySelectorAll('.milestone')]
          .find((node) => node.textContent.includes(${JSON.stringify(milestoneTitle)}));
        [...card.querySelectorAll('button')].find((node) => /raise a dispute/i.test(node.textContent)).click();
        return true;
      `);

      await page.waitFor(`!!document.querySelector('#dispute-form')`);
      await page.type('#dispute-form [name="reason"]',
        'Delivered three weeks ago and the client has not responded to the release request.');
      await page.click('#dispute-form button[type="submit"]');

      await page.waitFor(`
        const data = await (await fetch('${projectApi}', { headers: { accept: 'application/json' } })).json();
        return data.disputes.some((entry) => entry.status === 'open');
      `, { timeout: 12000 });

      const shown = await page.eval('return document.querySelector("#page").textContent;');
      assert.match(shown, /disputed/i, 'the milestone should show as disputed');
      assert.deepEqual(page.hardErrors(), []);
    });

    it('the client sees the dispute and can add their side', async () => {
      await signOutInBrowser();
      await signIn(CLIENT_EMAIL);
      await visit(projectPath, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });

      const text = await page.eval('return document.querySelector("#page").textContent;');
      assert.match(text, /Disputes/, 'the disputes panel should render for the client');
      assert.match(text, /has not responded to the release request/, 'the reason is visible to the counterparty');

      await page.eval(`
        [...document.querySelectorAll('button')].find((node) => /add your side/i.test(node.textContent)).click();
        return true;
      `);
      await page.waitFor(`!!document.querySelector('#response-form')`);
      await page.type('#response-form [name="response"]',
        'Two of the four agreed deliverables are still missing from the handoff package.');
      await page.click('#response-form button[type="submit"]');

      await page.waitFor(`
        const data = await (await fetch('${projectApi}', { headers: { accept: 'application/json' } })).json();
        return data.disputes.some((entry) => entry.status === 'answered');
      `, { timeout: 12000 });
      assert.deepEqual(page.hardErrors(), []);
    });

    it('the client cannot release or refund while it is frozen', async () => {
      await visit(projectPath, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });
      const buttons = await page.eval(`
        const card = [...document.querySelectorAll('.milestone')]
          .find((node) => node.textContent.includes(${JSON.stringify(milestoneTitle)}));
        return [...card.querySelectorAll('button')].map((node) => node.textContent.trim());
      `);
      assert.ok(!buttons.some((label) => /^Release/.test(label)), `release should be gone: ${JSON.stringify(buttons)}`);
      assert.ok(!buttons.some((label) => /^Refund$/.test(label)), `refund should be gone: ${JSON.stringify(buttons)}`);
    });

    it('a frozen milestone warns on the client dashboard', async () => {
      await visit('/app/dashboard.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });
      const banner = await page.eval(`
        const node = document.querySelector('#page .alert.warn');
        return node ? node.textContent : null;
      `);
      assert.ok(banner, 'the client dashboard should warn about frozen escrow');
      assert.match(banner, /under dispute/i);
      assert.match(banner, /frozen/i);
    });

    it('an admin splits the escrow from the console and both wallets settle', async () => {
      await signOutInBrowser();
      await signIn(ADMIN_EMAIL);
      await visit('/app/admin.html', { waitFor: 'document.querySelectorAll(".stat").length > 0' });

      const before = await page.eval(`
        const data = await (await fetch('/api/admin/overview', { headers: { accept: 'application/json' } })).json();
        const dispute = data.disputes.find((entry) => entry.milestone_title === ${JSON.stringify(milestoneTitle)});
        return { open: data.counts.openDisputes, amount: dispute.amount, id: dispute.id };
      `);
      assert.ok(before.open >= 1, 'the console should show the open dispute');

      await page.eval(`
        const card = [...document.querySelectorAll('.review-row')]
          .find((node) => node.textContent.includes(${JSON.stringify(milestoneTitle)}));
        [...card.querySelectorAll('button')].find((node) => /^Split$/i.test(node.textContent.trim())).click();
        return true;
      `);
      await page.waitFor(`!!document.querySelector('#resolve-form')`);
      await page.type('#resolve-form [name="talent_share"]', String(Math.round(before.amount * 0.7 * 100) / 100));
      await page.type('#resolve-form [name="resolution"]',
        'Most deliverables landed; two were incomplete, so the client keeps thirty percent.');
      await page.click('#resolve-form button[type="submit"]');

      await page.waitFor(`
        const data = await (await fetch('/api/admin/overview', { headers: { accept: 'application/json' } })).json();
        const dispute = data.disputes.find((entry) => entry.id === ${JSON.stringify(before.id)});
        return dispute.status === 'resolved';
      `, { timeout: 12000 });

      const resolved = await page.eval(`
        const data = await (await fetch('/api/admin/overview', { headers: { accept: 'application/json' } })).json();
        const dispute = data.disputes.find((entry) => entry.id === ${JSON.stringify(before.id)});
        return { outcome: dispute.outcome, share: dispute.talent_share };
      `);
      assert.equal(resolved.outcome, 'split');
      assert.equal(resolved.share, Math.round(before.amount * 0.7 * 100) / 100);
      assert.deepEqual(page.hardErrors(), []);
    });

    it('the specialist\u2019s ledger shows the split settling only its share', async () => {
      await signOutInBrowser();
      await signIn(TALENT_EMAIL);
      await visit('/app/payments.html', { waitFor: 'document.querySelectorAll(".ledger tbody tr").length > 0' });

      const row = await page.eval(`
        const data = await (await fetch('/api/payments', { headers: { accept: 'application/json' } })).json();
        const payment = data.payments.find((entry) => entry.status === 'split');
        const cells = [...document.querySelectorAll('.ledger tbody tr')]
          .map((node) => node.textContent)
          .find((text) => /settled/i.test(text));
        return { payment, cells };
      `);
      assert.ok(row.payment, 'a split payment should be on the ledger');
      assert.ok(row.payment.settled_amount > 0 && row.payment.settled_amount < row.payment.amount,
        `a split settles part of its amount: ${JSON.stringify(row.payment)}`);
      assert.ok(row.cells, 'the split row should annotate what actually settled');

      // The headline figure must be the money received, not the milestone amount.
      const totals = await page.eval(`
        const tiles = [...document.querySelectorAll('.stat')]
          .map((node) => node.textContent.replace(/\\s+/g, ' ').trim());
        return tiles.find((text) => /Total earned/i.test(text));
      `);
      assert.ok(/arbitrated/i.test(totals), `the earnings tile should count the arbitrated payment: ${totals}`);
      assert.deepEqual(page.hardErrors(), []);
    });
  });

  describe('message attachments', () => {
    /** Opens the first project's message thread and returns its project id. */
    async function openMessages() {
      const projectId = await page.eval(`
        const data = await (await fetch('/api/projects', { headers: { accept: 'application/json' } })).json();
        return data.projects[0].id;
      `);
      await visit(`/app/project.html?id=${projectId}`, { waitFor: 'document.querySelectorAll(".milestone").length > 0' });
      await page.eval(`
        [...document.querySelectorAll('.tab')].find((node) => /messages/i.test(node.textContent)).click();
        return true;
      `);
      await page.waitFor(`!!document.querySelector('.composer')`);
      return projectId;
    }

    before(async () => {
      await signOutInBrowser();
      await signIn(CLIENT_EMAIL);
    });

    it('a link attachment posts and renders as a safe external link', async () => {
      await openMessages();

      await page.type('.composer [name="body"]', 'Latest preview is up.');
      await page.type('.composer [name="attachment"]', 'https://preview.example.com/build/42');
      await page.click('.composer button[type="submit"]');

      await page.waitFor(`
        return [...document.querySelectorAll('a.attachment')]
          .some((node) => node.getAttribute('href') === 'https://preview.example.com/build/42');
      `, { timeout: 12000 });

      const link = await page.eval(`
        const node = [...document.querySelectorAll('a.attachment')]
          .find((candidate) => candidate.getAttribute('href') === 'https://preview.example.com/build/42');
        return { rel: node.getAttribute('rel'), target: node.getAttribute('target'), text: node.textContent.trim() };
      `);
      assert.match(link.rel, /noopener/, 'an external link must not leak window.opener');
      assert.equal(link.target, '_blank');
      assert.match(link.text, /preview\.example\.com/, 'the label shows the host, not the raw URL');
      assert.deepEqual(page.hardErrors(), []);
    });

    it('a non-link attachment is refused with a field message', async () => {
      await openMessages();

      await page.type('.composer [name="body"]', 'Here is the file.');
      await page.type('.composer [name="attachment"]', 'notes.pdf');
      await page.click('.composer button[type="submit"]');

      await page.waitFor(`
        const alert = document.querySelector('.composer .alert');
        return !!alert && !alert.hidden;
      `, { timeout: 12000 });

      const message = await page.eval(`return document.querySelector('.composer .alert').textContent;`);
      assert.match(message, /http/i, `expected an http hint, got: ${message}`);

      // The message must not have been posted.
      const posted = await page.eval(`
        return [...document.querySelectorAll('.bubble p')].some((node) => node.textContent.trim() === 'Here is the file.');
      `);
      assert.equal(posted, false, 'a rejected message stays out of the thread');
    });
  });

  describe('rate limiting through the UI', () => {
    it('a locked-out login paints the server\u2019s retry message on the form', async () => {
      // A unique address gets its own bucket, so this cannot lock out a demo
      // account other tests rely on. The login limiter allows 12 per window.
      const email = `browser-lockout-${Date.now().toString(36)}@example.test`;

      await page.goto(`${server.baseUrl}/login.html`);
      await page.waitFor(`!!document.querySelector('#form')`);

      // Burn the allowance over fetch: twelve form submissions would be slow and
      // would prove nothing the thirteenth does not.
      const statuses = await page.eval(`
        const seen = [];
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ email: ${JSON.stringify(email)}, password: 'definitely-wrong' })
          });
          seen.push(response.status);
        }
        return seen;
      `);
      assert.ok(statuses.every((status) => status === 400),
        `the allowance should not run out early: ${JSON.stringify(statuses)}`);

      // The next attempt goes through the real form.
      page.clearErrors();
      await page.type('#form [name="email"]', email);
      await page.type('#form [name="password"]', 'definitely-wrong');
      await page.click('#form button[type="submit"]');

      await page.waitFor(`
        const box = document.querySelector('#form-error');
        return !!box && !box.hidden && box.textContent.length > 0;
      `, { timeout: 12000 });

      const shown = await page.eval(`return document.querySelector('#form-error').textContent;`);
      assert.match(shown, /too many attempts/i, `expected a rate-limit message, got: ${shown}`);
      assert.match(shown, /try again in \d+s/i, 'the message should say how long to wait');

      // Still on the login page, and the submit button is usable again.
      assert.equal(await page.eval('return location.pathname;'), '/login.html');
      assert.equal(await page.eval(`return document.querySelector('#form button[type="submit"]').disabled;`), false,
        'the form should not be left stuck in its busy state');
    });
  });
});
