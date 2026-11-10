import crypto from 'node:crypto';

const COOKIE = 'tux_admin';
const SESSION_TTL_SECONDS = 30 * 60;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [, saltText, hashText] = encoded.split('$');
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(hashText, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, { N: 16_384, r: 8, p: 1 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
export const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
/** Accepts either a scrypt hash (preferred) or a plain passphrase kept in a Render env var. */
export function checkPassword(input, { hash, plain } = {}) {
  if (hash) return verifyPassword(input, hash);
  if (plain) return safeEqual(input, plain);
  return false;
}

const sign = (value, secret) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
export function issueSession(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}
export function validSession(cookie, secret) {
  try {
    const [payload, signature] = String(cookie || '').split('.');
    if (!payload || !signature || !safeEqual(signature, sign(payload, secret))) return false;
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Math.floor(Date.now() / 1000);
  } catch { return false; }
}
export function cookieHeader(value, maxAge = SESSION_TTL_SECONDS) {
  return `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
export function clearCookieHeader() { return `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`; }
export function cookieName() { return COOKIE; }
export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key, value]) => key && value));
}
