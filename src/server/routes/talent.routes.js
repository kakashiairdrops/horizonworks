'use strict';

const { get, run, all, transaction } = require('../db');
const { requireUser, requireRole } = require('../auth');
const { validate, notFound, badRequest } = require('../validate');
const { query, queryInt, queryList, resolveSkillIds, skillNamesFor, audit } = require('../http');

const AVAILABILITY = ['available_now', 'two_weeks', 'next_month', 'unavailable'];
const SORTS = {
  relevance: 'p.verified DESC, p.rating DESC, p.reviews_count DESC',
  rating: 'p.rating DESC, p.reviews_count DESC',
  rate_low: 'p.rate_min ASC',
  rate_high: 'p.rate_max DESC',
  newest: 'p.updated_at DESC',
  experience: 'p.years_experience DESC'
};

function publicProfile(db, row) {
  return {
    id: row.user_id,
    name: row.name,
    avatarHue: row.avatar_hue,
    headline: row.headline,
    bio: row.bio,
    location: row.location,
    timezone: row.timezone,
    rateMin: row.rate_min,
    rateMax: row.rate_max,
    availability: row.availability,
    weeklyCapacity: row.weekly_capacity,
    payoutAsset: row.payout_asset,
    payoutNetwork: row.payout_network,
    portfolioUrl: row.portfolio_url,
    yearsExperience: row.years_experience,
    rating: row.rating,
    reviewsCount: row.reviews_count,
    jobsCompleted: row.jobs_completed,
    verified: Boolean(row.verified),
    status: row.status,
    skills: skillNamesFor(db, 'talent_skills', 'user_id', row.user_id)
  };
}

function register(router) {
  router.get('/api/skills', ({ db }) => ({
    skills: all(db, 'SELECT id, name, category FROM skills ORDER BY category, name')
  }));

  // Public, paginated talent directory with filters. Only approved profiles appear.
  router.get('/api/talent', ({ db, url }) => {
    const search = query(url, 'q');
    const skills = queryList(url, 'skill');
    const availability = queryList(url, 'availability').filter((value) => AVAILABILITY.includes(value));
    const asset = query(url, 'asset');
    const network = query(url, 'network');
    const maxRate = queryInt(url, 'max_rate', 0);
    const minRating = Number(query(url, 'min_rating', '0')) || 0;
    const verifiedOnly = query(url, 'verified') === 'true';
    const sort = SORTS[query(url, 'sort', 'relevance')] || SORTS.relevance;
    const limit = Math.min(Math.max(queryInt(url, 'limit', 12), 1), 50);
    const page = Math.max(queryInt(url, 'page', 1), 1);

    const where = ["p.status = 'approved'"];
    const params = [];

    if (search) {
      where.push('(u.name LIKE ? OR p.headline LIKE ? OR p.bio LIKE ? OR p.location LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (availability.length) {
      where.push(`p.availability IN (${availability.map(() => '?').join(', ')})`);
      params.push(...availability);
    }
    if (asset) { where.push('p.payout_asset = ?'); params.push(asset); }
    if (network) { where.push('p.payout_network = ?'); params.push(network); }
    if (maxRate > 0) { where.push('p.rate_min <= ?'); params.push(maxRate); }
    if (minRating > 0) { where.push('p.rating >= ?'); params.push(minRating); }
    if (verifiedOnly) where.push('p.verified = 1');
    if (skills.length) {
      const skillIds = resolveSkillIds(db, skills);
      where.push(`(SELECT count(DISTINCT ts.skill_id) FROM talent_skills ts
                   WHERE ts.user_id = p.user_id AND ts.skill_id IN (${skillIds.map(() => '?').join(', ')})) = ?`);
      params.push(...skillIds, skillIds.length);
    }

    const clause = `WHERE ${where.join(' AND ')}`;
    const total = get(db, `SELECT count(*) AS n FROM talent_profiles p JOIN users u ON u.id = p.user_id ${clause}`, params).n;
    const rows = all(db, `SELECT p.*, u.name, u.avatar_hue FROM talent_profiles p JOIN users u ON u.id = p.user_id
                          ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);

    return {
      talent: rows.map((row) => publicProfile(db, row)),
      page, limit, total, pages: Math.max(Math.ceil(total / limit), 1)
    };
  });

  // Mirrors the directory's visibility rule: a profile the directory hides must
  // not be readable here either. Owners and admins always see their own.
  router.get('/api/talent/:userId', ({ db, params, session }) => {
    const row = get(db, `SELECT p.*, u.name, u.avatar_hue FROM talent_profiles p JOIN users u ON u.id = p.user_id
                         WHERE p.user_id = ?`, [params.userId]);
    if (!row) throw notFound('That specialist profile does not exist.');

    const viewer = session?.user;
    const maySeeUnapproved = viewer && (viewer.id === row.user_id || viewer.role === 'admin');
    if (row.status !== 'approved' && !maySeeUnapproved) {
      throw notFound('That specialist profile does not exist.');
    }

    const reviews = all(db, `SELECT r.rating, r.comment, r.created_at, u.name AS reviewer_name, pr.name AS project_name
                             FROM reviews r JOIN users u ON u.id = r.reviewer_id
                             JOIN projects pr ON pr.id = r.project_id
                             WHERE r.subject_id = ? ORDER BY r.created_at DESC LIMIT 10`, [params.userId]);
    return { talent: publicProfile(db, row), reviews };
  });

  router.get('/api/profile', ({ db, session }) => {
    const user = requireRole(session, 'talent');
    const row = get(db, `SELECT p.*, u.name, u.avatar_hue FROM talent_profiles p JOIN users u ON u.id = p.user_id
                         WHERE p.user_id = ?`, [user.id]);
    if (!row) throw notFound('Profile not found.');
    return {
      profile: publicProfile(db, row),
      walletAddress: row.wallet_address,
      invitations: get(db, `SELECT count(*) AS n FROM invitations WHERE talent_id = ? AND status = 'sent'`, [user.id]).n
    };
  });

  router.put('/api/profile', ({ db, session, body }) => {
    const user = requireRole(session, 'talent');
    const data = validate(body, {
      headline: { type: 'string', required: true, min: 6, max: 120 },
      bio: { type: 'string', required: true, min: 40, max: 1200 },
      location: { type: 'string', required: true, min: 2, max: 80 },
      timezone: { type: 'string', max: 60, default: 'UTC' },
      rate_min: { type: 'int', required: true, min: 5, max: 2000 },
      rate_max: { type: 'int', required: true, min: 5, max: 5000 },
      availability: { type: 'enum', required: true, values: AVAILABILITY },
      weekly_capacity: { type: 'int', min: 1, max: 80, default: 20 },
      payout_asset: { type: 'enum', required: true, values: ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'Fiat'] },
      payout_network: { type: 'enum', required: true, values: ['Base', 'Solana', 'Ethereum', 'Arbitrum', 'Polygon', 'Bank'] },
      wallet_address: { type: 'string', max: 120, default: '' },
      portfolio_url: { type: 'url', max: 200, default: '' },
      years_experience: { type: 'int', min: 0, max: 60, default: 0 },
      skills: { type: 'stringArray', required: true, min: 1, max: 12 }
    });
    if (data.rate_max < data.rate_min) throw badRequest('Please correct the highlighted fields.', { rate_max: 'Maximum rate must be at least the minimum rate.' });

    const skillIds = resolveSkillIds(db, data.skills);

    transaction(db, () => {
      run(db, `UPDATE talent_profiles SET headline = ?, bio = ?, location = ?, timezone = ?, rate_min = ?, rate_max = ?,
               availability = ?, weekly_capacity = ?, payout_asset = ?, payout_network = ?, wallet_address = ?,
               portfolio_url = ?, years_experience = ?, updated_at = datetime('now'),
               status = CASE WHEN status = 'rejected' THEN 'pending' ELSE status END
               WHERE user_id = ?`,
        [data.headline, data.bio, data.location, data.timezone, data.rate_min, data.rate_max,
          data.availability, data.weekly_capacity, data.payout_asset, data.payout_network,
          data.wallet_address, data.portfolio_url, data.years_experience, user.id]);
      run(db, 'DELETE FROM talent_skills WHERE user_id = ?', [user.id]);
      for (const skillId of skillIds) {
        run(db, 'INSERT INTO talent_skills (user_id, skill_id, level) VALUES (?, ?, 4)', [user.id, skillId]);
      }
    });

    audit(db, user.id, 'profile.updated', 'talent_profile', user.id, { skills: data.skills.length });
    const row = get(db, `SELECT p.*, u.name, u.avatar_hue FROM talent_profiles p JOIN users u ON u.id = p.user_id
                         WHERE p.user_id = ?`, [user.id]);
    return { profile: publicProfile(db, row) };
  });

  router.get('/api/notifications', ({ db, session, url }) => {
    const user = requireUser(session);
    const limit = Math.min(Math.max(queryInt(url, 'limit', 20), 1), 60);
    return {
      notifications: all(db, `SELECT id, kind, title, body, link, read_at, created_at FROM notifications
                              WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [user.id, limit]),
      unread: get(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]).n
    };
  });

  router.post('/api/notifications/read', ({ db, session, body }) => {
    const user = requireUser(session);
    if (Array.isArray(body?.ids) && body.ids.length) {
      const placeholders = body.ids.map(() => '?').join(', ');
      run(db, `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND id IN (${placeholders})`,
        [user.id, ...body.ids.map(String)]);
    } else {
      run(db, `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`, [user.id]);
    }
    return { unread: get(db, 'SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [user.id]).n };
  });
}

module.exports = { register, publicProfile, AVAILABILITY };
