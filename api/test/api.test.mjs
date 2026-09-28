// End-to-end checks against a running API (default: local `npm run dev`).
//   API=http://127.0.0.1:8787 node test/api.test.mjs
import assert from 'node:assert/strict';

const API = process.env.API || 'http://127.0.0.1:8787';
const ORIGIN = 'http://127.0.0.1:8797';

async function authKey(email, password) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: 200000, salt: new TextEncoder().encode('smart-spend-auth|' + email.toLowerCase()) }, k, 256);
  return Buffer.from(bits).toString('hex');
}
async function call(method, path, body, token, origin = ORIGIN) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json(), headers: r.headers };
}
const T = Date.now() - 3600_000;   // realistic clocks: very old deletions are pruned by design
const rec = (id, over = {}) => Object.assign({ id, title: 'Coffee', amount: 12.5, type: 'out', category: 'Dining', date: '2026-09-20', createdAt: T, updatedAt: T }, over);

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok  ' + name); }

const email = 'user' + Date.now() + '@example.com';
const key = await authKey(email, 'correct horse battery');
let token, token2, recovery;

await test('register', async () => {
  const r = await call('POST', '/api/register', { email, name: 'Test User', authKey: key, currency: 'SAR', altCurrency: 'INR', rate: 26.5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/);
  assert.deepEqual([r.body.user.currency, r.body.user.altCurrency, r.body.user.rate], ['SAR', 'INR', 26.5]);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  token = r.body.token; recovery = r.body.recoveryCode;
});

await test('duplicate email is refused', async () => {
  const r = await call('POST', '/api/register', { email: email.toUpperCase(), name: 'X', authKey: key, currency: 'SAR' });
  assert.equal(r.status, 409);
});

await test('unknown origin is refused', async () => {
  const r = await call('POST', '/api/login', { email, authKey: key }, null, 'https://evil.example');
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

await test('wrong password and unknown email look the same', async () => {
  const a = await call('POST', '/api/login', { email, authKey: 'a'.repeat(64) });
  const b = await call('POST', '/api/login', { email: 'nobody' + Date.now() + '@example.com', authKey: key });
  assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.message, b.body.message);
});

await test('login from a second device', async () => {
  const r = await call('POST', '/api/login', { email, authKey: key });
  assert.equal(r.status, 200); token2 = r.body.token;
  assert.equal((await call('GET', '/api/me', null, token2)).body.user.name, 'Test User');
});

await test('no token, no data', async () => {
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/sync', { since: 0 }, 'x'.repeat(43))).status, 401);
});

let seqA = 0, seqB = 0;
await test('device A pushes, device B pulls', async () => {
  const a = await call('POST', '/api/sync', { since: 0, changes: [rec('r1'), rec('r2', { title: 'Salary', type: 'in', amount: 5000, category: 'Salary' }), { id: 'bad id!', updatedAt: T }] }, token);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.rejected, 1);
  assert.equal(a.body.records.length, 2);
  seqA = a.body.seq;
  const b = await call('POST', '/api/sync', { since: 0, changes: [] }, token2);
  assert.deepEqual(b.body.records.map((r) => r.id).sort(), ['r1', 'r2']);
  seqB = b.body.seq;
  assert.equal(seqB, seqA);
});

await test('latest edit wins; an older edit gets the server copy back', async () => {
  const newer = await call('POST', '/api/sync', { since: seqB, changes: [rec('r1', { amount: 20, updatedAt: T + 3000 })] }, token2);
  seqB = newer.body.seq;
  const older = await call('POST', '/api/sync', { since: seqA, changes: [rec('r1', { amount: 99, updatedAt: T + 2000 })] }, token);
  const r1 = older.body.records.find((r) => r.id === 'r1');
  assert.equal(r1.amount, 20);
  seqA = older.body.seq;
});

await test('deletions sync and win ties', async () => {
  const d = await call('POST', '/api/sync', { since: seqA, changes: [{ id: 'r2', deleted: true, updatedAt: T + 4000 }] }, token);
  seqA = d.body.seq;
  const b = await call('POST', '/api/sync', { since: seqB }, token2);
  assert.deepEqual(b.body.records.map((r) => [r.id, r.deleted]), [['r2', true]]);
  seqB = b.body.seq;
  const tie = await call('POST', '/api/sync', { since: seqB, changes: [rec('r2', { updatedAt: T + 4000 })] }, token2);
  assert.equal(tie.body.records.find((r) => r.id === 'r2').deleted, true);
});

await test('nothing new means nothing returned', async () => {
  const b = await call('POST', '/api/sync', { since: 1e9 }, token2);
  assert.equal(b.body.records.length, 0);
});

await test('rate: newest wins', async () => {
  const a = await call('POST', '/api/sync', { since: seqA, rate: { value: 27.1, updatedAt: Date.now() } }, token);
  assert.equal(a.body.rate, 27.1);
  const old = await call('POST', '/api/sync', { since: seqB, rate: { value: 25, updatedAt: 10 } }, token2);
  assert.equal(old.body.rate, 27.1);
});

await test('big first upload in chunks, then paging', async () => {
  const many = Array.from({ length: 2000 }, (_, i) => rec('bulk' + i, { updatedAt: T + 5000 + i }));
  const r = await call('POST', '/api/sync', { since: 0, changes: many }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const fresh = await call('POST', '/api/sync', { since: 0 }, token2);
  assert.equal(fresh.body.records.length, 2002);
  assert.equal(fresh.body.more, false);
  const tooMany = await call('POST', '/api/sync', { since: 0, changes: Array.from({ length: 2001 }, (_, i) => rec('x' + i)) }, token);
  assert.equal(tooMany.status, 400);
});

await test('custom categories: saved, synced to entries, validated', async () => {
  const cats = [{ id: 'c_travel01', label: 'Travel', emoji: '✈️', words: ['trip', 'Hotel', ' flight '] }];
  const r = await call('PATCH', '/api/me', { categories: cats }, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.user.categories[0], { id: 'c_travel01', label: 'Travel', emoji: '✈️', words: ['trip', 'hotel', 'flight'] });
  assert.ok(r.body.user.categoriesUpdatedAt > 0);
  const s = await call('POST', '/api/sync', { since: 0, changes: [rec('trip1', { category: 'c_travel01', title: 'Hotel' })] }, token);
  assert.equal(s.body.records.find((x) => x.id === 'trip1').category, 'c_travel01');
  assert.equal(s.body.account.categoriesUpdatedAt, r.body.user.categoriesUpdatedAt);
  assert.equal((await call('PATCH', '/api/me', { categories: [{ id: 'bad', label: 'X' }] }, token)).status, 400);
  assert.equal((await call('PATCH', '/api/me', { categories: [{ id: 'c_abcd1', label: 'Dining' }] }, token)).status, 400);   // clashes with built-in
  assert.equal((await call('PATCH', '/api/me', { categories: Array.from({ length: 31 }, (_, i) => ({ id: 'c_x' + String(i).padStart(4, '0'), label: 'C' + i })) }, token)).status, 400);
  assert.equal((await call('PATCH', '/api/me', { name: 'Test User' }, token)).body.user.categories.length, 1);          // other edits keep them
});

await test('settings: change currency and drop the second one', async () => {
  const r = await call('PATCH', '/api/me', { currency: 'INR', altCurrency: null }, token);
  assert.deepEqual([r.body.user.currency, r.body.user.altCurrency, r.body.user.rate], ['INR', null, null]);
  const bad = await call('PATCH', '/api/me', { currency: 'XYZ' }, token);
  assert.equal(bad.status, 400);
});

let key2;
await test('recovery code resets the password and signs out everywhere', async () => {
  key2 = await authKey(email, 'new password 123');
  const wrong = await call('POST', '/api/recover', { email, recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA', newAuthKey: key2 });
  assert.equal(wrong.status, 401);
  const r = await call('POST', '/api/recover', { email, recoveryCode: recovery.toLowerCase().replace(/-/g, ' '), newAuthKey: key2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.recoveryCode, recovery);
  assert.equal((await call('GET', '/api/me', null, token)).status, 401);
  assert.equal((await call('GET', '/api/me', null, token2)).status, 401);
  assert.equal((await call('POST', '/api/login', { email, authKey: key })).status, 401);
  token = r.body.token;
  assert.equal((await call('POST', '/api/recover', { email, recoveryCode: recovery, newAuthKey: key2 })).status, 401);   // old code is spent
});

await test('change password keeps this device, signs out others', async () => {
  const other = (await call('POST', '/api/login', { email, authKey: key2 })).body.token;
  const key3 = await authKey(email, 'third password!');
  assert.equal((await call('POST', '/api/password', { authKey: 'b'.repeat(64), newAuthKey: key3 }, token)).status, 403);
  assert.equal((await call('POST', '/api/password', { authKey: key2, newAuthKey: key3 }, token)).status, 200);
  assert.equal((await call('GET', '/api/me', null, token)).status, 200);
  assert.equal((await call('GET', '/api/me', null, other)).status, 401);
  key2 = key3;
});

await test('logout ends the session', async () => {
  const t = (await call('POST', '/api/login', { email, authKey: key2 })).body.token;
  assert.equal((await call('POST', '/api/logout', {}, t)).status, 200);
  assert.equal((await call('GET', '/api/me', null, t)).status, 401);
});

await test('brute force is slowed down', async () => {
  const victim = 'brute' + Date.now() + '@example.com';
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { email: victim, authKey: 'c'.repeat(64) });
  assert.equal(last.status, 429);
});

await test('delete account removes everything', async () => {
  assert.equal((await call('DELETE', '/api/me', { authKey: key2 }, token)).status, 200);
  assert.equal((await call('POST', '/api/login', { email, authKey: key2 })).status, 401);
});

console.log('\n' + passed + ' passed');
