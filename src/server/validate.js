'use strict';

/** Thrown for any expected client-side failure; carries an HTTP status. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, message, details);
const unauthorized = (message = 'Please sign in to continue.') => new HttpError(401, message);
const forbidden = (message = 'You do not have access to this resource.') => new HttpError(403, message);
const notFound = (message = 'Not found.') => new HttpError(404, message);
const conflict = (message) => new HttpError(409, message);
const tooMany = (message = 'Too many attempts. Please wait and try again.') => new HttpError(429, message);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Declarative body validation. Returns a cleaned object or throws HttpError(400)
 * with per-field messages.
 *
 * Rule shape: { type, required, min, max, values, default, trim }
 */
function validate(body, rules) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Expected a JSON object body.');
  }
  const out = {};
  const errors = {};

  for (const [field, rule] of Object.entries(rules)) {
    const present = Object.prototype.hasOwnProperty.call(body, field) && body[field] !== null && body[field] !== '';
    if (!present) {
      if (rule.required) errors[field] = `${label(field)} is required.`;
      else if ('default' in rule) out[field] = rule.default;
      continue;
    }

    const raw = body[field];
    switch (rule.type) {
      case 'string':
      case 'email':
      case 'url':
      case 'enum': {
        let value = typeof raw === 'string' ? raw : String(raw);
        if (rule.trim !== false) value = value.trim();
        if (rule.min && value.length < rule.min) { errors[field] = `${label(field)} must be at least ${rule.min} characters.`; break; }
        if (rule.max && value.length > rule.max) { errors[field] = `${label(field)} must be ${rule.max} characters or fewer.`; break; }
        if (rule.type === 'email' && !EMAIL.test(value)) { errors[field] = 'Enter a valid email address.'; break; }
        if (rule.type === 'url' && value && !/^https?:\/\/\S+$/i.test(value)) { errors[field] = `${label(field)} must start with http:// or https://.`; break; }
        if (rule.type === 'enum' && !rule.values.includes(value)) { errors[field] = `${label(field)} must be one of: ${rule.values.join(', ')}.`; break; }
        out[field] = value;
        break;
      }
      case 'int':
      case 'number': {
        const value = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
        if (!Number.isFinite(value)) { errors[field] = `${label(field)} must be a number.`; break; }
        if (rule.type === 'int' && !Number.isInteger(value)) { errors[field] = `${label(field)} must be a whole number.`; break; }
        if (rule.min !== undefined && value < rule.min) { errors[field] = `${label(field)} must be at least ${rule.min}.`; break; }
        if (rule.max !== undefined && value > rule.max) { errors[field] = `${label(field)} must be at most ${rule.max}.`; break; }
        out[field] = value;
        break;
      }
      case 'boolean': {
        out[field] = raw === true || raw === 'true' || raw === 1 || raw === '1';
        break;
      }
      case 'stringArray': {
        const list = Array.isArray(raw) ? raw : String(raw).split(',');
        const cleaned = list.map((item) => String(item).trim()).filter(Boolean).slice(0, rule.max || 25);
        if (rule.min && cleaned.length < rule.min) { errors[field] = `Select at least ${rule.min}.`; break; }
        out[field] = cleaned;
        break;
      }
      default:
        out[field] = raw;
    }
  }

  if (Object.keys(errors).length) throw badRequest('Please correct the highlighted fields.', errors);
  return out;
}

function label(field) {
  const words = field.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Escapes text for safe interpolation into HTML. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  HttpError, validate, escapeHtml,
  badRequest, unauthorized, forbidden, notFound, conflict, tooMany
};
