import { api, clearMeCache, setCsrfToken } from './api.js';
import { $, $$, formValues, applyFieldErrors, clearFieldErrors, withBusy, param } from './ui.js';

const form = $('#form');
const errorBox = $('#form-error');
const companyField = $('#company-field');

function setRole(role) {
  form.elements.role.value = role;
  $$('.role-card').forEach((card) => card.setAttribute('aria-pressed', String(card.dataset.role === role)));
  companyField.hidden = role !== 'client';
}

$$('.role-card').forEach((card) => card.addEventListener('click', () => setRole(card.dataset.role)));
setRole(param('role') === 'talent' ? 'talent' : 'client');

/** Rough strength signal: length plus character-class variety. */
function scorePassword(value) {
  let score = 0;
  if (value.length >= 10) score += 1;
  if (value.length >= 14) score += 1;
  if (/[a-z]/.test(value) && /[A-Z0-9]/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value) || value.length >= 20) score += 1;
  return score;
}

const LABELS = ['Too short', 'Weak — add length', 'Reasonable', 'Strong', 'Very strong'];

form.elements.password.addEventListener('input', (event) => {
  const score = scorePassword(event.target.value);
  $$('#strength i').forEach((bar, index) => bar.classList.toggle('on', index < score));
  $('#strength-label').textContent = event.target.value ? LABELS[score] : 'Use at least 10 characters. A passphrase works well.';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  clearFieldErrors(form);
  const submit = form.querySelector('button[type="submit"]');
  try {
    const values = formValues(form);
    if (values.role !== 'client') delete values.company;
    const result = await withBusy(submit, () => api.post('/api/auth/signup', values));
    setCsrfToken(result.csrfToken);
    clearMeCache();
    location.replace(result.user.role === 'talent' ? '/app/profile.html?welcome=1' : '/app/briefs.html?welcome=1');
  } catch (error) {
    applyFieldErrors(form, error.details);
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
});
