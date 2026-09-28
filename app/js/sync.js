// Sync with the Smart Spend server. Offline first: every change is saved on the device
// straight away and sent when there's a connection. The same entry changed on two devices
// keeps the latest edit (docs/API.md).

import { store, emit, plural, fmtDate, toISO } from './core.js';
import { state, persist, sanitizeTxn, validRate } from './ledger.js';
import { account, api, signedIn, refreshUser } from './auth.js';

const SYNC_PREFIX = 'ss3.sync.';
const CHUNK = 2000;
const TOMBSTONE_DAYS = 180;

export const status = { syncing: false, error: null, offline: false, lastAt: 0 };

function syncState() {
  const s = store.getJSON(SYNC_PREFIX + account.key, null);
  return Object.assign({ seq: 0, versions: {}, rateAt: 0, lastAt: 0 }, s && typeof s === 'object' ? s : {});
}
function saveState(s) { store.setJSON(SYNC_PREFIX + account.key, s); }
export function forgetSyncState(key) { store.remove(SYNC_PREFIX + key); }

const versionOf = (r) => (r.deleted ? 'd' : 'l') + (Number(r.updatedAt) || 0);

function localRecords() {
  const out = {};
  state.txns.forEach((t) => {
    out[t.id] = { id: t.id, title: t.title, amount: t.amount, type: t.type, category: t.category, date: t.date,
      createdAt: t.createdAt, updatedAt: t.updatedAt || t.createdAt, deleted: false };
    if (t.account) out[t.id].account = t.account;
  });
  Object.keys(state.deleted).forEach((id) => { if (!out[id]) out[id] = { id, deleted: true, updatedAt: state.deleted[id] }; });
  return out;
}

/** Records changed on this device that the server hasn't confirmed yet. */
function pending(st) {
  const all = localRecords();
  return Object.keys(all).map((id) => all[id]).filter((r) => st.versions[r.id] !== versionOf(r));
}
export function pendingCount() { return account.key && state.profileId === account.key ? pending(syncState()).length : 0; }

// Same rule as the server: later updatedAt wins; on a tie a deletion wins, then the greater content.
function canon(r) { return [r.title, Number(r.amount).toFixed(2), r.type, r.category, r.date].join('|'); }
function localWins(local, remote) {
  const a = Number(local.updatedAt) || 0, b = Number(remote.updatedAt) || 0;
  if (a !== b) return a > b;
  if (!!local.deleted !== !!remote.deleted) return !!local.deleted;
  if (local.deleted) return false;
  return canon(local) > canon(remote);
}

/** Merges the server's records into the ledger. Returns true when anything changed. */
function applyRemote(records, st) {
  if (!records.length) return false;
  const all = localRecords();
  let changed = false;
  records.forEach((r) => {
    const mine = all[r.id];
    st.versions[r.id] = versionOf(r);
    if (mine && versionOf(mine) === versionOf(r)) return;
    if (mine && localWins(mine, r)) return;                        // edited here while the request was out; goes next time
    all[r.id] = r;
    changed = true;
  });
  if (!changed) return false;
  const cutoff = Date.now() - TOMBSTONE_DAYS * 86400000;
  const live = [], dead = {};
  Object.keys(all).forEach((id) => {
    const r = all[id];
    if (r.deleted) { if (r.updatedAt >= cutoff) dead[id] = r.updatedAt; return; }
    const t = sanitizeTxn(r);
    if (t) { t.id = id; live.push(t); }
  });
  state.txns = live;
  state.deleted = dead;
  return true;
}

let again = false, timer = null;

/** Sends local changes and fetches everyone else's. `manual` reports the result as a toast. */
export async function syncNow(manual) {
  if (!signedIn() || state.profileId !== account.key) return false;
  if (status.syncing) { again = true; return false; }
  clearTimeout(timer);
  status.syncing = true; emit('cloud');
  const key = account.key;
  let changedAny = false, pulled = 0;
  const firstPull = !syncState().seq;
  try {
    let res = null;
    for (let round = 0; round < 60; round++) {
      const st = syncState();
      const changes = pending(st);
      const body = { since: st.seq, changes: changes.slice(0, CHUNK) };
      if (state.rateUpdatedAt > st.rateAt && validRate(state.rate)) body.rate = { value: state.rate, updatedAt: state.rateUpdatedAt };
      res = await api('POST', '/api/sync', body);
      if (account.key !== key || state.profileId !== key) return false;      // logged out meanwhile
      const sent = {};
      body.changes.forEach((c) => { sent[c.id] = 1; });
      pulled += res.records.filter((r) => !sent[r.id]).length;
      if (applyRemote(res.records, st)) changedAny = true;
      if (res.rate && res.rateUpdatedAt > state.rateUpdatedAt) { state.rate = res.rate; state.rateUpdatedAt = res.rateUpdatedAt; changedAny = true; }
      st.rateAt = Math.max(res.rateUpdatedAt || 0, body.rate ? body.rate.updatedAt : 0);
      st.seq = res.seq;
      st.lastAt = Date.now();
      saveState(st);
      if (!res.more && changes.length <= CHUNK) break;
    }
    const u = account.user || {}, a = res && res.account;
    if (a && (a.currency !== u.currency || a.altCurrency !== (u.altCurrency || null) || a.name !== u.name || (a.categoriesUpdatedAt || 0) !== (u.categoriesUpdatedAt || 0))) {
      refreshUser().then(() => emit('account')).catch(() => {});       // changed on another device
    }
    if (changedAny) persist('sync');
    status.error = null; status.offline = false; status.lastAt = Date.now();
    if (manual) emit('toast', { msg: 'Synced · ' + plural(state.txns.length, 'entry', 'entries'), tone: 'ok' });
    else if (pulled && changedAny && !firstPull) emit('toast', { msg: 'Updated with ' + plural(pulled, 'change') + ' from your other devices', tone: 'ok' });
    return true;
  } catch (e) {
    status.offline = e.code === 'offline';
    status.error = e.code === 'offline' || e.code === 'signed_out' ? null : e.message;
    if (manual && e.code !== 'signed_out') {
      emit('toast', e.code === 'offline'
        ? { msg: 'Offline. Your entries will sync when you’re back online.', duration: 5000 }
        : { msg: 'Sync failed. ' + e.message, tone: 'err', duration: 7000 });
    }
    return false;
  } finally {
    status.syncing = false; emit('cloud');
    if (again) { again = false; scheduleSync(1500); }
  }
}

export function scheduleSync(delay = 2500) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(false), delay);
}
export function cancelTimers() { clearTimeout(timer); }

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return plural(h, 'hour') + ' ago';
  const d = Math.round(h / 24);
  return d < 30 ? plural(d, 'day') + ' ago' : fmtDate(toISO(new Date(ms)));
}

/** { level: 'ok'|'busy'|'warn'|'error', title, detail } for the sync pill and Settings. */
export function describe() {
  if (!signedIn()) return { level: 'warn', title: 'Logged out', detail: 'Log in again to sync. Your entries are safe on this device.' };
  const waiting = pendingCount(), last = status.lastAt || syncState().lastAt;
  if (status.syncing) return { level: 'busy', title: 'Syncing…', detail: '' };
  if (status.offline) return { level: 'warn', title: 'Offline', detail: waiting ? plural(waiting, 'change') + ' will sync when you’re back online.' : 'Everything is saved on this device.' };
  if (status.error) return { level: 'error', title: 'Sync failed', detail: status.error };
  if (waiting) return { level: 'busy', title: plural(waiting, 'change') + ' waiting', detail: 'Sending shortly.' };
  return { level: 'ok', title: last ? 'Synced ' + timeAgo(last) : 'Not synced yet', detail: 'The same entries on every device you log in on.' };
}
