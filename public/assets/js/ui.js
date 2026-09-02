// Small DOM/format helpers shared by every page. No framework, no build step.

/** Escapes text for safe insertion into an HTML string. */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const MONEY_2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (amount, asset = '') =>
  `${MONEY.format(Number(amount) || 0)}${asset ? ` ${asset}` : ''}`;
export const money2 = (amount, asset = '') =>
  `${MONEY_2.format(Number(amount) || 0)}${asset ? ` ${asset}` : ''}`;

export function compactMoney(amount) {
  const value = Number(amount) || 0;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${MONEY.format(value)}`;
}

/** SQLite stores UTC without a zone marker; normalise before parsing. */
function toDate(value) {
  if (!value) return null;
  const text = String(value);
  const iso = /Z|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function timeAgo(value) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units = [['minute', 60], ['hour', 60], ['day', 24], ['week', 7], ['month', 4.35], ['year', 12]];
  let amount = seconds / 60;
  let label = 'minute';
  for (let index = 0; index < units.length - 1; index += 1) {
    if (Math.abs(amount) < units[index + 1][1]) { label = units[index][0]; break; }
    amount /= units[index + 1][1];
    label = units[index + 1][0];
  }
  const rounded = Math.round(amount);
  return `${rounded} ${label}${rounded === 1 ? '' : 's'} ago`;
}

export function formatDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  const date = toDate(value);
  return date ? date.toLocaleDateString('en-US', options) : '';
}

export function formatTime(value) {
  const date = toDate(value);
  return date ? date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}

export const initials = (name) =>
  String(name || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('');

export const AVAILABILITY_LABEL = {
  available_now: 'Available now',
  two_weeks: 'Within 2 weeks',
  next_month: 'Next month',
  unavailable: 'Not taking work'
};

export const START_LABEL = { this_week: 'This week', two_weeks: 'Within two weeks', flexible: 'Flexible' };

export const STATUS_TAG = {
  planned: ['Planned', ''],
  funded: ['In escrow', 'info'],
  submitted: ['Ready for review', 'warn'],
  approved: ['Approved', 'ok'],
  paid: ['Paid', 'ok'],
  active: ['Active', 'lime'],
  in_review: ['In review', 'warn'],
  completed: ['Completed', 'ok'],
  cancelled: ['Cancelled', 'danger'],
  open: ['Open', 'lime'],
  draft: ['Draft', ''],
  matched: ['Matched', 'ok'],
  closed: ['Closed', ''],
  sent: ['Awaiting reply', 'warn'],
  accepted: ['Accepted', 'ok'],
  declined: ['Declined', 'danger'],
  withdrawn: ['Withdrawn', ''],
  escrow_funded: ['In escrow', 'info'],
  released: ['Released', 'ok'],
  refunded: ['Refunded', 'danger'],
  split: ['Split', 'warn'],
  disputed: ['Disputed', 'danger'],
  resolved: ['Resolved', 'ok'],
  answered: ['Awaiting review', 'warn'],
  pending: ['Pending review', 'warn'],
  rejected: ['Needs changes', 'danger'],
  new: ['New', 'lime'],
  contacted: ['Contacted', 'info'],
  verified: ['Verified', 'ok']
};

export function statusTag(status) {
  const [label, variant] = STATUS_TAG[status] || [String(status || '').replace(/_/g, ' '), ''];
  return `<span class="tag ${variant}">${esc(label)}</span>`;
}

/** Toast notifications; auto-dismiss unless the message is an error. */
export function toast(message, { title = '', variant = 'ok', timeout } = {}) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const node = el('div', { class: `toast ${variant}` }, [
    title ? el('strong', { text: title }) : null,
    el('span', { text: message })
  ]);
  host.append(node);
  const life = timeout ?? (variant === 'error' ? 6500 : 3800);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 250); }, life);
}

/** Reads a form into a plain object, coercing multi-selects into arrays. */
export function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (key in values) values[key] = [].concat(values[key], value);
    else values[key] = value;
  }
  return values;
}

/** Clears then applies server-side field errors returned as { field: message }. */
export function applyFieldErrors(form, details) {
  clearFieldErrors(form);
  if (!details) return;
  for (const [field, message] of Object.entries(details)) {
    const input = form.elements[field];
    const wrapper = input?.closest('.field');
    if (!wrapper) continue;
    wrapper.classList.add('invalid');
    let error = wrapper.querySelector('.field-error');
    if (!error) {
      error = el('span', { class: 'field-error' });
      wrapper.append(error);
    }
    error.textContent = message;
  }
  const first = form.querySelector('.field.invalid input, .field.invalid select, .field.invalid textarea');
  first?.focus();
}

export function clearFieldErrors(form) {
  $$('.field.invalid', form).forEach((node) => node.classList.remove('invalid'));
  $$('.field-error', form).forEach((node) => { node.textContent = ''; });
}

/** Disables a button and shows a spinner while `task` runs. */
export async function withBusy(button, task) {
  if (!button) return task();
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    return await task();
  } finally {
    button.classList.remove('is-loading');
    button.disabled = wasDisabled;
  }
}

export function param(name, fallback = '') {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}

/** Minimal dialog helper: returns a promise resolving to true on confirm. */
export function confirmDialog({ title = 'Are you sure?', body = '', confirmLabel = 'Confirm', variant = 'primary' } = {}) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'modal' });
    dialog.innerHTML = `
      <div class="modal-head"><h2>${esc(title)}</h2>
        <button class="close-x" type="button" aria-label="Close">×</button></div>
      <div class="modal-body"><p style="margin:0;color:var(--muted);font-size:13.5px">${esc(body)}</p></div>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-act="cancel">Cancel</button>
        <button class="btn ${variant}" type="button" data-act="ok">${esc(confirmLabel)}</button>
      </div>`;
    document.body.append(dialog);
    const finish = (value) => { dialog.close(); dialog.remove(); resolve(value); };
    dialog.querySelector('[data-act="ok"]').onclick = () => finish(true);
    dialog.querySelector('[data-act="cancel"]').onclick = () => finish(false);
    dialog.querySelector('.close-x').onclick = () => finish(false);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    dialog.showModal();
  });
}
