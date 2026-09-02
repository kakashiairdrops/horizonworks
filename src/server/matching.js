'use strict';

const { all } = require('./db');

const START_ORDER = { this_week: 0, two_weeks: 1, flexible: 2 };
const AVAILABILITY_ORDER = { available_now: 0, two_weeks: 1, next_month: 2, unavailable: 3 };

/**
 * Transparent, deterministic scoring. Every component is reported back so the UI
 * can explain *why* a person was surfaced instead of showing an opaque percentage.
 *
 * skills 40 · availability 20 · budget fit 15 · reputation 15 · settlement 10
 *
 * Skill relevance also gates the total: someone with no overlap on a brief that
 * names required skills cannot outrank a genuine specialist on the strength of
 * their availability and reputation alone.
 */
function scoreTalent(brief, talent) {
  const reasons = [];
  const briefSkills = brief.skills || [];
  const talentSkills = talent.skills || [];
  const overlap = briefSkills.filter((skill) => talentSkills.includes(skill));

  let skillPoints;
  if (!briefSkills.length) {
    skillPoints = talent.category === brief.category ? 28 : 18;
  } else {
    skillPoints = Math.round((overlap.length / briefSkills.length) * 40);
  }
  if (overlap.length) reasons.push(`${overlap.length}/${briefSkills.length || overlap.length} required skills: ${overlap.join(', ')}`);
  else if (briefSkills.length) reasons.push('No overlap with the required skills');

  const gap = AVAILABILITY_ORDER[talent.availability] - START_ORDER[brief.start_window];
  let availabilityPoints;
  if (talent.availability === 'unavailable') availabilityPoints = 0;
  else if (gap <= 0) { availabilityPoints = 20; reasons.push('Free within your start window'); }
  else if (gap === 1) { availabilityPoints = 12; reasons.push('Slightly after your ideal start'); }
  else { availabilityPoints = 6; reasons.push('Available later than requested'); }

  let budgetPoints = 8;
  const budgetMax = Number(brief.budget_max) || 0;
  const budgetMin = Number(brief.budget_min) || 0;
  const rateMin = Number(talent.rate_min) || 0;
  if (budgetMax > 0 && rateMin > 0) {
    // Compare like with like: assume a project consumes ~40 billable hours.
    const impliedHourly = brief.engagement === 'hourly' ? budgetMax : budgetMax / 40;
    if (rateMin <= impliedHourly) { budgetPoints = 15; reasons.push('Rate sits inside your budget'); }
    else if (rateMin <= impliedHourly * 1.25) { budgetPoints = 9; reasons.push('Slightly above budget — negotiable'); }
    else { budgetPoints = 3; reasons.push('Rate is above this budget'); }
  }

  const rating = Number(talent.rating) || 0;
  const reviews = Number(talent.reviews_count) || 0;
  let reputationPoints = Math.round((rating / 5) * 10);
  if (reviews >= 5) reputationPoints += 3;
  else if (reviews >= 1) reputationPoints += 1;
  if (talent.verified) reputationPoints += 2;
  reputationPoints = Math.min(reputationPoints, 15);
  if (rating > 0) reasons.push(`${rating.toFixed(1)}★ across ${reviews} review${reviews === 1 ? '' : 's'}`);
  if (talent.verified) reasons.push('Identity verified');

  let settlementPoints = 4;
  if (talent.payout_asset === brief.asset && talent.payout_network === brief.network) {
    settlementPoints = 10;
    reasons.push(`Already settles in ${brief.asset} on ${brief.network}`);
  } else if (talent.payout_asset === brief.asset) {
    settlementPoints = 7;
    reasons.push(`Accepts ${brief.asset} on another network`);
  }

  const subtotal = skillPoints + availabilityPoints + budgetPoints + reputationPoints + settlementPoints;

  // Relevance gate: strong availability and reputation must not float a candidate
  // with no required-skill overlap above someone who actually has the skills.
  const gated = briefSkills.length && !overlap.length;
  if (gated) reasons.push('Ranked down: none of the required skills');
  const total = gated ? Math.round(subtotal * 0.45) : subtotal;

  return {
    score: Math.max(0, Math.min(100, total)),
    breakdown: {
      skills: skillPoints, availability: availabilityPoints, budget: budgetPoints,
      reputation: reputationPoints, settlement: settlementPoints
    },
    relevanceGated: Boolean(gated),
    reasons,
    matchedSkills: overlap
  };
}

/** Loads approved talent with their skills attached. */
function loadTalentPool(db, { onlyApproved = true } = {}) {
  const rows = all(db, `
    SELECT p.*, u.name, u.email, u.avatar_hue AS avatar_hue,
           (SELECT group_concat(s.name, '||') FROM talent_skills ts
              JOIN skills s ON s.id = ts.skill_id WHERE ts.user_id = p.user_id) AS skill_names,
           (SELECT s.category FROM talent_skills ts JOIN skills s ON s.id = ts.skill_id
              WHERE ts.user_id = p.user_id LIMIT 1) AS category
    FROM talent_profiles p JOIN users u ON u.id = p.user_id
    ${onlyApproved ? "WHERE p.status = 'approved'" : ''}
  `);
  return rows.map((row) => ({ ...row, skills: row.skill_names ? row.skill_names.split('||') : [] }));
}

/** Ranks the pool against a brief, best first. */
function rankMatches(db, brief, { limit = 12, pool } = {}) {
  const candidates = pool || loadTalentPool(db);
  return candidates
    .map((talent) => ({ talent, ...scoreTalent(brief, talent) }))
    .sort((a, b) => (
      b.matchedSkills.length - a.matchedSkills.length
      || b.score - a.score
      || b.talent.rating - a.talent.rating
    ))
    .slice(0, limit);
}

module.exports = { scoreTalent, rankMatches, loadTalentPool };
