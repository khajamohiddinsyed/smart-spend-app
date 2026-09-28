// Checks the admin commands end to end against a running API:
//   local:  npm run dev, then  node test/admin.test.mjs --local
//   live:   API=https://… node test/admin.test.mjs
// It makes a throwaway account and deletes it at the end.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const local = process.argv.includes('--local');
const API = process.env.API || 'http://127.0.0.1:8787';
const ORIGIN = 'https://khajamohiddinsyed.github.io';
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'admin.mjs');

async function authKey(email, password) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 200000, salt: new TextEncoder().encode('smart-spend-auth|' + email) }, k, 256);
  return Buffer.from(bits).toString('hex');
}
async function call(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const admin = (...a) => execFileSync('node', [ADMIN, ...a, ...(local ? ['--local'] : []), '--yes'], { encoding: 'utf8' });

const email = 'admintest' + Date.now() + '@example.com';
const T = Date.now() - 60000;
const reg = await call('POST', '/api/register', { email, name: 'Admin Test', authKey: await authKey(email, 'first-password'), currency: 'SAR' });
assert.equal(reg.status, 200);
const oldCode = reg.body.recoveryCode;
await call('POST', '/api/sync', { since: 0, changes: [
  { id: 'e1', title: 'Juice', amount: 15, type: 'out', category: 'Dining', date: '2026-09-28', createdAt: T, updatedAt: T },
  { id: 'e2', title: 'Salary', amount: 9000, type: 'in', category: 'Salary', date: '2026-09-27', createdAt: T, updatedAt: T }] }, reg.body.token);
for (let i = 0; i < 9; i++) await call('POST', '/api/login', { email, authKey: 'f'.repeat(64) });   // locked out
console.log('ok  account with 2 entries, locked out after wrong passwords');

const listed = admin('list');
assert.match(listed, new RegExp(email.replace(/\./g, '\\.') + '.*2 entries'));
console.log('ok  list shows it with its entry count');

const out = admin('reset', email);
const code = (out.match(/\b[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4}\b/) || [])[0];
assert.ok(code, 'reset printed a code');
assert.notEqual(code, oldCode);
console.log('ok  reset printed a new code');

assert.equal((await call('POST', '/api/recover', { email, recoveryCode: oldCode, newAuthKey: await authKey(email, 'x-password') })).status, 401);
console.log('ok  the old code no longer works');

const rec = await call('POST', '/api/recover', { email, recoveryCode: code, newAuthKey: await authKey(email, 'second-password') });
assert.equal(rec.status, 200, JSON.stringify(rec.body));
assert.equal((await call('GET', '/api/me', null, reg.body.token)).status, 401);
console.log('ok  the new code resets the password (lockout cleared) and logs out the old session');

const login = await call('POST', '/api/login', { email, authKey: await authKey(email, 'second-password') });
assert.equal(login.status, 200);
const pulled = await call('POST', '/api/sync', { since: 0 }, login.body.token);
assert.deepEqual(pulled.body.records.map((r) => r.title).sort(), ['Juice', 'Salary']);
console.log('ok  logging in with the new password shows both entries, untouched');

assert.throws(() => execFileSync('node', [ADMIN, 'reset', 'nobody' + Date.now() + '@example.com', ...(local ? ['--local'] : []), '--yes'], { stdio: 'pipe' }));
console.log('ok  reset refuses an unknown email');

admin('delete', email);
assert.equal((await call('POST', '/api/login', { email, authKey: await authKey(email, 'second-password') })).status, 401);
assert.doesNotMatch(admin('list'), new RegExp(email.replace(/\./g, '\\.')));
console.log('ok  delete removes the account and its entries\n\nall admin checks passed');
