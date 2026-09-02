'use strict';

const { get, run, all, transaction } = require('../db');
const { requireUser, requireRole } = require('../auth');
const { validate, notFound, badRequest, conflict, forbidden } = require('../validate');
const { created, resolveSkillIds, skillNamesFor, audit, newId, queryInt } = require('../http');
const { rankMatches, loadTalentPool } = require('../matching');
const { notify } = require('../escrow');

const START_WINDOWS = ['this_week', 'two_weeks', 'flexible'];
const ENGAGEMENTS = ['project', 'retainer', 'hourly'];
const CATEGORIES = ['Web development', 'App development', 'AI automation', 'Creative production', 'Web3'];

const briefRules = {
  title: { type: 'string', required: true, min: 6, max: 120 },
  description: { type: 'string', required: true, min: 40, max: 4000 },
  category: { type: 'enum', required: true, values: CATEGORIES },
  budget_min: { type: 'int', required: true, min: 100, max: 1_000_000 },
  budget_max: { type: 'int', required: true, min: 100, max: 1_000_000 },
  asset: { type: 'enum', required: true, values: ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'Fiat'] },
  network: { type: 'enum', required: true, values: ['Base', 'Solana', 'Ethereum', 'Arbitrum', 'Polygon', 'Bank'] },
  start_window: { type: 'enum', required: true, values: START_WINDOWS },
  engagement: { type: 'enum', values: ENGAGEMENTS, default: 'project' },
  skills: { type: 'stringArray', required: true, min: 1, max: 10 },
  status: { type: 'enum', values: ['draft', 'open'], default: 'open' }
};

function shapeBrief(db, row) {
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientCompany: row.client_company,
    title: row.title,
    description: row.description,
    category: row.category,
    budgetMin: row.budget_min,
    budgetMax: row.budget_max,
    asset: row.asset,
    network: row.network,
    startWindow: row.start_window,
    engagement: row.engagement,
    status: row.status,
    createdAt: row.created_at,
    skills: skillNamesFor(db, 'brief_skills', 'brief_id', row.id),
    invitationCount: get(db, 'SELECT count(*) AS n FROM invitations WHERE brief_id = ?', [row.id]).n
  };
}

function loadBrief(db, briefId) {
  const row = get(db, `SELECT b.*, u.name AS client_name, u.company AS client_company
                       FROM briefs b JOIN users u ON u.id = b.client_id WHERE b.id = ?`, [briefId]);
  if (!row) throw notFound('That brief does not exist.');
  return row;
}

function register(router) {
  router.get('/api/briefs', ({ db, session, url }) => {
    const user = requireUser(session);
    const limit = Math.min(Math.max(queryInt(url, 'limit', 25), 1), 50);
    const rows = user.role === 'admin'
      ? all(db, `SELECT b.*, u.name AS client_name, u.company AS client_company FROM briefs b
                 JOIN users u ON u.id = b.client_id ORDER BY b.created_at DESC LIMIT ?`, [limit])
      : user.role === 'client'
        ? all(db, `SELECT b.*, u.name AS client_name, u.company AS client_company FROM briefs b
                   JOIN users u ON u.id = b.client_id WHERE b.client_id = ? ORDER BY b.created_at DESC LIMIT ?`, [user.id, limit])
        // Talent see open briefs matching at least one of their skills.
        : all(db, `SELECT DISTINCT b.*, u.name AS client_name, u.company AS client_company FROM briefs b
                   JOIN users u ON u.id = b.client_id
                   JOIN brief_skills bs ON bs.brief_id = b.id
                   JOIN talent_skills ts ON ts.skill_id = bs.skill_id AND ts.user_id = ?
                   WHERE b.status = 'open' ORDER BY b.created_at DESC LIMIT ?`, [user.id, limit]);
    return { briefs: rows.map((row) => shapeBrief(db, row)) };
  });

  router.post('/api/briefs', ({ db, session, body }) => {
    const user = requireRole(session, 'client', 'admin');
    const data = validate(body, briefRules);
    if (data.budget_max < data.budget_min) {
      throw badRequest('Please correct the highlighted fields.', { budget_max: 'Maximum budget must be at least the minimum.' });
    }
    const skillIds = resolveSkillIds(db, data.skills);
    const briefId = newId('brf');

    transaction(db, () => {
      run(db, `INSERT INTO briefs (id, client_id, title, description, category, budget_min, budget_max,
                                  asset, network, start_window, engagement, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [briefId, user.id, data.title, data.description, data.category, data.budget_min, data.budget_max,
          data.asset, data.network, data.start_window, data.engagement, data.status]);
      for (const skillId of skillIds) {
        run(db, 'INSERT INTO brief_skills (brief_id, skill_id) VALUES (?, ?)', [briefId, skillId]);
      }
    });

    audit(db, user.id, 'brief.created', 'brief', briefId, { category: data.category });
    return created({ brief: shapeBrief(db, loadBrief(db, briefId)) });
  });

  router.get('/api/briefs/:briefId', ({ db, session, params }) => {
    const user = requireUser(session);
    const row = loadBrief(db, params.briefId);
    if (user.role === 'client' && row.client_id !== user.id) throw forbidden('This brief belongs to another workspace.');
    if (user.role === 'talent' && row.status !== 'open') throw forbidden('This brief is not open.');
    return { brief: shapeBrief(db, row) };
  });

  router.patch('/api/briefs/:briefId', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const row = loadBrief(db, params.briefId);
    if (row.client_id !== user.id && user.role !== 'admin') throw forbidden('This brief belongs to another workspace.');

    const data = validate(body, {
      title: { type: 'string', min: 6, max: 120 },
      description: { type: 'string', min: 40, max: 4000 },
      budget_min: { type: 'int', min: 100, max: 1_000_000 },
      budget_max: { type: 'int', min: 100, max: 1_000_000 },
      start_window: { type: 'enum', values: START_WINDOWS },
      engagement: { type: 'enum', values: ENGAGEMENTS },
      status: { type: 'enum', values: ['draft', 'open', 'matched', 'closed'] },
      skills: { type: 'stringArray', max: 10 }
    });

    const columns = { title: data.title, description: data.description, budget_min: data.budget_min,
      budget_max: data.budget_max, start_window: data.start_window, engagement: data.engagement, status: data.status };

    transaction(db, () => {
      for (const [column, value] of Object.entries(columns)) {
        if (value !== undefined) run(db, `UPDATE briefs SET ${column} = ? WHERE id = ?`, [value, row.id]);
      }
      if (data.skills?.length) {
        const skillIds = resolveSkillIds(db, data.skills);
        run(db, 'DELETE FROM brief_skills WHERE brief_id = ?', [row.id]);
        for (const skillId of skillIds) run(db, 'INSERT INTO brief_skills (brief_id, skill_id) VALUES (?, ?)', [row.id, skillId]);
      }
    });

    audit(db, user.id, 'brief.updated', 'brief', row.id, {});
    return { brief: shapeBrief(db, loadBrief(db, row.id)) };
  });

  router.delete('/api/briefs/:briefId', ({ db, session, params }) => {
    const user = requireUser(session);
    const row = loadBrief(db, params.briefId);
    if (row.client_id !== user.id && user.role !== 'admin') throw forbidden('This brief belongs to another workspace.');
    run(db, 'DELETE FROM briefs WHERE id = ?', [row.id]);
    audit(db, user.id, 'brief.deleted', 'brief', row.id, {});
    return { ok: true };
  });

  // Explainable shortlist: each entry carries the score breakdown and reasons.
  router.get('/api/briefs/:briefId/matches', ({ db, session, params, url }) => {
    const user = requireUser(session);
    const brief = loadBrief(db, params.briefId);
    if (user.role === 'client' && brief.client_id !== user.id) throw forbidden('This brief belongs to another workspace.');
    if (user.role === 'talent') throw forbidden('Shortlists are visible to the hiring client.');

    const limit = Math.min(Math.max(queryInt(url, 'limit', 8), 1), 25);
    const briefWithSkills = { ...brief, skills: skillNamesFor(db, 'brief_skills', 'brief_id', brief.id) };
    const invited = new Set(all(db, 'SELECT talent_id FROM invitations WHERE brief_id = ?', [brief.id]).map((row) => row.talent_id));

    const matches = rankMatches(db, briefWithSkills, { limit, pool: loadTalentPool(db) }).map((match) => ({
      score: match.score,
      breakdown: match.breakdown,
      reasons: match.reasons,
      matchedSkills: match.matchedSkills,
      relevanceGated: match.relevanceGated,
      invited: invited.has(match.talent.user_id),
      talent: {
        id: match.talent.user_id,
        name: match.talent.name,
        avatarHue: match.talent.avatar_hue,
        headline: match.talent.headline,
        bio: match.talent.bio,
        location: match.talent.location,
        rateMin: match.talent.rate_min,
        rateMax: match.talent.rate_max,
        availability: match.talent.availability,
        payoutAsset: match.talent.payout_asset,
        payoutNetwork: match.talent.payout_network,
        rating: match.talent.rating,
        reviewsCount: match.talent.reviews_count,
        jobsCompleted: match.talent.jobs_completed,
        verified: Boolean(match.talent.verified),
        skills: match.talent.skills
      }
    }));

    return { brief: shapeBrief(db, brief), matches };
  });

  router.post('/api/briefs/:briefId/invitations', ({ db, session, params, body }) => {
    const user = requireRole(session, 'client', 'admin');
    const brief = loadBrief(db, params.briefId);
    if (brief.client_id !== user.id && user.role !== 'admin') throw forbidden('This brief belongs to another workspace.');

    const data = validate(body, {
      talent_id: { type: 'string', required: true, max: 60 },
      message: { type: 'string', max: 600, default: '' }
    });
    const talent = get(db, `SELECT u.id, u.name, p.status FROM users u JOIN talent_profiles p ON p.user_id = u.id
                            WHERE u.id = ?`, [data.talent_id]);
    if (!talent) throw notFound('That specialist does not exist.');
    if (talent.status !== 'approved') throw badRequest('That profile is not approved yet.');
    if (get(db, 'SELECT id FROM invitations WHERE brief_id = ? AND talent_id = ?', [brief.id, talent.id])) {
      throw conflict('You already invited this specialist to this brief.');
    }

    const briefWithSkills = { ...brief, skills: skillNamesFor(db, 'brief_skills', 'brief_id', brief.id) };
    const pool = loadTalentPool(db).filter((row) => row.user_id === talent.id);
    const score = pool.length ? rankMatches(db, briefWithSkills, { limit: 1, pool })[0].score : 0;

    const invitationId = newId('inv');
    run(db, `INSERT INTO invitations (id, brief_id, talent_id, score, message, status)
             VALUES (?, ?, ?, ?, ?, 'sent')`, [invitationId, brief.id, talent.id, score, data.message]);
    notify(db, talent.id, 'invitation', 'New project invitation',
      `${brief.client_company || brief.client_name} invited you to "${brief.title}".`, '/app/invitations.html');
    audit(db, user.id, 'invitation.sent', 'invitation', invitationId, { brief: brief.id, talent: talent.id });

    return created({ invitation: get(db, 'SELECT * FROM invitations WHERE id = ?', [invitationId]) });
  });

  router.get('/api/invitations', ({ db, session }) => {
    const user = requireUser(session);
    const rows = user.role === 'talent'
      ? all(db, `SELECT i.*, b.title, b.description, b.category, b.budget_min, b.budget_max, b.asset, b.network,
                        b.start_window, b.engagement, u.name AS client_name, u.company AS client_company
                 FROM invitations i JOIN briefs b ON b.id = i.brief_id JOIN users u ON u.id = b.client_id
                 WHERE i.talent_id = ? ORDER BY i.created_at DESC`, [user.id])
      : all(db, `SELECT i.*, b.title, b.description, b.category, b.budget_min, b.budget_max, b.asset, b.network,
                        b.start_window, b.engagement, u.name AS talent_name
                 FROM invitations i JOIN briefs b ON b.id = i.brief_id JOIN users u ON u.id = i.talent_id
                 WHERE b.client_id = ? ORDER BY i.created_at DESC`, [user.id]);
    return { invitations: rows };
  });

  // Accepting an invitation is the moment a brief becomes a project room.
  router.post('/api/invitations/:invitationId/respond', ({ db, session, params, body }) => {
    const user = requireRole(session, 'talent');
    const data = validate(body, { action: { type: 'enum', required: true, values: ['accept', 'decline'] } });

    const invitation = get(db, `SELECT i.*, b.title, b.description, b.client_id, b.asset, b.network, b.budget_max, b.budget_min
                                FROM invitations i JOIN briefs b ON b.id = i.brief_id WHERE i.id = ?`, [params.invitationId]);
    if (!invitation) throw notFound('That invitation does not exist.');
    if (invitation.talent_id !== user.id) throw forbidden('That invitation was sent to someone else.');
    if (invitation.status !== 'sent') throw conflict(`This invitation was already ${invitation.status}.`);

    if (data.action === 'decline') {
      run(db, `UPDATE invitations SET status = 'declined' WHERE id = ?`, [invitation.id]);
      notify(db, invitation.client_id, 'invitation', 'Invitation declined',
        `${user.name} declined "${invitation.title}".`, '/app/briefs.html');
      return { invitation: get(db, 'SELECT * FROM invitations WHERE id = ?', [invitation.id]) };
    }

    const projectId = newId('prj');
    transaction(db, () => {
      run(db, `UPDATE invitations SET status = 'accepted' WHERE id = ?`, [invitation.id]);
      run(db, `UPDATE briefs SET status = 'matched' WHERE id = ?`, [invitation.brief_id]);
      run(db, `INSERT INTO projects (id, brief_id, client_id, talent_id, name, summary, asset, network, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [projectId, invitation.brief_id, invitation.client_id, user.id, invitation.title,
          invitation.description.slice(0, 500), invitation.asset, invitation.network]);
      // Seed a sensible three-part milestone plan from the agreed budget.
      const budget = invitation.budget_max || invitation.budget_min || 0;
      const plan = [
        ['Kickoff & direction', 'Alignment, scope confirmation, and the agreed plan of work.', Math.round(budget * 0.25)],
        ['Core delivery', 'The main body of work, delivered for review.', Math.round(budget * 0.5)],
        ['Launch & handoff', 'Final QA, revisions, and handoff.', budget - Math.round(budget * 0.25) - Math.round(budget * 0.5)]
      ];
      plan.forEach(([title, description, amount], index) => {
        run(db, `INSERT INTO milestones (id, project_id, position, title, description, amount, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'planned')`, [newId('mil'), projectId, index + 1, title, description, amount]);
      });
      run(db, `INSERT INTO messages (id, project_id, author_id, body)
               VALUES (?, ?, ?, ?)`, [newId('msg'), projectId, user.id,
        `Thanks for the invitation — happy to take this on. I've reviewed the brief and the milestone plan looks like a sensible starting point.`]);
    });

    notify(db, invitation.client_id, 'project', 'Invitation accepted',
      `${user.name} accepted "${invitation.title}". A project room is ready.`, `/app/project.html?id=${projectId}`);
    audit(db, user.id, 'invitation.accepted', 'project', projectId, { brief: invitation.brief_id });

    return created({
      invitation: get(db, 'SELECT * FROM invitations WHERE id = ?', [invitation.id]),
      projectId
    });
  });
}

module.exports = { register, CATEGORIES, START_WINDOWS, ENGAGEMENTS, shapeBrief };
