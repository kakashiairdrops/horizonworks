import { api, me } from './api.js';
import { $, el, esc, initials, formatDate, param, AVAILABILITY_LABEL } from './ui.js';

const host = $('#profile');
const talentId = param('id');

me().then((session) => {
  if (!session.user) return;
  const cta = $('#nav-cta');
  cta.textContent = 'Open workspace ↗';
  cta.href = '/app/dashboard.html';
}).catch(() => { /* public page */ });

if (!talentId) {
  host.innerHTML = '<div class="empty"><strong>No specialist selected</strong>Head back to the directory to browse the network.</div>';
} else {
  load();
}

async function load() {
  try {
    const { talent, reviews } = await api.get(`/api/talent/${encodeURIComponent(talentId)}`);
    document.title = `Horizon — ${talent.name}`;
    host.innerHTML = '';

    host.append(el('div', { class: 'profile-hero' }, [
      el('div', { class: 'avatar lg', style: `--hue:${talent.avatarHue};width:86px;height:86px;font-size:26px`, text: initials(talent.name) }),
      el('div', { class: 'grow' }, [
        el('h1', {}, [talent.name, talent.verified ? el('span', { class: 'tag ok', style: 'margin-left:10px;vertical-align:middle', text: 'Verified' }) : null]),
        el('p', { class: 'role', text: `${talent.headline} · ${talent.location} · ${talent.timezone}` }),
        el('div', { class: 'chip-set' }, [
          el('span', { class: 'tag ok', text: AVAILABILITY_LABEL[talent.availability] }),
          el('span', { class: 'tag', text: `${talent.payoutAsset} on ${talent.payoutNetwork}` }),
          el('span', { class: 'tag', text: `${talent.weeklyCapacity} hrs/week` })
        ]),
        el('div', { class: 'profile-meta' }, [
          metaItem('Starting rate', `$${talent.rateMin}/hr`),
          metaItem('Rate ceiling', `$${talent.rateMax}/hr`),
          metaItem('Experience', `${talent.yearsExperience} years`),
          metaItem('Rating', `${talent.rating.toFixed(1)}★ (${talent.reviewsCount})`),
          metaItem('Projects completed', String(talent.jobsCompleted))
        ])
      ]),
      el('div', { style: 'display:flex;flex-direction:column;gap:8px;min-width:190px' }, [
        el('a', { class: 'btn primary', href: '/signup.html?role=client' }, ['Invite to a brief →']),
        talent.portfolioUrl
          ? el('a', { class: 'btn ghost', href: talent.portfolioUrl, target: '_blank', rel: 'noopener nofollow' }, ['View portfolio ↗'])
          : null,
        el('p', { style: 'margin:4px 0 0;font-size:11.5px;color:var(--muted-dim);line-height:1.5', text: 'Create a client account to send an invitation with your brief attached.' })
      ])
    ]));

    const columns = el('div', { class: 'two-col' });

    columns.append(el('section', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'About' })]),
      el('p', { style: 'margin:0 0 18px;font-size:13.5px;line-height:1.75;color:#cfd1c9;white-space:pre-wrap', text: talent.bio }),
      el('div', { class: 'card-head', style: 'margin-top:8px' }, [el('h3', { text: 'Skills' })]),
      el('div', { class: 'chip-set' }, talent.skills.map((skill) => el('span', { class: 'tag lime', text: skill })))
    ]));

    const reviewPanel = el('aside', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: `Reviews (${reviews.length})` })])
    ]);
    if (!reviews.length) {
      reviewPanel.append(el('div', { class: 'empty', text: 'No reviews yet. Reviews unlock after a paid milestone.' }));
    }
    for (const review of reviews) {
      reviewPanel.append(el('div', { class: 'review-card', style: 'margin-bottom:9px' }, [
        el('div', { class: 'stars', text: '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating) }),
        el('p', { style: 'margin:8px 0;font-size:13px;line-height:1.65;color:#cfd1c9', text: review.comment || 'No comment left.' }),
        el('p', {
          style: 'margin:0;font:9.5px var(--mono);letter-spacing:.9px;text-transform:uppercase;color:var(--muted-dim)',
          text: `${review.reviewer_name} · ${review.project_name} · ${formatDate(review.created_at)}`
        })
      ]));
    }
    columns.append(reviewPanel);
    host.append(columns);
  } catch (error) {
    host.innerHTML = `<div class="empty"><strong>Profile unavailable</strong>${esc(error.message)}</div>`;
  }
}

function metaItem(label, value) {
  return el('div', {}, [el('small', { text: label }), el('strong', { text: value })]);
}
