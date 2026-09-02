import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import {
  $, el, esc, money, initials, statusTag, toast, withBusy, param,
  AVAILABILITY_LABEL, START_LABEL
} from '../ui.js';

const BREAKDOWN_LABELS = {
  skills: 'Skills / 40',
  availability: 'Availability / 20',
  budget: 'Budget fit / 15',
  reputation: 'Reputation / 15',
  settlement: 'Settlement / 10'
};
const BREAKDOWN_MAX = { skills: 40, availability: 20, budget: 15, reputation: 15, settlement: 10 };

const session = await requireSession(['client', 'admin']);
const briefId = param('brief');

if (session) {
  await mountShell({
    title: 'Curated shortlist',
    crumb: `Horizon / ${session.user.company || session.user.name} / Shortlist`,
    actions: [el('a', { class: 'btn sm ghost', href: '/app/briefs.html' }, ['← All briefs'])]
  });
  if (!briefId) {
    $('#page').innerHTML = '<div class="empty"><strong>No brief selected</strong>Choose a brief to see its shortlist.</div>';
  } else {
    load();
  }
}

async function load() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton" style="min-height:200px"></div>';
  try {
    const data = await api.get(`/api/briefs/${encodeURIComponent(briefId)}/matches?limit=10`);
    host.innerHTML = '';

    host.append(el('section', { class: 'card', style: 'margin-bottom:18px' }, [
      el('div', { class: 'card-head' }, [
        el('div', {}, [
          el('p', { class: 'kicker', text: `Your brief · ${data.brief.category} · ${START_LABEL[data.brief.startWindow]}` }),
          el('h2', { style: 'margin-top:6px', text: data.brief.title })
        ]),
        el('div', { style: 'display:flex;gap:7px;align-items:center' }, [
          el('span', { html: statusTag(data.brief.status) }),
          el('a', { class: 'btn sm ghost', href: '/app/briefs.html' }, ['Refine brief'])
        ])
      ]),
      el('p', { style: 'margin:0 0 12px;color:var(--muted);font-size:13px;line-height:1.65', text: data.brief.description }),
      el('div', { class: 'chip-set' }, [
        el('span', { class: 'tag lime', text: `${money(data.brief.budgetMin)}–${money(data.brief.budgetMax, data.brief.asset)}` }),
        el('span', { class: 'tag', text: `${data.brief.asset} · ${data.brief.network}` }),
        ...data.brief.skills.map((skill) => el('span', { class: 'tag', text: skill }))
      ])
    ]));

    host.append(el('div', { class: 'section-title' }, [
      el('h2', { text: `${data.matches.length} ranked match${data.matches.length === 1 ? '' : 'es'}` }),
      el('span', {
        style: 'font-size:12px;color:var(--muted)',
        text: 'Scored out of 100: skills 40 · availability 20 · budget 15 · reputation 15 · settlement 10'
      })
    ]));

    if (!data.matches.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No approved specialists match yet' }),
        'Widen the required skills or the budget range, or check back once more profiles are approved.'
      ]));
      return;
    }

    const grid = el('div', { class: 'grid-2' });
    data.matches.forEach((match, index) => grid.append(matchCard(match, index === 0)));
    host.append(grid);
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}

function matchCard(match, isTop) {
  const person = match.talent;
  const inviteButton = el('button', {
    class: 'btn sm primary', type: 'button', disabled: match.invited,
    onclick: (event) => invite(event.currentTarget, person)
  }, [match.invited ? 'Invitation sent ✓' : 'Invite to brief →']);

  return el('article', { class: `match-card${isTop ? ' top' : ''}` }, [
    el('div', { class: 'head' }, [
      el('div', { class: 'avatar lg', style: `--hue:${person.avatarHue}`, text: initials(person.name) }),
      el('div', { class: 'grow' }, [
        el('h3', {}, [person.name, person.verified ? el('span', { class: 'tag ok', style: 'margin-left:7px', text: 'Verified' }) : null]),
        el('p', { class: 'role', text: `${person.headline} · ${person.location}` }),
        el('p', { class: 'role', style: 'margin-top:4px', text: `${person.rating.toFixed(1)}★ · ${person.reviewsCount} reviews · ${person.jobsCompleted} projects` })
      ]),
      el('div', { class: 'score' }, [
        el('strong', { text: String(match.score) }),
        el('small', { text: 'match' })
      ])
    ]),
    el('p', { style: 'margin:0;font-size:12.5px;color:var(--muted);line-height:1.6', text: person.bio }),
    el('div', { class: 'chip-set' }, person.skills.map((skill) => el('span', {
      class: match.matchedSkills.includes(skill) ? 'tag lime' : 'tag', text: skill
    }))),
    el('div', { class: 'score-breakdown' }, Object.entries(match.breakdown).map(([key, value]) => el('div', { class: 'score-row' }, [
      el('span', { text: BREAKDOWN_LABELS[key] }),
      el('span', { class: 'bar' }, [el('i', { style: `width:${Math.round((value / BREAKDOWN_MAX[key]) * 100)}%` })]),
      el('span', { style: 'text-align:right;color:var(--paper)', text: String(value) })
    ]))),
    el('ul', { class: 'reasons' }, match.reasons.map((reason) => el('li', { text: reason }))),
    el('div', { class: 'foot' }, [
      el('div', {}, [
        el('strong', { style: 'font-size:16px', text: `$${person.rateMin}–${person.rateMax}` }),
        el('span', { style: 'color:var(--muted-dim);font-size:12px', text: ' /hr' }),
        el('p', {
          style: 'margin:2px 0 0;font:9.5px var(--mono);letter-spacing:.9px;text-transform:uppercase;color:var(--muted-dim)',
          text: `${AVAILABILITY_LABEL[person.availability]} · ${person.payoutAsset} on ${person.payoutNetwork}`
        })
      ]),
      el('div', { style: 'display:flex;gap:7px' }, [
        el('a', { class: 'btn sm ghost', href: `/talent-profile.html?id=${encodeURIComponent(person.id)}`, target: '_blank', rel: 'noopener' }, ['Profile ↗']),
        inviteButton
      ])
    ])
  ]);
}

async function invite(button, person) {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="invite-form">
      <div class="modal-head"><h2>Invite ${esc(person.name)}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="invite-error" hidden></div>
        <label class="field"><span>Add a note (optional)</span>
          <textarea name="message" rows="4" maxlength="600"
            placeholder="Why you think they're a fit, and anything they should know before replying."></textarea>
        </label>
        <p style="margin:0;font-size:12.5px;color:var(--muted)">If they accept, Horizon opens a project room with a three-part milestone plan drafted from your budget.</p>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">Send invitation</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  $('#invite-form', dialog).addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post(`/api/briefs/${encodeURIComponent(briefId)}/invitations`, {
        talent_id: person.id,
        message: event.currentTarget.elements.message.value
      }));
      close();
      button.disabled = true;
      button.textContent = 'Invitation sent ✓';
      toast(`${person.name} has been invited.`, { title: 'Invitation sent' });
    } catch (error) {
      const box = $('#invite-error', dialog);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}
