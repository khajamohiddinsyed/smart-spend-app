#!/usr/bin/env node
// Smart Spend admin commands. They run on the maintainer's computer through wrangler
// (the maintainer's Cloudflare login); nothing here is reachable from the website.
//
//   npm run admin -- list
//   npm run admin -- reset  <email>      new recovery code for someone who is locked out
//   npm run admin -- delete <email>      remove an account and all its entries
//
// Add --local to work on the local development database instead of the live one.

import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { webcrypto as crypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const local = args.includes('--local');
const yes = args.includes('--yes');
const [cmd, emailArg] = args.filter((a) => !a.startsWith('--'));
const where = local ? 'the LOCAL database' : 'the LIVE database';

function fail(msg) { console.error('✘ ' + msg); process.exit(1); }

/** Runs SQL through wrangler and returns the rows of the last statement. */
function sql(query) {
  let out;
  try {
    out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'smart-spend', local ? '--local' : '--remote', '--json', '--command', query],
      { cwd: API_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    fail('wrangler failed: ' + String(e.stderr || e.message).split('\n').filter(Boolean).slice(-3).join(' '));
  }
  const res = JSON.parse(out);
  return res[res.length - 1].results || [];
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) fail('Give a valid email address.');
  return e;
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";            // SQL string literal

// Same recovery-code scheme as the Worker (src/index.js).
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function newRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let s = '';
  for (let i = 0; i < 20; i++) s += B32[bytes[i] & 31];
  return s.match(/.{4}/g).join('-');
}
const normRecovery = (code) => String(code).toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
const hex = (buf) => Buffer.from(buf).toString('hex');
async function hmacHex(saltHex, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(saltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function findUser(email) {
  const u = sql(`SELECT id, email, name, currency, alt_currency, created_at,
    (SELECT count(*) FROM records r WHERE r.user_id = users.id AND r.deleted = 0) AS entries,
    (SELECT max(last_seen) FROM sessions s WHERE s.user_id = users.id) AS last_seen
    FROM users WHERE email = ${q(email)}`)[0];
  if (!u) fail('No account with the email ' + email + ' in ' + where + '.');
  return u;
}
function describe(u) {
  return `${u.name} <${u.email}> · ${u.currency}${u.alt_currency ? ' + ' + u.alt_currency : ''} · ${u.entries} entries · joined ${when(u.created_at)} · last active ${when(u.last_seen)}`;
}

async function confirm(question, expected) {
  if (yes) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === expected;
}

async function list() {
  const rows = sql(`SELECT u.email, u.name, u.currency, u.alt_currency, u.created_at,
    (SELECT count(*) FROM records r WHERE r.user_id = u.id AND r.deleted = 0) AS entries,
    (SELECT max(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
    FROM users u ORDER BY u.created_at`);
  console.log(`${rows.length} account${rows.length === 1 ? '' : 's'} in ${where}\n`);
  rows.forEach((u, i) => console.log(String(i + 1).padStart(3) + '. ' + describe(u)));
}

async function reset(email) {
  const u = findUser(email);
  console.log('Account: ' + describe(u));
  console.log('\nThis makes a new recovery code for them. Their entries are not touched, their old code stops');
  console.log('working, and their password stays the same until they use the new code on “Forgot your password?”.');
  console.log('Only do this once you are sure the request really comes from them.\n');
  if (!(await confirm('Type "reset" to continue: ', 'reset'))) fail('Cancelled. Nothing changed.');
  const code = newRecoveryCode(), salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  sql(`UPDATE users SET rec_salt = ${q(salt)}, rec_hash = ${q(await hmacHex(salt, normRecovery(code)))}, updated_at = ${Date.now()} WHERE id = ${q(u.id)};
       DELETE FROM attempts WHERE key IN (${q('em:recover:' + email)}, ${q('em:login:' + email)})`);
  console.log('\n✔ New recovery code for ' + u.email + ':\n\n    ' + code + '\n');
  console.log('Send it to them privately. On the login screen they tap “Forgot your password?”, enter their');
  console.log('email, this code and a new password. All their entries stay; their other devices are logged out.');
}

async function remove(email) {
  const u = findUser(email);
  console.log('Account: ' + describe(u));
  console.log(`\n⚠️  This deletes the account and all ${u.entries} entries for good. It can’t be undone.`);
  console.log('   For a forgotten password, use “reset” instead.\n');
  if (!(await confirm('Type the email address to delete it: ', u.email))) fail('Cancelled. Nothing changed.');
  sql(`DELETE FROM records WHERE user_id = ${q(u.id)}; DELETE FROM sessions WHERE user_id = ${q(u.id)}; DELETE FROM users WHERE id = ${q(u.id)}`);
  console.log('\n✔ Deleted ' + u.email + ' and all of its entries.');
}

if (cmd === 'list') await list();
else if (cmd === 'reset') await reset(cleanEmail(emailArg));
else if (cmd === 'delete') await remove(cleanEmail(emailArg));
else {
  console.log('Smart Spend admin\n\n  npm run admin -- list\n  npm run admin -- reset  <email>\n  npm run admin -- delete <email>\n\nAdd --local for the local database.');
  process.exit(cmd ? 1 : 0);
}
