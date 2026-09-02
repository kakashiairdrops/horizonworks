'use strict';

/**
 * Captures screenshots of every significant page, signed in as each role.
 * Output goes to the directory given as the first argument (default ./shots).
 *
 * Usage: node scripts/screenshots.js [outDir] [baseUrl]
 */

const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const outDir = path.resolve(process.argv[2] || 'shots');
const baseUrl = process.argv[3] || 'http://127.0.0.1:3210';
const PASSWORD = 'horizon-demo-2025';

const PUBLIC_PAGES = [
  ['01-landing', '/', `document.querySelector('#stat-talent').textContent.trim() !== '\u2014'`],
  ['02-directory', '/talent-directory.html', `document.querySelectorAll('.person').length > 0`],
  ['03-login', '/login.html', `!!document.querySelector('#form')`],
  ['04-signup', '/signup.html', `!!document.querySelector('#form')`]
];

const ROLE_PAGES = {
  'alex@northstar.test': [
    ['10-client-dashboard', '/app/dashboard.html', `document.querySelectorAll('.stat').length > 0`],
    ['11-client-briefs', '/app/briefs.html', `document.querySelectorAll('.brief-card').length > 0`],
    ['13-client-directory', '/app/talent.html', `document.querySelectorAll('.person').length > 0`],
    ['14-client-projects', '/app/projects.html', `document.querySelectorAll('.brief-card').length > 0`],
    ['16-client-payments', '/app/payments.html', `document.querySelectorAll('.stat').length > 0`],
    ['17-client-settings', '/app/settings.html', `!!document.querySelector('#account-form')`]
  ],
  'maya@horizon.test': [
    ['20-talent-dashboard', '/app/dashboard.html', `document.querySelectorAll('.stat').length > 0`],
    ['21-talent-profile', '/app/profile.html', `!!document.querySelector('#profile-form')`],
    ['22-talent-opportunities', '/app/opportunities.html', `!!document.querySelector('#page .brief-card, #page .empty')`],
    ['23-talent-invitations', '/app/invitations.html', `!!document.querySelector('#page .brief-card, #page .empty')`],
    ['24-talent-earnings', '/app/payments.html', `document.querySelectorAll('.stat').length > 0`]
  ],
  'admin@horizon.test': [
    ['30-admin-console', '/app/admin.html', `document.querySelectorAll('.stat').length > 0`]
  ]
};

/** Opens the split-resolution modal on whichever dispute is awaiting a decision. */
async function shootDisputeModal(page) {
  await page.goto(`${baseUrl}/app/admin.html`);
  await page.waitFor(`document.querySelectorAll('.stat').length > 0`);
  const opened = await page.eval(`
    const card = [...document.querySelectorAll('.review-row')]
      .find((node) => [...node.querySelectorAll('button')].some((b) => /^Split$/i.test(b.textContent.trim())));
    if (!card) return false;
    [...card.querySelectorAll('button')].find((b) => /^Split$/i.test(b.textContent.trim())).click();
    return true;
  `);
  if (!opened) return null;
  await page.waitFor(`!!document.querySelector('#resolve-form')`);
  await sleep(250);
  return shoot(page, '31-admin-dispute-split');
}

async function shoot(page, name, { full = false } = {}) {
  const file = path.join(outDir, `${name}.png`);
  await page.call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: full ? 2400 : 1000,
    deviceScaleFactor: 1,
    mobile: false
  });
  await sleep(250);
  await page.screenshot(file);
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`  ${name}.png  ${size} KB`);
  return file;
}

async function signIn(page, email) {
  await page.goto(`${baseUrl}/login.html`);
  await page.waitFor(`!!document.querySelector('#form')`);
  await page.type('#form [name="email"]', email);
  await page.type('#form [name="password"]', PASSWORD);
  await page.click('#form button[type="submit"]');
  await page.waitFor(`location.pathname.startsWith('/app/')`, { timeout: 15000 });
}

async function signOut(page) {
  await page.eval(`
    const me = await (await fetch('/api/auth/me', { headers: { accept: 'application/json' } })).json();
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrfToken || '' } });
    return true;
  `);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const page = await browser.newPage();
  const written = [];

  try {
    console.log('public pages:');
    for (const [name, url, waitFor] of PUBLIC_PAGES) {
      await page.goto(`${baseUrl}${url}`);
      if (waitFor) await page.waitFor(waitFor).catch(() => {});
      written.push(await shoot(page, name, { full: name === '01-landing' }));
    }

    // A specialist profile, reached from the directory so the id is real.
    await page.goto(`${baseUrl}/talent-directory.html`);
    await page.waitFor(`document.querySelectorAll('.person').length > 0`);
    const href = await page.eval(`
      return document.querySelector('.person a[href^="/talent-profile.html"]').getAttribute('href');
    `);
    await page.goto(`${baseUrl}${href}`);
    await page.waitFor(`!!document.querySelector('.profile-hero h1')`);
    written.push(await shoot(page, '05-talent-profile-public'));

    for (const [email, pages] of Object.entries(ROLE_PAGES)) {
      console.log(`${email}:`);
      await signIn(page, email);
      for (const [name, url, waitFor] of pages) {
        await page.goto(`${baseUrl}${url}`);
        if (waitFor) await page.waitFor(waitFor).catch(() => {});
        written.push(await shoot(page, name));
      }

      if (email === 'alex@northstar.test') {
        // The shortlist and the project room both need a real id from the API.
        const briefId = await page.eval(`
          const data = await (await fetch('/api/briefs?limit=5', { headers: { accept: 'application/json' } })).json();
          return data.briefs[0].id;
        `);
        await page.goto(`${baseUrl}/app/matches.html?brief=${briefId}`);
        await page.waitFor(`document.querySelectorAll('.match-card').length > 0`);
        written.push(await shoot(page, '12-client-shortlist', { full: true }));

        const projectId = await page.eval(`
          const data = await (await fetch('/api/projects', { headers: { accept: 'application/json' } })).json();
          return data.projects[0].id;
        `);
        await page.goto(`${baseUrl}/app/project.html?id=${projectId}`);
        await page.waitFor(`document.querySelectorAll('.milestone').length > 0`);
        written.push(await shoot(page, '15-client-project-room', { full: true }));

        await page.eval(`
          [...document.querySelectorAll('.tab')].find((n) => /messages/i.test(n.textContent)).click();
          return true;
        `);
        await page.waitFor(`!!document.querySelector('.thread')`);
        written.push(await shoot(page, '15b-client-project-messages'));
      }

      if (email === 'admin@horizon.test') {
        const modal = await shootDisputeModal(page);
        if (modal) written.push(modal);
        else console.log('  (no open dispute to photograph)');
      }

      await signOut(page);
    }

    const errors = page.hardErrors();
    if (errors.length) console.log(`\nconsole errors seen:\n  ${errors.join('\n  ')}`);
    console.log(`\n${written.length} screenshots in ${outDir}`);
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
