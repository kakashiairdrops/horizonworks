// Shared talent-search UI used by the public directory and the in-app directory.

import { api, qs } from './api.js';
import { $, el, esc, initials, AVAILABILITY_LABEL } from './ui.js';

const SORTS = [
  ['relevance', 'Most relevant'],
  ['rating', 'Highest rated'],
  ['rate_low', 'Lowest rate'],
  ['rate_high', 'Highest rate'],
  ['experience', 'Most experienced'],
  ['newest', 'Recently updated']
];

export function personCard(person, { actions = [] } = {}) {
  return el('article', { class: 'person' }, [
    el('div', { class: 'head' }, [
      el('div', { class: 'avatar lg', style: `--hue:${person.avatarHue}`, text: initials(person.name) }),
      el('div', { class: 'grow' }, [
        el('h3', {}, [person.name, person.verified ? el('span', { class: 'tag ok', style: 'margin-left:7px', text: 'Verified' }) : null]),
        el('p', { class: 'role', text: person.headline }),
        el('p', { class: 'role', style: 'margin-top:3px', text: `${person.location} · ${person.yearsExperience} yrs · ${person.rating.toFixed(1)}★ (${person.reviewsCount})` })
      ])
    ]),
    el('p', { class: 'bio', text: person.bio.slice(0, 165) + (person.bio.length > 165 ? '…' : '') }),
    el('div', { class: 'meta' }, [
      el('span', { class: 'tag ok', text: AVAILABILITY_LABEL[person.availability] }),
      el('span', { class: 'tag', text: `${person.payoutAsset} · ${person.payoutNetwork}` }),
      ...person.skills.slice(0, 4).map((skill) => el('span', { class: 'tag', text: skill }))
    ]),
    el('div', { class: 'foot' }, [
      el('div', { class: 'rate' }, [
        el('small', { text: 'Starting from' }),
        el('strong', { text: `$${person.rateMin}` }),
        el('span', { style: 'color:var(--muted-dim);font-size:12px', text: ' /hr' })
      ]),
      el('div', { style: 'display:flex;gap:7px' }, [
        ...actions,
        el('a', { class: 'btn sm ghost', href: `/talent-profile.html?id=${encodeURIComponent(person.id)}` }, ['View profile →'])
      ])
    ])
  ]);
}

/**
 * Renders the filter bar + results grid into `host`.
 * @param {object} options.initial seeds the filter state (e.g. from the URL)
 * @param {function} options.cardActions optional per-person extra buttons
 */
export async function mountTalentSearch(host, { initial = {}, cardActions } = {}) {
  const skills = (await api.get('/api/skills')).skills;
  const state = {
    q: initial.q || '',
    availability: initial.availability || '',
    asset: initial.asset || '',
    max_rate: initial.max_rate || '',
    min_rating: initial.min_rating || '',
    verified: initial.verified || false,
    sort: initial.sort || 'relevance',
    page: 1,
    skill: new Set(initial.skill || [])
  };

  const assets = [...new Set(skills.length ? ['USDC', 'USDT', 'ETH', 'SOL', 'Fiat'] : [])];

  const bar = el('form', { class: 'filter-bar', onsubmit: (event) => { event.preventDefault(); state.page = 1; refresh(); } }, [
    el('label', { class: 'field' }, [
      el('span', { text: 'Search' }),
      el('input', { name: 'q', value: state.q, placeholder: 'Name, headline, or location', oninput: debounce((event) => { state.q = event.target.value; state.page = 1; refresh(); }, 280) })
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Availability' }),
      select('availability', [['', 'Any time'], ...Object.entries(AVAILABILITY_LABEL)], state.availability, (value) => { state.availability = value; state.page = 1; refresh(); })
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Payout asset' }),
      select('asset', [['', 'Any asset'], ...assets.map((asset) => [asset, asset])], state.asset, (value) => { state.asset = value; state.page = 1; refresh(); })
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Max hourly' }),
      select('max_rate', [['', 'Any rate'], ['60', 'Up to $60'], ['85', 'Up to $85'], ['110', 'Up to $110'], ['160', 'Up to $160']], state.max_rate, (value) => { state.max_rate = value; state.page = 1; refresh(); })
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: 'Sort by' }),
      select('sort', SORTS, state.sort, (value) => { state.sort = value; state.page = 1; refresh(); })
    ]),
    el('button', { class: 'btn sm ghost', type: 'button', onclick: reset }, ['Reset'])
  ]);

  const chipHost = el('div', { class: 'filter-skills' });
  for (const skill of skills) {
    chipHost.append(el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(state.skill.has(skill.name)),
      onclick: (event) => {
        if (state.skill.has(skill.name)) state.skill.delete(skill.name);
        else state.skill.add(skill.name);
        event.currentTarget.setAttribute('aria-pressed', String(state.skill.has(skill.name)));
        state.page = 1;
        refresh();
      }
    }, [skill.name]));
  }

  const meta = el('div', { class: 'result-meta' });
  const grid = el('div', { class: 'talent-grid' });
  const pager = el('div', { class: 'pager' });

  host.innerHTML = '';
  host.append(bar, chipHost, meta, grid, pager);

  function reset() {
    Object.assign(state, { q: '', availability: '', asset: '', max_rate: '', min_rating: '', verified: false, sort: 'relevance', page: 1 });
    state.skill.clear();
    bar.reset();
    bar.elements.q.value = '';
    [...chipHost.children].forEach((chip) => chip.setAttribute('aria-pressed', 'false'));
    refresh();
  }

  async function refresh() {
    grid.innerHTML = '<div class="skeleton" style="min-height:230px"></div><div class="skeleton" style="min-height:230px"></div><div class="skeleton" style="min-height:230px"></div>';
    pager.innerHTML = '';
    try {
      const data = await api.get(`/api/talent${qs({
        q: state.q, availability: state.availability, asset: state.asset,
        max_rate: state.max_rate, min_rating: state.min_rating, verified: state.verified,
        sort: state.sort, page: state.page, limit: 9, skill: [...state.skill]
      })}`);

      meta.innerHTML = '';
      meta.append(
        el('span', { text: `${data.total} specialist${data.total === 1 ? '' : 's'} match${data.total === 1 ? 'es' : ''} your filters` }),
        el('span', { text: `Page ${data.page} of ${data.pages}` })
      );

      grid.innerHTML = '';
      if (!data.talent.length) {
        grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><strong>No one matches those filters</strong>Try widening the rate ceiling or clearing a few skills.</div>';
        return;
      }
      for (const person of data.talent) {
        grid.append(personCard(person, { actions: cardActions ? cardActions(person) : [] }));
      }

      if (data.pages > 1) {
        pager.append(
          el('button', { class: 'btn sm ghost', type: 'button', disabled: data.page <= 1, onclick: () => { state.page -= 1; refresh(); } }, ['← Previous']),
          el('span', { text: `${data.page} / ${data.pages}` }),
          el('button', { class: 'btn sm ghost', type: 'button', disabled: data.page >= data.pages, onclick: () => { state.page += 1; refresh(); } }, ['Next →'])
        );
      }
    } catch (error) {
      grid.innerHTML = `<div class="alert error" style="grid-column:1/-1">${esc(error.message)}</div>`;
    }
  }

  refresh();
  return { refresh, state };
}

function select(name, options, value, onChange) {
  const node = el('select', { name, onchange: (event) => onChange(event.target.value) });
  for (const [optionValue, label] of options) {
    node.append(el('option', { value: optionValue, selected: optionValue === value }, [label]));
  }
  return node;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
