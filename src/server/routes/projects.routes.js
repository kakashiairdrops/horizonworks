'use strict';

const { get, run, all, transaction } = require('../db');
const { requireUser } = require('../auth');
const { validate, notFound, badRequest, conflict, forbidden } = require('../validate');
const { created, projectForUser, audit, newId } = require('../http');
const escrow = require('../escrow');

function shapeProject(db, row) {
  const milestones = all(db, `SELECT id, position, title, description, amount, due_date, status
                              FROM milestones WHERE project_id = ? ORDER BY position, created_at`, [row.id]);
  const totals = milestones.reduce((acc, milestone) => {
    acc.total += milestone.amount;
    if (milestone.status === 'paid') acc.paid += milestone.amount;
    if (['funded', 'submitted', 'disputed'].includes(milestone.status)) acc.escrow += milestone.amount;
    if (milestone.status === 'disputed') acc.disputed += milestone.amount;
    return acc;
  }, { total: 0, paid: 0, escrow: 0, disputed: 0 });

  return {
    id: row.id,
    briefId: row.brief_id,
    name: row.name,
    summary: row.summary,
    asset: row.asset,
    network: row.network,
    status: row.status,
    createdAt: row.created_at,
    client: { id: row.client_id, name: row.client_name, company: row.client_company, avatarHue: row.client_hue },
    talent: { id: row.talent_id, name: row.talent_name, avatarHue: row.talent_hue },
    milestones,
    totals: {
      ...totals,
      progress: totals.total ? Math.round((totals.paid / totals.total) * 100) : 0
    }
  };
}

function register(router) {
  router.get('/api/projects', ({ db, session }) => {
    const user = requireUser(session);
    const where = user.role === 'admin' ? '1 = 1'
      : user.role === 'client' ? 'p.client_id = ?' : 'p.talent_id = ?';
    const params = user.role === 'admin' ? [] : [user.id];
    const rows = all(db, `
      SELECT p.*, c.name AS client_name, c.company AS client_company, c.avatar_hue AS client_hue,
             t.name AS talent_name, t.avatar_hue AS talent_hue
      FROM projects p JOIN users c ON c.id = p.client_id JOIN users t ON t.id = p.talent_id
      WHERE ${where} ORDER BY p.created_at DESC`, params);
    return { projects: rows.map((row) => shapeProject(db, row)) };
  });

  router.get('/api/projects/:projectId', ({ db, session, params }) => {
    const user = requireUser(session);
    const project = projectForUser(db, params.projectId, user);
    const messages = all(db, `SELECT m.id, m.body, m.attachment, m.created_at, m.author_id,
                                     u.name AS author_name, u.avatar_hue AS author_hue
                              FROM messages m JOIN users u ON u.id = m.author_id
                              WHERE m.project_id = ? ORDER BY m.created_at ASC`, [params.projectId]);
    const payments = all(db, `SELECT id, milestone_id, amount, fee, asset, network, status, tx_ref, created_at, settled_at
                              FROM payments WHERE project_id = ? ORDER BY created_at DESC`, [params.projectId]);
    const review = get(db, 'SELECT rating, comment, reviewer_id FROM reviews WHERE project_id = ? AND reviewer_id = ?',
      [params.projectId, user.id]);
    return {
      project: shapeProject(db, project),
      messages,
      payments,
      disputes: escrow.disputesForProject(db, params.projectId),
      myReview: review || null,
      viewerRole: user.role
    };
  });

  router.post('/api/projects', ({ db, session, body }) => {
    const user = requireUser(session);
    if (user.role === 'talent') throw forbidden('Only clients can open a project directly.');
    const data = validate(body, {
      talent_id: { type: 'string', required: true, max: 60 },
      name: { type: 'string', required: true, min: 4, max: 120 },
      summary: { type: 'string', max: 1000, default: '' },
      asset: { type: 'enum', values: ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'Fiat'], default: 'USDC' },
      network: { type: 'enum', values: ['Base', 'Solana', 'Ethereum', 'Arbitrum', 'Polygon', 'Bank'], default: 'Base' },
      brief_id: { type: 'string', max: 60, default: null }
    });
    const talent = get(db, `SELECT u.id FROM users u JOIN talent_profiles p ON p.user_id = u.id
                            WHERE u.id = ? AND p.status = 'approved'`, [data.talent_id]);
    if (!talent) throw badRequest('Choose an approved specialist.');

    const projectId = newId('prj');
    run(db, `INSERT INTO projects (id, brief_id, client_id, talent_id, name, summary, asset, network, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [projectId, data.brief_id || null, user.id, talent.id, data.name, data.summary, data.asset, data.network]);
    escrow.notify(db, talent.id, 'project', 'New project room',
      `${user.company || user.name} opened "${data.name}".`, `/app/project.html?id=${projectId}`);
    audit(db, user.id, 'project.created', 'project', projectId, {});
    return created({ project: shapeProject(db, projectForUser(db, projectId, user)) });
  });

  router.patch('/api/projects/:projectId', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const project = projectForUser(db, params.projectId, user);
    const data = validate(body, {
      name: { type: 'string', min: 4, max: 120 },
      summary: { type: 'string', max: 1000 },
      status: { type: 'enum', values: ['active', 'in_review', 'completed', 'cancelled'] }
    });
    if (data.status && project.client_id !== user.id && user.role !== 'admin') {
      throw forbidden('Only the client can change project status.');
    }
    for (const [column, value] of Object.entries(data)) {
      if (value !== undefined) run(db, `UPDATE projects SET ${column} = ? WHERE id = ?`, [value, project.id]);
    }
    return { project: shapeProject(db, projectForUser(db, project.id, user)) };
  });

  router.post('/api/projects/:projectId/milestones', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const project = projectForUser(db, params.projectId, user);
    if (project.client_id !== user.id && user.role !== 'admin') throw forbidden('Only the client can add milestones.');
    const data = validate(body, {
      title: { type: 'string', required: true, min: 3, max: 120 },
      description: { type: 'string', max: 1000, default: '' },
      amount: { type: 'number', required: true, min: 1, max: 1_000_000 },
      due_date: { type: 'string', max: 20, default: null }
    });
    const next = get(db, 'SELECT COALESCE(max(position), 0) + 1 AS position FROM milestones WHERE project_id = ?', [project.id]);
    const milestoneId = newId('mil');
    run(db, `INSERT INTO milestones (id, project_id, position, title, description, amount, due_date, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')`,
      [milestoneId, project.id, next.position, data.title, data.description, data.amount, data.due_date]);
    escrow.notify(db, project.talent_id, 'milestone', 'Milestone added',
      `"${data.title}" was added to ${project.name}.`, `/app/project.html?id=${project.id}`);
    return created({ milestone: get(db, 'SELECT * FROM milestones WHERE id = ?', [milestoneId]) });
  });

  router.patch('/api/milestones/:milestoneId', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const milestone = get(db, 'SELECT * FROM milestones WHERE id = ?', [params.milestoneId]);
    if (!milestone) throw notFound('That milestone does not exist.');
    const project = projectForUser(db, milestone.project_id, user);
    if (project.client_id !== user.id && user.role !== 'admin') throw forbidden('Only the client can edit milestones.');
    if (['funded', 'submitted', 'paid'].includes(milestone.status)) {
      throw conflict('A funded or paid milestone cannot be edited.');
    }
    const data = validate(body, {
      title: { type: 'string', min: 3, max: 120 },
      description: { type: 'string', max: 1000 },
      amount: { type: 'number', min: 1, max: 1_000_000 },
      due_date: { type: 'string', max: 20 }
    });
    for (const [column, value] of Object.entries(data)) {
      if (value !== undefined) run(db, `UPDATE milestones SET ${column} = ? WHERE id = ?`, [value, milestone.id]);
    }
    return { milestone: get(db, 'SELECT * FROM milestones WHERE id = ?', [milestone.id]) };
  });

  router.delete('/api/milestones/:milestoneId', ({ db, session, params }) => {
    const user = requireUser(session);
    const milestone = get(db, 'SELECT * FROM milestones WHERE id = ?', [params.milestoneId]);
    if (!milestone) throw notFound('That milestone does not exist.');
    const project = projectForUser(db, milestone.project_id, user);
    if (project.client_id !== user.id && user.role !== 'admin') throw forbidden('Only the client can remove milestones.');
    if (milestone.status !== 'planned') throw conflict('Only a planned milestone can be removed.');
    run(db, 'DELETE FROM milestones WHERE id = ?', [milestone.id]);
    return { ok: true };
  });

  // Escrow lifecycle: fund → submit → release (or refund).
  router.post('/api/milestones/:milestoneId/fund', ({ db, session, params }) => {
    const user = requireUser(session);
    const payment = escrow.fundMilestone(db, { milestoneId: params.milestoneId, actorId: user.id });
    audit(db, user.id, 'milestone.funded', 'milestone', params.milestoneId, { amount: payment.amount });
    return { payment };
  });

  router.post('/api/milestones/:milestoneId/submit', ({ db, session, params }) => {
    const user = requireUser(session);
    const milestone = escrow.submitMilestone(db, { milestoneId: params.milestoneId, actorId: user.id });
    audit(db, user.id, 'milestone.submitted', 'milestone', params.milestoneId, {});
    return { milestone };
  });

  router.post('/api/milestones/:milestoneId/release', ({ db, session, params }) => {
    const user = requireUser(session);
    const payment = escrow.releaseMilestone(db, { milestoneId: params.milestoneId, actorId: user.id });
    audit(db, user.id, 'milestone.released', 'payment', payment.id, { amount: payment.amount });
    return { payment };
  });

  router.post('/api/milestones/:milestoneId/refund', ({ db, session, params }) => {
    const user = requireUser(session);
    const payment = escrow.refundMilestone(db, { milestoneId: params.milestoneId, actorId: user.id });
    audit(db, user.id, 'milestone.refunded', 'payment', payment.id, {});
    return { payment };
  });

  // Dispute lifecycle: either party freezes a submitted milestone, the other
  // answers, an admin arbitrates. Escrow does not move until the admin decides.
  router.post('/api/milestones/:milestoneId/dispute', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const data = validate(body, {
      reason: { type: 'string', required: true, min: 20, max: 2000 },
      desired: { type: 'enum', values: ['release', 'refund', 'split'], default: 'refund' }
    });
    const dispute = escrow.openDispute(db, {
      milestoneId: params.milestoneId,
      actorId: user.id,
      reason: data.reason,
      desired: data.desired
    });
    audit(db, user.id, 'dispute.opened', 'milestone', params.milestoneId, { desired: data.desired });
    return created({ dispute });
  });

  router.post('/api/disputes/:disputeId/respond', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const data = validate(body, { response: { type: 'string', required: true, min: 20, max: 2000 } });
    const dispute = escrow.respondToDispute(db, {
      disputeId: params.disputeId,
      actorId: user.id,
      response: data.response
    });
    audit(db, user.id, 'dispute.answered', 'dispute', params.disputeId, {});
    return { dispute };
  });

  router.post('/api/disputes/:disputeId/withdraw', ({ db, session, params }) => {
    const user = requireUser(session);
    const dispute = escrow.withdrawDispute(db, { disputeId: params.disputeId, actorId: user.id });
    audit(db, user.id, 'dispute.withdrawn', 'dispute', params.disputeId, {});
    return { dispute };
  });

  router.post('/api/projects/:projectId/messages', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const project = projectForUser(db, params.projectId, user);
    const data = validate(body, {
      body: { type: 'string', required: true, min: 1, max: 4000 },
      // A reference to work living elsewhere (Figma, a repo, a deploy preview).
      // Nothing is uploaded or proxied; the link is stored and rendered as-is.
      attachment: { type: 'url', max: 400, default: null }
    });
    const messageId = newId('msg');
    run(db, `INSERT INTO messages (id, project_id, author_id, body, attachment) VALUES (?, ?, ?, ?, ?)`,
      [messageId, project.id, user.id, data.body, data.attachment]);
    const recipient = project.client_id === user.id ? project.talent_id : project.client_id;
    escrow.notify(db, recipient, 'message', `New message from ${user.name}`,
      data.body.slice(0, 120), `/app/project.html?id=${project.id}`);
    return created({
      message: get(db, `SELECT m.id, m.body, m.attachment, m.created_at, m.author_id,
                               u.name AS author_name, u.avatar_hue AS author_hue
                        FROM messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`, [messageId])
    });
  });

  router.get('/api/payments', ({ db, session }) => {
    const user = requireUser(session);
    const where = user.role === 'admin' ? '1 = 1' : '(pay.payer_id = ? OR pay.payee_id = ?)';
    const params = user.role === 'admin' ? [] : [user.id, user.id];
    const payments = all(db, `
      SELECT pay.*, pr.name AS project_name, m.title AS milestone_title,
             payer.name AS payer_name, payee.name AS payee_name
      FROM payments pay
      JOIN projects pr ON pr.id = pay.project_id
      LEFT JOIN milestones m ON m.id = pay.milestone_id
      JOIN users payer ON payer.id = pay.payer_id
      JOIN users payee ON payee.id = pay.payee_id
      WHERE ${where} ORDER BY pay.created_at DESC LIMIT 100`, params);
    const wallets = all(db, 'SELECT asset, network, available, in_escrow FROM wallets WHERE user_id = ?', [user.id]);
    return { payments, wallets, feeRate: escrow.PLATFORM_FEE_RATE };
  });

  router.post('/api/projects/:projectId/reviews', ({ db, session, params, body }) => {
    const user = requireUser(session);
    const project = projectForUser(db, params.projectId, user);
    const data = validate(body, {
      rating: { type: 'int', required: true, min: 1, max: 5 },
      comment: { type: 'string', max: 1000, default: '' }
    });
    const paid = get(db, `SELECT count(*) AS n FROM milestones WHERE project_id = ? AND status = 'paid'`, [project.id]).n;
    if (!paid) throw conflict('Reviews unlock once at least one milestone has been paid.');
    if (get(db, 'SELECT id FROM reviews WHERE project_id = ? AND reviewer_id = ?', [project.id, user.id])) {
      throw conflict('You already reviewed this project.');
    }
    const subjectId = project.client_id === user.id ? project.talent_id : project.client_id;

    transaction(db, () => {
      run(db, `INSERT INTO reviews (id, project_id, reviewer_id, subject_id, rating, comment)
               VALUES (?, ?, ?, ?, ?, ?)`, [newId('rev'), project.id, user.id, subjectId, data.rating, data.comment]);
      // Recompute the subject's rating from the reviews table so it stays consistent.
      const stats = get(db, 'SELECT avg(rating) AS average, count(*) AS n FROM reviews WHERE subject_id = ?', [subjectId]);
      run(db, 'UPDATE talent_profiles SET rating = ?, reviews_count = ? WHERE user_id = ?',
        [Math.round(stats.average * 10) / 10, stats.n, subjectId]);
    });

    escrow.notify(db, subjectId, 'review', 'New review received',
      `${user.name} left ${data.rating}★ on ${project.name}.`, `/app/project.html?id=${project.id}`);
    return created({ ok: true });
  });
}

module.exports = { register, shapeProject };
