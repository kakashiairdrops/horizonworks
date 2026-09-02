'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, sortable, collision-resistant id with a readable prefix. */
function id(prefix) {
  const time = Date.now().toString(36).padStart(9, '0');
  const bytes = crypto.randomBytes(8);
  let random = '';
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${random}`;
}

const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/** Hashes a password with scrypt; the salt and parameters travel with the hash. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Constant-time password verification against a stored hash. */
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const derived = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p)
    });
    return crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

/** Timing-safe comparison for opaque tokens of arbitrary length. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

module.exports = { id, token, hashPassword, verifyPassword, safeEqual };
