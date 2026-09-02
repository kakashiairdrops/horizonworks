// Workspace chrome: sidebar navigation, notification tray, and sign-out.

import { api, me, clearMeCache } from './api.js';
import { $, el, esc, initials, timeAgo, toast } from './ui.js';

const NAV = {
  client: [
    ['/app/dashboard.html', 'Overview'],
    ['/app/briefs.html', 'Briefs & matches'],
    ['/app/talent.html', 'Talent directory'],
    ['/app/projects.html', 'Projects'],
    ['/app/payments.html', 'Payments & escrow']
  ],
  talent: [
    ['/app/dashboard.html', 'Overview'],
    ['/app/invitations.html', 'Invitations', 'openInvitations'],
    ['/app/opportunities.html', 'Open briefs'],
    ['/app/projects.html', 'Projects'],
    ['/app/payments.html', 'Earnings'],
    ['/app/profile.html', 'My profile']
  ],
  admin: [
    ['/app/dashboard.html', 'Overview'],
    ['/app/admin.html', 'Control room'],
    ['/app/talent.html', 'Talent directory'],
    ['/app/projects.html', 'All projects'],
    ['/app/payments.html', 'Escrow ledger']
  ]
};

/**
 * Renders the sidebar + top bar into the current page.
 * @returns the session payload so callers can reuse it.
 */
export async function mountShell({ title, crumb, actions = [] } = {}) {
  const session = await me();
  if (!session.user) return null;
  const user = session.user;

  const sidebar = el('aside', { class: 'sidebar', id: 'sidebar' });
  sidebar.append(el('a', { class: 'brand', href: '/' }, [el('i', {}), 'horizon']));

  // The links live in their own scroll region so that a short window shortens
  // the list rather than pushing the account block and sign-out off the bottom.
  const links = el('nav', { class: 'nav-scroll', 'aria-label': 'Workspace' });
  links.append(el('div', { class: 'nav-label', text: user.role === 'admin' ? 'Control room' : 'Workspace' }));

  const counts = await loadCounts(user.role);
  for (const [href, label, countKey] of NAV[user.role] || NAV.client) {
    const isCurrent = location.pathname === href;
    const count = countKey ? counts[countKey] : 0;
    links.append(el('a', {
      class: 'nav-item', href, ...(isCurrent ? { 'aria-current': 'page' } : {})
    }, [label, count ? el('span', { class: 'count', text: String(count) }) : null]));
  }

  links.append(
    el('div', { class: 'nav-label', text: 'Account' }),
    el('a', { class: 'nav-item', href: '/app/settings.html' }, ['Settings']),
    el('a', { class: 'nav-item', href: '/' }, ['Public site ↗'])
  );
  sidebar.append(links);

  sidebar.append(
    el('div', { class: 'sidebar-foot' }, [
      el('span', { text: user.role === 'talent' ? 'Specialist' : user.role === 'admin' ? 'Operator' : 'Client workspace' }),
      el('strong', { text: user.company || user.name }),
      el('button', { class: 'btn ghost sm', style: 'margin-top:10px', type: 'button', onclick: signOut }, ['Sign out'])
    ])
  );

  const bell = el('button', { class: 'bell', type: 'button', 'aria-label': 'Notifications', onclick: openNotifications }, ['◔']);
  if (session.unreadNotifications) bell.append(el('span', { class: 'dot', text: String(session.unreadNotifications) }));

  const top = el('div', { class: 'workspace-top' }, [
    el('div', { style: 'display:flex;align-items:center;gap:12px' }, [
      el('button', {
        class: 'mobile-nav-toggle', type: 'button', 'aria-label': 'Toggle navigation',
        onclick: () => sidebar.classList.toggle('open')
      }, ['☰']),
      el('span', { class: 'crumb', text: crumb || `Horizon / ${user.name}` })
    ]),
    el('div', { class: 'top-actions' }, [
      ...actions,
      bell,
      el('div', { class: 'avatar sm', style: `--hue:${user.avatarHue}`, title: user.email, text: initials(user.name) })
    ])
  ]);

  const main = $('#workspace');
  main.prepend(top);
  if (title) {
    const heading = el('h1', { text: title });
    top.after(heading);
  }
  // The sidebar must be the FIRST CHILD OF .shell: that grid declares
  // `246px 1fr`, so the nav fills column one and the workspace fills column
  // two. Appending it to <body> instead leaves the grid with a single child,
  // which squeezes the workspace into the 246px column and pushes it a full
  // viewport height down the page.
  const shell = document.querySelector('.shell') || document.body;
  shell.prepend(sidebar);
  document.title = `Horizon — ${title || 'Workspace'}`;
  return session;
}

async function loadCounts(role) {
  if (role !== 'talent') return {};
  try {
    const data = await api.get('/api/dashboard');
    return data.stats || {};
  } catch {
    return {};
  }
}

async function signOut() {
  try { await api.post('/api/auth/logout'); } catch { /* clearing locally regardless */ }
  clearMeCache();
  location.href = '/';
}

async function openNotifications() {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <div class="modal-head"><h2>Notifications</h2>
      <button class="close-x" type="button" aria-label="Close">×</button></div>
    <div class="modal-body" id="notification-body"><div class="skeleton"></div></div>
    <div class="modal-foot">
      <button class="btn ghost" type="button" data-act="read">Mark all read</button>
      <button class="btn primary" type="button" data-act="close">Done</button>
    </div>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('.close-x').onclick = close;
  dialog.querySelector('[data-act="close"]').onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  const body = dialog.querySelector('#notification-body');
  try {
    const data = await api.get('/api/notifications?limit=25');
    body.innerHTML = data.notifications.length
      ? data.notifications.map((item) => `
        <a class="row-item" href="${esc(item.link || '#')}" style="margin-bottom:8px">
          <div class="grow">
            <h3>${esc(item.title)}${item.read_at ? '' : ' <span class="tag lime">NEW</span>'}</h3>
            <p>${esc(item.body)}</p>
          </div>
          <div class="trail" style="font-weight:500;color:var(--muted-dim);font-size:11px">${esc(timeAgo(item.created_at))}</div>
        </a>`).join('')
      : '<div class="empty"><strong>Nothing yet</strong>Updates about briefs, milestones, and payments land here.</div>';
  } catch (error) {
    body.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }

  dialog.querySelector('[data-act="read"]').onclick = async () => {
    try {
      await api.post('/api/notifications/read', {});
      toast('All notifications marked read.');
      document.querySelector('.bell .dot')?.remove();
      close();
    } catch (error) {
      toast(error.message, { variant: 'error' });
    }
  };
}
