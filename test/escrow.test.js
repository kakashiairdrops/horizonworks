'use strict';

/**
 * Escrow accounting, exercised directly against an in-memory database rather
 * than over HTTP, so the wallet arithmetic and transaction rollbacks can be
 * asserted exactly.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { SRC } = require('./helpers');

const { openDatabase, all, get, run } = require(path.join(SRC, 'db'));
const { seed } = require(path.join(SRC, 'seed'));
const { id } = require(path.join(SRC, 'ids'));
const { HttpError } = require(path.join(SRC, 'validate'));
const {
  fundMilestone, submitMilestone, releaseMilestone, refundMilestone,
  openDispute, respondToDispute, resolveDispute, withdrawDispute, disputesForProject,
  feeFor, round2, PLATFORM_FEE_RATE
} = require(path.join(SRC, 'escrow'));

const CLIENT_EMAIL = 'alex@northstar.test';
const TALENT_EMAIL = 'maya@horizon.test';

/** Every escrow failure should be an HttpError with a 4xx status. */
const isHttpError = (error) =>
  error instanceof HttpError && error.name === 'HttpError' &&
  typeof error.status === 'number' && error.status >= 400 && error.status < 500;

describe('escrow accounting', () => {
  let db;
  let clientId;
  let talentId;
  let project;

  const wallet = (userId) =>
    get(db, `SELECT available, in_escrow FROM wallets WHERE user_id = ? AND asset = 'USDC' AND network = 'Base'`, [userId]);

  const milestoneBy = (status) =>
    get(db, 'SELECT * FROM milestones WHERE project_id = ? AND status = ? ORDER BY position LIMIT 1', [project.id, status]);

  const milestoneStatus = (milestoneId) => get(db, 'SELECT status FROM milestones WHERE id = ?', [milestoneId]).status;
  const projectStatus = () => get(db, 'SELECT status FROM projects WHERE id = ?', [project.id]).status;
  const paymentFor = (milestoneId) =>
    get(db, 'SELECT * FROM payments WHERE milestone_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [milestoneId]);

  beforeEach(() => {
    db = openDatabase(':memory:');
    seed(db);
    clientId = get(db, 'SELECT id FROM users WHERE email = ?', [CLIENT_EMAIL]).id;
    talentId = get(db, 'SELECT id FROM users WHERE email = ?', [TALENT_EMAIL]).id;
    project = get(db, 'SELECT * FROM projects LIMIT 1');
  });

  afterEach(() => {
    db.close();
  });

  describe('the seeded fixture', () => {
    it('exposes the accounts, project, and milestone mix the tests rely on', () => {
      assert.ok(clientId, 'seeded client');
      assert.ok(talentId, 'seeded talent');
      assert.equal(project.client_id, clientId);
      assert.equal(project.talent_id, talentId);
      assert.equal(project.status, 'active');

      const statuses = all(db, 'SELECT status FROM milestones WHERE project_id = ? ORDER BY position', [project.id])
        .map((row) => row.status);
      assert.deepEqual(statuses, ['paid', 'funded', 'planned']);
      assert.equal(PLATFORM_FEE_RATE, 0.03);
    });
  });

  describe('feeFor()', () => {
    it('charges 3% rounded to two decimals', () => {
      assert.equal(feeFor(1000), 30);
      assert.equal(feeFor(900), 27);
      assert.equal(feeFor(0), 0);
      assert.equal(feeFor(33.33), round2(33.33 * 0.03));
      assert.equal(feeFor(1234.56), 37.04);
    });
  });

  describe('fundMilestone()', () => {
    it('moves amount + fee out of available and into in_escrow', () => {
      const milestone = milestoneBy('planned');
      const before = wallet(clientId);
      const fee = feeFor(milestone.amount);
      const total = round2(milestone.amount + fee);

      const payment = fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });

      const after = wallet(clientId);
      assert.equal(after.available, round2(before.available - total));
      assert.equal(after.in_escrow, round2(before.in_escrow + total));
      assert.equal(round2(after.available + after.in_escrow), round2(before.available + before.in_escrow),
        'funding moves money, it does not create or destroy it');

      assert.equal(payment.amount, milestone.amount);
      assert.equal(payment.fee, fee);
      assert.equal(payment.status, 'escrow_funded');
      assert.equal(payment.payer_id, clientId);
      assert.equal(payment.payee_id, talentId);
      assert.equal(payment.asset, 'USDC');
      assert.equal(payment.network, 'Base');
      assert.equal(payment.settled_at, null);
      assert.match(payment.tx_ref, /^sim-escrow-/);
      assert.equal(milestoneStatus(milestone.id), 'funded');
    });

    it('leaves the talent wallet untouched and notifies them', () => {
      const milestone = milestoneBy('planned');
      const before = wallet(talentId);
      const notificationsBefore = get(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = ?', [talentId]).n;

      fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });

      assert.deepEqual(wallet(talentId), before, 'escrow does not pay the talent yet');
      assert.equal(get(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = ?', [talentId]).n, notificationsBefore + 1);
    });

    it('throws for an unknown milestone', () => {
      assert.throws(
        () => fundMilestone(db, { milestoneId: 'mil_nope', actorId: clientId }),
        (error) => isHttpError(error) && error.status === 404
      );
    });

    it('throws when the milestone is not planned', () => {
      const funded = milestoneBy('funded');
      assert.throws(
        () => fundMilestone(db, { milestoneId: funded.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409 && /already funded/.test(error.message)
      );
    });

    it('throws for a non-payer (the talent) and changes nothing', () => {
      const milestone = milestoneBy('planned');
      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      assert.throws(
        () => fundMilestone(db, { milestoneId: milestone.id, actorId: talentId }),
        (error) => isHttpError(error) && error.status === 400 && /Only the client can fund/.test(error.message)
      );

      assert.deepEqual(wallet(clientId), clientBefore);
      assert.deepEqual(wallet(talentId), talentBefore);
      assert.equal(milestoneStatus(milestone.id), 'planned');
      assert.equal(paymentFor(milestone.id), undefined, 'no payment row is written');
    });

    it('throws on insufficient balance and rolls the whole transaction back', () => {
      const milestoneId = id('mil');
      run(db, `INSERT INTO milestones (id, project_id, position, title, description, amount, status)
               VALUES (?, ?, 9, 'Unaffordable scope', '', 10000000, 'planned')`, [milestoneId, project.id]);

      const clientBefore = wallet(clientId);
      const paymentsBefore = get(db, 'SELECT count(*) AS n FROM payments').n;
      const notificationsBefore = get(db, 'SELECT count(*) AS n FROM notifications').n;

      assert.throws(
        () => fundMilestone(db, { milestoneId, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 400 && /Insufficient balance/.test(error.message)
      );

      assert.deepEqual(wallet(clientId), clientBefore, 'wallet balances must be unchanged after rollback');
      assert.equal(milestoneStatus(milestoneId), 'planned', 'the milestone must stay planned');
      assert.equal(get(db, 'SELECT count(*) AS n FROM payments').n, paymentsBefore, 'no payment row survives');
      assert.equal(get(db, 'SELECT count(*) AS n FROM notifications').n, notificationsBefore, 'no notification survives');
    });

    it('still works after a failed attempt (the failed transaction did not poison the connection)', () => {
      const doomed = id('mil');
      run(db, `INSERT INTO milestones (id, project_id, position, title, amount, status)
               VALUES (?, ?, 9, 'Unaffordable', 10000000, 'planned')`, [doomed, project.id]);
      assert.throws(() => fundMilestone(db, { milestoneId: doomed, actorId: clientId }), isHttpError);

      const milestone = milestoneBy('planned');
      const payment = fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      assert.equal(payment.status, 'escrow_funded');
      assert.equal(milestoneStatus(milestone.id), 'funded');
    });
  });

  describe('submitMilestone()', () => {
    it('moves a funded milestone to submitted for the assigned talent', () => {
      const milestone = milestoneBy('funded');
      const result = submitMilestone(db, { milestoneId: milestone.id, actorId: talentId });
      assert.equal(result.status, 'submitted');
      assert.equal(milestoneStatus(milestone.id), 'submitted');
    });

    it('throws for the client and for a planned milestone', () => {
      const funded = milestoneBy('funded');
      assert.throws(
        () => submitMilestone(db, { milestoneId: funded.id, actorId: clientId }),
        (error) => isHttpError(error) && /Only the assigned specialist/.test(error.message)
      );
      assert.equal(milestoneStatus(funded.id), 'funded');

      const planned = milestoneBy('planned');
      assert.throws(
        () => submitMilestone(db, { milestoneId: planned.id, actorId: talentId }),
        (error) => isHttpError(error) && error.status === 409
      );
    });
  });

  describe('releaseMilestone()', () => {
    it('credits the talent the amount only — never the fee — and closes the escrow entry', () => {
      const milestone = milestoneBy('funded');
      const payment = paymentFor(milestone.id);
      const fee = payment.fee;
      const total = round2(payment.amount + fee);

      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      submitMilestone(db, { milestoneId: milestone.id, actorId: talentId });
      const released = releaseMilestone(db, { milestoneId: milestone.id, actorId: clientId });

      const clientAfter = wallet(clientId);
      const talentAfter = wallet(talentId);

      assert.equal(talentAfter.available, round2(talentBefore.available + payment.amount),
        'the talent receives the amount, not amount + fee');
      assert.notEqual(talentAfter.available, round2(talentBefore.available + total));
      assert.equal(talentAfter.in_escrow, talentBefore.in_escrow);

      assert.equal(clientAfter.in_escrow, round2(clientBefore.in_escrow - total), 'the escrow entry is zeroed out');
      assert.equal(clientAfter.available, clientBefore.available, 'release does not touch the client’s available balance');

      assert.equal(released.status, 'released');
      assert.equal(released.id, payment.id);
      assert.ok(released.settled_at, 'settled_at is stamped');
      assert.equal(get(db, 'SELECT status FROM payments WHERE id = ?', [payment.id]).status, 'released');
      assert.equal(milestoneStatus(milestone.id), 'paid');
      assert.equal(round2(fee), round2(total - payment.amount), 'the platform keeps the fee');
    });

    it('increments the talent’s jobs_completed counter', () => {
      const milestone = milestoneBy('funded');
      const before = get(db, 'SELECT jobs_completed FROM talent_profiles WHERE user_id = ?', [talentId]).jobs_completed;
      releaseMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      const after = get(db, 'SELECT jobs_completed FROM talent_profiles WHERE user_id = ?', [talentId]).jobs_completed;
      assert.equal(after, before + 1);
    });

    it('throws for a non-payer (the talent) and leaves everything unchanged', () => {
      const milestone = milestoneBy('funded');
      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      assert.throws(
        () => releaseMilestone(db, { milestoneId: milestone.id, actorId: talentId }),
        (error) => isHttpError(error) && error.status === 400 && /Only the client can release/.test(error.message)
      );

      assert.deepEqual(wallet(clientId), clientBefore);
      assert.deepEqual(wallet(talentId), talentBefore);
      assert.equal(milestoneStatus(milestone.id), 'funded');
      assert.equal(paymentFor(milestone.id).status, 'escrow_funded');
    });

    it('throws for an unknown milestone, a planned milestone, and a milestone with no escrow', () => {
      assert.throws(
        () => releaseMilestone(db, { milestoneId: 'mil_nope', actorId: clientId }),
        (error) => isHttpError(error) && error.status === 404
      );

      const planned = milestoneBy('planned');
      assert.throws(
        () => releaseMilestone(db, { milestoneId: planned.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409 && /planned milestone cannot be released/.test(error.message)
      );

      const paid = milestoneBy('paid');
      assert.throws(
        () => releaseMilestone(db, { milestoneId: paid.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409
      );
    });

    it('flips the project to completed once every milestone is paid', () => {
      assert.equal(projectStatus(), 'active');

      const outstanding = all(db, `SELECT id, status FROM milestones WHERE project_id = ? AND status <> 'paid' ORDER BY position`,
        [project.id]);
      assert.ok(outstanding.length > 0);

      for (const [index, milestone] of outstanding.entries()) {
        if (milestone.status === 'planned') fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });
        releaseMilestone(db, { milestoneId: milestone.id, actorId: clientId });
        const isLast = index === outstanding.length - 1;
        assert.equal(projectStatus(), isLast ? 'completed' : 'active',
          isLast ? 'the final release completes the project' : 'the project stays active while work remains');
      }

      const statuses = all(db, 'SELECT status FROM milestones WHERE project_id = ?', [project.id]).map((row) => row.status);
      assert.deepEqual(statuses, statuses.map(() => 'paid'));
      assert.equal(wallet(clientId).in_escrow, 0, 'no funds are left in escrow');
    });
  });

  describe('refundMilestone()', () => {
    it('returns amount + fee to the client and resets the milestone to planned', () => {
      const milestone = milestoneBy('funded');
      const payment = paymentFor(milestone.id);
      const total = round2(payment.amount + payment.fee);

      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      const refunded = refundMilestone(db, { milestoneId: milestone.id, actorId: clientId });

      const clientAfter = wallet(clientId);
      assert.equal(clientAfter.available, round2(clientBefore.available + total), 'the fee comes back too');
      assert.equal(clientAfter.in_escrow, round2(clientBefore.in_escrow - total));
      assert.deepEqual(wallet(talentId), talentBefore, 'the talent is not paid on a refund');

      assert.equal(refunded.status, 'refunded');
      assert.ok(refunded.settled_at);
      assert.equal(milestoneStatus(milestone.id), 'planned');
    });

    it('allows re-funding after a refund', () => {
      const milestone = milestoneBy('funded');
      refundMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      const payment = fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      assert.equal(payment.status, 'escrow_funded');
      assert.equal(milestoneStatus(milestone.id), 'funded');
    });

    it('throws for a non-payer and leaves the escrow intact', () => {
      const milestone = milestoneBy('funded');
      const clientBefore = wallet(clientId);

      assert.throws(
        () => refundMilestone(db, { milestoneId: milestone.id, actorId: talentId }),
        (error) => isHttpError(error) && error.status === 400 && /Only the client can request a refund/.test(error.message)
      );

      assert.deepEqual(wallet(clientId), clientBefore);
      assert.equal(milestoneStatus(milestone.id), 'funded');
      assert.equal(paymentFor(milestone.id).status, 'escrow_funded');
    });

    it('throws when there is no escrowed payment to refund', () => {
      const planned = milestoneBy('planned');
      assert.throws(
        () => refundMilestone(db, { milestoneId: planned.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409 && /No escrowed payment/.test(error.message)
      );
    });
  });

  describe('conservation of value across a full cycle', () => {
    it('client outflow equals talent inflow plus platform fees', () => {
      const clientStart = wallet(clientId);
      const talentStart = wallet(talentId);

      const planned = milestoneBy('planned');
      fundMilestone(db, { milestoneId: planned.id, actorId: clientId });
      submitMilestone(db, { milestoneId: planned.id, actorId: talentId });
      releaseMilestone(db, { milestoneId: planned.id, actorId: clientId });

      const clientEnd = wallet(clientId);
      const talentEnd = wallet(talentId);

      const clientOut = round2((clientStart.available + clientStart.in_escrow) - (clientEnd.available + clientEnd.in_escrow));
      const talentIn = round2(talentEnd.available - talentStart.available);
      assert.equal(talentIn, planned.amount);
      assert.equal(clientOut, round2(planned.amount + feeFor(planned.amount)));
      assert.equal(round2(clientOut - talentIn), feeFor(planned.amount), 'the difference is exactly the platform fee');
    });
  });

  describe('disputes', () => {
    let adminId;

    /** Drives a planned milestone to `submitted` so it can be disputed. */
    const toSubmitted = () => {
      const planned = milestoneBy('planned');
      fundMilestone(db, { milestoneId: planned.id, actorId: clientId });
      submitMilestone(db, { milestoneId: planned.id, actorId: talentId });
      return get(db, 'SELECT * FROM milestones WHERE id = ?', [planned.id]);
    };

    /**
     * The seed has exactly one `planned` milestone, so a test that needs more
     * than one submitted milestone has to add its own.
     */
    let extra = 20;
    const newSubmitted = (amount) => {
      const milestoneId = id('mil');
      extra += 1;
      run(db, `INSERT INTO milestones (id, project_id, position, title, amount, status)
               VALUES (?, ?, ?, ?, ?, 'planned')`,
        [milestoneId, project.id, extra, `Extra milestone ${extra}`, amount]);
      fundMilestone(db, { milestoneId, actorId: clientId });
      submitMilestone(db, { milestoneId, actorId: talentId });
      return get(db, 'SELECT * FROM milestones WHERE id = ?', [milestoneId]);
    };

    beforeEach(() => {
      adminId = get(db, `SELECT id FROM users WHERE role = 'admin' LIMIT 1`).id;
    });

    it('either party can freeze a submitted milestone, and escrow does not move', () => {
      const milestone = toSubmitted();
      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId,
        reason: 'The delivered build is missing the responsive breakpoints we agreed on.',
        desired: 'split'
      });

      assert.equal(dispute.status, 'open');
      assert.equal(dispute.desired, 'split');
      assert.equal(dispute.raised_by, clientId);
      assert.equal(milestoneStatus(milestone.id), 'disputed');
      assert.equal(paymentFor(milestone.id).status, 'escrow_funded', 'the payment stays escrowed');
      assert.deepEqual(wallet(clientId), clientBefore, 'no client funds move on opening a dispute');
      assert.deepEqual(wallet(talentId), talentBefore, 'no talent funds move on opening a dispute');
    });

    it('the specialist can raise it too, and both parties plus admins are notified', () => {
      const milestone = toSubmitted();
      const before = get(db, 'SELECT count(*) AS n FROM notifications').n;

      openDispute(db, {
        milestoneId: milestone.id, actorId: talentId,
        reason: 'Work was delivered two weeks ago and the client has not responded to release it.',
        desired: 'release'
      });

      const after = all(db, 'SELECT user_id, kind FROM notifications ORDER BY rowid DESC LIMIT ?',
        [get(db, 'SELECT count(*) AS n FROM notifications').n - before]);
      assert.ok(after.some((row) => row.user_id === clientId), 'the counterparty is notified');
      assert.ok(after.some((row) => row.user_id === adminId), 'an admin is notified');
      assert.ok(after.every((row) => row.kind === 'dispute'));
    });

    it('a milestone that is not submitted cannot be disputed', () => {
      const planned = milestoneBy('planned');
      assert.throws(
        () => openDispute(db, { milestoneId: planned.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund' }),
        (error) => isHttpError(error) && error.status === 409 && /Only a submitted milestone/.test(error.message)
      );
      assert.equal(milestoneStatus(planned.id), 'planned');
    });

    it('a stranger cannot dispute someone else’s milestone', () => {
      const milestone = toSubmitted();
      const stranger = get(db, `SELECT u.id FROM users u WHERE u.id NOT IN (?, ?, ?) LIMIT 1`,
        [clientId, talentId, adminId]).id;
      assert.throws(
        () => openDispute(db, { milestoneId: milestone.id, actorId: stranger, reason: 'x'.repeat(25), desired: 'refund' }),
        (error) => isHttpError(error) && error.status === 403
      );
      assert.equal(milestoneStatus(milestone.id), 'submitted');
    });

    it('the same milestone cannot be disputed twice', () => {
      const milestone = toSubmitted();
      openDispute(db, { milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund' });
      assert.throws(
        () => openDispute(db, { milestoneId: milestone.id, actorId: talentId, reason: 'y'.repeat(25), desired: 'release' }),
        (error) => isHttpError(error) && error.status === 409 && /already under dispute/.test(error.message)
      );
    });

    it('a frozen milestone can be neither released nor refunded by the parties', () => {
      const milestone = toSubmitted();
      openDispute(db, { milestoneId: milestone.id, actorId: talentId, reason: 'x'.repeat(25), desired: 'release' });
      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);

      assert.throws(
        () => releaseMilestone(db, { milestoneId: milestone.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409 && /under dispute/.test(error.message)
      );
      assert.throws(
        () => refundMilestone(db, { milestoneId: milestone.id, actorId: clientId }),
        (error) => isHttpError(error) && error.status === 409 && /under dispute/.test(error.message)
      );

      assert.deepEqual(wallet(clientId), clientBefore);
      assert.deepEqual(wallet(talentId), talentBefore);
      assert.equal(milestoneStatus(milestone.id), 'disputed');
    });

    it('the counterparty responds, and the raiser cannot respond to their own dispute', () => {
      const milestone = toSubmitted();
      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });

      assert.throws(
        () => respondToDispute(db, { disputeId: dispute.id, actorId: clientId, response: 'y'.repeat(25) }),
        (error) => isHttpError(error) && error.status === 400 && /You opened this dispute/.test(error.message)
      );

      const answered = respondToDispute(db, {
        disputeId: dispute.id, actorId: talentId,
        response: 'Every agreed breakpoint is in the delivered build; here is the preview link.'
      });
      assert.equal(answered.status, 'answered');
      assert.equal(answered.responded_by, talentId);
      assert.ok(answered.responded_at, 'the response is timestamped');
    });

    it('an admin release pays the specialist the full amount and retains the fee', () => {
      const milestone = toSubmitted();
      const clientBefore = wallet(clientId);
      const talentBefore = wallet(talentId);
      const fee = feeFor(milestone.amount);
      const held = round2(milestone.amount + fee);

      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: talentId, reason: 'x'.repeat(25), desired: 'release'
      });
      const resolved = resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'release',
        talentShare: null, resolution: 'The delivery matches the agreed scope.'
      });

      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.outcome, 'release');
      assert.equal(resolved.resolved_by, adminId);
      assert.equal(milestoneStatus(milestone.id), 'paid');
      assert.equal(paymentFor(milestone.id).status, 'released');

      assert.equal(round2(wallet(talentId).available - talentBefore.available), milestone.amount);
      assert.equal(round2(wallet(clientId).in_escrow - clientBefore.in_escrow), -held);
      assert.equal(wallet(clientId).available, clientBefore.available, 'the client gets nothing back');
    });

    it('an admin refund returns the amount and the fee, and resets the milestone', () => {
      const milestone = toSubmitted();
      const talentBefore = wallet(talentId);
      const held = round2(milestone.amount + feeFor(milestone.amount));
      const clientAfterFunding = wallet(clientId);

      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });
      resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'refund',
        talentShare: null, resolution: 'The work was never delivered.'
      });

      assert.equal(milestoneStatus(milestone.id), 'planned', 'a refunded milestone can be funded again');
      assert.equal(paymentFor(milestone.id).status, 'refunded');
      assert.equal(round2(wallet(clientId).available - clientAfterFunding.available), held, 'the fee comes back too');
      assert.equal(wallet(clientId).in_escrow, round2(clientAfterFunding.in_escrow - held));
      assert.deepEqual(wallet(talentId), talentBefore, 'the specialist is paid nothing');
    });

    it('an admin split divides the amount and conserves every unit of value', () => {
      const milestone = toSubmitted();
      const clientAfterFunding = wallet(clientId);
      const talentBefore = wallet(talentId);
      const fee = feeFor(milestone.amount);
      const held = round2(milestone.amount + fee);
      const share = round2(milestone.amount * 0.6);

      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'split'
      });
      const resolved = resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'split',
        talentShare: share, resolution: 'Most of the scope landed; two items were missing.'
      });

      assert.equal(resolved.outcome, 'split');
      assert.equal(resolved.talent_share, share);
      assert.equal(milestoneStatus(milestone.id), 'resolved');
      assert.equal(paymentFor(milestone.id).status, 'split');

      const toTalent = round2(wallet(talentId).available - talentBefore.available);
      const backToClient = round2(wallet(clientId).available - clientAfterFunding.available);
      assert.equal(toTalent, share);
      assert.equal(backToClient, round2(milestone.amount - share));
      assert.equal(round2(toTalent + backToClient + fee), held, 'talent + client + fee accounts for everything held');
      assert.equal(wallet(clientId).in_escrow, round2(clientAfterFunding.in_escrow - held), 'escrow is fully drained');

      // Reporting reads settled_amount, so a split must record what actually moved
      // rather than leaving the full amount to be summed as if it were earned.
      const payment = paymentFor(milestone.id);
      assert.equal(payment.settled_amount, share, 'the ledger records the share, not the amount');
      assert.equal(payment.amount, milestone.amount, 'the original amount is preserved for the record');
    });

    it('a full release and a refund record what settled', () => {
      const released = newSubmitted(300);
      releaseMilestone(db, { milestoneId: released.id, actorId: clientId });
      assert.equal(paymentFor(released.id).settled_amount, 300, 'a release settles the whole amount');

      const refunded = newSubmitted(250);
      refundMilestone(db, { milestoneId: refunded.id, actorId: clientId });
      assert.equal(paymentFor(refunded.id).settled_amount, 0, 'a refund settles nothing to the specialist');
    });

    it('summing settled_amount matches what the specialist actually received', () => {
      const talentBefore = wallet(talentId).available;

      const full = newSubmitted(400);
      releaseMilestone(db, { milestoneId: full.id, actorId: clientId });

      const partial = newSubmitted(500);
      const share = round2(partial.amount * 0.4);
      const dispute = openDispute(db, {
        milestoneId: partial.id, actorId: talentId, reason: 'x'.repeat(25), desired: 'release'
      });
      resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'split',
        talentShare: share, resolution: 'Partial delivery, partial payment.'
      });

      const received = round2(wallet(talentId).available - talentBefore);
      const reported = round2(get(db, `SELECT COALESCE(sum(settled_amount), 0) AS total FROM payments
                                       WHERE payee_id = ? AND status IN ('released', 'split')
                                         AND milestone_id IN (?, ?)`,
        [talentId, full.id, partial.id]).total);
      assert.equal(reported, received, 'the reported total must equal the money that moved');
    });

    it('a split must award the specialist strictly between zero and the full amount', () => {
      const milestone = toSubmitted();
      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'split'
      });
      const clientBefore = wallet(clientId);

      for (const share of [0, -50, milestone.amount, milestone.amount + 1]) {
        assert.throws(
          () => resolveDispute(db, {
            disputeId: dispute.id, actorId: adminId, outcome: 'split',
            talentShare: share, resolution: 'A rationale that is long enough.'
          }),
          (error) => isHttpError(error) && error.status === 400,
          `share ${share} should be rejected`
        );
      }

      assert.deepEqual(wallet(clientId), clientBefore, 'a rejected split moves nothing');
      assert.equal(milestoneStatus(milestone.id), 'disputed');
      assert.equal(get(db, 'SELECT status FROM disputes WHERE id = ?', [dispute.id]).status, 'open');
    });

    it('a dispute cannot be resolved twice', () => {
      const milestone = toSubmitted();
      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });
      resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'refund',
        talentShare: null, resolution: 'Nothing was delivered.'
      });
      const walletAfter = wallet(clientId);

      assert.throws(
        () => resolveDispute(db, {
          disputeId: dispute.id, actorId: adminId, outcome: 'release',
          talentShare: null, resolution: 'Changed my mind.'
        }),
        (error) => isHttpError(error) && error.status === 409 && /already resolved/.test(error.message)
      );
      assert.deepEqual(wallet(clientId), walletAfter, 'the money cannot move a second time');
    });

    it('the raiser can withdraw an open dispute, returning it to submitted', () => {
      const milestone = toSubmitted();
      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });

      assert.throws(
        () => withdrawDispute(db, { disputeId: dispute.id, actorId: talentId }),
        (error) => isHttpError(error) && error.status === 403
      );

      const withdrawn = withdrawDispute(db, { disputeId: dispute.id, actorId: clientId });
      assert.equal(withdrawn.status, 'withdrawn');
      assert.equal(milestoneStatus(milestone.id), 'submitted');

      // With the freeze lifted, the normal release path works again.
      releaseMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      assert.equal(milestoneStatus(milestone.id), 'paid');
    });

    it('resolving the last milestone completes the project', () => {
      // Drive every milestone on the project to a terminal state.
      for (const row of all(db, `SELECT id, status FROM milestones WHERE project_id = ?`, [project.id])) {
        if (row.status === 'paid') continue;
        if (row.status === 'planned') fundMilestone(db, { milestoneId: row.id, actorId: clientId });
        submitMilestone(db, { milestoneId: row.id, actorId: talentId });
        releaseMilestone(db, { milestoneId: row.id, actorId: clientId });
      }
      assert.equal(projectStatus(), 'completed');
    });

    it('a split on the final milestone also completes the project', () => {
      const rows = all(db, `SELECT id, status FROM milestones WHERE project_id = ? ORDER BY position`, [project.id]);
      const last = rows[rows.length - 1];

      for (const row of rows) {
        if (row.id === last.id || row.status === 'paid') continue;
        if (row.status === 'planned') fundMilestone(db, { milestoneId: row.id, actorId: clientId });
        submitMilestone(db, { milestoneId: row.id, actorId: talentId });
        releaseMilestone(db, { milestoneId: row.id, actorId: clientId });
      }

      if (last.status === 'planned') fundMilestone(db, { milestoneId: last.id, actorId: clientId });
      submitMilestone(db, { milestoneId: last.id, actorId: talentId });
      const amount = get(db, 'SELECT amount FROM milestones WHERE id = ?', [last.id]).amount;
      const dispute = openDispute(db, {
        milestoneId: last.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'split'
      });
      resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'split',
        talentShare: round2(amount / 2), resolution: 'Half the scope landed.'
      });

      assert.equal(milestoneStatus(last.id), 'resolved');
      assert.equal(projectStatus(), 'completed', 'a resolved milestone counts as finished');
    });

    it('a withdrawn dispute can be raised again on the same milestone', () => {
      const milestone = toSubmitted();
      const first = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });
      withdrawDispute(db, { disputeId: first.id, actorId: clientId });

      const second = openDispute(db, {
        milestoneId: milestone.id, actorId: talentId,
        reason: 'The client went quiet again after the withdrawal.', desired: 'release'
      });
      assert.equal(second.status, 'open');
      assert.equal(second.raised_by, talentId, 'the other party now owns it');
      assert.equal(second.response, '', 'the previous exchange is cleared');
      assert.equal(milestoneStatus(milestone.id), 'disputed');
      assert.equal(disputesForProject(db, project.id).length, 1, 'one dispute row per milestone');
    });

    it('a resolved milestone cannot be disputed again', () => {
      const milestone = toSubmitted();
      const dispute = openDispute(db, {
        milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund'
      });
      resolveDispute(db, {
        disputeId: dispute.id, actorId: adminId, outcome: 'refund',
        talentShare: null, resolution: 'Nothing was delivered.'
      });

      // The refund reset it to planned, so fund and submit it once more.
      fundMilestone(db, { milestoneId: milestone.id, actorId: clientId });
      submitMilestone(db, { milestoneId: milestone.id, actorId: talentId });

      assert.throws(
        () => openDispute(db, { milestoneId: milestone.id, actorId: clientId, reason: 'x'.repeat(25), desired: 'refund' }),
        (error) => isHttpError(error) && error.status === 409 && /already arbitrated/.test(error.message)
      );
    });

    it('disputesForProject returns the dispute with participant names attached', () => {
      const milestone = toSubmitted();
      openDispute(db, {
        milestoneId: milestone.id, actorId: clientId,
        reason: 'The responsive breakpoints are missing.', desired: 'split'
      });

      const rows = disputesForProject(db, project.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].milestone_title, milestone.title);
      assert.equal(rows[0].amount, milestone.amount);
      assert.equal(typeof rows[0].raised_by_name, 'string');
      assert.equal(rows[0].responded_by_name, null, 'nobody has responded yet');
    });
  });
});
