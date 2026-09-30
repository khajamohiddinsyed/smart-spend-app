// Smart Spend API: accounts, sessions and ledger sync on Cloudflare Workers + D1.
//
// The browser never sends the password. It stretches it first
// (PBKDF2-SHA256, 200k rounds, salt = "smart-spend-auth|" + email) and sends the
// 32-byte result as `authKey`; the server keeps only an HMAC of that with its own salt.
//
// Sync is "latest edit wins" per record (docs/API.md). Every accepted change gets a
// per-user change number (`seq`), so a device asks only for what it hasn't seen.

const SESSION_DAYS = 180;
const TOMBSTONE_DAYS = 180;
const MAX_BODY = 1_500_000;
const MAX_CHANGES = 2000;          // per sync request; the app sends larger sets in chunks
const PAGE = 5000;                 // records returned per sync response
const INSERT_CHUNK = 400;

export const CURRENCIES = ['SAR', 'INR', 'AED', 'QAR', 'KWD', 'BHD', 'OMR', 'EGP', 'PKR', 'BDT', 'LKR', 'NPR', 'PHP', 'IDR', 'MYR', 'SGD', 'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY', 'TRY', 'ZAR', 'NGN', 'KES'];
const CATEGORIES = ['Groceries', 'Dining', 'Transport', 'Utilities', 'Cash', 'Shopping', 'Healthcare', 'Salary', 'Freelance', 'General'];
const CUSTOM_ID = /^c_[a-z0-9]{4,16}$/;
const MAX_CUSTOM = 30;
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';
const AI_PER_DAY = 40;                 // per person, so one heavy user can't use up the shared free allowance

/* ------------------------------------------------------------------ http */

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = (message, code = 'bad_request') => new HttpError(400, code, message);

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = { 'Vary': 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(req, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    }, corsHeaders(req, env))
  });
}

async function readJson(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'too_large', 'That request is too large.');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'too_large', 'That request is too large.');
  try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object') return v; } catch (e) { /* fallthrough */ }
  throw bad('The request body must be JSON.');
}

/* ---------------------------------------------------------------- crypto */

const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
function randomBytes(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; }
const randomHex = (n) => hex(randomBytes(n));
function b64url(bytes) { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacHex(saltHex, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(saltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Recovery codes: 20 Crockford base32 characters (100 bits), shown as 5 groups of 4.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newRecoveryCode() {
  const bytes = randomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i++) s += B32[bytes[i] & 31];
  return s.match(/.{4}/g).join('-');
}
function normRecovery(code) {
  return String(code || '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
}

/* ------------------------------------------------------------ validation */

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw bad('Enter a valid email address.', 'email');
  return e;
}
function cleanName(v) {
  const n = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!n) throw bad('Enter your name.', 'name');
  return n;
}
function cleanAuthKey(v) {
  const k = String(v || '');
  if (!/^[0-9a-f]{64}$/.test(k)) throw bad('Missing password key.', 'auth_key');
  return k;
}
function cleanCurrency(v, optional) {
  if (optional && (v == null || v === '')) return null;
  const c = String(v || '').toUpperCase();
  if (!CURRENCIES.includes(c)) throw bad('Pick a currency from the list.', 'currency');
  return c;
}
/** The account's own categories, or throws. */
function cleanCategories(v) {
  if (!Array.isArray(v)) throw bad('Categories must be a list.', 'categories');
  if (v.length > MAX_CUSTOM) throw bad('You can have up to ' + MAX_CUSTOM + ' of your own categories.', 'categories');
  const ids = new Set(), labels = new Set(CATEGORIES.map((c) => c.toLowerCase()).concat(['cash/atm', 'food & drinks', 'food and drinks', 'other']));
  return v.map((c) => {
    const id = String(c && c.id || '');
    if (!CUSTOM_ID.test(id) || ids.has(id)) throw bad('A category has an invalid id.', 'categories');
    const label = String(c.label || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!label) throw bad('Give every category a name.', 'categories');
    if (labels.has(label.toLowerCase())) throw bad('There is already a category called ' + label + '.', 'categories');
    ids.add(id); labels.add(label.toLowerCase());
    const emoji = String(c.emoji || '🏷️').replace(/[<>"'&]/g, '').trim().slice(0, 8) || '🏷️';
    const words = (Array.isArray(c.words) ? c.words : []).map((w) => String(w).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 24))
      .filter(Boolean).slice(0, 20);
    return { id, label, emoji, words };
  });
}
const parseCats = (raw) => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

/** { categoryId: monthly limit } for built-in or custom categories. */
function cleanBudgets(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('Budgets must be an object.', 'budgets');
  const out = {};
  Object.keys(v).slice(0, 60).forEach((k) => {
    if (!CATEGORIES.includes(k) && !CUSTOM_ID.test(k)) return;
    const n = Math.round(Number(v[k]) * 100) / 100;
    if (n > 0 && n <= 1e9) out[k] = n;
  });
  return out;
}
const parseBudgets = (raw) => { try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } };

function cleanRate(v) {
  if (v == null || v === '') return null;
  const r = Number(v);
  if (!isFinite(r) || r <= 0 || r >= 1e7) throw bad('The exchange rate must be a positive number.', 'rate');
  return Math.round(r * 1e6) / 1e6;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** A synced record from the app, or null when it can't be used. */
function cleanRecord(r, now) {
  if (!r || typeof r !== 'object') return null;
  const id = String(r.id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const u = Math.floor(Number(r.updatedAt));
  if (!(u > 0) || u > now + 86_400_000) return null;
  if (r.deleted) return { id, deleted: 1, u, c: '', data: null };
  const amount = round2(Math.abs(Number(r.amount)));
  if (!(amount > 0) || amount > 1e9) return null;
  const type = r.type === 'in' ? 'in' : 'out';
  const category = CATEGORIES.includes(r.category) || CUSTOM_ID.test(String(r.category || '')) ? r.category : 'General';
  const date = String(r.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const title = String(r.title || '').replace(/\s+/g, ' ').trim().slice(0, 120) || category;
  const createdAt = Math.floor(Number(r.createdAt)) || u;
  const rec = { id, title, amount, type, category, date, createdAt, updatedAt: u };
  const account = String(r.account || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (account) rec.account = account;
  return { id, deleted: 0, u, c: [title, amount.toFixed(2), type, category, date].join('|'), data: JSON.stringify(rec) };
}

/* ---------------------------------------------------------- rate limits */

async function tooMany(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO attempts (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN attempts.reset_at < ?3 THEN 1 ELSE attempts.count + 1 END,
       reset_at = CASE WHEN attempts.reset_at < ?3 THEN ?2 ELSE attempts.reset_at END
     RETURNING count, reset_at`
  ).bind(key, now + windowMs, now).first();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM attempts WHERE reset_at < ?1').bind(now - 86_400_000).run();
  return row && row.count > max ? Math.ceil((row.reset_at - now) / 60000) : 0;
}
async function brake(env, req, what, email) {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const mins = Math.max(
    await tooMany(env, 'ip:' + what + ':' + ip, what === 'register' ? 10 : 30, 15 * 60000),
    email ? await tooMany(env, 'em:' + what + ':' + email, 8, 15 * 60000) : 0
  );
  if (mins) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.');
}
const clearBrake = (env, what, email) => env.DB.prepare('DELETE FROM attempts WHERE key = ?1').bind('em:' + what + ':' + email).run();

/* -------------------------------------------------------------- sessions */

async function newSession(env, userId, req) {
  const token = b64url(randomBytes(32));
  const now = Date.now();
  const device = String(req.headers.get('User-Agent') || '').slice(0, 160);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, device) VALUES (?1, ?2, ?3, ?3, ?4, ?5)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_DAYS * 86_400_000, device).run();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(now).run();
  return token;
}

async function requireUser(req, env) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get('Authorization') || '');
  if (!m) throw new HttpError(401, 'signed_out', 'Please log in again.');
  const sid = await sha256Hex(m[1]);
  const now = Date.now();
  const row = await env.DB.prepare(
    `SELECT s.id AS sid, s.last_seen, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?1`
  ).bind(sid).first();
  if (!row || row.expires_at < now) throw new HttpError(401, 'signed_out', 'Your session ended. Please log in again.');
  if (now - row.last_seen > 86_400_000) {           // slide the expiry at most once a day
    await env.DB.prepare('UPDATE sessions SET last_seen = ?2, expires_at = ?3 WHERE id = ?1').bind(sid, now, now + SESSION_DAYS * 86_400_000).run();
  }
  return row;
}

const publicUser = (u) => ({
  email: u.email, name: u.name, currency: u.currency, altCurrency: u.alt_currency || null,
  rate: u.rate || null, rateUpdatedAt: u.rate_updated_at || 0, createdAt: u.created_at,
  categories: parseCats(u.categories), categoriesUpdatedAt: u.categories_updated_at || 0,
  budgets: parseBudgets(u.budgets), budgetsUpdatedAt: u.budgets_updated_at || 0,
  isAdmin: !!u.is_admin
});

/* -------------------------------------------------------------- handlers */

async function register(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email);
  await brake(env, req, 'register', null);
  const name = cleanName(b.name);
  const authKey = cleanAuthKey(b.authKey);
  const currency = cleanCurrency(b.currency);
  let alt = cleanCurrency(b.altCurrency, true);
  if (alt === currency) alt = null;
  const rate = alt ? cleanRate(b.rate) : null;
  const now = Date.now();
  const pwSalt = randomHex(16), recSalt = randomHex(16), recovery = newRecoveryCode();
  const id = randomHex(12);
  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, name, pw_salt, pw_hash, rec_salt, rec_hash, currency, alt_currency, rate, rate_updated_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`
    ).bind(id, email, name, pwSalt, await hmacHex(pwSalt, authKey), recSalt, await hmacHex(recSalt, normRecovery(recovery)),
      currency, alt, rate, rate ? now : 0, now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
    throw e;
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  return { token: await newSession(env, id, req), user: publicUser(user), recoveryCode: recovery };
}

const DUMMY_SALT = '00000000000000000000000000000000';

async function login(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email);
  const authKey = cleanAuthKey(b.authKey);
  await brake(env, req, 'login', email);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  const h = await hmacHex(u ? u.pw_salt : DUMMY_SALT, authKey);           // same work either way
  if (!u || !sameHex(h, u.pw_hash)) throw new HttpError(401, 'wrong_login', 'That email and password don’t match.');
  await clearBrake(env, 'login', email);
  return { token: await newSession(env, u.id, req), user: publicUser(u) };
}

async function recover(req, env) {
  const b = await readJson(req);
  const email = cleanEmail(b.email);
  await brake(env, req, 'recover', email);
  const code = normRecovery(b.recoveryCode);
  const authKey = cleanAuthKey(b.newAuthKey);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  const h = await hmacHex(u ? u.rec_salt : DUMMY_SALT, code);
  if (!u || code.length !== 20 || !sameHex(h, u.rec_hash)) throw new HttpError(401, 'wrong_recovery', 'That recovery code doesn’t match this email.');
  const pwSalt = randomHex(16), recSalt = randomHex(16), recovery = newRecoveryCode(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_salt = ?2, pw_hash = ?3, rec_salt = ?4, rec_hash = ?5, updated_at = ?6 WHERE id = ?1')
      .bind(u.id, pwSalt, await hmacHex(pwSalt, authKey), recSalt, await hmacHex(recSalt, normRecovery(recovery)), now),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id)
  ]);
  await clearBrake(env, 'recover', email);
  await clearBrake(env, 'login', email);
  return { token: await newSession(env, u.id, req), user: publicUser(u), recoveryCode: recovery };
}

async function changePassword(req, env, u) {
  const b = await readJson(req);
  if (!sameHex(await hmacHex(u.pw_salt, cleanAuthKey(b.authKey)), u.pw_hash)) throw new HttpError(403, 'wrong_password', 'Your current password isn’t right.');
  const pwSalt = randomHex(16);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET pw_salt = ?2, pw_hash = ?3, updated_at = ?4 WHERE id = ?1').bind(u.id, pwSalt, await hmacHex(pwSalt, cleanAuthKey(b.newAuthKey)), Date.now()),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1 AND id != ?2').bind(u.id, u.sid)      // sign out other devices
  ]);
  return { ok: true };
}

async function newRecovery(req, env, u) {
  const b = await readJson(req);
  if (!sameHex(await hmacHex(u.pw_salt, cleanAuthKey(b.authKey)), u.pw_hash)) throw new HttpError(403, 'wrong_password', 'Your password isn’t right.');
  const recSalt = randomHex(16), recovery = newRecoveryCode();
  await env.DB.prepare('UPDATE users SET rec_salt = ?2, rec_hash = ?3, updated_at = ?4 WHERE id = ?1')
    .bind(u.id, recSalt, await hmacHex(recSalt, normRecovery(recovery)), Date.now()).run();
  return { recoveryCode: recovery };
}

async function updateMe(req, env, u) {
  const b = await readJson(req);
  const name = b.name !== undefined ? cleanName(b.name) : u.name;
  const currency = b.currency !== undefined ? cleanCurrency(b.currency) : u.currency;
  let alt = b.altCurrency !== undefined ? cleanCurrency(b.altCurrency, true) : u.alt_currency;
  if (alt === currency) alt = null;
  let rate = b.rate !== undefined ? cleanRate(b.rate) : u.rate;
  let rateAt = b.rate !== undefined ? (Math.floor(Number(b.rateUpdatedAt)) || Date.now()) : u.rate_updated_at;
  if (!alt) { rate = null; }
  const cats = b.categories !== undefined ? JSON.stringify(cleanCategories(b.categories)) : (u.categories || null);
  const catsAt = b.categories !== undefined ? Date.now() : (u.categories_updated_at || 0);
  const buds = b.budgets !== undefined ? JSON.stringify(cleanBudgets(b.budgets)) : (u.budgets || null);
  const budsAt = b.budgets !== undefined ? Date.now() : (u.budgets_updated_at || 0);
  await env.DB.prepare('UPDATE users SET name = ?2, currency = ?3, alt_currency = ?4, rate = ?5, rate_updated_at = ?6, updated_at = ?7, categories = ?8, categories_updated_at = ?9, budgets = ?10, budgets_updated_at = ?11 WHERE id = ?1')
    .bind(u.id, name, currency, alt, rate, rateAt || 0, Date.now(), cats, catsAt, buds, budsAt).run();
  return { user: publicUser(await env.DB.prepare('SELECT * FROM users WHERE id = ?1').bind(u.id).first()) };
}

async function deleteMe(req, env, u) {
  const b = await readJson(req);
  if (!sameHex(await hmacHex(u.pw_salt, cleanAuthKey(b.authKey)), u.pw_hash)) throw new HttpError(403, 'wrong_password', 'Your password isn’t right.');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(u.id)
  ]);
  return { ok: true };
}

async function logout(req, env, u) {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?1').bind(u.sid).run();
  return { ok: true };
}

/**
 * POST /api/sync { since, changes: [record…], rate?: { value, updatedAt } }
 * → { records: [record…], seq, more, rate, rateUpdatedAt }
 * Returns everything changed after `since`, plus the server's copy of every record
 * sent (so a device learns when its older edit lost).
 */
async function sync(req, env, u) {
  const b = await readJson(req);
  const now = Date.now();
  const since = Math.max(0, Math.floor(Number(b.since)) || 0);
  const raw = Array.isArray(b.changes) ? b.changes : [];
  if (raw.length > MAX_CHANGES) throw bad('Send at most ' + MAX_CHANGES + ' changes at a time.', 'too_many_changes');
  const rows = [];
  const seen = new Set();
  raw.forEach((r) => { const c = cleanRecord(r, now); if (c && !seen.has(c.id)) { seen.add(c.id); rows.push(c); } });

  const stmts = [];
  if (rows.length) {
    stmts.push(env.DB.prepare('UPDATE users SET seq = seq + 1 WHERE id = ?1').bind(u.id));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      stmts.push(env.DB.prepare(
        `INSERT INTO records (user_id, id, data, deleted, updated_at, canon, seq)
         SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.data'), json_extract(value, '$.deleted'),
                json_extract(value, '$.u'), json_extract(value, '$.c'), (SELECT seq FROM users WHERE id = ?1)
         FROM json_each(?2) WHERE true
         ON CONFLICT(user_id, id) DO UPDATE SET
           data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, canon = excluded.canon, seq = excluded.seq
         WHERE excluded.updated_at > records.updated_at
            OR (excluded.updated_at = records.updated_at AND (excluded.deleted > records.deleted
                OR (excluded.deleted = records.deleted AND excluded.canon > records.canon)))`
      ).bind(u.id, JSON.stringify(rows.slice(i, i + INSERT_CHUNK))));
    }
  }
  const rate = b.rate && typeof b.rate === 'object' ? cleanRate(b.rate.value) : null;
  const rateAt = rate ? Math.min(Math.floor(Number(b.rate.updatedAt)) || 0, now + 86_400_000) : 0;
  if (rate && rateAt > 0) {
    stmts.push(env.DB.prepare('UPDATE users SET rate = ?2, rate_updated_at = ?3 WHERE id = ?1 AND alt_currency IS NOT NULL AND ?3 > rate_updated_at').bind(u.id, rate, rateAt));
  }
  const pushedIds = JSON.stringify(rows.map((r) => r.id));
  // Two index lookups, not one OR: with "seq > ? OR id IN (…)" SQLite reads every record the
  // person has on every sync. CROSS JOIN makes it look each sent id up by primary key.
  stmts.push(env.DB.prepare(
    `SELECT id, data, deleted, updated_at, seq FROM records WHERE user_id = ?1 AND seq > ?2
     UNION
     SELECT r.id, r.data, r.deleted, r.updated_at, r.seq FROM json_each(?3) j CROSS JOIN records r
     WHERE r.user_id = ?1 AND r.id = j.value
     ORDER BY seq, id LIMIT ?4`
  ).bind(u.id, since, pushedIds, PAGE + 1));
  stmts.push(env.DB.prepare('SELECT seq, rate, rate_updated_at, currency, alt_currency, name, categories_updated_at, budgets_updated_at FROM users WHERE id = ?1').bind(u.id));

  const results = await env.DB.batch(stmts);            // one transaction
  let out = results[results.length - 2].results || [];
  const head = results[results.length - 1].results[0];
  let more = false, seq = head.seq;
  if (out.length > PAGE) {
    const cut = out[PAGE].seq;
    out = out.filter((r) => r.seq < cut);
    more = true;
    seq = cut - 1;
  }
  if (Math.random() < 0.05) {
    await env.DB.prepare('DELETE FROM records WHERE user_id = ?1 AND deleted = 1 AND updated_at < ?2').bind(u.id, now - TOMBSTONE_DAYS * 86_400_000).run();
  }
  return {
    records: out.map((r) => (r.deleted ? { id: r.id, deleted: true, updatedAt: r.updated_at } : Object.assign(JSON.parse(r.data), { deleted: false }))),
    seq, more, rate: head.rate || null, rateUpdatedAt: head.rate_updated_at || 0,
    account: { currency: head.currency, altCurrency: head.alt_currency || null, name: head.name, categoriesUpdatedAt: head.categories_updated_at || 0, budgetsUpdatedAt: head.budgets_updated_at || 0 },
    rejected: raw.length - rows.length
  };
}

/* -------------------------------------------------------------------- AI */

// The rules in the app handle most entries; this is the fallback for text they're unsure about.
// Workers AI runs on the same Cloudflare account. The answer is treated as untrusted and
// checked field by field, like anything else a device sends.
const CURRENCY_HINT = 'Rs, ₹ and rupees = INR; riyal, SR and SAR = SAR; dirham and AED = AED; $ = USD; € = EUR; £ = GBP';

function aiPrompt(today, base, alt, cats) {
  return [
    'You turn a person\'s note about their money into ledger entries and reply with JSON only.',
    'Today is ' + today + '. Their main currency is ' + base + (alt ? ' and their second currency is ' + alt : '') + '.',
    'Categories (use the id exactly): ' + cats.map((c) => c.id + ' = ' + c.label + (c.words && c.words.length ? ' (' + c.words.slice(0, 8).join(', ') + ')' : '')).join('; ') + '.',
    'Rules:',
    '- One entry per separate amount of money that was spent or received. Never add, subtract or net amounts together, and never invent an amount that isn\'t written.',
    '- Most notes are about spending: use "out" unless the words clearly say the money came to the person.',
    '- Ignore balances, available or credit limits, budgets, reference numbers, phone numbers, card or account numbers, and counts of people, nights, days or items.',
    '- type is "out" for money spent, paid, debited, sent or given, and "in" for money received, credited, refunded, earned or returned.',
    '- title is what was bought, who was paid, or who paid: 1 to 4 words in Title Case, with no amounts, currencies or dates.',
    '- date is YYYY-MM-DD. Work out words like yesterday or last friday from today. Use today when no date is given.',
    '- currency is the ISO code if the note names one (' + CURRENCY_HINT + '), otherwise null.',
    '- category is the best id from the list, or General if nothing fits.',
    'Reply with exactly: {"entries":[{"title":"","amount":0,"type":"out","category":"General","date":"' + today + '","currency":null}]}'
  ].join('\n');
}

// Two worked examples: they fix the mistakes small models make most (calling spending "in",
// netting two amounts into one, inventing a number).
const AI_EXAMPLES = [
  { role: 'user', content: 'went to dubai trip, hotel 900 and taxi 60 yesterday. my friend paid me back 200' },
  { role: 'assistant', content: '{"entries":[{"title":"Hotel","amount":900,"type":"out","category":"General","date":"<yesterday>","currency":null},{"title":"Taxi","amount":60,"type":"out","category":"Transport","date":"<yesterday>","currency":null},{"title":"Friend Paid Back","amount":200,"type":"in","category":"General","date":"<today>","currency":null}]}' },
  { role: 'user', content: 'dad sent me 5000 for rent, I paid rent 4500 and chai 20' },
  { role: 'assistant', content: '{"entries":[{"title":"From Dad","amount":5000,"type":"in","category":"General","date":"<today>","currency":null},{"title":"Rent","amount":4500,"type":"out","category":"Utilities","date":"<today>","currency":null},{"title":"Chai","amount":20,"type":"out","category":"Dining","date":"<today>","currency":null}]}' }
];

function examplesFor(today) {
  const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1);
  const yday = d.toISOString().slice(0, 10);
  return AI_EXAMPLES.map((m) => ({ role: m.role, content: m.content.replace(/<today>/g, today).replace(/<yesterday>/g, yday) }));
}

function extractJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

async function aiParse(req, env, u) {
  if (!env.AI) throw new HttpError(503, 'ai_off', 'AI checking isn’t available right now.');
  const b = await readJson(req);
  const text = String(b.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 1500);
  if (!text) throw bad('There’s nothing to check.');
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
  const mins = await tooMany(env, 'ai:' + u.id, AI_PER_DAY, 86_400_000);
  if (mins) throw new HttpError(429, 'ai_limit', 'You’ve used your ' + AI_PER_DAY + ' AI checks for today. The regular preview still works, and AI checks come back tomorrow.');

  const custom = parseCats(u.categories);
  const LABELS = { Cash: 'Cash/ATM withdrawal', Dining: 'Food & Drinks: restaurants, cafés, coffee, tea, juice, snacks, food delivery' };
  const cats = CATEGORIES.map((id) => ({ id, label: LABELS[id] || id })).concat(custom);
  const byKey = {};
  cats.forEach((c) => { byKey[c.id.toLowerCase()] = c.id; byKey[String(c.label).toLowerCase()] = c.id; });
  ['food & drinks', 'food and drinks', 'food', 'drinks', 'restaurant', 'cash/atm', 'atm'].forEach((k) => { if (!byKey[k]) byKey[k] = /cash|atm/.test(k) ? 'Cash' : 'Dining'; });

  const model = env.AI_MODEL || AI_MODEL;
  let out;
  try {
    out = await env.AI.run(model, {
      messages: [{ role: 'system', content: aiPrompt(today, u.currency, u.alt_currency, cats) }].concat(examplesFor(today), [{ role: 'user', content: text }]),
      max_tokens: 700, temperature: 0
    });
  } catch (e) {
    console.error('ai', e && e.message);
    throw new HttpError(503, 'ai_busy', 'The AI can’t help right now (it may have reached today’s free limit). Try again later; the regular preview still works.');
  }
  const raw = out && out.response;
  const data = typeof raw === 'object' && raw ? raw : extractJson(raw);
  const list = data && Array.isArray(data.entries) ? data.entries : Array.isArray(data) ? data : [];
  const y = +today.slice(0, 4);
  const entries = list.slice(0, 25).map((e) => {
    const amount = round2(Math.abs(Number(String(e && e.amount).replace(/[^\d.]/g, ''))));
    if (!(amount > 0) || amount > 1e9) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Math.abs(+e.date.slice(0, 4) - y) <= 3 ? e.date : today;
    const title = String(e.title || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const code = String(e.currency || '').toUpperCase();
    return {
      title, amount, date,
      type: e.type === 'in' ? 'in' : 'out',
      category: byKey[String(e.category || '').toLowerCase()] || 'General',
      currency: CURRENCIES.includes(code) ? code : null
    };
  }).filter(Boolean);
  return { entries, model, usage: out && out.usage || null };
}


/**
 * POST /api/ai/ask { question, today } -> { spec }
 * The AI only turns a plain question into a filter; the app computes the number from the
 * ledger, so totals are always exact. spec = { metric, category, categoryLabel, period, from, to,
 * account, cardOnly, type }.
 */
const ASK_PER_DAY = 60;
const PERIODS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year', 'all', 'range'];
const METRICS = ['spent', 'received', 'net', 'count'];

function askPrompt(today, cats) {
  return [
    'Turn a question about the person\'s own spending into a JSON filter. Reply with JSON only, no prose.',
    'Today is ' + today + '.',
    'Categories (use the id): ' + cats.map((c) => c.id + '=' + c.label).join('; ') + '.',
    'Fields:',
    '- metric: "spent" (money out), "received" (money in), "net" (in minus out), or "count" (how many entries).',
    '- category: a category id from the list, or null for all.',
    '- period: one of today, yesterday, this_week, last_week, this_month, last_month, this_year, all, range.',
    '- from,to: "YYYY-MM-DD" only when period is "range", else null.',
    '- account: text to match an account or card name (e.g. "HDFC", "8432"), or null.',
    '- cardOnly: true if the question is about credit-card spending in general, else false.',
    'Reply exactly like: {"metric":"spent","category":"Dining","period":"this_week","from":null,"to":null,"account":null,"cardOnly":false}'
  ].join('\n');
}

async function aiAsk(req, env, u) {
  if (!env.AI) throw new HttpError(503, 'ai_off', 'Ask isn’t available right now.');
  const b = await readJson(req);
  const question = String(b.question || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!question) throw bad('Ask a question, like “how much did I spend on food this week?”');
  const today = /^\d{4}-\d{2}-\d{2}$/.test(b.today) ? b.today : new Date().toISOString().slice(0, 10);
  const mins = await tooMany(env, 'ask:' + u.id, ASK_PER_DAY, 86_400_000);
  if (mins) throw new HttpError(429, 'ask_limit', 'You’ve used your ' + ASK_PER_DAY + ' questions for today. They come back tomorrow.');
  const custom = parseCats(u.categories);
  const cats = CATEGORIES.map((id) => ({ id, label: id === 'Cash' ? 'Cash/ATM' : id })).concat(custom);
  const byKey = {}; cats.forEach((c) => { byKey[c.id.toLowerCase()] = c.id; byKey[String(c.label).toLowerCase()] = c.id; });
  ['food & drinks', 'food and drinks', 'food', 'restaurant', 'dining'].forEach((k) => { if (!byKey[k]) byKey[k] = 'Dining'; });
  let out;
  try {
    out = await env.AI.run(env.AI_MODEL || AI_MODEL, {
      messages: [{ role: 'system', content: askPrompt(today, cats) }, { role: 'user', content: question }],
      max_tokens: 250, temperature: 0
    });
  } catch (e) { console.error('ask', e && e.message); throw new HttpError(503, 'ai_busy', 'The AI can’t answer right now (it may have reached today’s free limit). Try again later.'); }
  const raw = out && out.response;
  const d = (typeof raw === 'object' && raw) ? raw : extractJson(raw);
  if (!d) throw new HttpError(422, 'no_spec', 'I couldn’t understand that question. Try naming an amount of time and a category, like “food this week”.');
  const period = PERIODS.includes(d.period) ? d.period : 'this_month';
  const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const spec = {
    metric: METRICS.includes(d.metric) ? d.metric : 'spent',
    category: d.category ? (byKey[String(d.category).toLowerCase()] || null) : null,
    period,
    from: period === 'range' ? iso(d.from) : null,
    to: period === 'range' ? iso(d.to) : null,
    account: d.account ? String(d.account).replace(/[<>]/g, '').trim().slice(0, 40) : null,
    cardOnly: !!d.cardOnly
  };
  spec.categoryLabel = spec.category ? (cats.find((c) => c.id === spec.category) || {}).label || null : null;
  return { spec, model: env.AI_MODEL || AI_MODEL };
}

/* --------------------------------------------------------------- admin */

async function requireAdmin(req, env) {
  const u = await requireUser(req, env);
  if (!u.is_admin) throw new HttpError(403, 'not_admin', 'This needs an admin account.');
  return u;
}

// Sensitive admin actions re-check the admin's own password, so a merely unlocked
// device can't manage accounts.
async function adminConfirm(u, authKey) {
  if (!sameHex(await hmacHex(u.pw_salt, cleanAuthKey(authKey)), u.pw_hash)) throw new HttpError(403, 'wrong_password', 'Your password isn’t right.');
}
async function logAdmin(env, actor, action, target, detail) {
  await env.DB.prepare('INSERT INTO admin_log (id, at, actor_id, actor_email, action, target_id, target_email, detail) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)')
    .bind(randomHex(12), Date.now(), actor.id, actor.email, action, target ? target.id : null, target ? target.email : null, detail || null).run();
}
async function targetByEmail(env, email) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?1').bind(cleanEmail(email)).first();
  if (!u) throw new HttpError(404, 'no_user', 'No account with that email.');
  return u;
}

// Proves the admin's password before the client reveals the admin area.
async function adminUnlock(req, env, u) {
  await adminConfirm(u, (await readJson(req)).authKey);
  return { ok: true };
}

async function adminUsers(req, env, u) {
  const rows = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.currency, u.alt_currency, u.is_admin, u.created_at,
       (SELECT count(*) FROM records r WHERE r.user_id = u.id AND r.deleted = 0) AS entries,
       (SELECT max(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
     FROM users u ORDER BY u.created_at`
  ).all();
  return { users: (rows.results || []).map((r) => ({
    id: r.id, email: r.email, name: r.name, currency: r.currency, altCurrency: r.alt_currency || null,
    isAdmin: !!r.is_admin, entries: r.entries, createdAt: r.created_at, lastSeen: r.last_seen || 0, self: r.id === u.id
  })) };
}

async function adminResetUser(req, env, u) {
  const b = await readJson(req);
  await adminConfirm(u, b.authKey);
  const t = await targetByEmail(env, b.email);
  const recSalt = randomHex(16), recovery = newRecoveryCode();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET rec_salt = ?2, rec_hash = ?3, updated_at = ?4 WHERE id = ?1').bind(t.id, recSalt, await hmacHex(recSalt, normRecovery(recovery)), Date.now()),
    env.DB.prepare('DELETE FROM attempts WHERE key IN (?1, ?2)').bind('em:recover:' + t.email, 'em:login:' + t.email)
  ]);
  await logAdmin(env, u, 'reset-recovery', t, null);
  return { recoveryCode: recovery, email: t.email };
}

async function adminRole(req, env, u) {
  const b = await readJson(req);
  await adminConfirm(u, b.authKey);
  const makeAdmin = !!b.admin;
  const t = await targetByEmail(env, b.email);
  if (t.id === u.id && !makeAdmin) throw new HttpError(400, 'self_demote', 'You can’t remove your own admin access. Ask another admin to do it.');
  await env.DB.prepare('UPDATE users SET is_admin = ?2, updated_at = ?3 WHERE id = ?1').bind(t.id, makeAdmin ? 1 : 0, Date.now()).run();
  await logAdmin(env, u, makeAdmin ? 'grant-admin' : 'revoke-admin', t, null);
  return { ok: true };
}

async function adminDeleteUser(req, env, u) {
  const b = await readJson(req);
  await adminConfirm(u, b.authKey);
  const t = await targetByEmail(env, b.email);
  if (t.id === u.id) throw new HttpError(400, 'self_delete', 'Delete your own account from Settings, not from here.');
  const n = (((await env.DB.prepare('SELECT count(*) n FROM records WHERE user_id = ?1').bind(t.id).first()) || {}).n) || 0;
  await logAdmin(env, u, 'delete-account', t, n + ' entries');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM records WHERE user_id = ?1').bind(t.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(t.id),
    env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(t.id)
  ]);
  return { ok: true };
}

// Full read access to a user's entries (an explicit choice for this deployment).
async function adminEntries(req, env, u) {
  const id = new URL(req.url).searchParams.get('userId') || '';
  const t = await env.DB.prepare('SELECT id, email, name FROM users WHERE id = ?1').bind(id).first();
  if (!t) throw new HttpError(404, 'no_user', 'No such account.');
  const rows = await env.DB.prepare(
    'SELECT data FROM records WHERE user_id = ?1 AND deleted = 0 ORDER BY seq DESC LIMIT 2000').bind(id).all();
  await logAdmin(env, u, 'view-entries', t, null);
  return { user: { email: t.email, name: t.name }, records: (rows.results || []).map((r) => JSON.parse(r.data)) };
}

/* ---------------------------------------------------------------- router */

const ROUTES = {
  'POST /api/register': { fn: register },
  'POST /api/login': { fn: login },
  'POST /api/recover': { fn: recover },
  'GET /api/me': { auth: true, fn: async (req, env, u) => ({ user: publicUser(u) }) },
  'PATCH /api/me': { auth: true, fn: updateMe },
  'DELETE /api/me': { auth: true, fn: deleteMe },
  'POST /api/logout': { auth: true, fn: logout },
  'POST /api/password': { auth: true, fn: changePassword },
  'POST /api/recovery-code': { auth: true, fn: newRecovery },
  'POST /api/sync': { auth: true, fn: sync },
  'POST /api/ai/parse': { auth: true, fn: aiParse },
  'POST /api/ai/ask': { auth: true, fn: aiAsk },
  'POST /api/admin/unlock': { auth: true, fn: adminUnlock },
  'GET /api/admin/users': { admin: true, fn: adminUsers },
  'POST /api/admin/reset': { admin: true, fn: adminResetUser },
  'POST /api/admin/role': { admin: true, fn: adminRole },
  'DELETE /api/admin/user': { admin: true, fn: adminDeleteUser },
  'GET /api/admin/entries': { admin: true, fn: adminEntries },
  'GET /api/health': { fn: async () => ({ ok: true }) }
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
    const route = ROUTES[req.method + ' ' + url.pathname];
    try {
      if (!route) throw new HttpError(404, 'not_found', 'Not found.');
      const origin = req.headers.get('Origin');
      if (origin && !corsHeaders(req, env)['Access-Control-Allow-Origin']) throw new HttpError(403, 'origin', 'This site isn’t allowed to use the API.');
      const user = route.admin ? await requireAdmin(req, env) : route.auth ? await requireUser(req, env) : null;
      return json(req, env, 200, await route.fn(req, env, user));
    } catch (e) {
      if (e instanceof HttpError) return json(req, env, e.status, { error: e.code, message: e.message });
      console.error(e && e.stack || e);
      return json(req, env, 500, { error: 'server', message: 'Something went wrong on the server. Try again.' });
    }
  }
};
