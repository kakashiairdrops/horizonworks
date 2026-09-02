'use strict';

const { get, run, all } = require('../db');
const { requireRole, requireUser } = require('../auth');
const { validate, notFound } = require('../validate');
const { created, audit, newId, queryInt, query } = require('../http');
const escrowModule = require('../escrow');
const { notify } = escrowModule;

function register(router) {
  // Public lead capture from the marketing site. No session required.
  router.post('/api/inquiries', ({ db, body, inquiryLimiter, clientKey }) => {
    inquiryLimiter(db, `inquiry:${clientKey}`);
    const data = validate(body, {
      name: { type: 'string', required: true, min: 2, max: 80 },
      email: { type: 'email', required: true, max: 160 },
      role: { type: 'enum', values: ['client', 'talent'], default: 'client' },
      service: { type: 'string', max: 80, default: '' },
      settlement: { type: 'string', max: 40, default: '' },
      note: { type: 'string', max: 1000, default: '' }
    });
    const inquiryId = newId('inq');
    run(db, `INSERT INTO inquiries (id, name, email, role, service, settlement, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [inquiryId, data.name, data.email.toLowerCase(), data.role, data.service, data.settlement, data.note]);
    for (const admin of all(db, `SELECT id FROM users WHERE role = 'admin'`)) {
      notify(db, admin.id, 'inquiry', 'New inbound inquiry', `${data.name} · ${data.role} · ${data.service || 'general'}`, '/app/admin.html');
    }
    return created({ ok: true, id: inquiryId });
  });

  router.get('/api/stats', ({ db }) => {
    const talent = get(db, `SELECT count(*) AS n FROM talent_profiles WHERE status = 'approved'`).n;
    const available = get(db, `SELECT count(*) AS n FROM talent_profiles
                               WHERE status = 'approved' AND availability = 'available_now'`).n;
    // settled_amount, not amount: a split settled only the arbitrated share.
    const settled = get(db, `SELECT COALESCE(sum(settled_amount), 0) AS total FROM payments
                             WHERE status IN ('released', 'split')`).total;
    const projects = get(db, `SELECT count(*) AS n FROM projects WHERE status IN ('active', 'in_review')`).n;
    const countries = get(db, `SELECT count(DISTINCT trim(substr(location, instr(location, ',') + 1))) AS n
                               FROM talent_profiles WHERE status = 'approved' AND location <> ''`).n;
    const skills = all(db, `SELECT s.category, count(*) AS n FROM talent_skills ts
                            JOIN skills s ON s.id = ts.skill_id GROUP BY s.category ORDER BY n DESC`);
    return { talent, availableNow: available, settled, activeProjects: projects, countries, skillMix: skills };
  });

  router.get('/api/admin/overview', ({ db, session }) => {
    requireRole(session, 'admin');
    const counts = {
      users: get(db, 'SELECT count(*) AS n FROM users').n,
      talent: get(db, `SELECT count(*) AS n FROM talent_profiles`).n,
      pendingTalent: get(db, `SELECT count(*) AS n FROM talent_profiles WHERE status = 'pending'`).n,
      openBriefs: get(db, `SELECT count(*) AS n FROM briefs WHERE status = 'open'`).n,
      activeProjects: get(db, `SELECT count(*) AS n FROM projects WHERE status IN ('active', 'in_review')`).n,
      newInquiries: get(db, `SELECT count(*) AS n FROM inquiries WHERE status = 'new'`).n,
      openDisputes: get(db, `SELECT count(*) AS n FROM disputes WHERE status IN ('open', 'answered')`).n
    };
    const money = {
      escrow: get(db, `SELECT COALESCE(sum(amount), 0) AS total FROM payments WHERE status = 'escrow_funded'`).total,
      released: get(db, `SELECT COALESCE(sum(settled_amount), 0) AS total FROM payments
                         WHERE status IN ('released', 'split')`).total,
      fees: get(db, `SELECT COALESCE(sum(fee), 0) AS total FROM payments WHERE status IN ('released', 'split')`).total,
      pipeline: get(db, `SELECT COALESCE(sum(budget_max), 0) AS total FROM briefs WHERE status IN ('open', 'matched')`).total
    };
    const pending = all(db, `SELECT p.user_id, u.name, u.email, p.headline, p.location, p.rate_min, p.rate_max,
                                    p.availability, p.payout_asset, p.payout_network, p.status, p.updated_at
                             FROM talent_profiles p JOIN users u ON u.id = p.user_id
                             WHERE p.status = 'pending' ORDER BY p.updated_at DESC LIMIT 25`);
    const inquiries = all(db, `SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 25`);
    const escrowQueue = all(db, `SELECT pay.id, pay.amount, pay.fee, pay.asset, pay.network, pay.status, pay.created_at,
                                        pr.name AS project_name, m.title AS milestone_title, m.status AS milestone_status,
                                        payer.name AS payer_name, payee.name AS payee_name
                                 FROM payments pay JOIN projects pr ON pr.id = pay.project_id
                                 LEFT JOIN milestones m ON m.id = pay.milestone_id
                                 JOIN users payer ON payer.id = pay.payer_id
                                 JOIN users payee ON payee.id = pay.payee_id
                                 WHERE pay.status = 'escrow_funded' ORDER BY pay.created_at DESC LIMIT 25`);
    const briefs = all(db, `SELECT b.id, b.title, b.category, b.budget_min, b.budget_max, b.status, b.created_at,
                                   u.name AS client_name, u.company AS client_company,
                                   (SELECT count(*) FROM invitations i WHERE i.brief_id = b.id) AS invitations
                            FROM briefs b JOIN users u ON u.id = b.client_id
                            ORDER BY b.created_at DESC LIMIT 25`);
    const audit = all(db, `SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, u.name AS actor_name
                           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
                           ORDER BY a.id DESC LIMIT 30`);
    const disputes = all(db, `SELECT d.*, m.title AS milestone_title, m.amount, pr.name AS project_name,
                                     pr.asset, pr.network,
                                     raiser.name AS raised_by_name, raiser.role AS raised_by_role,
                                     responder.name AS responded_by_name,
                                     client.name AS client_name, talent.name AS talent_name
                              FROM disputes d
                              JOIN milestones m ON m.id = d.milestone_id
                              JOIN projects pr ON pr.id = d.project_id
                              JOIN users raiser ON raiser.id = d.raised_by
                              LEFT JOIN users responder ON responder.id = d.responded_by
                              JOIN users client ON client.id = pr.client_id
                              JOIN users talent ON talent.id = pr.talent_id
                              ORDER BY CASE d.status WHEN 'open' THEN 0 WHEN 'answered' THEN 1 ELSE 2 END,
                                       d.created_at DESC
                              LIMIT 25`);
    return { counts, money, pendingTalent: pending, inquiries, escrowQueue, briefs, audit, disputes };
  });

  router.post('/api/admin/disputes/:disputeId/resolve', ({ db, session, params, body }) => {
    const admin = requireRole(session, 'admin');
    const data = validate(body, {
      outcome: { type: 'enum', required: true, values: ['release', 'refund', 'split'] },
      talent_share: { type: 'number', min: 0, max: 1_000_000, default: null },
      resolution: { type: 'string', required: true, min: 10, max: 2000 }
    });
    const dispute = escrowModule.resolveDispute(db, {
      disputeId: params.disputeId,
      actorId: admin.id,
      outcome: data.outcome,
      talentShare: data.talent_share,
      resolution: data.resolution
    });
    audit(db, admin.id, `dispute.${data.outcome}`, 'dispute', params.disputeId,
      { talentShare: dispute.talent_share });
    return { dispute };
  });

  router.post('/api/admin/talent/:userId/status', ({ db, session, params, body }) => {
    const admin = requireRole(session, 'admin');
    const data = validate(body, {
      status: { type: 'enum', required: true, values: ['pending', 'approved', 'rejected'] },
      verified: { type: 'boolean', default: undefined },
      note: { type: 'string', max: 500, default: '' }
    });
    const profile = get(db, 'SELECT user_id FROM talent_profiles WHERE user_id = ?', [params.userId]);
    if (!profile) throw notFound('That profile does not exist.');

    run(db, `UPDATE talent_profiles SET status = ?, updated_at = datetime('now') WHERE user_id = ?`, [data.status, params.userId]);
    if (data.verified !== undefined) {
      run(db, 'UPDATE talent_profiles SET verified = ? WHERE user_id = ?', [data.verified ? 1 : 0, params.userId]);
    }
    const titles = { approved: 'Your profile is live', rejected: 'Profile needs changes', pending: 'Profile under review' };
    notify(db, params.userId, 'profile', titles[data.status],
      data.note || 'An operator reviewed your Horizon profile.', '/app/profile.html');
    audit(db, admin.id, `talent.${data.status}`, 'talent_profile', params.userId, { note: data.note });
    return { ok: true, status: data.status };
  });

  router.patch('/api/admin/inquiries/:inquiryId', ({ db, session, params, body }) => {
    requireRole(session, 'admin');
    const data = validate(body, { status: { type: 'enum', required: true, values: ['new', 'contacted', 'closed'] } });
    const inquiry = get(db, 'SELECT id FROM inquiries WHERE id = ?', [params.inquiryId]);
    if (!inquiry) throw notFound('That inquiry does not exist.');
    run(db, 'UPDATE inquiries SET status = ? WHERE id = ?', [data.status, params.inquiryId]);
    return { ok: true };
  });

  router.get('/api/admin/users', ({ db, session, url }) => {
    requireRole(session, 'admin');
    const search = query(url, 'q');
    const limit = Math.min(Math.max(queryInt(url, 'limit', 50), 1), 200);
    const rows = search
      ? all(db, `SELECT id, email, name, role, company, created_at, last_login_at FROM users
                 WHERE name LIKE ? OR email LIKE ? ORDER BY created_at DESC LIMIT ?`, [`%${search}%`, `%${search}%`, limit])
      : all(db, `SELECT id, email, name, role, company, created_at, last_login_at FROM users
                 ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { users: rows };
  });

  // Client-side dashboard summary tailored to the viewer's role.
  router.get('/api/dashboard', ({ db, session }) => {
    const user = requireUser(session);
    const wallets = all(db, 'SELECT asset, network, available, in_escrow FROM wallets WHERE user_id = ?', [user.id]);
    const notifications = all(db, `SELECT id, kind, title, body, link, read_at, created_at FROM notifications
                                   WHERE user_id = ? ORDER BY created_at DESC LIMIT 6`, [user.id]);

    if (user.role === 'talent') {
      const stats = {
        openInvitations: get(db, `SELECT count(*) AS n FROM invitations WHERE talent_id = ? AND status = 'sent'`, [user.id]).n,
        activeProjects: get(db, `SELECT count(*) AS n FROM projects WHERE talent_id = ? AND status IN ('active','in_review')`, [user.id]).n,
        earned: get(db, `SELECT COALESCE(sum(settled_amount), 0) AS total FROM payments
                         WHERE payee_id = ? AND status IN ('released', 'split')`, [user.id]).total,
        inEscrow: get(db, `SELECT COALESCE(sum(amount), 0) AS total FROM payments WHERE payee_id = ? AND status = 'escrow_funded'`, [user.id]).total,
        awaitingSubmission: get(db, `SELECT count(*) AS n FROM milestones m JOIN projects p ON p.id = m.project_id
                                     WHERE p.talent_id = ? AND m.status = 'funded'`, [user.id]).n,
        openDisputes: get(db, `SELECT count(*) AS n FROM disputes d JOIN projects p ON p.id = d.project_id
                               WHERE p.talent_id = ? AND d.status IN ('open', 'answered')`, [user.id]).n
      };
      const matchingBriefs = get(db, `SELECT count(DISTINCT b.id) AS n FROM briefs b
                                      JOIN brief_skills bs ON bs.brief_id = b.id
                                      JOIN talent_skills ts ON ts.skill_id = bs.skill_id AND ts.user_id = ?
                                      WHERE b.status = 'open'`, [user.id]).n;
      return { role: 'talent', stats: { ...stats, matchingBriefs }, wallets, notifications };
    }

    if (user.role === 'admin') {
      return {
        role: 'admin',
        stats: {
          users: get(db, 'SELECT count(*) AS n FROM users').n,
          pendingTalent: get(db, `SELECT count(*) AS n FROM talent_profiles WHERE status = 'pending'`).n,
          openBriefs: get(db, `SELECT count(*) AS n FROM briefs WHERE status = 'open'`).n,
          escrow: get(db, `SELECT COALESCE(sum(amount), 0) AS total FROM payments WHERE status = 'escrow_funded'`).total,
          openDisputes: get(db, `SELECT count(*) AS n FROM disputes WHERE status IN ('open', 'answered')`).n
        },
        wallets, notifications
      };
    }

    const stats = {
      openBriefs: get(db, `SELECT count(*) AS n FROM briefs WHERE client_id = ? AND status = 'open'`, [user.id]).n,
      activeProjects: get(db, `SELECT count(*) AS n FROM projects WHERE client_id = ? AND status IN ('active','in_review')`, [user.id]).n,
      inEscrow: get(db, `SELECT COALESCE(sum(amount), 0) AS total FROM payments WHERE payer_id = ? AND status = 'escrow_funded'`, [user.id]).total,
      paid: get(db, `SELECT COALESCE(sum(settled_amount), 0) AS total FROM payments
                     WHERE payer_id = ? AND status IN ('released', 'split')`, [user.id]).total,
      awaitingReview: get(db, `SELECT count(*) AS n FROM milestones m JOIN projects p ON p.id = m.project_id
                               WHERE p.client_id = ? AND m.status = 'submitted'`, [user.id]).n,
      pendingInvitations: get(db, `SELECT count(*) AS n FROM invitations i JOIN briefs b ON b.id = i.brief_id
                                   WHERE b.client_id = ? AND i.status = 'sent'`, [user.id]).n,
      openDisputes: get(db, `SELECT count(*) AS n FROM disputes d JOIN projects p ON p.id = d.project_id
                             WHERE p.client_id = ? AND d.status IN ('open', 'answered')`, [user.id]).n
    };
    return { role: 'client', stats, wallets, notifications };
  });
}

module.exports = { register };
