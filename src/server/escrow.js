'use strict';

const { get, all, run, transaction } = require('./db');
const { id } = require('./ids');
const { badRequest, notFound, conflict, forbidden } = require('./validate');

const PLATFORM_FEE_RATE = 0.03;

const round2 = (value) => Math.round(Number(value) * 100) / 100;
const feeFor = (amount) => round2(Number(amount) * PLATFORM_FEE_RATE);

function ensureWallet(db, userId, asset, network) {
  let wallet = get(db, 'SELECT * FROM wallets WHERE user_id = ? AND asset = ? AND network = ?', [userId, asset, network]);
  if (!wallet) {
    run(db, 'INSERT INTO wallets (user_id, asset, network, available, in_escrow) VALUES (?, ?, ?, 0, 0)', [userId, asset, network]);
    wallet = get(db, 'SELECT * FROM wallets WHERE user_id = ? AND asset = ? AND network = ?', [userId, asset, network]);
  }
  return wallet;
}

/**
 * Moves milestone funds from the client's available balance into escrow.
 * Simulated: no wallet is connected and nothing is broadcast on-chain.
 */
function fundMilestone(db, { milestoneId, actorId }) {
  return transaction(db, () => {
    const milestone = get(db, `SELECT m.*, p.client_id, p.talent_id, p.asset, p.network, p.name AS project_name
                               FROM milestones m JOIN projects p ON p.id = m.project_id
                               WHERE m.id = ?`, [milestoneId]);
    if (!milestone) throw notFound('That milestone does not exist.');
    if (milestone.client_id !== actorId) throw badRequest('Only the client can fund a milestone.');
    if (milestone.status !== 'planned') throw conflict(`This milestone is already ${milestone.status}.`);

    const amount = round2(milestone.amount);
    const fee = feeFor(amount);
    const total = round2(amount + fee);
    const wallet = ensureWallet(db, milestone.client_id, milestone.asset, milestone.network);
    if (wallet.available < total) {
      throw badRequest(`Insufficient balance: ${total} ${milestone.asset} needed, ${round2(wallet.available)} available.`);
    }

    run(db, `UPDATE wallets SET available = available - ?, in_escrow = in_escrow + ?
             WHERE user_id = ? AND asset = ? AND network = ?`,
      [total, total, milestone.client_id, milestone.asset, milestone.network]);
    run(db, `UPDATE milestones SET status = 'funded' WHERE id = ?`, [milestoneId]);

    const paymentId = id('pay');
    run(db, `INSERT INTO payments (id, project_id, milestone_id, payer_id, payee_id, amount, fee, asset, network, status, tx_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'escrow_funded', ?)`,
      [paymentId, milestone.project_id, milestoneId, milestone.client_id, milestone.talent_id,
        amount, fee, milestone.asset, milestone.network, `sim-escrow-${paymentId.slice(-8)}`]);

    notify(db, milestone.talent_id, 'payment', 'Milestone funded',
      `${amount} ${milestone.asset} is held in escrow for "${milestone.title}".`,
      `/app/project.html?id=${milestone.project_id}`);

    return get(db, 'SELECT * FROM payments WHERE id = ?', [paymentId]);
  });
}

/** Talent marks work delivered; a funded milestone becomes reviewable. */
function submitMilestone(db, { milestoneId, actorId }) {
  const milestone = get(db, `SELECT m.*, p.client_id, p.talent_id, p.id AS project_id
                             FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?`, [milestoneId]);
  if (!milestone) throw notFound('That milestone does not exist.');
  if (milestone.talent_id !== actorId) throw badRequest('Only the assigned specialist can submit work.');
  if (milestone.status !== 'funded') throw conflict('Work can only be submitted once the milestone is funded.');
  run(db, `UPDATE milestones SET status = 'submitted' WHERE id = ?`, [milestoneId]);
  notify(db, milestone.client_id, 'milestone', 'Work submitted for review',
    `"${milestone.title}" is ready for your review.`, `/app/project.html?id=${milestone.project_id}`);
  return get(db, 'SELECT * FROM milestones WHERE id = ?', [milestoneId]);
}

/** Releases escrowed funds to the specialist and records the settlement. */
function releaseMilestone(db, { milestoneId, actorId }) {
  return transaction(db, () => {
    const milestone = get(db, `SELECT m.*, p.client_id, p.talent_id, p.asset, p.network
                               FROM milestones m JOIN projects p ON p.id = m.project_id WHERE m.id = ?`, [milestoneId]);
    if (!milestone) throw notFound('That milestone does not exist.');
    if (milestone.client_id !== actorId) throw badRequest('Only the client can release a payment.');
    if (milestone.status === 'disputed') {
      throw conflict('This milestone is under dispute. An admin has to resolve it.');
    }
    if (!['submitted', 'approved', 'funded'].includes(milestone.status)) {
      throw conflict(`A ${milestone.status} milestone cannot be released.`);
    }

    const payment = get(db, `SELECT * FROM payments WHERE milestone_id = ? AND status = 'escrow_funded'`, [milestoneId]);
    if (!payment) throw conflict('No escrowed payment found for this milestone.');

    const total = round2(payment.amount + payment.fee);
    run(db, `UPDATE wallets SET in_escrow = in_escrow - ? WHERE user_id = ? AND asset = ? AND network = ?`,
      [total, payment.payer_id, payment.asset, payment.network]);
    ensureWallet(db, payment.payee_id, payment.asset, payment.network);
    run(db, `UPDATE wallets SET available = available + ? WHERE user_id = ? AND asset = ? AND network = ?`,
      [round2(payment.amount), payment.payee_id, payment.asset, payment.network]);
    run(db, `UPDATE payments SET status = 'released', settled_amount = ?, settled_at = datetime('now') WHERE id = ?`,
      [round2(payment.amount), payment.id]);
    run(db, `UPDATE milestones SET status = 'paid' WHERE id = ?`, [milestoneId]);
    run(db, `UPDATE talent_profiles SET jobs_completed = jobs_completed + 1 WHERE user_id = ?`, [payment.payee_id]);

    const remaining = get(db, `SELECT count(*) AS n FROM milestones
                               WHERE project_id = ? AND status NOT IN ('paid', 'resolved')`, [milestone.project_id]);
    if (remaining.n === 0) run(db, `UPDATE projects SET status = 'completed' WHERE id = ?`, [milestone.project_id]);

    notify(db, payment.payee_id, 'payment', 'Payment released',
      `${round2(payment.amount)} ${payment.asset} settled on ${payment.network}.`,
      `/app/payments.html`);

    return get(db, 'SELECT * FROM payments WHERE id = ?', [payment.id]);
  });
}

/** Returns escrowed funds to the client (used for cancelled work). */
function refundMilestone(db, { milestoneId, actorId }) {
  return transaction(db, () => {
    const payment = get(db, `SELECT p.*, m.title, m.status AS milestone_status
                             FROM payments p JOIN milestones m ON m.id = p.milestone_id
                             WHERE p.milestone_id = ? AND p.status = 'escrow_funded'`, [milestoneId]);
    if (!payment) throw conflict('No escrowed payment found for this milestone.');
    if (payment.payer_id !== actorId) throw badRequest('Only the client can request a refund.');
    // A dispute freezes the money: only an admin resolution may move it.
    if (payment.milestone_status === 'disputed') {
      throw conflict('This milestone is under dispute. An admin has to resolve it.');
    }

    const total = round2(payment.amount + payment.fee);
    run(db, `UPDATE wallets SET in_escrow = in_escrow - ?, available = available + ?
             WHERE user_id = ? AND asset = ? AND network = ?`,
      [total, total, payment.payer_id, payment.asset, payment.network]);
    run(db, `UPDATE payments SET status = 'refunded', settled_amount = 0, settled_at = datetime('now') WHERE id = ?`, [payment.id]);
    run(db, `UPDATE milestones SET status = 'planned' WHERE id = ?`, [milestoneId]);
    notify(db, payment.payee_id, 'payment', 'Escrow refunded',
      `Escrow for "${payment.title}" was returned to the client.`, '/app/payments.html');
    return get(db, 'SELECT * FROM payments WHERE id = ?', [payment.id]);
  });
}

function notify(db, userId, kind, title, body, link = '') {
  run(db, `INSERT INTO notifications (id, user_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?, ?)`,
    [id('ntf'), userId, kind, title, body, link]);
}

// --------------------------------------------------------------- disputes
//
// A submitted milestone can stall: the client thinks the work fell short, or the
// client simply will not release. Either party freezes it here and an admin
// arbitrates. Escrow stays exactly where it is until the admin decides, so the
// money can only move once, through resolveDispute.

const OPEN_STATUSES = ['open', 'answered'];

/** The project row plus the counterparty, or throws if the actor is not a party. */
function partyFor(db, milestoneId, actorId) {
  const milestone = get(db, `SELECT m.*, p.client_id, p.talent_id, p.name AS project_name
                             FROM milestones m JOIN projects p ON p.id = m.project_id
                             WHERE m.id = ?`, [milestoneId]);
  if (!milestone) throw notFound('That milestone does not exist.');
  const isClient = milestone.client_id === actorId;
  const isTalent = milestone.talent_id === actorId;
  if (!isClient && !isTalent) throw forbidden('Only the client or the assigned specialist can dispute a milestone.');
  return { milestone, isClient, counterparty: isClient ? milestone.talent_id : milestone.client_id };
}

/**
 * Freezes a submitted milestone pending admin arbitration.
 * Escrow is untouched: the funds simply stop being releasable by the client.
 */
function openDispute(db, { milestoneId, actorId, reason, desired }) {
  return transaction(db, () => {
    const { milestone, isClient, counterparty } = partyFor(db, milestoneId, actorId);

    // Check for an existing dispute first: a disputed milestone also fails the
    // status test below, and "already under dispute" is the accurate message.
    const existing = get(db, 'SELECT id, status FROM disputes WHERE milestone_id = ?', [milestoneId]);
    if (existing && OPEN_STATUSES.includes(existing.status)) throw conflict('This milestone is already under dispute.');
    if (existing && existing.status === 'resolved') throw conflict('This milestone was already arbitrated.');

    if (milestone.status !== 'submitted') {
      throw conflict('Only a submitted milestone can be disputed. Fund it and wait for delivery first.');
    }
    if (!get(db, `SELECT id FROM payments WHERE milestone_id = ? AND status = 'escrow_funded'`, [milestoneId])) {
      throw conflict('No escrowed payment found for this milestone.');
    }

    // A withdrawn dispute leaves its row behind, and milestone_id is UNIQUE,
    // so reuse the row rather than inserting a second one.
    const disputeId = existing ? existing.id : id('dsp');
    if (existing) {
      run(db, `UPDATE disputes SET raised_by = ?, reason = ?, desired = ?, status = 'open',
                                   response = '', responded_by = NULL, responded_at = NULL,
                                   created_at = datetime('now')
               WHERE id = ?`, [actorId, reason, desired, disputeId]);
    } else {
      run(db, `INSERT INTO disputes (id, milestone_id, project_id, raised_by, reason, desired, status)
               VALUES (?, ?, ?, ?, ?, ?, 'open')`,
        [disputeId, milestoneId, milestone.project_id, actorId, reason, desired]);
    }
    run(db, `UPDATE milestones SET status = 'disputed' WHERE id = ?`, [milestoneId]);

    notify(db, counterparty, 'dispute', 'Milestone disputed',
      `"${milestone.title}" is on hold pending review. You can add your side.`,
      `/app/project.html?id=${milestone.project_id}`);
    for (const admin of all(db, `SELECT id FROM users WHERE role = 'admin'`)) {
      notify(db, admin.id, 'dispute', 'New dispute to arbitrate',
        `${isClient ? 'A client' : 'A specialist'} disputed "${milestone.title}".`, '/app/admin.html');
    }

    return get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
  });
}

/** The counterparty records their side of the story before an admin decides. */
function respondToDispute(db, { disputeId, actorId, response }) {
  const dispute = get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
  if (!dispute) throw notFound('That dispute does not exist.');
  if (!OPEN_STATUSES.includes(dispute.status)) throw conflict('This dispute is already closed.');
  if (dispute.raised_by === actorId) throw badRequest('You opened this dispute; add detail in the project room instead.');

  const { counterparty } = partyFor(db, dispute.milestone_id, actorId);
  run(db, `UPDATE disputes SET response = ?, responded_by = ?, responded_at = datetime('now'), status = 'answered'
           WHERE id = ?`, [response, actorId, disputeId]);
  notify(db, counterparty, 'dispute', 'Dispute answered',
    'The other party responded. An admin will review it.', `/app/project.html?id=${dispute.project_id}`);
  return get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
}

/**
 * Admin arbitration. Moves the escrowed funds exactly once:
 *
 *   release → the full amount to the specialist (platform fee retained)
 *   refund  → the amount and the fee back to the client
 *   split   → `talentShare` to the specialist, the rest to the client, fee retained
 *
 * The milestone lands on `paid` for a release, `planned` for a refund (so it can
 * be re-funded), and `resolved` for a split, which is terminal.
 */
function resolveDispute(db, { disputeId, actorId, outcome, talentShare, resolution }) {
  return transaction(db, () => {
    const dispute = get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
    if (!dispute) throw notFound('That dispute does not exist.');
    if (!OPEN_STATUSES.includes(dispute.status)) throw conflict('This dispute is already resolved.');

    const payment = get(db, `SELECT p.*, m.title FROM payments p JOIN milestones m ON m.id = p.milestone_id
                             WHERE p.milestone_id = ? AND p.status = 'escrow_funded'`, [dispute.milestone_id]);
    if (!payment) throw conflict('No escrowed payment found for this milestone.');

    const amount = round2(payment.amount);
    const fee = round2(payment.fee);
    const held = round2(amount + fee);

    let toTalent = 0;
    let toClient = 0;
    let milestoneStatus;
    let paymentStatus;

    if (outcome === 'release') {
      toTalent = amount;
      milestoneStatus = 'paid';
      paymentStatus = 'released';
    } else if (outcome === 'refund') {
      toClient = held;
      milestoneStatus = 'planned';
      paymentStatus = 'refunded';
    } else {
      const share = round2(talentShare);
      if (!(share > 0) || share >= amount) {
        throw badRequest('A split must award the specialist more than 0 and less than the full amount.', {
          talent_share: `Enter an amount between 0 and ${amount}, exclusive.`
        });
      }
      toTalent = share;
      toClient = round2(amount - share);
      milestoneStatus = 'resolved';
      paymentStatus = 'split';
    }

    run(db, `UPDATE wallets SET in_escrow = in_escrow - ? WHERE user_id = ? AND asset = ? AND network = ?`,
      [held, payment.payer_id, payment.asset, payment.network]);
    if (toClient > 0) {
      run(db, `UPDATE wallets SET available = available + ? WHERE user_id = ? AND asset = ? AND network = ?`,
        [toClient, payment.payer_id, payment.asset, payment.network]);
    }
    if (toTalent > 0) {
      ensureWallet(db, payment.payee_id, payment.asset, payment.network);
      run(db, `UPDATE wallets SET available = available + ? WHERE user_id = ? AND asset = ? AND network = ?`,
        [toTalent, payment.payee_id, payment.asset, payment.network]);
      run(db, `UPDATE talent_profiles SET jobs_completed = jobs_completed + 1 WHERE user_id = ?`, [payment.payee_id]);
    }

    run(db, `UPDATE payments SET status = ?, settled_amount = ?, settled_at = datetime('now') WHERE id = ?`,
      [paymentStatus, toTalent, payment.id]);
    run(db, `UPDATE milestones SET status = ? WHERE id = ?`, [milestoneStatus, dispute.milestone_id]);
    run(db, `UPDATE disputes SET status = 'resolved', outcome = ?, talent_share = ?, resolution = ?,
                                 resolved_by = ?, resolved_at = datetime('now')
             WHERE id = ?`, [outcome, toTalent || null, resolution, actorId, disputeId]);

    const remaining = get(db, `SELECT count(*) AS n FROM milestones
                               WHERE project_id = ? AND status NOT IN ('paid', 'resolved')`, [dispute.project_id]);
    if (remaining.n === 0) run(db, `UPDATE projects SET status = 'completed' WHERE id = ?`, [dispute.project_id]);

    const project = get(db, 'SELECT client_id, talent_id FROM projects WHERE id = ?', [dispute.project_id]);
    const summary = outcome === 'release' ? `Released ${amount} ${payment.asset} to the specialist.`
      : outcome === 'refund' ? `Refunded ${held} ${payment.asset} to the client.`
        : `Split: ${toTalent} ${payment.asset} to the specialist, ${toClient} returned to the client.`;
    for (const userId of [project.client_id, project.talent_id]) {
      notify(db, userId, 'dispute', 'Dispute resolved', `"${payment.title}" — ${summary}`, '/app/payments.html');
    }

    return get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
  });
}

/** Whoever opened a dispute can withdraw it while it is still open. */
function withdrawDispute(db, { disputeId, actorId }) {
  return transaction(db, () => {
    const dispute = get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
    if (!dispute) throw notFound('That dispute does not exist.');
    if (!OPEN_STATUSES.includes(dispute.status)) throw conflict('This dispute is already closed.');
    if (dispute.raised_by !== actorId) throw forbidden('Only whoever raised the dispute can withdraw it.');

    run(db, `UPDATE disputes SET status = 'withdrawn' WHERE id = ?`, [disputeId]);
    // Back to submitted: the client can release or the parties can dispute again.
    run(db, `UPDATE milestones SET status = 'submitted' WHERE id = ?`, [dispute.milestone_id]);
    const { counterparty } = partyFor(db, dispute.milestone_id, actorId);
    notify(db, counterparty, 'dispute', 'Dispute withdrawn',
      'The milestone is back to awaiting release.', `/app/project.html?id=${dispute.project_id}`);
    return get(db, 'SELECT * FROM disputes WHERE id = ?', [disputeId]);
  });
}

/** Disputes on one project, newest first, with participant names attached. */
function disputesForProject(db, projectId) {
  return all(db, `SELECT d.*, m.title AS milestone_title, m.amount,
                         raiser.name AS raised_by_name, responder.name AS responded_by_name
                  FROM disputes d
                  JOIN milestones m ON m.id = d.milestone_id
                  JOIN users raiser ON raiser.id = d.raised_by
                  LEFT JOIN users responder ON responder.id = d.responded_by
                  WHERE d.project_id = ? ORDER BY d.created_at DESC`, [projectId]);
}

module.exports = {
  PLATFORM_FEE_RATE, feeFor, round2, ensureWallet, notify,
  fundMilestone, submitMilestone, releaseMilestone, refundMilestone,
  openDispute, respondToDispute, resolveDispute, withdrawDispute, disputesForProject
};
