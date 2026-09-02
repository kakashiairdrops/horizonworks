'use strict';

const { get, run, all, transaction } = require('./db');
const { id, hashPassword } = require('./ids');

const SKILLS = [
  ['Next.js', 'Web development'], ['React', 'Web development'], ['Webflow', 'Web development'],
  ['Shopify', 'Web development'], ['Node.js', 'Web development'], ['Three.js', 'Web development'],
  ['React Native', 'App development'], ['Swift', 'App development'], ['Flutter', 'App development'],
  ['Kotlin', 'App development'],
  ['LLM integration', 'AI automation'], ['Workflow automation', 'AI automation'],
  ['Data pipelines', 'AI automation'], ['Prompt engineering', 'AI automation'],
  ['Video editing', 'Creative production'], ['Motion design', 'Creative production'],
  ['Thumbnail design', 'Creative production'], ['Short-form clipping', 'Creative production'],
  ['Script writing', 'Creative production'], ['Brand identity', 'Creative production'],
  ['Smart contracts', 'Web3'], ['Solidity', 'Web3'], ['Tokenomics', 'Web3'], ['DeFi integration', 'Web3']
];

const CATEGORIES = ['Web development', 'App development', 'AI automation', 'Creative production', 'Web3'];

const DEMO_PASSWORD = 'horizon-demo-2025';

const TALENT = [
  {
    email: 'maya@horizon.test', name: 'Maya Chen', headline: 'Senior web developer & design engineer',
    location: 'London, UK', timezone: 'Europe/London', bio: 'High-conversion product sites for teams who care about the details. Ten years shipping Next.js and Shopify builds for startups and studios.',
    rate: [85, 120], availability: 'available_now', capacity: 30, asset: 'USDC', network: 'Base',
    skills: ['Next.js', 'React', 'Shopify', 'Node.js'], experience: 10, rating: 4.9, reviews: 18, jobs: 24, verified: 1
  },
  {
    email: 'jordan@horizon.test', name: 'Jordan Ellis', headline: 'Full-stack developer',
    location: 'Toronto, CA', timezone: 'America/Toronto', bio: 'Pragmatic builder pairing thoughtful frontend craft with sturdy, scalable foundations. Comfortable owning a product end to end.',
    rate: [75, 100], availability: 'available_now', capacity: 25, asset: 'USDC', network: 'Solana',
    skills: ['React', 'Node.js', 'Webflow'], experience: 8, rating: 4.7, reviews: 11, jobs: 15, verified: 1
  },
  {
    email: 'rafael@horizon.test', name: 'Rafael Moreno', headline: 'Creative developer',
    location: 'Lisbon, PT', timezone: 'Europe/Lisbon', bio: 'Digital experiences with personality — WebGL, scroll choreography, and interfaces that create a little wonder.',
    rate: [95, 140], availability: 'two_weeks', capacity: 20, asset: 'ETH', network: 'Ethereum',
    skills: ['Three.js', 'React', 'Motion design'], experience: 9, rating: 4.8, reviews: 9, jobs: 12, verified: 1
  },
  {
    email: 'samir@horizon.test', name: 'Samir Patel', headline: 'AI automation architect',
    location: 'Bengaluru, IN', timezone: 'Asia/Kolkata', bio: 'I design the systems that remove the busywork: LLM pipelines, internal tooling, and integrations that survive real traffic.',
    rate: [70, 110], availability: 'available_now', capacity: 35, asset: 'USDC', network: 'Base',
    skills: ['LLM integration', 'Workflow automation', 'Data pipelines', 'Node.js'], experience: 7, rating: 4.9, reviews: 14, jobs: 19, verified: 1
  },
  {
    email: 'olivia@horizon.test', name: 'Olivia James', headline: 'Video editor & short-form specialist',
    location: 'Austin, US', timezone: 'America/Chicago', bio: 'Founder-led content that keeps attention. Long-form edits, clip systems, and thumbnails that earn the click.',
    rate: [55, 85], availability: 'two_weeks', capacity: 25, asset: 'USDT', network: 'Ethereum',
    skills: ['Video editing', 'Short-form clipping', 'Thumbnail design'], experience: 6, rating: 4.6, reviews: 21, jobs: 41, verified: 1
  },
  {
    email: 'noor@horizon.test', name: 'Noor Haddad', headline: 'Mobile engineer (iOS & Android)',
    location: 'Dubai, AE', timezone: 'Asia/Dubai', bio: 'Cross-platform apps with native polish. I care about launch quality, crash-free sessions, and App Store review timelines.',
    rate: [80, 115], availability: 'next_month', capacity: 20, asset: 'USDC', network: 'Base',
    skills: ['React Native', 'Swift', 'Kotlin'], experience: 8, rating: 4.8, reviews: 7, jobs: 10, verified: 1
  },
  {
    email: 'diego@horizon.test', name: 'Diego Alvarez', headline: 'Smart contract engineer',
    location: 'Buenos Aires, AR', timezone: 'America/Argentina/Buenos_Aires', bio: 'Audited Solidity, protocol integrations, and on-chain payment rails. Security review before shipping, always.',
    rate: [110, 160], availability: 'available_now', capacity: 20, asset: 'USDC', network: 'Base',
    skills: ['Smart contracts', 'Solidity', 'DeFi integration'], experience: 6, rating: 4.9, reviews: 6, jobs: 8, verified: 1
  },
  {
    email: 'freya@horizon.test', name: 'Freya Lund', headline: 'Brand & product designer',
    location: 'Copenhagen, DK', timezone: 'Europe/Copenhagen', bio: 'Identity systems and interface design that make small teams look considered. Figma-first, handoff-friendly.',
    rate: [70, 100], availability: 'available_now', capacity: 28, asset: 'USDC', network: 'Solana',
    skills: ['Brand identity', 'Motion design', 'Thumbnail design'], experience: 11, rating: 4.7, reviews: 13, jobs: 22, verified: 0
  },
  {
    email: 'kenji@horizon.test', name: 'Kenji Watanabe', headline: 'Growth-focused script writer',
    location: 'Tokyo, JP', timezone: 'Asia/Tokyo', bio: 'Scripts and narrative structure for founder channels and product launches. Research-led, hook-first.',
    rate: [50, 80], availability: 'two_weeks', capacity: 22, asset: 'USDT', network: 'Ethereum',
    skills: ['Script writing', 'Short-form clipping'], experience: 5, rating: 4.5, reviews: 8, jobs: 17, verified: 0
  },
  {
    email: 'amara@horizon.test', name: 'Amara Okafor', headline: 'Data & analytics engineer',
    location: 'Lagos, NG', timezone: 'Africa/Lagos', bio: 'Warehouses, dashboards, and the pipelines feeding them. I make the numbers trustworthy before anyone makes decisions on them.',
    rate: [65, 95], availability: 'available_now', capacity: 30, asset: 'USDC', network: 'Base',
    skills: ['Data pipelines', 'Workflow automation', 'Node.js'], experience: 7, rating: 4.8, reviews: 10, jobs: 14, verified: 1
  }
];

function seed(db, { withDemoData = true } = {}) {
  transaction(db, () => {
    for (const [name, category] of SKILLS) {
      if (!get(db, 'SELECT id FROM skills WHERE name = ?', [name])) {
        run(db, 'INSERT INTO skills (id, name, category) VALUES (?, ?, ?)', [id('skl'), name, category]);
      }
    }

    if (!get(db, `SELECT id FROM users WHERE role = 'admin'`)) {
      const adminId = id('usr');
      run(db, `INSERT INTO users (id, email, password_hash, name, role, company, avatar_hue)
               VALUES (?, ?, ?, ?, 'admin', 'Horizon Collective', 82)`,
        [adminId, 'admin@horizon.test', hashPassword(DEMO_PASSWORD), 'Horizon Operator']);
    }

    if (!withDemoData || get(db, `SELECT id FROM users WHERE email = 'maya@horizon.test'`)) return;

    const skillId = (name) => get(db, 'SELECT id FROM skills WHERE name = ?', [name]).id;

    const clientId = id('usr');
    run(db, `INSERT INTO users (id, email, password_hash, name, role, company, avatar_hue)
             VALUES (?, ?, ?, ?, 'client', 'Northstar Studio', 200)`,
      [clientId, 'alex@northstar.test', hashPassword(DEMO_PASSWORD), 'Alex Morgan']);
    run(db, `INSERT INTO wallets (user_id, asset, network, available, in_escrow) VALUES (?, 'USDC', 'Base', 42480, 0)`, [clientId]);

    const talentIds = {};
    for (const person of TALENT) {
      const userId = id('usr');
      talentIds[person.email] = userId;
      run(db, `INSERT INTO users (id, email, password_hash, name, role, avatar_hue)
               VALUES (?, ?, ?, ?, 'talent', ?)`,
        [userId, person.email, hashPassword(DEMO_PASSWORD), person.name, Math.floor(Math.random() * 360)]);
      run(db, `INSERT INTO talent_profiles
               (user_id, headline, bio, location, timezone, rate_min, rate_max, availability, weekly_capacity,
                payout_asset, payout_network, wallet_address, portfolio_url, years_experience,
                rating, reviews_count, jobs_completed, verified, status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved')`,
        [userId, person.headline, person.bio, person.location, person.timezone,
          person.rate[0], person.rate[1], person.availability, person.capacity,
          person.asset, person.network, `0x${id('w').slice(-12)}…${id('w').slice(-4)}`,
          `https://${person.name.toLowerCase().split(' ')[0]}.work`, person.experience,
          person.rating, person.reviews, person.jobs, person.verified]);
      for (const skill of person.skills) {
        run(db, 'INSERT INTO talent_skills (user_id, skill_id, level) VALUES (?, ?, 4)', [userId, skillId(skill)]);
      }
      run(db, `INSERT INTO wallets (user_id, asset, network, available, in_escrow) VALUES (?, ?, ?, ?, 0)`,
        [userId, person.asset, person.network, Math.round(person.jobs * 180)]);
    }

    const briefId = id('brf');
    run(db, `INSERT INTO briefs (id, client_id, title, description, category, budget_min, budget_max,
                                asset, network, start_window, engagement, status)
             VALUES (?, ?, ?, ?, 'Web development', 3000, 5000, 'USDC', 'Base', 'this_week', 'project', 'open')`,
      [briefId, clientId, 'Northstar product site',
        'A sharp, conversion-first launch site for our new analytics product. Needs a considered design system, CMS-backed marketing pages, and fast Core Web Vitals.']);
    for (const skill of ['Next.js', 'React', 'Shopify']) {
      run(db, 'INSERT INTO brief_skills (brief_id, skill_id) VALUES (?, ?)', [briefId, skillId(skill)]);
    }

    const secondBriefId = id('brf');
    run(db, `INSERT INTO briefs (id, client_id, title, description, category, budget_min, budget_max,
                                asset, network, start_window, engagement, status)
             VALUES (?, ?, ?, ?, 'AI automation', 5000, 8000, 'USDC', 'Base', 'two_weeks', 'project', 'open')`,
      [secondBriefId, clientId, 'Inbox & ops automation',
        'Design and implement the internal automation layer for a fast-moving remote team: triage, routing, and reporting.']);
    for (const skill of ['LLM integration', 'Workflow automation']) {
      run(db, 'INSERT INTO brief_skills (brief_id, skill_id) VALUES (?, ?)', [secondBriefId, skillId(skill)]);
    }

    const projectId = id('prj');
    run(db, `INSERT INTO projects (id, brief_id, client_id, talent_id, name, summary, asset, network, status)
             VALUES (?, ?, ?, ?, ?, ?, 'USDC', 'Base', 'active')`,
      [projectId, briefId, clientId, talentIds['maya@horizon.test'], 'Northstar website rebuild',
        'Full rebuild of the Northstar marketing site: direction, design system, responsive build, and CMS handoff.']);

    const milestones = [
      ['Direction & sitemap', 'Structure, creative direction, and approved page plan.', 800, 'paid', 1],
      ['Design system & build', 'Full visual system, responsive build, and CMS integration.', 1700, 'funded', 2],
      ['Launch & handoff', 'QA, performance checks, and team handoff.', 900, 'planned', 3]
    ];
    for (const [title, description, amount, status, position] of milestones) {
      run(db, `INSERT INTO milestones (id, project_id, position, title, description, amount, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)`, [id('mil'), projectId, position, title, description, amount, status]);
    }

    const funded = get(db, `SELECT id, amount FROM milestones WHERE project_id = ? AND status = 'funded'`, [projectId]);
    const fee = Math.round(funded.amount * 0.03 * 100) / 100;
    run(db, `INSERT INTO payments (id, project_id, milestone_id, payer_id, payee_id, amount, fee, asset, network, status, tx_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'USDC', 'Base', 'escrow_funded', 'sim-escrow-seed01')`,
      [id('pay'), projectId, funded.id, clientId, talentIds['maya@horizon.test'], funded.amount, fee]);
    run(db, `UPDATE wallets SET available = available - ?, in_escrow = in_escrow + ?
             WHERE user_id = ? AND asset = 'USDC' AND network = 'Base'`,
      [funded.amount + fee, funded.amount + fee, clientId]);

    const paidMilestone = get(db, `SELECT id, amount FROM milestones WHERE project_id = ? AND status = 'paid'`, [projectId]);
    run(db, `INSERT INTO payments (id, project_id, milestone_id, payer_id, payee_id, amount, fee, settled_amount,
                                   asset, network, status, tx_ref, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USDC', 'Base', 'released', 'sim-escrow-seed00', datetime('now', '-6 days'))`,
      [id('pay'), projectId, paidMilestone.id, clientId, talentIds['maya@horizon.test'],
        paidMilestone.amount, Math.round(paidMilestone.amount * 0.03 * 100) / 100, paidMilestone.amount]);

    const chat = [
      [talentIds['maya@horizon.test'], 'Design system is complete and the responsive build is ready for review. Desktop and mobile previews are linked.', 'https://www.figma.com/file/northstar-build-preview'],
      [clientId, 'The new direction is landing really well. Excited to see the build come together.', null]
    ];
    for (const [authorId, body, attachment] of chat) {
      run(db, `INSERT INTO messages (id, project_id, author_id, body, attachment) VALUES (?, ?, ?, ?, ?)`,
        [id('msg'), projectId, authorId, body, attachment]);
    }

    run(db, `INSERT INTO invitations (id, brief_id, talent_id, score, message, status)
             VALUES (?, ?, ?, 94, 'We think your Shopify and Next.js work is a strong fit for this launch.', 'accepted')`,
      [id('inv'), briefId, talentIds['maya@horizon.test']]);
    run(db, `INSERT INTO invitations (id, brief_id, talent_id, score, message, status)
             VALUES (?, ?, ?, 88, 'Would you be open to scoping the automation layer with us?', 'sent')`,
      [id('inv'), secondBriefId, talentIds['samir@horizon.test']]);

    run(db, `INSERT INTO reviews (id, project_id, reviewer_id, subject_id, rating, comment)
             VALUES (?, ?, ?, ?, 5, 'Maya turned a vague brief into a genuinely sharp site. Communication was excellent throughout.')`,
      [id('rev'), projectId, clientId, talentIds['maya@horizon.test']]);

    run(db, `INSERT INTO notifications (id, user_id, kind, title, body, link)
             VALUES (?, ?, 'milestone', 'Milestone ready for review', 'Design system & build is awaiting your approval.', ?)`,
      [id('ntf'), clientId, `/app/project.html?id=${projectId}`]);
    run(db, `INSERT INTO notifications (id, user_id, kind, title, body, link)
             VALUES (?, ?, 'invitation', 'New project invitation', 'Northstar Studio invited you to a brief.', '/app/invitations.html')`,
      [id('ntf'), talentIds['samir@horizon.test']]);

    for (const inquiry of [
      ['Priya Raman', 'priya@example.com', 'client', 'App development', 'USDC', 'Looking for an iOS build partner for Q4.'],
      ['Tom Becker', 'tom@example.com', 'talent', 'Video editing', 'USDT', 'Six years editing founder content, would love to join.']
    ]) {
      run(db, `INSERT INTO inquiries (id, name, email, role, service, settlement, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id('inq'), ...inquiry]);
    }
  });

  return {
    skills: all(db, 'SELECT count(*) AS n FROM skills')[0].n,
    users: all(db, 'SELECT count(*) AS n FROM users')[0].n
  };
}

module.exports = { seed, SKILLS, CATEGORIES, DEMO_PASSWORD };
