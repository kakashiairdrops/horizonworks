import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import {
  $, $$, el, esc, money, formatDate, statusTag, toast, formValues,
  applyFieldErrors, clearFieldErrors, withBusy, confirmDialog, param, START_LABEL
} from '../ui.js';

const ASSETS = ['USDC', 'USDT', 'ETH', 'SOL', 'BTC', 'Fiat'];
const NETWORKS = ['Base', 'Solana', 'Ethereum', 'Arbitrum', 'Polygon', 'Bank'];
const CATEGORIES = ['Web development', 'App development', 'AI automation', 'Creative production', 'Web3'];

const session = await requireSession(['client', 'admin']);
let allSkills = [];

if (session) {
  await mountShell({
    title: 'Briefs & matches',
    crumb: `Horizon / ${session.user.company || session.user.name} / Briefs`,
    actions: [el('button', { class: 'btn primary sm', type: 'button', onclick: openBriefForm }, ['+ New brief'])]
  });
  $('#page').before(el('p', { class: 'subtitle', text: 'A brief is the signal we match against. Post one, then review a ranked shortlist you can interrogate.' }));
  allSkills = (await api.get('/api/skills')).skills;
  await loadBriefs();
  if (param('new') || param('welcome')) openBriefForm();
}

async function loadBriefs() {
  const host = $('#page');
  host.innerHTML = '<div class="skeleton"></div>';
  try {
    const { briefs } = await api.get('/api/briefs');
    host.innerHTML = '';
    if (!briefs.length) {
      host.append(el('div', { class: 'empty' }, [
        el('strong', { text: 'No briefs yet' }),
        'Describe the work once and we will rank the specialists who fit it. ',
        el('div', { style: 'margin-top:14px' }, [
          el('button', { class: 'btn primary', type: 'button', onclick: openBriefForm }, ['Write your first brief'])
        ])
      ]));
      return;
    }
    const grid = el('div', { class: 'grid-2' });
    for (const brief of briefs) grid.append(briefCard(brief));
    host.append(grid);
  } catch (error) {
    host.innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}

function briefCard(brief) {
  return el('article', { class: 'brief-card' }, [
    el('div', { class: 'head' }, [
      el('div', {}, [
        el('h3', { text: brief.title }),
        el('p', {
          class: 'meta',
          text: `${brief.category} · ${money(brief.budgetMin)}–${money(brief.budgetMax, brief.asset)} · ${START_LABEL[brief.startWindow]}`
        })
      ]),
      el('span', { html: statusTag(brief.status) })
    ]),
    el('p', { text: brief.description.slice(0, 190) + (brief.description.length > 190 ? '…' : '') }),
    el('div', { class: 'chip-set' }, brief.skills.map((skill) => el('span', { class: 'tag', text: skill }))),
    el('div', { class: 'foot' }, [
      el('span', {
        style: 'font:9.5px var(--mono);color:var(--muted-dim);text-transform:uppercase;letter-spacing:.9px',
        text: `${brief.invitationCount} invitation${brief.invitationCount === 1 ? '' : 's'} · posted ${formatDate(brief.createdAt)}`
      }),
      el('div', { style: 'display:flex;gap:7px' }, [
        el('a', { class: 'btn sm primary', href: `/app/matches.html?brief=${encodeURIComponent(brief.id)}` }, ['View shortlist →']),
        el('button', { class: 'btn sm ghost', type: 'button', onclick: () => openBriefForm(brief) }, ['Edit']),
        el('button', {
          class: 'btn sm danger', type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Delete this brief?',
              body: `"${brief.title}" and its invitations will be removed. Projects already created stay in place.`,
              confirmLabel: 'Delete brief', variant: 'danger'
            });
            if (!ok) return;
            try {
              await api.delete(`/api/briefs/${encodeURIComponent(brief.id)}`);
              toast('Brief deleted.');
              loadBriefs();
            } catch (error) { toast(error.message, { variant: 'error' }); }
          }
        }, ['Delete'])
      ])
    ])
  ]);
}

/** Create/edit dialog. Passing a brief switches it into edit mode. */
function openBriefForm(brief = null) {
  const editing = Boolean(brief?.id);
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="brief-form" novalidate>
      <div class="modal-head">
        <h2>${editing ? 'Edit brief' : 'Write a brief'}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="alert error" id="brief-error" hidden></div>
        <label class="field"><span>Project title</span>
          <input name="title" required minlength="6" maxlength="120" placeholder="Northstar product site">
        </label>
        <label class="field"><span>The brief</span>
          <textarea name="description" required minlength="40" maxlength="4000" rows="5"
            placeholder="What are you making, who is it for, and what would great look like?"></textarea>
          <span class="field-hint">At least 40 characters. The more signal, the better the shortlist.</span>
        </label>
        <div class="grid-2">
          <label class="field"><span>Discipline</span>
            <select name="category">${CATEGORIES.map((value) => `<option>${esc(value)}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Engagement</span>
            <select name="engagement">
              <option value="project">Fixed project</option>
              <option value="retainer">Ongoing retainer</option>
              <option value="hourly">Hourly</option>
            </select>
          </label>
          <label class="field"><span>Budget minimum</span><input name="budget_min" required inputmode="numeric" placeholder="3000"></label>
          <label class="field"><span>Budget maximum</span><input name="budget_max" required inputmode="numeric" placeholder="5000"></label>
          <label class="field"><span>Settle in</span>
            <select name="asset">${ASSETS.map((value) => `<option>${esc(value)}</option>`).join('')}</select>
          </label>
          <label class="field"><span>Network</span>
            <select name="network">${NETWORKS.map((value) => `<option>${esc(value)}</option>`).join('')}</select>
          </label>
          <label class="field span-2"><span>Ideal start</span>
            <select name="start_window">
              <option value="this_week">This week</option>
              <option value="two_weeks">Within two weeks</option>
              <option value="flexible">Flexible</option>
            </select>
          </label>
        </div>
        <div class="field">
          <span class="field-label">Required skills</span>
          <div class="chip-set" id="skill-chips"></div>
          <span class="field-hint">Pick one to ten. Skill overlap is the heaviest component of the match score.</span>
          <span class="field-error" id="skills-error"></span>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">${editing ? 'Save changes' : 'Post brief & see matches'}</button>
      </div>
    </form>`;
  document.body.append(dialog);

  const form = $('#brief-form', dialog);
  const errorBox = $('#brief-error', dialog);
  const chosen = new Set(brief?.skills || []);

  const chipHost = $('#skill-chips', dialog);
  let currentCategory = brief?.category || CATEGORIES[0];

  function renderChips() {
    chipHost.innerHTML = '';
    const relevant = allSkills.filter((skill) => skill.category === currentCategory);
    const others = allSkills.filter((skill) => skill.category !== currentCategory && chosen.has(skill.name));
    for (const skill of [...relevant, ...others]) {
      chipHost.append(el('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(chosen.has(skill.name)),
        onclick: (event) => {
          const button = event.currentTarget;
          if (chosen.has(skill.name)) chosen.delete(skill.name);
          else chosen.add(skill.name);
          button.setAttribute('aria-pressed', String(chosen.has(skill.name)));
        }
      }, [skill.name]));
    }
  }
  renderChips();

  form.elements.category.addEventListener('change', (event) => {
    currentCategory = event.target.value;
    renderChips();
  });

  if (editing) {
    form.elements.title.value = brief.title;
    form.elements.description.value = brief.description;
    form.elements.category.value = brief.category;
    form.elements.engagement.value = brief.engagement;
    form.elements.budget_min.value = brief.budgetMin;
    form.elements.budget_max.value = brief.budgetMax;
    form.elements.asset.value = brief.asset;
    form.elements.network.value = brief.network;
    form.elements.start_window.value = brief.startWindow;
    form.elements.category.disabled = true;
    form.elements.asset.disabled = true;
    form.elements.network.disabled = true;
  }

  const close = () => { dialog.close(); dialog.remove(); };
  $('.close-x', dialog).onclick = close;
  $('[data-act="cancel"]', dialog).onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    clearFieldErrors(form);
    $('#skills-error', dialog).textContent = '';
    if (!chosen.size) {
      $('#skills-error', dialog).textContent = 'Choose at least one required skill.';
      return;
    }
    const values = { ...formValues(form), skills: [...chosen] };
    if (editing) { delete values.category; delete values.asset; delete values.network; }
    const submit = form.querySelector('button[type="submit"]');
    try {
      const result = await withBusy(submit, () => (editing
        ? api.patch(`/api/briefs/${encodeURIComponent(brief.id)}`, values)
        : api.post('/api/briefs', values)));
      close();
      if (editing) {
        toast('Brief updated.');
        loadBriefs();
      } else {
        location.href = `/app/matches.html?brief=${encodeURIComponent(result.brief.id)}`;
      }
    } catch (error) {
      applyFieldErrors(form, error.details);
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    }
  });
}
