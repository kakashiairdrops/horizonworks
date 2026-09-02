import { api, requireSession, clearMeCache } from '../api.js';
import { mountShell } from '../shell.js';
import { $, el, esc, formatTime, toast, formValues, applyFieldErrors, clearFieldErrors, withBusy } from '../ui.js';

const session = await requireSession();

if (session) {
  await mountShell({
    title: 'Settings',
    crumb: `Horizon / ${session.user.company || session.user.name} / Settings`
  });
  render();
}

async function render() {
  const host = $('#page');
  const user = session.user;
  host.innerHTML = '';

  const grid = el('div', { class: 'two-col' });

  // Account details --------------------------------------------------------
  const accountForm = el('form', { class: 'card', id: 'account-form', novalidate: true });
  accountForm.innerHTML = `
    <div class="card-head"><h2>Account details</h2><span class="tag">${esc(user.role)}</span></div>
    <div class="alert ok" id="account-ok" hidden>Saved.</div>
    <div class="alert error" id="account-error" hidden></div>
    <label class="field"><span>Name</span><input name="name" required minlength="2" maxlength="80"></label>
    ${user.role === 'client' ? '<label class="field"><span>Company or studio</span><input name="company" maxlength="120"></label>' : ''}
    <label class="field"><span>Email address</span><input value="${esc(user.email)}" disabled></label>
    <span class="field-hint" style="margin:-8px 0 14px">Email changes are not supported in this build.</span>
    <button class="btn primary" type="submit">Save details</button>`;
  accountForm.elements.name.value = user.name;
  if (accountForm.elements.company) accountForm.elements.company.value = user.company || '';

  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(accountForm);
    $('#account-ok', accountForm).hidden = true;
    $('#account-error', accountForm).hidden = true;
    const submit = accountForm.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.patch('/api/account', formValues(accountForm)));
      clearMeCache();
      $('#account-ok', accountForm).hidden = false;
      toast('Account details saved.');
    } catch (error) {
      applyFieldErrors(accountForm, error.details);
      const box = $('#account-error', accountForm);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
  grid.append(accountForm);

  const side = el('div', {});

  // Password --------------------------------------------------------------
  const passwordForm = el('form', { class: 'card', id: 'password-form', novalidate: true });
  passwordForm.innerHTML = `
    <div class="card-head"><h2>Password</h2></div>
    <div class="alert error" id="password-error" hidden></div>
    <label class="field"><span>Current password</span><input name="current_password" type="password" required autocomplete="current-password"></label>
    <label class="field"><span>New password</span>
      <input name="new_password" type="password" required minlength="10" autocomplete="new-password">
      <span class="field-hint">At least 10 characters. Changing it signs out every session, including this one.</span>
    </label>
    <button class="btn primary" type="submit">Change password</button>`;

  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFieldErrors(passwordForm);
    $('#password-error', passwordForm).hidden = true;
    const submit = passwordForm.querySelector('button[type="submit"]');
    try {
      await withBusy(submit, () => api.post('/api/auth/password', formValues(passwordForm)));
      clearMeCache();
      toast('Password changed. Signing you back in…', { title: 'Updated' });
      setTimeout(() => location.replace('/login.html'), 1400);
    } catch (error) {
      applyFieldErrors(passwordForm, error.details);
      const box = $('#password-error', passwordForm);
      box.textContent = error.message;
      box.hidden = false;
    }
  });
  side.append(passwordForm);

  // Sessions -------------------------------------------------------------
  const sessionsCard = el('section', { class: 'card', style: 'margin-top:14px' }, [
    el('div', { class: 'card-head' }, [el('h2', { text: 'Active sessions' })]),
    el('div', { id: 'session-list' }, [el('div', { class: 'skeleton', style: 'min-height:60px' })])
  ]);
  side.append(sessionsCard);
  grid.append(side);
  host.append(grid);

  try {
    const data = await api.get('/api/auth/sessions');
    const list = $('#session-list');
    list.innerHTML = '';
    for (const item of data.sessions) {
      list.append(el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line)' }, [
        el('div', { style: 'display:flex;justify-content:space-between;gap:10px' }, [
          el('strong', { style: 'font-size:12.5px', text: item.id === data.current ? 'This device' : 'Another device' }),
          el('span', { style: 'font:9.5px var(--mono);color:var(--muted-dim)', text: formatTime(item.created_at) })
        ]),
        el('p', {
          style: 'margin:4px 0 0;font-size:11.5px;color:var(--muted);word-break:break-word',
          text: item.user_agent || 'Unknown client'
        })
      ]));
    }
    list.append(el('p', {
      style: 'margin:12px 0 0;font-size:11.5px;color:var(--muted-dim)',
      text: 'Changing your password ends every session listed here.'
    }));
  } catch (error) {
    $('#session-list').innerHTML = `<div class="alert error">${esc(error.message)}</div>`;
  }
}
