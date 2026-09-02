// Landing page: live network stats, category counts, featured talent, and lead capture.

import { api, me } from './api.js';
import { $, $$, el, esc, compactMoney, initials, AVAILABILITY_LABEL, toast, formValues, applyFieldErrors, withBusy } from './ui.js';

const CATEGORY_COPY = {
  'Web development': 'Sites, stores, and product platforms',
  'App development': 'iOS, Android, and cross-platform',
  'AI automation': 'LLM pipelines and internal tooling',
  'Creative production': 'Video, thumbnails, scripts, and brand',
  Web3: 'Contracts, protocols, and on-chain payments'
};

function stickyNav() {
  const nav = $('#site-nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 12);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

async function reflectSession() {
  try {
    const session = await me();
    if (!session.user) return;
    const cta = $('#nav-cta');
    cta.textContent = 'Open workspace ↗';
    cta.href = '/app/dashboard.html';
  } catch { /* the landing page works fine without a session */ }
}

async function loadStats() {
  try {
    const stats = await api.get('/api/stats');
    $('#stat-talent').textContent = stats.talent;
    $('#stat-available').textContent = stats.availableNow;
    $('#stat-settled').textContent = compactMoney(stats.settled);
    $('#stat-projects').textContent = String(stats.activeProjects).padStart(2, '0');
    $('#stat-countries').textContent = stats.countries || '—';

    const grid = $('#category-grid');
    const counts = new Map(stats.skillMix.map((row) => [row.category, row.n]));
    grid.innerHTML = '';
    Object.entries(CATEGORY_COPY).forEach(([category, blurb], index) => {
      grid.append(el('a', {
        class: 'service-card',
        href: `/talent-directory.html?category=${encodeURIComponent(category)}`
      }, [
        el('span', { class: 'no', text: String(index + 1).padStart(2, '0') }),
        el('span', { class: 'arrow', 'aria-hidden': 'true', text: '↗' }),
        el('div', {}, [
          el('h3', { text: category }),
          el('p', { text: blurb }),
          el('p', { class: 'count', text: `${counts.get(category) || 0} listed skills in the network` })
        ])
      ]));
    });
  } catch (error) {
    $('#category-grid').innerHTML = `<div class="empty"><strong>Network stats unavailable</strong>${esc(error.message)}</div>`;
  }
}

async function loadFeaturedTalent() {
  const host = $('#featured-talent');
  try {
    const data = await api.get('/api/talent?availability=available_now&sort=rating&limit=3');
    if (!data.talent.length) {
      host.innerHTML = '<div class="empty"><strong>No one is free right now</strong>Check the directory for specialists starting later.</div>';
      return;
    }
    host.innerHTML = '';
    for (const person of data.talent) {
      host.append(el('a', { class: 'talent-card', href: `/talent-profile.html?id=${encodeURIComponent(person.id)}` }, [
        el('div', { class: 'head' }, [
          el('div', { class: 'avatar', style: `--hue:${person.avatarHue}`, text: initials(person.name) }),
          el('div', {}, [
            el('h3', { text: person.name }),
            el('p', { class: 'role', text: `${person.headline} · ${person.location}` })
          ])
        ]),
        el('p', { class: 'bio', text: person.bio.slice(0, 132) + (person.bio.length > 132 ? '…' : '') }),
        el('div', { class: 'chip-set' }, person.skills.slice(0, 3).map((skill) => el('span', { class: 'tag', text: skill }))),
        el('div', { class: 'foot' }, [
          el('span', { html: `<strong>$${person.rateMin}</strong><span style="color:var(--muted-dim)">/hr</span>` }),
          el('span', { class: 'tag ok', text: AVAILABILITY_LABEL[person.availability] })
        ])
      ]));
    }
  } catch (error) {
    host.innerHTML = `<div class="empty"><strong>Directory unavailable</strong>${esc(error.message)}</div>`;
  }
}

function inquiryForm() {
  const form = $('#inquiry-form');
  const errorBox = $('#inquiry-error');

  $$('.role-toggle button').forEach((button) => {
    button.addEventListener('click', () => {
      $$('.role-toggle button').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
      form.elements.role.value = button.dataset.role;
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const submit = form.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post('/api/inquiries', formValues(form)));
      form.reset();
      form.elements.role.value = 'client';
      toast('An operator will be in touch within one working day.', { title: 'Thanks — message received', variant: 'ok' });
      submit.textContent = 'Sent ✓';
      setTimeout(() => { submit.textContent = 'Start the conversation ↗'; }, 4000);
    } catch (error) {
      applyFieldErrors(form, error.details);
      if (!error.details) { errorBox.textContent = error.message; errorBox.hidden = false; }
    }
  });
}

stickyNav();
inquiryForm();
reflectSession();
loadStats();
loadFeaturedTalent();
