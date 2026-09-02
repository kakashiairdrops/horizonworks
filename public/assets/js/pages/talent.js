import { api, requireSession } from '../api.js';
import { mountShell } from '../shell.js';
import { mountTalentSearch } from '../talent-search.js';
import { $, el, toast, withBusy } from '../ui.js';

const session = await requireSession();

if (session) {
  await mountShell({
    title: 'Talent directory',
    crumb: `Horizon / ${session.user.company || session.user.name} / Directory`
  });
  $('#page').before(el('p', {
    class: 'subtitle',
    text: session.user.role === 'client'
      ? 'Browse the whole approved network. To invite someone, attach them to one of your briefs.'
      : 'Every approved specialist in the network, with the same filters clients use.'
  }));

  const briefs = session.user.role === 'client' ? (await api.get('/api/briefs')).briefs.filter((brief) => brief.status === 'open') : [];

  mountTalentSearch($('#page'), {
    cardActions: (person) => (session.user.role === 'client' && briefs.length
      ? [el('button', { class: 'btn sm primary', type: 'button', onclick: (event) => inviteFlow(event.currentTarget, person, briefs) }, ['Invite →'])]
      : [])
  });
}

/** Lets a client pick which open brief to attach the invitation to. */
function inviteFlow(button, person, briefs) {
  const dialog = el('dialog', { class: 'modal' });
  dialog.innerHTML = `
    <form id="pick-form">
      <div class="modal-head"><h2>Invite ${person.name}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body">
        <div class="alert error" id="pick-error" hidden></div>
        <label class="field"><span>Attach to brief</span>
          <select name="brief_id" required>
            ${briefs.map((brief) => `<option value="${brief.id}">${brief.title} · ${brief.category}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>Note (optional)</span>
          <textarea name="message" rows="3" maxlength="600" placeholder="Why they're a fit for this brief."></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn primary" type="submit">Send invitation</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('.close-x').onclick = close;
  dialog.querySelector('[data-act="cancel"]').onclick = close;
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.showModal();

  dialog.querySelector('#pick-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post(`/api/briefs/${encodeURIComponent(form.elements.brief_id.value)}/invitations`, {
        talent_id: person.id,
        message: form.elements.message.value
      }));
      close();
      button.disabled = true;
      button.textContent = 'Invited ✓';
      toast(`${person.name} has been invited.`, { title: 'Invitation sent' });
    } catch (error) {
      const box = dialog.querySelector('#pick-error');
      box.textContent = error.message;
      box.hidden = false;
    }
  });
}
