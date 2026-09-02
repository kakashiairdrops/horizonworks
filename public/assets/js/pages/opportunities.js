import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, money, formatDate, statusTag, START_LABEL } from '../ui.js';

const session = await requireSession(['talent']);

if (session) {
  await mountShell({
    title: 'Open briefs matching your skills',
    crumb: `Horizon / ${session.user.name} / Opportunities`,
    actions: [el('a', { class: 'btn sm ghost', href: '/app/profile.html' }, ['Edit profile'])]
  });
  load();
}

async function load() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    const [{ briefs }, { invitations }] = await Promise.all([api.get('/api/briefs'), api.get('/api/invitations')]);
    const invitedBriefs = new Set(invitations.map((invitation) => invitation.brief_id));
    host.innerHTML = '';

    host.append(el('p', {
      class: 'subtitle',
      text: 'Open briefs that share at least one skill with your profile. Clients invite from ranked shortlists — keeping your rate and availability current is what gets you surfaced.'
    }));

    if (!briefs.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No matching briefs right now' }),
        'Add more skills to your profile, or check back — new briefs are posted regularly.',
        el('div', { style: 'margin-top:14px' }, [el('a', { class: 'btn primary', href: '/app/profile.html' }, ['Update your profile'])])
      ]));
      return;
    }

    const grid = el('div', { class: 'grid-2' });
    for (const brief of briefs) {
      grid.append(el('article', { class: 'brief-card' }, [
        el('div', { class: 'head' }, [
          el('div', {}, [
            el('h3', { text: brief.title }),
            el('p', { class: 'meta', text: `${brief.clientCompany || brief.clientName} · ${brief.category} · ${START_LABEL[brief.startWindow]}` })
          ]),
          el('span', { html: invitedBriefs.has(brief.id) ? '<span class="tag ok">You were invited</span>' : statusTag(brief.status) })
        ]),
        el('p', { text: brief.description.slice(0, 220) + (brief.description.length > 220 ? '…' : '') }),
        el('div', { class: 'chip-set' }, brief.skills.map((skill) => el('span', { class: 'tag', text: skill }))),
        el('div', { class: 'foot' }, [
          el('span', {
            style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase;letter-spacing:.9px',
            text: `${money(brief.budgetMin)}–${money(brief.budgetMax, brief.asset)} · ${brief.network} · posted ${formatDate(brief.createdAt)}`
          }),
          invitedBriefs.has(brief.id)
            ? el('a', { class: 'btn sm primary', href: '/app/invitations.html' }, ['View invitation →'])
            : el('span', { style: 'font-size:11.5px;color:var(--muted-dim)', text: 'Awaiting a client invitation' })
        ])
      ]));
    }
    host.append(grid);
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}
