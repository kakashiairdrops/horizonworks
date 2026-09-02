'use strict';

/**
 * End-to-end API coverage: public reads, brief creation, matching, and the full
 * invitation → project → escrow lifecycle, all over real HTTP.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { startServer, createClient, login, uniqueEmail, LONG_PASSWORD } = require('./helpers');

const CLIENT_EMAIL = 'alex@northstar.test';

const briefPayload = (overrides = {}) => ({
  title: 'Northstar launch site refresh',
  description: 'A conversion-first marketing site with a considered design system and CMS-backed pages.',
  category: 'Web development',
  budget_min: 2000,
  budget_max: 6000,
  asset: 'USDC',
  network: 'Base',
  start_window: 'this_week',
  engagement: 'project',
  skills: ['React', 'Node.js'],
  ...overrides
});

describe('Horizon API', () => {
  let server;
  let baseUrl;
  let db;
  let clientSession;
  let pendingTalentId;

  const emailFor = (userId) => db.prepare('SELECT email FROM users WHERE id = ?').get(userId).email;

  before(async () => {
    server = await startServer();
    baseUrl = server.baseUrl;
    db = server.app.db;

    clientSession = createClient(baseUrl);
    const loggedIn = await login(clientSession, CLIENT_EMAIL);
    assert.equal(loggedIn.status, 200, 'seeded client should log in');
  });

  after(async () => {
    await server.close();
  });

  describe('public reads', () => {
    it('GET /api/health responds without a session', async () => {
      const response = await createClient(baseUrl).get('/api/health');
      assert.equal(response.status, 200);
      assert.equal(response.body.ok, true);
      assert.equal(typeof response.body.uptime, 'number');
    });

    it('GET /api/stats is public and returns the expected shape', async () => {
      const response = await createClient(baseUrl).get('/api/stats');
      assert.equal(response.status, 200);
      const stats = response.body;
      assert.equal(typeof stats.talent, 'number');
      assert.equal(typeof stats.availableNow, 'number');
      assert.equal(typeof stats.settled, 'number');
      assert.equal(typeof stats.activeProjects, 'number');
      assert.equal(typeof stats.countries, 'number');
      assert.ok(Array.isArray(stats.skillMix));
      assert.equal(stats.talent, 10, 'the demo seed approves ten specialists');
      assert.ok(stats.availableNow <= stats.talent);
      for (const bucket of stats.skillMix) {
        assert.equal(typeof bucket.category, 'string');
        assert.equal(typeof bucket.n, 'number');
      }
    });

    it('GET /api/talent is public, paginated, and only lists approved profiles', async () => {
      const response = await createClient(baseUrl).get('/api/talent?limit=50');
      assert.equal(response.status, 200);
      assert.equal(response.body.total, 10);
      assert.equal(response.body.talent.length, 10);
      for (const person of response.body.talent) {
        assert.equal(person.status, 'approved');
        assert.equal(typeof person.id, 'string');
        assert.equal(typeof person.name, 'string');
        assert.equal(typeof person.headline, 'string');
        assert.equal(typeof person.rateMin, 'number');
        assert.equal(typeof person.verified, 'boolean');
        assert.ok(Array.isArray(person.skills));
      }
    });

    it('hides a profile that is not approved', async () => {
      const talent = createClient(baseUrl);
      const email = uniqueEmail('pending-talent');
      const signedUp = await talent.signup({ name: 'Pending Person', email, password: LONG_PASSWORD, role: 'talent' });
      assert.equal(signedUp.status, 201);
      pendingTalentId = signedUp.body.user.id;

      const listing = await createClient(baseUrl).get('/api/talent?limit=50');
      assert.equal(listing.body.total, 10, 'a pending profile must not appear');
      assert.equal(listing.body.talent.some((person) => person.id === pendingTalentId), false);
    });

    it('a non-approved profile is not retrievable by id', async () => {
      const response = await createClient(baseUrl).get(`/api/talent/${pendingTalentId}`);
      assert.equal(response.status, 404, 'a hidden profile should not be readable by id either');
    });

    it('the owner can still read their own pending profile by id', async () => {
      const owner = createClient(baseUrl);
      const email = uniqueEmail('owner-reads-self');
      const signedUp = await owner.signup({ name: 'Owner Reads Self', email, password: LONG_PASSWORD, role: 'talent' });
      assert.equal(signedUp.status, 201);
      const response = await owner.get(`/api/talent/${signedUp.body.user.id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.talent.status, 'pending');
    });

    it('GET /api/skills lists the seeded skill catalogue', async () => {
      const response = await createClient(baseUrl).get('/api/skills');
      assert.equal(response.status, 200);
      assert.equal(response.body.skills.length, 24);
      assert.ok(response.body.skills.some((skill) => skill.name === 'Next.js'));
    });

    it('GET /api/talent/:userId returns one profile plus reviews, 404 for an unknown id', async () => {
      const listing = await createClient(baseUrl).get('/api/talent?limit=1');
      const first = listing.body.talent[0];
      const response = await createClient(baseUrl).get(`/api/talent/${first.id}`);
      assert.equal(response.status, 200);
      assert.equal(response.body.talent.id, first.id);
      assert.ok(Array.isArray(response.body.reviews));

      const missing = await createClient(baseUrl).get('/api/talent/usr_nope');
      assert.equal(missing.status, 404);
    });
  });

  describe('talent directory filters', () => {
    const publicClient = () => createClient(baseUrl);

    it('filters by availability', async () => {
      const response = await publicClient().get('/api/talent?availability=available_now&limit=50');
      assert.equal(response.status, 200);
      assert.ok(response.body.total > 0);
      assert.ok(response.body.total < 10, 'not everyone is available now');
      for (const person of response.body.talent) assert.equal(person.availability, 'available_now');
    });

    it('filters by skill', async () => {
      const response = await publicClient().get('/api/talent?skill=Next.js&limit=50');
      assert.equal(response.status, 200);
      assert.ok(response.body.total >= 1);
      for (const person of response.body.talent) assert.ok(person.skills.includes('Next.js'));
    });

    it('requires every requested skill when several are given', async () => {
      const both = await publicClient().get('/api/talent?skill=React,Node.js&limit=50');
      assert.equal(both.status, 200);
      for (const person of both.body.talent) {
        assert.ok(person.skills.includes('React') && person.skills.includes('Node.js'));
      }
      const onlyReact = await publicClient().get('/api/talent?skill=React&limit=50');
      assert.ok(onlyReact.body.total >= both.body.total);
    });

    it('rejects an unknown skill name with 400', async () => {
      const response = await publicClient().get('/api/talent?skill=Fortran');
      assert.equal(response.status, 400);
      assert.match(response.body.error, /Unknown skills: Fortran/);
    });

    it('filters by max_rate against rate_min', async () => {
      const response = await publicClient().get('/api/talent?max_rate=70&limit=50');
      assert.equal(response.status, 200);
      assert.ok(response.body.total > 0);
      for (const person of response.body.talent) assert.ok(person.rateMin <= 70, `${person.name} rateMin=${person.rateMin}`);
    });

    it('filters by payout asset, network, and verified flag', async () => {
      const usdc = await publicClient().get('/api/talent?asset=USDC&network=Base&limit=50');
      assert.ok(usdc.body.total > 0);
      for (const person of usdc.body.talent) {
        assert.equal(person.payoutAsset, 'USDC');
        assert.equal(person.payoutNetwork, 'Base');
      }
      const verified = await publicClient().get('/api/talent?verified=true&limit=50');
      for (const person of verified.body.talent) assert.equal(person.verified, true);
      assert.ok(verified.body.total < 10, 'the seed includes unverified specialists');
    });

    it('reports page/limit/total/pages and paginates without overlap', async () => {
      const first = await publicClient().get('/api/talent?limit=4&page=1');
      assert.equal(first.status, 200);
      assert.equal(first.body.page, 1);
      assert.equal(first.body.limit, 4);
      assert.equal(first.body.total, 10);
      assert.equal(first.body.pages, 3);
      assert.equal(first.body.talent.length, 4);

      const third = await publicClient().get('/api/talent?limit=4&page=3');
      assert.equal(third.body.page, 3);
      assert.equal(third.body.talent.length, 2, 'the last page holds the remainder');

      const firstIds = new Set(first.body.talent.map((person) => person.id));
      assert.equal(third.body.talent.some((person) => firstIds.has(person.id)), false);
    });

    it('sorts by rate_low ascending', async () => {
      const response = await publicClient().get('/api/talent?limit=50&sort=rate_low');
      const rates = response.body.talent.map((person) => person.rateMin);
      assert.deepEqual(rates, [...rates].sort((a, b) => a - b));
    });

    it('supports free-text search on q', async () => {
      const response = await publicClient().get('/api/talent?q=Maya&limit=50');
      assert.equal(response.body.total, 1);
      assert.equal(response.body.talent[0].name, 'Maya Chen');
    });

    it('applies the documented default limit of 12 when none is given', async () => {
      const response = await publicClient().get('/api/talent');
      assert.equal(response.status, 200);
      assert.equal(response.body.limit, 12, 'talent.routes.js documents a default of 12');
      assert.equal(response.body.pages, 1);
      assert.equal(response.body.talent.length, 10, 'all ten seeded specialists fit on one page');
    });

    it('falls back to the default for a non-numeric or empty limit', async () => {
      for (const query of ['?limit=abc', '?limit=']) {
        const response = await publicClient().get(`/api/talent${query}`);
        assert.equal(response.body.limit, 12, `${query} should fall back to the default`);
      }
    });

    it('clamps the limit to the 1..50 range', async () => {
      assert.equal((await publicClient().get('/api/talent?limit=0')).body.limit, 1);
      assert.equal((await publicClient().get('/api/talent?limit=500')).body.limit, 50);
      assert.equal((await publicClient().get('/api/talent?page=0&limit=5')).body.page, 1);
    });
  });

  describe('inquiries', () => {
    it('POST /api/inquiries works unauthenticated and returns 201', async () => {
      const response = await createClient(baseUrl).post('/api/inquiries', {
        name: 'Priya Raman', email: uniqueEmail('inquiry'), role: 'client',
        service: 'App development', settlement: 'USDC', note: 'Looking for an iOS partner.'
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.ok, true);
      assert.match(response.body.id, /^inq_/);
    });

    it('validates the inquiry body', async () => {
      const response = await createClient(baseUrl).post('/api/inquiries', { name: 'A', email: 'not-an-email' });
      assert.equal(response.status, 400);
      assert.equal(response.body.details.name, 'Name must be at least 2 characters.');
      assert.equal(response.body.details.email, 'Enter a valid email address.');
    });
  });

  describe('briefs', () => {
    it('a client can create a brief and gets 201 with the shaped brief', async () => {
      const response = await clientSession.post('/api/briefs', briefPayload());
      assert.equal(response.status, 201);
      const brief = response.body.brief;
      assert.match(brief.id, /^brf_/);
      assert.equal(brief.title, 'Northstar launch site refresh');
      assert.equal(brief.status, 'open');
      assert.equal(brief.budgetMin, 2000);
      assert.equal(brief.budgetMax, 6000);
      assert.equal(brief.engagement, 'project');
      assert.deepEqual([...brief.skills].sort(), ['Node.js', 'React']);
      assert.equal(brief.invitationCount, 0);
    });

    it('rejects budget_max < budget_min with 400 + details.budget_max', async () => {
      const response = await clientSession.post('/api/briefs', briefPayload({ budget_min: 5000, budget_max: 1000 }));
      assert.equal(response.status, 400);
      assert.equal(response.body.details.budget_max, 'Maximum budget must be at least the minimum.');
    });

    it('rejects a brief missing required fields', async () => {
      const response = await clientSession.post('/api/briefs', { title: 'Too short' });
      assert.equal(response.status, 400);
      assert.equal(response.body.details.description, 'Description is required.');
      assert.equal(response.body.details.category, 'Category is required.');
      assert.equal(response.body.details.skills, 'Skills is required.');
    });

    it('rejects an unknown skill name on a brief', async () => {
      const response = await clientSession.post('/api/briefs', briefPayload({ skills: ['COBOL'] }));
      assert.equal(response.status, 400);
      assert.match(response.body.error, /Unknown skills: COBOL/);
    });

    it('GET /api/briefs lists only the calling client’s briefs', async () => {
      const response = await clientSession.get('/api/briefs?limit=50');
      assert.equal(response.status, 200);
      assert.ok(response.body.briefs.length > 0);
      const clientId = (await clientSession.get('/api/auth/me')).body.user.id;
      for (const brief of response.body.briefs) assert.equal(brief.clientId, clientId);
    });

    it('GET /api/briefs returns every brief the client owns by default', async () => {
      const withLimit = await clientSession.get('/api/briefs?limit=50');
      const withoutLimit = await clientSession.get('/api/briefs');
      assert.ok(withLimit.body.briefs.length > 1, 'the client owns more than one brief by now');
      assert.equal(withoutLimit.body.briefs.length, withLimit.body.briefs.length,
        'briefs.routes.js documents a default limit of 25');
    });

    it('GET /api/briefs/:id/matches returns scores sorted descending with breakdown + reasons', async () => {
      const brief = (await clientSession.post('/api/briefs', briefPayload({ title: 'Matching probe brief' }))).body.brief;
      const response = await clientSession.get(`/api/briefs/${brief.id}/matches?limit=10`);
      assert.equal(response.status, 200);
      assert.equal(response.body.brief.id, brief.id);

      const matches = response.body.matches;
      assert.ok(matches.length > 1, 'the seeded pool should return several matches');
      const scores = matches.map((match) => match.score);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'matches must be sorted by score descending');

      for (const match of matches) {
        assert.ok(match.score >= 0 && match.score <= 100);
        assert.equal(typeof match.breakdown, 'object');
        assert.deepEqual(
          Object.keys(match.breakdown).sort(),
          ['availability', 'budget', 'reputation', 'settlement', 'skills']
        );
        assert.ok(Array.isArray(match.reasons));
        assert.ok(match.reasons.length > 0);
        assert.ok(Array.isArray(match.matchedSkills));
        assert.equal(typeof match.invited, 'boolean');
        assert.equal(typeof match.talent.id, 'string');
        assert.equal(typeof match.talent.name, 'string');
      }
    });

    it('honours the matches limit parameter', async () => {
      const brief = (await clientSession.get('/api/briefs?limit=50')).body.briefs[0];
      const response = await clientSession.get(`/api/briefs/${brief.id}/matches?limit=3`);
      assert.equal(response.body.matches.length, 3);
    });

    it('returns up to 8 matches by default', async () => {
      const brief = (await clientSession.get('/api/briefs?limit=50')).body.briefs[0];
      const response = await clientSession.get(`/api/briefs/${brief.id}/matches`);
      assert.equal(response.status, 200);
      assert.equal(response.body.matches.length, 8, 'briefs.routes.js documents a default limit of 8');
    });

    it('hides shortlists from talent and unknown briefs 404', async () => {
      const brief = (await clientSession.get('/api/briefs?limit=50')).body.briefs[0];
      const talent = createClient(baseUrl);
      const signedUp = await talent.signup({
        name: 'Shortlist Peeker', email: uniqueEmail('peeker'), password: LONG_PASSWORD, role: 'talent'
      });
      assert.equal(signedUp.status, 201);

      const denied = await talent.get(`/api/briefs/${brief.id}/matches`);
      assert.equal(denied.status, 403);

      const missing = await clientSession.get('/api/briefs/brf_missing/matches');
      assert.equal(missing.status, 404);
    });
  });

  describe('full lifecycle: brief → invitation → project → escrow', () => {
    let brief;
    let talentSession;
    let projectId;
    let milestones;

    it('the client creates a brief', async () => {
      const response = await clientSession.post('/api/briefs', briefPayload({ title: 'Lifecycle: rebuild the site' }));
      assert.equal(response.status, 201);
      brief = response.body.brief;
      assert.equal(brief.status, 'open');
    });

    it('the client invites the top-ranked specialist', async () => {
      const matches = await clientSession.get(`/api/briefs/${brief.id}/matches?limit=1`);
      const top = matches.body.matches[0];
      assert.equal(top.invited, false);

      const response = await clientSession.post(`/api/briefs/${brief.id}/invitations`, {
        talent_id: top.talent.id, message: 'Your Next.js work looks like a strong fit.'
      });
      assert.equal(response.status, 201);
      assert.equal(response.body.invitation.status, 'sent');
      assert.equal(response.body.invitation.talent_id, top.talent.id);
      assert.equal(response.body.invitation.score, top.score, 'the stored score matches the shortlist score');

      const duplicate = await clientSession.post(`/api/briefs/${brief.id}/invitations`, { talent_id: top.talent.id });
      assert.equal(duplicate.status, 409);

      talentSession = createClient(baseUrl);
      const loggedIn = await login(talentSession, emailFor(top.talent.id));
      assert.equal(loggedIn.status, 200);
      assert.equal(loggedIn.body.user.role, 'talent');
    });

    it('the invited talent accepts, creating a project with three planned milestones', async () => {
      const invitations = await talentSession.get('/api/invitations');
      assert.equal(invitations.status, 200);
      const invitation = invitations.body.invitations.find((entry) => entry.brief_id === brief.id);
      assert.ok(invitation, 'the talent should see the invitation');
      assert.equal(invitation.status, 'sent');

      const response = await talentSession.post(`/api/invitations/${invitation.id}/respond`, { action: 'accept' });
      assert.equal(response.status, 201);
      assert.equal(response.body.invitation.status, 'accepted');
      projectId = response.body.projectId;
      assert.match(projectId, /^prj_/);

      const again = await talentSession.post(`/api/invitations/${invitation.id}/respond`, { action: 'accept' });
      assert.equal(again.status, 409, 'an invitation cannot be answered twice');

      const project = await clientSession.get(`/api/projects/${projectId}`);
      assert.equal(project.status, 200);
      assert.equal(project.body.project.status, 'active');
      assert.equal(project.body.project.briefId, brief.id);

      milestones = project.body.project.milestones;
      assert.equal(milestones.length, 3, 'accepting seeds a three-part milestone plan');
      assert.deepEqual(milestones.map((milestone) => milestone.status), ['planned', 'planned', 'planned']);
      assert.deepEqual(milestones.map((milestone) => milestone.position), [1, 2, 3]);
      const total = milestones.reduce((sum, milestone) => sum + milestone.amount, 0);
      assert.equal(total, briefPayload().budget_max, 'the plan splits the agreed budget exactly');

      const updatedBrief = await clientSession.get(`/api/briefs/${brief.id}`);
      assert.equal(updatedBrief.body.brief.status, 'matched');
    });

    it('the client funds the first milestone (planned → funded)', async () => {
      const response = await clientSession.post(`/api/milestones/${milestones[0].id}/fund`);
      assert.equal(response.status, 200);
      assert.equal(response.body.payment.status, 'escrow_funded');
      assert.equal(response.body.payment.amount, milestones[0].amount);
      assert.equal(response.body.payment.fee, Math.round(milestones[0].amount * 0.03 * 100) / 100);

      const project = await clientSession.get(`/api/projects/${projectId}`);
      assert.equal(project.body.project.milestones[0].status, 'funded');
      assert.equal(project.body.project.totals.escrow, milestones[0].amount);

      const twice = await clientSession.post(`/api/milestones/${milestones[0].id}/fund`);
      assert.equal(twice.status, 409, 'a funded milestone cannot be funded again');
    });

    it('the talent submits the funded milestone (funded → submitted)', async () => {
      const tooEarly = await talentSession.post(`/api/milestones/${milestones[1].id}/submit`);
      assert.equal(tooEarly.status, 409, 'a planned milestone cannot be submitted');

      const response = await talentSession.post(`/api/milestones/${milestones[0].id}/submit`);
      assert.equal(response.status, 200);
      assert.equal(response.body.milestone.status, 'submitted');

      const project = await clientSession.get(`/api/projects/${projectId}`);
      assert.equal(project.body.project.milestones[0].status, 'submitted');
    });

    it('the client releases the milestone (submitted → paid)', async () => {
      const response = await clientSession.post(`/api/milestones/${milestones[0].id}/release`);
      assert.equal(response.status, 200);
      assert.equal(response.body.payment.status, 'released');
      assert.ok(response.body.payment.settled_at, 'a released payment records settled_at');

      const project = await clientSession.get(`/api/projects/${projectId}`);
      assert.equal(project.body.project.milestones[0].status, 'paid');
      assert.equal(project.body.project.totals.paid, milestones[0].amount);
      assert.equal(project.body.project.totals.escrow, 0);
      assert.equal(
        project.body.project.totals.progress,
        Math.round((milestones[0].amount / project.body.project.totals.total) * 100)
      );
      assert.equal(project.body.payments.length, 1);
    });

    it('the talent sees the milestone in their own payments feed', async () => {
      const response = await talentSession.get('/api/payments');
      assert.equal(response.status, 200);
      assert.equal(response.body.feeRate, 0.03);
      const payment = response.body.payments.find((entry) => entry.milestone_id === milestones[0].id);
      assert.ok(payment, 'the payee should see the payment');
      assert.equal(payment.status, 'released');
    });

    describe('authorization inside a project', () => {
      it('a talent cannot fund a milestone', async () => {
        const response = await talentSession.post(`/api/milestones/${milestones[1].id}/fund`);
        assert.ok(response.status >= 400, `expected non-2xx, got ${response.status}`);
        assert.equal(response.status, 400);
        assert.match(response.body.error, /Only the client can fund/);
      });

      it('a talent cannot release a milestone or add one', async () => {
        await clientSession.post(`/api/milestones/${milestones[1].id}/fund`);
        const release = await talentSession.post(`/api/milestones/${milestones[1].id}/release`);
        assert.ok(release.status >= 400);
        assert.match(release.body.error, /Only the client can release/);

        const added = await talentSession.post(`/api/projects/${projectId}/milestones`, { title: 'Extra scope', amount: 100 });
        assert.equal(added.status, 403);
      });

      it('a client cannot submit work on the talent’s behalf', async () => {
        const response = await clientSession.post(`/api/milestones/${milestones[1].id}/submit`);
        assert.ok(response.status >= 400);
        assert.match(response.body.error, /Only the assigned specialist/);
      });

      it('an unrelated third user gets 403/404 on GET /api/projects/:id', async () => {
        const stranger = createClient(baseUrl);
        const signedUp = await stranger.signup({
          name: 'Unrelated Party', email: uniqueEmail('stranger'), password: LONG_PASSWORD, role: 'client'
        });
        assert.equal(signedUp.status, 201);

        const response = await stranger.get(`/api/projects/${projectId}`);
        assert.ok([403, 404].includes(response.status), `expected 403/404, got ${response.status}`);
        assert.equal(response.status, 403);
        assert.match(response.body.error, /not part of this project/);

        const listing = await stranger.get('/api/projects');
        assert.equal(listing.status, 200);
        assert.equal(listing.body.projects.length, 0, 'a stranger sees no projects');

        const missing = await stranger.get('/api/projects/prj_does_not_exist');
        assert.equal(missing.status, 404);
      });
    });

    describe('project messages', () => {
      it('a project party can post a message and it appears in GET /api/projects/:id', async () => {
        const before = (await clientSession.get(`/api/projects/${projectId}`)).body.messages.length;

        const posted = await talentSession.post(`/api/projects/${projectId}/messages`, {
          body: 'Kickoff notes are in the shared doc.', attachment: 'https://docs.example.com/kickoff-notes'
        });
        assert.equal(posted.status, 201);
        assert.equal(posted.body.message.body, 'Kickoff notes are in the shared doc.');
        assert.equal(posted.body.message.attachment, 'https://docs.example.com/kickoff-notes');

        const replied = await clientSession.post(`/api/projects/${projectId}/messages`, { body: 'Thanks — reviewing today.' });
        assert.equal(replied.status, 201);
        assert.equal(replied.body.message.attachment, null, 'an attachment is optional');

        const project = await clientSession.get(`/api/projects/${projectId}`);
        const bodies = project.body.messages.map((message) => message.body);
        assert.equal(project.body.messages.length, before + 2);
        assert.ok(bodies.includes('Kickoff notes are in the shared doc.'));
        assert.ok(bodies.includes('Thanks — reviewing today.'));
        for (const message of project.body.messages) {
          assert.equal(typeof message.author_name, 'string');
          assert.equal(typeof message.created_at, 'string');
        }
      });

      it('rejects an attachment that is not an http(s) link', async () => {
        const bad = await talentSession.post(`/api/projects/${projectId}/messages`, {
          body: 'See the file.', attachment: 'javascript:alert(1)'
        });
        assert.equal(bad.status, 400);
        assert.match(bad.body.details.attachment, /http/i);

        const alsoBad = await talentSession.post(`/api/projects/${projectId}/messages`, {
          body: 'See the file.', attachment: 'kickoff-notes.pdf · 1.1 MB'
        });
        assert.equal(alsoBad.status, 400, 'a bare filename is not a usable reference');
      });

      it('rejects an empty message body and blocks non-parties', async () => {
        const empty = await clientSession.post(`/api/projects/${projectId}/messages`, { body: '' });
        assert.equal(empty.status, 400);
        assert.equal(empty.body.details.body, 'Body is required.');

        const stranger = createClient(baseUrl);
        await stranger.signup({
          name: 'Message Intruder', email: uniqueEmail('intruder'), password: LONG_PASSWORD, role: 'client'
        });
        const denied = await stranger.post(`/api/projects/${projectId}/messages`, { body: 'let me in' });
        assert.equal(denied.status, 403);
      });
    });

    describe('disputes over HTTP', () => {
      let adminSession;
      let disputed;

      before(async () => {
        adminSession = createClient(baseUrl);
        await login(adminSession, 'admin@horizon.test');
      });

      it('the talent freezes a submitted milestone and both sides state their case', async () => {
        // milestones[2] is still planned: fund it and submit it.
        disputed = milestones[2];
        await clientSession.post(`/api/milestones/${disputed.id}/fund`);
        await talentSession.post(`/api/milestones/${disputed.id}/submit`);

        const tooShort = await talentSession.post(`/api/milestones/${disputed.id}/dispute`, { reason: 'nope' });
        assert.equal(tooShort.status, 400);
        assert.match(tooShort.body.details.reason, /at least 20 characters/);

        const opened = await talentSession.post(`/api/milestones/${disputed.id}/dispute`, {
          reason: 'Delivered three weeks ago and the client has not responded to the release request.',
          desired: 'release'
        });
        assert.equal(opened.status, 201);
        assert.equal(opened.body.dispute.status, 'open');
        assert.equal(opened.body.dispute.desired, 'release');

        const project = await clientSession.get(`/api/projects/${projectId}`);
        const row = project.body.project.milestones.find((entry) => entry.id === disputed.id);
        assert.equal(row.status, 'disputed');
        assert.equal(project.body.disputes.length, 1, 'the project payload carries its disputes');
        assert.equal(project.body.project.totals.disputed, disputed.amount);

        const answered = await clientSession.post(`/api/disputes/${opened.body.dispute.id}/respond`, {
          response: 'Two of the four agreed deliverables are still missing from the handoff.'
        });
        assert.equal(answered.status, 200);
        assert.equal(answered.body.dispute.status, 'answered');
      });

      it('neither party can move the money while it is frozen', async () => {
        const release = await clientSession.post(`/api/milestones/${disputed.id}/release`);
        assert.equal(release.status, 409);
        assert.match(release.body.error, /under dispute/);

        const refund = await clientSession.post(`/api/milestones/${disputed.id}/refund`);
        assert.equal(refund.status, 409);
      });

      it('only an admin can resolve it', async () => {
        const list = await adminSession.get('/api/admin/overview');
        assert.equal(list.status, 200);
        assert.equal(list.body.counts.openDisputes, 1);
        const dispute = list.body.disputes[0];
        assert.equal(dispute.status, 'answered');
        assert.equal(typeof dispute.client_name, 'string');
        assert.equal(typeof dispute.talent_name, 'string');

        const asClient = await clientSession.post(`/api/admin/disputes/${dispute.id}/resolve`, {
          outcome: 'refund', resolution: 'I would like my money back please.'
        });
        assert.equal(asClient.status, 403, 'a client cannot arbitrate their own dispute');

        const asTalent = await talentSession.post(`/api/admin/disputes/${dispute.id}/resolve`, {
          outcome: 'release', resolution: 'Pay me in full, thanks.'
        });
        assert.equal(asTalent.status, 403);
      });

      it('the admin splits the escrow and both wallets settle', async () => {
        const overview = await adminSession.get('/api/admin/overview');
        const dispute = overview.body.disputes[0];

        const clientBefore = (await clientSession.get('/api/payments')).body.wallets[0];
        const talentBefore = (await talentSession.get('/api/payments')).body.wallets[0];

        const tooBig = await adminSession.post(`/api/admin/disputes/${dispute.id}/resolve`, {
          outcome: 'split', talent_share: disputed.amount, resolution: 'Everything to the specialist.'
        });
        assert.equal(tooBig.status, 400, 'a split cannot award the whole amount');

        const share = Math.round(disputed.amount * 0.7 * 100) / 100;
        const resolved = await adminSession.post(`/api/admin/disputes/${dispute.id}/resolve`, {
          outcome: 'split', talent_share: share,
          resolution: 'Most deliverables landed; two were incomplete, so the client keeps 30%.'
        });
        assert.equal(resolved.status, 200);
        assert.equal(resolved.body.dispute.status, 'resolved');
        assert.equal(resolved.body.dispute.outcome, 'split');
        assert.equal(resolved.body.dispute.talent_share, share);

        const clientAfter = (await clientSession.get('/api/payments')).body.wallets[0];
        const talentAfter = (await talentSession.get('/api/payments')).body.wallets[0];
        const round2 = (value) => Math.round(value * 100) / 100;

        assert.equal(round2(talentAfter.available - talentBefore.available), share);
        assert.equal(round2(clientAfter.available - clientBefore.available), round2(disputed.amount - share));
        assert.equal(round2(clientBefore.in_escrow - clientAfter.in_escrow),
          round2(disputed.amount + Math.round(disputed.amount * 0.03 * 100) / 100),
          'the whole held amount including the fee leaves escrow');

        const project = await clientSession.get(`/api/projects/${projectId}`);
        const row = project.body.project.milestones.find((entry) => entry.id === disputed.id);
        assert.equal(row.status, 'resolved');

        const after = await adminSession.get('/api/admin/overview');
        assert.equal(after.body.counts.openDisputes, 0);
        assert.ok(
          after.body.audit.some((entry) => entry.action === 'dispute.split'),
          'the arbitration is recorded in the audit trail'
        );
      });

      it('a split reports only what settled, not the full milestone amount', async () => {
        const share = Math.round(disputed.amount * 0.7 * 100) / 100;
        const ledger = await talentSession.get('/api/payments');
        const payment = ledger.body.payments.find((entry) => entry.milestone_id === disputed.id);

        assert.equal(payment.status, 'split');
        assert.equal(payment.settled_amount, share, 'the row records the arbitrated share');
        assert.equal(payment.amount, disputed.amount, 'the original amount stays on the record');

        // The specialist's headline "earned" figure must match the money received.
        const reported = ledger.body.payments
          .filter((entry) => entry.status === 'released' || entry.status === 'split')
          .reduce((sum, entry) => sum + entry.settled_amount, 0);
        const dashboard = await talentSession.get('/api/dashboard');
        assert.equal(Math.round(dashboard.body.stats.earned * 100) / 100, Math.round(reported * 100) / 100,
          'the dashboard total is the sum of what settled');
        assert.ok(dashboard.body.stats.earned >= share, 'the arbitrated share counts as earnings');

        // And the public landing figure must not double-count the unsettled part.
        const stats = await createClient(baseUrl).get('/api/stats');
        assert.ok(stats.body.settled >= share);
        const escrowed = ledger.body.payments.filter((entry) => entry.status === 'escrow_funded');
        for (const entry of escrowed) {
          assert.equal(entry.settled_amount, 0, 'escrowed money has not settled');
        }
      });

      it('a resolved dispute cannot be resolved again', async () => {
        const overview = await adminSession.get('/api/admin/overview');
        const dispute = overview.body.disputes.find((entry) => entry.status === 'resolved');
        const again = await adminSession.post(`/api/admin/disputes/${dispute.id}/resolve`, {
          outcome: 'release', resolution: 'Actually, give it all to the specialist.'
        });
        assert.equal(again.status, 409);
      });
    });
  });
});
