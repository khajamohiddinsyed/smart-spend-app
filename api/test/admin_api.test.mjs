// Admin API, end to end. Needs npm run dev; makes throwaway accounts and deletes them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const local = process.argv.includes('--local');
const API = process.env.API || 'http://127.0.0.1:8787', ORIGIN = 'https://khajamohiddinsyed.github.io';
async function ak(e, p) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(p), 'PBKDF2', false, ['deriveBits']); return Buffer.from(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 200000, salt: new TextEncoder().encode('smart-spend-auth|' + e) }, k, 256)).toString('hex'); }
async function call(m, p, b, t) { const r = await fetch(API + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', Origin: ORIGIN }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json() }; }
let passed = 0; const test = async (n, f) => { await f(); passed++; console.log('ok  ' + n); };

const adminEmail = 'adm' + Date.now() + '@example.com', userEmail = 'usr' + Date.now() + '@example.com';
const admin = await call('POST', '/api/register', { email: adminEmail, name: 'Boss', authKey: await ak(adminEmail, 'admin-pass-2026'), currency: 'SAR' });
const user = await call('POST', '/api/register', { email: userEmail, name: 'Member', authKey: await ak(userEmail, 'user-pass-2026'), currency: 'INR' });
let aT = admin.body.token, uT = user.body.token;
await call('POST', '/api/sync', { since: 0, changes: [{ id: 'm1', title: 'Secret Lunch', amount: 99, type: 'out', category: 'Dining', date: '2026-09-29', createdAt: Date.now(), updatedAt: Date.now() }] }, uT);

await test('non-admins are refused every admin route', async () => {
  assert.equal((await call('GET', '/api/admin/users', null, uT)).status, 403);
  assert.equal((await call('POST', '/api/admin/role', { email: userEmail, admin: true, authKey: await ak(userEmail, 'user-pass-2026') }, uT)).status, 403);
});
await test('CLI promotes the first admin', async () => {
  execFileSync('node', ['scripts/admin.mjs', 'promote', adminEmail, ...(local ? ['--local'] : [])], { encoding: 'utf8' });
  // token was issued before promotion; a fresh login reflects is_admin
  aT = (await call('POST', '/api/login', { email: adminEmail, authKey: await ak(adminEmail, 'admin-pass-2026') })).body.token;
  assert.equal((await call('GET', '/api/me', null, aT)).body.user.isAdmin, true);
});
await test('unlock needs the admin password', async () => {
  assert.equal((await call('POST', '/api/admin/unlock', { authKey: 'f'.repeat(64) }, aT)).status, 403);
  assert.equal((await call('POST', '/api/admin/unlock', { authKey: await ak(adminEmail, 'admin-pass-2026') }, aT)).status, 200);
});
await test('admin lists users with entry counts', async () => {
  const r = await call('GET', '/api/admin/users', null, aT);
  assert.equal(r.status, 200);
  const row = r.body.users.find((x) => x.email === userEmail);
  assert.equal(row.entries, 1); assert.equal(row.isAdmin, false);
});
let targetId;
await test('admin can read a user’s entries', async () => {
  targetId = (await call('GET', '/api/admin/users', null, aT)).body.users.find((x) => x.email === userEmail).id;
  const r = await call('GET', '/api/admin/entries?userId=' + targetId, null, aT);
  assert.equal(r.body.records[0].title, 'Secret Lunch');
});
await test('admin reset issues a working new recovery code', async () => {
  assert.equal((await call('POST', '/api/admin/reset', { email: userEmail, authKey: 'f'.repeat(64) }, aT)).status, 403);   // wrong pw
  const r = await call('POST', '/api/admin/reset', { email: userEmail, authKey: await ak(adminEmail, 'admin-pass-2026') }, aT);
  assert.match(r.body.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  const rec = await call('POST', '/api/recover', { email: userEmail, recoveryCode: r.body.recoveryCode, newAuthKey: await ak(userEmail, 'brand-new-pass') });
  assert.equal(rec.status, 200);
});
await test('promote/demote, and no self-demote', async () => {
  assert.equal((await call('POST', '/api/admin/role', { email: userEmail, admin: true, authKey: await ak(adminEmail, 'admin-pass-2026') }, aT)).status, 200);
  assert.equal((await call('GET', '/api/admin/users', null, aT)).body.users.find((x) => x.email === userEmail).isAdmin, true);
  assert.equal((await call('POST', '/api/admin/role', { email: adminEmail, admin: false, authKey: await ak(adminEmail, 'admin-pass-2026') }, aT)).status, 400);   // self-demote blocked
});
await test('admin deletes a user (not self)', async () => {
  assert.equal((await call('DELETE', '/api/admin/user', { email: adminEmail, authKey: await ak(adminEmail, 'admin-pass-2026') }, aT)).status, 400);
  assert.equal((await call('DELETE', '/api/admin/user', { email: userEmail, authKey: await ak(adminEmail, 'admin-pass-2026') }, aT)).status, 200);
  assert.equal((await call('POST', '/api/login', { email: userEmail, authKey: await ak(userEmail, 'brand-new-pass') })).status, 401);
});
await call('DELETE', '/api/me', { authKey: await ak(adminEmail, 'admin-pass-2026') }, aT);
console.log('\n' + passed + ' admin checks passed');
