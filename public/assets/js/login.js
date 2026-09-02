import { api, clearMeCache, setCsrfToken } from './api.js';
import { $, $$, formValues, applyFieldErrors, clearFieldErrors, withBusy, param } from './ui.js';

const form = $('#form');
const errorBox = $('#form-error');
const infoBox = $('#form-info');

if (param('next')) {
  infoBox.textContent = 'Sign in to continue to the page you requested.';
  infoBox.hidden = false;
}

$$('[data-fill]').forEach((button) => {
  button.addEventListener('click', () => {
    form.elements.email.value = button.dataset.fill;
    form.elements.password.value = 'horizon-demo-2025';
    form.elements.password.focus();
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  clearFieldErrors(form);
  const submit = form.querySelector('button[type="submit"]');
  try {
    const result = await withBusy(submit, () => api.post('/api/auth/login', formValues(form)));
    setCsrfToken(result.csrfToken);
    clearMeCache();
    const next = param('next');
    // Only allow same-origin relative redirects.
    location.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/app/dashboard.html');
  } catch (error) {
    applyFieldErrors(form, error.details);
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
});
