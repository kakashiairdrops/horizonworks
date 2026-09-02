import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, money, statusTag, timeAgo, toast, withBusy, confirmDialog, START_LABEL } from '../ui.js';

const session = await requireSession(['talent', 'client']);

if (session) {
  await mountShell({
    title: session.user.role === 'talent' ? 'Invitations' : 'Invitations sent',
    crumb: `Horizon / ${session.user.company || session.user.name} / Invitations`
  });
  load();
}

async function load() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton"></div>';
  const isTalent = session.user.role === 'talent';
  try {
    const { invitations } = await api.get('/api/invitations');
    host.innerHTML = '';
    host.append(el('p', {
      class: 'subtitle',
      text: isTalent
        ? 'Briefs a client has specifically invited you to. Accepting opens a project room with a draft milestone plan.'
        : 'Invitations you have sent, and where each one stands.'
    }));

    const pending = invitations.filter((invitation) => invitation.status === 'sent');
    const settled = invitations.filter((invitation) => invitation.status !== 'sent');

    if (!invitations.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No invitations yet' }),
        isTalent
          ? 'Keep your profile and availability current — clients invite from ranked shortlists.'
          : 'Open a brief shortlist and invite the specialists who fit.'
      ]));
      return;
    }

    if (pending.length) {
      host.append(el('div', { class: 'section-title' }, [el('h2', { text: `Awaiting a reply · ${pending.length}` })]));
      const grid = el('div', { class: 'grid-2' });
      for (const invitation of pending) grid.append(card(invitation, isTalent));
      host.append(grid);
    }
    if (settled.length) {
      host.append(el('div', { class: 'section-title' }, [el('h2', { text: `Resolved · ${settled.length}` })]));
      const grid = el('div', { class: 'grid-2' });
      for (const invitation of settled) grid.append(card(invitation, isTalent));
      host.append(grid);
    }
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}

function card(invitation, isTalent) {
  const actions = el('div', { style: 'display:flex;gap:7px' });
  if (isTalent && invitation.status === 'sent') {
    actions.append(
      el('button', {
        class: 'btn sm primary', type: 'button',
        onclick: (event) => respond(event.currentTarget, invitation, 'accept')
      }, ['Accept & open room →']),
      el('button', {
        class: 'btn sm ghost', type: 'button',
        onclick: (event) => respond(event.currentTarget, invitation, 'decline')
      }, ['Decline'])
    );
  }

  return el('article', { class: 'brief-card' }, [
    el('div', { class: 'head' }, [
      el('div', {}, [
        el('h3', { text: invitation.title }),
        el('p', {
          class: 'meta',
          text: `${isTalent ? (invitation.client_company || invitation.client_name) : invitation.talent_name} · ${invitation.category} · ${START_LABEL[invitation.start_window]}`
        })
      ]),
      el('div', { style: 'text-align:right' }, [
        el('span', { html: statusTag(invitation.status) }),
        el('p', { style: 'margin:6px 0 0;font:9.5px var(--mono);color:var(--muted-dim)', text: `${invitation.score} match` })
      ])
    ]),
    el('p', { text: invitation.description.slice(0, 200) + (invitation.description.length > 200 ? '…' : '') }),
    invitation.message
      ? el('div', {
        style: 'padding:11px 13px;border-left:2px solid var(--lime);background:rgba(217,255,95,.06);font-size:12.5px;color:#cfd1c9;border-radius:0 8px 8px 0'
      }, [`“${invitation.message}”`])
      : null,
    el('div', { class: 'foot' }, [
      el('span', {
        style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase;letter-spacing:.9px',
        text: `${money(invitation.budget_min)}–${money(invitation.budget_max, invitation.asset)} · ${timeAgo(invitation.created_at)}`
      }),
      actions
    ])
  ]);
}

async function respond(button, invitation, action) {
  const ok = await confirmDialog(action === 'accept'
    ? {
      title: 'Accept this invitation?',
      body: `A project room opens for "${invitation.title}" with a three-part milestone plan drafted from the client's budget. You can discuss changes in the room before anything is funded.`,
      confirmLabel: 'Accept & open room'
    }
    : {
      title: 'Decline this invitation?',
      body: 'The client will be notified. You can still be invited to other briefs.',
      confirmLabel: 'Decline', variant: 'danger'
    });
  if (!ok) return;

  try {
    const result = await withBusy(button, () => api.post(`/api/invitations/${encodeURIComponent(invitation.id)}/respond`, { action }));
    if (action === 'accept' && result.projectId) {
      toast('Project room created.', { title: 'Accepted' });
      location.href = `/app/project.html?id=${encodeURIComponent(result.projectId)}`;
      return;
    }
    toast('Invitation declined.');
    load();
  } catch (error) {
    toast(error.message, { variant: 'error' });
  }
}
