import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, money, compactMoney, timeAgo, statusTag } from '../ui.js';

const session = await requireSession();
if (session) {
  const user = session.user;
  await mountShell({
    title: `Your work, moving forward.`,
    crumb: `Horizon / ${user.company || user.name} / Overview`,
    actions: user.role === 'client'
      ? [el('a', { class: 'btn primary sm', href: '/app/briefs.html?new=1' }, ['+ New brief'])]
      : user.role === 'talent'
        ? [el('a', { class: 'btn primary sm', href: '/app/opportunities.html' }, ['Find briefs'])]
        : [el('a', { class: 'btn primary sm', href: '/app/admin.html' }, ['Control room'])]
  });
  render(user);
}

const CLIENT_TILES = [
  ['openBriefs', 'Open briefs', 'Waiting on matches'],
  ['activeProjects', 'Active projects', 'In motion right now'],
  ['awaitingReview', 'Awaiting your review', 'Submitted milestones'],
  ['pendingInvitations', 'Invitations sent', 'Awaiting a reply']
];

const TALENT_TILES = [
  ['openInvitations', 'Open invitations', 'Waiting on your reply'],
  ['matchingBriefs', 'Briefs matching you', 'Open right now'],
  ['activeProjects', 'Active projects', 'In motion right now'],
  ['awaitingSubmission', 'Funded milestones', 'Ready for you to deliver']
];

const ADMIN_TILES = [
  ['users', 'Accounts', 'Across all roles'],
  ['pendingTalent', 'Profiles to review', 'Awaiting approval'],
  ['openDisputes', 'Disputes to arbitrate', 'Escrow frozen'],
  ['openBriefs', 'Open briefs', 'Across the network']
];

async function render(user) {
  const host = $('#page');
  try {
    const [data, projects] = await Promise.all([api.get('/api/dashboard'), api.get('/api/projects')]);
    host.innerHTML = '';

    host.append(el('p', {
      class: 'subtitle',
      text: user.role === 'client'
        ? 'Post a brief, review an explainable shortlist, and settle each milestone through escrow.'
        : user.role === 'talent'
          ? 'Respond to invitations, deliver against funded milestones, and track your earnings.'
          : 'Review profiles, keep briefs moving, and watch the escrow ledger.'
    }));

    const tiles = el('div', { class: 'stat-grid' });
    const wallet = data.wallets[0];
    if (wallet) {
      tiles.append(el('article', { class: 'stat wallet-tile' }, [
        el('small', { text: user.role === 'talent' ? 'Available to withdraw' : 'Available to fund' }),
        el('strong', { text: money(wallet.available, wallet.asset) }),
        el('span', { text: `${wallet.network} · ${money(wallet.in_escrow)} in escrow` })
      ]));
    }

    const definitions = user.role === 'client' ? CLIENT_TILES : user.role === 'talent' ? TALENT_TILES : ADMIN_TILES;
    for (const [key, label, hint] of definitions) {
      tiles.append(el('article', { class: 'stat' }, [
        el('small', { text: label }),
        el('strong', { text: String(data.stats[key] ?? 0).padStart(2, '0') }),
        el('span', { text: hint })
      ]));
    }
    const moneyKey = user.role === 'talent' ? 'earned' : user.role === 'client' ? 'paid' : 'escrow';
    const moneyLabel = user.role === 'talent' ? 'Earned to date' : user.role === 'client' ? 'Released to talent' : 'Held in escrow';
    tiles.append(el('article', { class: 'stat' }, [
      el('small', { text: moneyLabel }),
      el('strong', { text: compactMoney(data.stats[moneyKey] || 0) }),
      el('span', { text: data.stats.inEscrow !== undefined ? `${compactMoney(data.stats.inEscrow)} currently in escrow` : 'Simulated settlement' })
    ]));
    host.append(tiles);

    const columns = el('div', { class: 'two-col', style: 'margin-top:26px' });

    const projectPanel = el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [
        el('h2', { text: user.role === 'admin' ? 'All projects' : 'Projects in motion' }),
        el('a', { href: '/app/projects.html', style: 'font:10px var(--mono);letter-spacing:1px;text-transform:uppercase;color:var(--lime);text-decoration:none' }, ['View all ↗'])
      ])
    ]);
    const list = el('div', { class: 'list' });
    const active = projects.projects.slice(0, 4);
    if (!active.length) {
      list.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No projects yet' }),
        user.role === 'client'
          ? 'Post a brief and invite a specialist to open your first project room.'
          : 'Accept an invitation to open your first project room.'
      ]));
    }
    for (const project of active) {
      const counterparty = user.role === 'talent' ? project.client : project.talent;
      list.append(el('a', { class: 'row-item', href: `/app/project.html?id=${encodeURIComponent(project.id)}` }, [
        el('div', { class: 'avatar', style: `--hue:${counterparty.avatarHue}`, text: (counterparty.name || '?')[0].toUpperCase() }),
        el('div', { class: 'grow' }, [
          el('h3', { text: project.name }),
          el('p', { text: `with ${counterparty.company || counterparty.name} · ${project.totals.progress}% complete` })
        ]),
        el('div', { class: 'trail', html: `${money(project.totals.total, project.asset)}<br>${statusTag(project.status)}` })
      ]));
    }
    projectPanel.append(list);
    columns.append(projectPanel);

    const feed = el('aside', { class: 'card' }, [el('div', { class: 'card-head' }, [el('h2', { text: 'Latest activity' })])]);
    if (!data.notifications.length) {
      feed.append(el('div', { class: 'empty', text: 'Activity will appear here as work progresses.' }));
    }
    for (const item of data.notifications) {
      feed.append(el('a', {
        href: item.link || '#',
        style: 'display:block;padding:11px 0;border-bottom:1px solid var(--line);text-decoration:none'
      }, [
        el('strong', { style: 'display:block;font-size:13px;letter-spacing:-.3px', text: item.title }),
        el('span', { style: 'display:block;font-size:12px;color:var(--muted);margin:3px 0 4px', text: item.body }),
        el('span', { style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase;letter-spacing:.9px', text: timeAgo(item.created_at) })
      ]));
    }
    columns.append(feed);
    host.append(columns);

    if (user.role === 'talent' && session.profile?.status !== 'approved') {
      host.prepend(el('div', { class: 'alert info' }, [
        session.profile?.status === 'pending'
          ? 'Your profile is awaiting operator review. Once approved you will appear in the directory and in client shortlists. '
          : 'Your profile needs changes before it can go live. ',
        el('a', { href: '/app/profile.html', style: 'color:var(--lime);font-weight:700' }, ['Review your profile ↗'])
      ]));
    }

    // Frozen escrow is the one thing worth interrupting a dashboard for, so it
    // gets a banner rather than a tile that would read 00 for almost everyone.
    if (user.role !== 'admin' && data.stats.openDisputes > 0) {
      const count = data.stats.openDisputes;
      host.prepend(el('div', { class: 'alert warn' }, [
        `${count === 1 ? 'One milestone is' : `${count} milestones are`} under dispute, so that escrow is frozen until an operator decides. `,
        el('a', { href: '/app/projects.html', style: 'color:var(--lime);font-weight:700' }, ['Open your projects ↗'])
      ]));
    }
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}
