// Accounts: register, log in, recovery codes, and the signed-in session on this device.
// The password never leaves the device: it is stretched here (PBKDF2-SHA256) and only the
// result is sent. The server keeps an HMAC of that.

import { store, emit, sha256Hex } from './core.js';
import { API_BASE } from './config.js';

const AUTH_KEY = 'ss3.auth';
const KDF_ROUNDS = 200000;
export const MIN_PASSWORD = 8;
const COLORS = ['#38bdf8', '#12a594', '#fbbf24', '#f472b6', '#a78bfa', '#fb923c', '#a3e635', '#2dd4bf'];

/** token, user (from the server), key (this account's local storage id), email. */
export const account = { token: null, user: null, key: null, email: null };

export function loadSession() {
  const d = store.getJSON(AUTH_KEY, null);
  if (d && typeof d.token === 'string' && d.user && d.email) {
    Object.assign(account, { token: d.token, user: d.user, email: d.email, key: localKey(d.email) });
    return true;
  }
  return false;
}
function saveSession(token, user, email) {
  Object.assign(account, { token, user, email, key: localKey(email) });
  store.setJSON(AUTH_KEY, { token, user, email });
}
export function forgetSession() {
  Object.assign(account, { token: null, user: null, key: null, email: null });
  store.remove(AUTH_KEY);
  store.remove(AUTH_KEY + '.last');
}
export const signedIn = () => !!account.token;
/** Keeps the email so "log in again" can prefill it, but drops the token. */
export function expireSession() {
  store.setJSON(AUTH_KEY + '.last', { email: account.email });
  account.token = null;
  const d = store.getJSON(AUTH_KEY, null);
  if (d) { d.token = null; store.setJSON(AUTH_KEY, d); }
}
export function lastEmail() { const d = store.getJSON(AUTH_KEY, null) || store.getJSON(AUTH_KEY + '.last', null); return (d && d.email) || ''; }

export function localKey(email) { return 'u' + sha256Hex('smart-spend|' + String(email).trim().toLowerCase()).slice(0, 20); }
export function userColor(email) { const h = parseInt(sha256Hex(String(email || '')).slice(0, 6), 16); return COLORS[h % COLORS.length]; }

export async function deriveAuthKey(email, password) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ROUNDS,
    salt: new TextEncoder().encode('smart-spend-auth|' + String(email).trim().toLowerCase()) }, k, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- API ---------- */

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, account.token ? { Authorization: 'Bearer ' + account.token } : {}),
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
  } catch (e) {
    const err = new Error('You’re offline, or the server can’t be reached. Your entries are safe on this device.');
    err.code = 'offline'; throw err;
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty or not JSON */ }
  if (!res.ok) {
    const err = new Error(data.message || 'Something went wrong (' + res.status + '). Try again.');
    err.code = data.error || 'http_' + res.status; err.status = res.status;
    if (res.status === 401 && account.token && err.code === 'signed_out') { expireSession(); emit('signed-out'); }
    throw err;
  }
  return data;
}

function checkPassword(pw) {
  if (String(pw || '').length < MIN_PASSWORD) { const e = new Error('Use at least ' + MIN_PASSWORD + ' characters for the password.'); e.code = 'password'; throw e; }
}
const cleanEmail = (e) => String(e || '').trim().toLowerCase();

export async function register(f) {
  checkPassword(f.password);
  const email = cleanEmail(f.email);
  const authKey = await deriveAuthKey(email, f.password);
  const r = await api('POST', '/api/register', { name: f.name, email, authKey, currency: f.currency, altCurrency: f.altCurrency || null, rate: f.rate || null });
  saveSession(r.token, r.user, email);
  return r.recoveryCode;
}

export async function login(email, password) {
  email = cleanEmail(email);
  if (!password) { const e = new Error('Enter your password.'); e.code = 'password'; throw e; }
  const r = await api('POST', '/api/login', { email, authKey: await deriveAuthKey(email, password) });
  saveSession(r.token, r.user, email);
  return r.user;
}

/** Resets the password with the recovery code. Returns the new recovery code. */
export async function recover(email, code, password) {
  checkPassword(password);
  email = cleanEmail(email);
  const r = await api('POST', '/api/recover', { email, recoveryCode: code, newAuthKey: await deriveAuthKey(email, password) });
  saveSession(r.token, r.user, email);
  return r.recoveryCode;
}

export async function logout() {
  try { await api('POST', '/api/logout', {}); } catch (e) { /* offline: the session still ends here */ }
  forgetSession();
}

export async function refreshUser() {
  const r = await api('GET', '/api/me');
  account.user = r.user;
  store.setJSON(AUTH_KEY, { token: account.token, user: r.user, email: account.email });
  return r.user;
}

export async function updateAccount(patch) {
  const r = await api('PATCH', '/api/me', patch);
  account.user = r.user;
  store.setJSON(AUTH_KEY, { token: account.token, user: r.user, email: account.email });
  emit('account');
  return r.user;
}

export async function changePassword(current, next) {
  checkPassword(next);
  await api('POST', '/api/password', { authKey: await deriveAuthKey(account.email, current), newAuthKey: await deriveAuthKey(account.email, next) });
}

export async function newRecoveryCode(password) {
  return (await api('POST', '/api/recovery-code', { authKey: await deriveAuthKey(account.email, password) })).recoveryCode;
}

export async function deleteAccount(password) {
  await api('DELETE', '/api/me', { authKey: await deriveAuthKey(account.email, password) });
  forgetSession();
}
