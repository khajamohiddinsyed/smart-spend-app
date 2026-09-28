// Boot, routing, events and gestures. Everything else is imported.

import { $, esc, on, todayISO, fromISO, fmtDateLong, addMonths, MONTHS_FULL, haptic, reducedMotion, pad, plural } from './core.js';
import { state, load, reset, setRate, loadDemo, clearAll, restoreSnapshot, buildBackupPayload, removeProfileData, writeBudgets } from './ledger.js';
import { describe, syncNow, scheduleSync, cancelTimers, pendingCount, forgetSyncState } from './sync.js';
import { account, loadSession, signedIn, logout, refreshUser, userColor, isAdmin } from './auth.js';
import { cur, setCurrencies } from './currency.js';
import { setCustomCategories } from './categories.js';
import { ui, resetScreenState } from './appstate.js';
import { icon, avatar, toast, initToast, initSheet, openSheet, closeSheet, sheetOpen, prefs, setPref, applyTheme, armed } from './ui.js';
import { homeView, activityView, activityListHtml, activityCounts, insightsView, moreView } from './views.js';
import {
  openQuickAdd, openEdit, removeWithUndo, openBudgets, openRestore, openCurrencySettings, openChangePassword,
  openNewRecoveryCode, openDeleteAccount, openTypingHelp, openInstallHelp, openCategories, openAdmin
} from './sheets.js';
import { initGate, show as showGate, gateOpen, close as closeGate } from './gate.js';

const TABS = ['home', 'activity', 'insights', 'more'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ---------------------------- rendering ---------------------------- */

function titleFor(tab) {
  const p = ui.profile, d = fromISO(todayISO());
  if (tab === 'home') return { t: 'Hi, ' + p.name, s: DAY_NAMES[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_FULL[d.getMonth()] };
  if (tab === 'activity') return { t: 'Activity', s: ui.scope === 'all' ? 'All entries' : ui.scope === 'day' ? fmtDateLong(ui.selected) : MONTHS_FULL[ui.month.m] + ' ' + ui.month.y };
  if (tab === 'insights') return { t: 'Insights', s: MONTHS_FULL[ui.month.m] + ' ' + ui.month.y };
  return { t: 'Settings', s: p.name };
}
function renderChrome() {
  if (!ui.profile) return;
  const tt = titleFor(ui.tab);
  $('#viewTitle').innerHTML = esc(tt.t) + '<span class="sub">' + esc(tt.s) + '</span>';
  $('#avatarBtn').innerHTML = avatar(ui.profile, 36);
  $('#avatarBtn').setAttribute('aria-label', 'Profile: ' + ui.profile.name);
  document.querySelectorAll('.tab[data-tab]').forEach((a) => {
    if (a.getAttribute('data-tab') === ui.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  renderSyncDot();
}

function renderSyncDot() {
  if (!ui.profile) return;
  const d = describe(), b = $('#syncDot');
  b.setAttribute('data-level', d.level);
  b.querySelector('span').textContent = d.level === 'busy' ? 'Syncing' : d.level === 'ok' ? 'Synced' : d.title === 'Offline' ? 'Offline' : d.level === 'warn' ? 'Log in' : 'Sync failed';
  b.title = d.title + (d.detail ? ' · ' + d.detail : '');
}

function render() {
  if (!ui.profile) { $('#view').innerHTML = ''; return; }
  const v = ui.tab === 'activity' ? activityView() : ui.tab === 'insights' ? insightsView() : ui.tab === 'more' ? moreView() : homeView();
  const paint = () => {
    $('#view').innerHTML = '<div class="view">' + v.html + '</div>';
    if (v.after) v.after();
    renderChrome();
    ui.flash = {};
  };
  paint();
}

function renderActivityList() {
  const list = $('#actList');
  if (!list) { render(); return; }
  list.innerHTML = activityListHtml();
  const c = activityCounts();
  document.querySelectorAll('#actFilter [data-filter]').forEach((b) => { b.querySelector('.c').textContent = c[b.getAttribute('data-filter')]; });
}

function go(tab, opts = {}) {
  if (TABS.indexOf(tab) === -1) tab = 'home';
  if (ui.tab === tab && !opts.force) { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }
  ui.tab = tab;
  if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab);
  const doIt = () => { render(); window.scrollTo(0, 0); };
  if (document.startViewTransition && !reducedMotion() && !opts.instant && document.visibilityState === 'visible') document.startViewTransition(doIt); else doIt();
}

/* ------------------------------ session ------------------------------ */

function profileFromAccount() {
  const u = account.user || {};
  return { id: account.key, name: u.name || account.email, email: account.email, color: userColor(account.email) };
}

function applyUser(u) {
  setCustomCategories(u.categories || []);
  writeBudgets(u.budgets || {});
  setCurrencies(u.currency, u.altCurrency);
  if (!cur.alt && prefs.show === 'alt') setPref('show', 'base');
  if (u.rate && (u.rateUpdatedAt || 0) > (state.rateUpdatedAt || 0)) { state.rate = u.rate; state.rateUpdatedAt = u.rateUpdatedAt; }
}

/** Opens the signed-in account. `isNew`: just registered. */
/** Opens the Add box with text shared from another app, once someone is logged in. */
function openShared() {
  let text = null;
  try { text = sessionStorage.getItem('ss3.share'); sessionStorage.removeItem('ss3.share'); } catch (e) { /* private mode */ }
  if (text) setTimeout(() => openQuickAdd(text), 450);
}

function enter(isNew, message) {
  ui.profile = profileFromAccount();
  setCustomCategories((account.user && account.user.categories) || []);   // before load, so their entries keep them
  load(account.key);
  applyUser(account.user);
  resetScreenState();
  const h = location.hash.slice(1);
  ui.tab = TABS.indexOf(h) !== -1 ? h : 'home';
  $('#app').hidden = false;
  render();
  if (message) toast(message, { tone: 'ok', duration: 6000 });
  else if (isNew) toast('Welcome, ' + ui.profile.name + '. Your account is ready.', { tone: 'ok' });
  setTimeout(() => syncNow(false), 300);
  openShared();
  refreshUser().then((u) => {                     // name or currency changed on another device
    if (!ui.profile) return;
    applyUser(u);
    ui.profile = profileFromAccount();
    render();
  }).catch(() => { /* offline: use the saved copy */ });
}

/** Logs out and removes this account's data from the device (it stays on the server). */
async function leave(force) {
  const waiting = pendingCount();
  if (waiting && !force) {
    await syncNow(false);
    if (pendingCount()) return waiting;
  }
  cancelTimers();
  closeSheet();
  const key = account.key;
  await logout();
  removeProfileData(key);
  forgetSyncState(key);
  ui.profile = null;
  reset(null);
  $('#view').innerHTML = '';
  $('#app').hidden = true;
  showGate('welcome');
  return 0;
}

/* ------------------------------ actions ------------------------------ */

function exportFile() {
  const p = ui.profile, n = new Date();
  const name = 'smart-spend-' + (p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'profile') + '-backup-' + n.getFullYear() + pad(n.getMonth() + 1) + pad(n.getDate()) + '.json';
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(buildBackupPayload(p.name), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Backup file saved · ' + state.txns.length + ' records', { tone: 'ok' });
  } catch (e) { toast('Couldn’t create the file in this browser.', { tone: 'err' }); }
}

function logoutFlow(btn) {
  const waiting = pendingCount();
  if (waiting && !btn.dataset.force) {
    leave(false).then((left) => {
      if (!left) return;
      btn.dataset.force = '1';
      const b = btn.querySelector('b') || btn;
      b.textContent = 'Log out anyway (' + plural(left, 'change') + ' not synced)';
      toast(plural(left, 'change') + ' haven’t reached the server yet (you’re offline). Logging out now would lose them.', { tone: 'err', duration: 7000 });
    });
    return;
  }
  leave(true);
}

function profileSheet() {
  const p = ui.profile;
  openSheet({
    title: p.name,
    body: '<div class="set-group"><div class="set-row"><span class="set-ico">' + icon('more') + '</span><span class="set-main"><b>' + esc(p.name) + '</b><span>' + esc(p.email) + '</span></span></div>' +
      '<button class="set-row" data-ps="settings"><span class="set-ico">' + icon('coins') + '</span><span class="set-main"><b>Settings</b><span>Currency, password, your data</span></span></button>' +
      '<button class="set-row danger" data-ps="logout"><span class="set-ico">' + icon('lock') + '</span><span class="set-main"><b>Log out</b><span>Removes your entries from this device; they stay in your account</span></span></button></div>',
    click: (e, t) => {
      const b = t.closest('[data-ps]');
      if (!b) return;
      const a = b.getAttribute('data-ps');
      if (a === 'settings') { closeSheet(); go('more'); }
      if (a === 'logout') logoutFlow(b);
    }
  });
}

function onViewClick(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.getAttribute('data-act'), p = ui.profile;
  switch (act) {
    case 'quick': openQuickAdd(); break;
    case 'go': go(t.getAttribute('data-go')); break;
    case 'month-prev': case 'month-next': {
      const n = addMonths(ui.month.y, ui.month.m, act === 'month-prev' ? -1 : 1);
      const now = fromISO(todayISO());
      if (act === 'month-next' && (n.y > now.getFullYear() || (n.y === now.getFullYear() && n.m > now.getMonth())) && ui.tab !== 'activity') break;
      ui.month = n;
      if (ui.scope === 'day') ui.scope = 'month';
      render(); break;
    }
    case 'cur': setPref('show', t.getAttribute('data-show')); haptic(6); break;
    case 'cur-flip': if (cur.alt) { setPref('show', prefs.show === 'alt' ? 'base' : 'alt'); haptic(6); } break;
    case 'row-open': if (!t.closest('.row-wrap').classList.contains('open')) openEdit(t.getAttribute('data-id')); else closeSwipes(); break;
    case 'row-del': removeWithUndo(t.getAttribute('data-id')); break;
    case 'day': {
      const iso = t.getAttribute('data-date');
      ui.selected = iso; ui.scope = 'day';
      const d = fromISO(iso); ui.month = { y: d.getFullYear(), m: d.getMonth() };
      render(); break;
    }
    case 'cal-today': { const d = fromISO(todayISO()); ui.selected = todayISO(); ui.month = { y: d.getFullYear(), m: d.getMonth() }; ui.scope = 'day'; render(); break; }
    case 'scope': ui.scope = t.getAttribute('data-scope'); render(); break;
    case 'filter': ui.filter = t.getAttribute('data-filter'); render(); break;
    case 'acct': ui.account = t.getAttribute('data-acct'); render(); break;
    case 'drop-edit': openEdit(t.getAttribute('data-id')); break;
    case 'cat-toggle': { const id = t.getAttribute('data-cat'); ui.expanded[id] = !ui.expanded[id]; render(); break; }
    case 'cat-view': ui.category = t.getAttribute('data-cat'); ui.account = 'all'; ui.filter = 'all'; ui.search = ''; if (ui.scope === 'day') ui.scope = 'month'; go('activity', { force: true }); break;
    case 'cat-clear': ui.category = 'all'; render(); break;
    case 'budgets': openBudgets(); break;
    case 'install': install(); break;
    case 'example': openQuickAdd(t.getAttribute('data-text')); break;
    case 'typing-help': openTypingHelp(); break;
    case 'currency': openCurrencySettings(); break;
    case 'categories': openCategories(); break;
    case 'admin': openAdmin(); break;
    case 'change-password': openChangePassword(); break;
    case 'recovery-code': openNewRecoveryCode(); break;
    case 'delete-account': openDeleteAccount(() => afterAccountDeleted()); break;
    case 'logout': logoutFlow(t); break;
    case 'install-help': openInstallHelp(); break;
    case 'install-dismiss': setPref('installDismissed', true); break;
    case 'demo': {
      const snap = loadDemo();
      toast('Loaded six months of sample entries', { tone: 'ok', actionLabel: 'Undo', onAction: () => restoreSnapshot(snap) });
      break;
    }
    case 'clear': {
      if (!state.txns.length) { toast('Nothing to clear.'); break; }
      if (!armed(t.querySelector('b'), 'Tap again to clear everything')) break;
      const snap = clearAll();
      toast('All entries cleared', { actionLabel: 'Undo', onAction: () => { restoreSnapshot(snap); toast('Entries restored', { tone: 'ok' }); } });
      break;
    }
    case 'export': exportFile(); break;
    case 'restore': document.getElementById('fileInput').click(); break;
    case 'sync-now': syncNow(true); break;
    case 'theme': setPref('theme', t.getAttribute('data-theme')); break;
  }
}

/* --------------------------- swipe to delete --------------------------- */

let swipe = null;
function closeSwipes(except) {
  document.querySelectorAll('.row-wrap.open').forEach((w) => { if (w !== except) { w.classList.remove('open'); w.querySelector('.row').style.transform = ''; } });
}
function initSwipe() {
  const host = $('#view');
  host.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.pointerType === 'mouse') return;
    swipe = { row, wrap: row.closest('.row-wrap'), x0: e.clientX, y0: e.clientY, dx: 0, active: false, base: row.closest('.row-wrap').classList.contains('open') ? -96 : 0 };
  });
  host.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x0, dy = e.clientY - swipe.y0;
    if (!swipe.active) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
      if (Math.abs(dx) < 10) return;
      swipe.active = true; swipe.row.classList.add('dragging'); swipe.wrap.classList.add('swiping'); closeSwipes(swipe.wrap);
    }
    swipe.dx = Math.min(0, Math.max(-220, swipe.base + dx));
    swipe.row.style.transform = 'translateX(' + swipe.dx + 'px)';
  });
  const end = () => {
    if (!swipe) return;
    const s = swipe; swipe = null;
    if (!s.active) return;
    s.row.classList.remove('dragging');
    setTimeout(() => s.wrap.classList.remove('swiping'), 260);
    if (s.dx < -180) { s.row.style.transform = 'translateX(-100%)'; setTimeout(() => removeWithUndo(s.row.getAttribute('data-id')), 160); }
    else if (s.dx < -50) { s.row.style.transform = 'translateX(-96px)'; s.wrap.classList.add('open'); haptic(6); }
    else { s.row.style.transform = ''; s.wrap.classList.remove('open'); }
    // Swallow the click that follows a drag.
    const stop = (ev) => { ev.stopPropagation(); ev.preventDefault(); window.removeEventListener('click', stop, true); };
    window.addEventListener('click', stop, true);
    setTimeout(() => window.removeEventListener('click', stop, true), 50);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', () => { if (swipe) { swipe.row.classList.remove('dragging'); swipe.row.style.transform = ''; swipe = null; } });
}

/* ---------------------------- pull to refresh ---------------------------- */

function initPullToRefresh() {
  const ptr = $('#ptr');
  let y0 = null, pull = 0;
  window.addEventListener('touchstart', (e) => {
    if (window.scrollY > 0 || sheetOpen() || gateOpen() || !ui.profile || e.target.closest('.row, .chart, input, textarea')) { y0 = null; return; }
    y0 = e.touches[0].clientY; pull = 0;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    pull = Math.max(0, e.touches[0].clientY - y0);
    const d = Math.min(90, pull * 0.5);
    ptr.style.transform = 'translate(-50%, ' + (d - 48) + 'px) rotate(' + pull * 2 + 'deg)';
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    if (pull > 120 && ui.profile) {
      ptr.classList.add('spin'); ptr.style.transform = 'translate(-50%, 20px)'; haptic(10);
      syncNow(true).then(() => { ptr.classList.remove('spin'); ptr.style.transform = ''; });
    } else ptr.style.transform = '';
  });
}

/* --------------------------------- PWA --------------------------------- */

let deferredInstall = null;
function install() {
  if (deferredInstall) {
    deferredInstall.prompt();
    deferredInstall.userChoice.then(() => { deferredInstall = null; ui.install = null; render(); });
  } else {
    openInstallHelp();
  }
}
function initPWA() {
  ui.standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; ui.install = e; if (ui.tab === 'home' || ui.tab === 'more') render(); });
  window.addEventListener('appinstalled', () => { deferredInstall = null; ui.install = null; ui.standalone = true; toast('Installed. Open Smart Spend from your home screen.', { tone: 'ok' }); render(); });
  const devNoCache = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]sw=1/.test(location.search);
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !devNoCache) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      const offer = (w) => toast('A new version of Smart Spend is ready', { actionLabel: 'Update', duration: 15000, onAction: () => w.postMessage('skip-waiting') });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
      });
    }).catch(() => { /* offline support is a bonus, never a blocker */ });
    // Reload only when a new version replaces a running one (after "Update"), never on the
    // first visit, when the worker takes control mid-sign-up.
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading) { reloading = true; location.reload(); } });
  }
}

function afterAccountDeleted() {
  const key = ui.profile && ui.profile.id;
  cancelTimers();
  if (key) { removeProfileData(key); forgetSyncState(key); }
  ui.profile = null; reset(null);
  $('#view').innerHTML = ''; $('#app').hidden = true;
  showGate('welcome');
  toast('Your account and all its entries were deleted.');
}

/* --------------------------------- boot --------------------------------- */

function boot() {
  applyTheme();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (prefs.theme === 'system') applyTheme(); });
  initToast();
  initSheet();
  initSwipe();
  initPullToRefresh();
  initPWA();

  initGate({
    onSignedIn: (isNew, message) => {
      if (ui.profile && ui.profile.id === account.key) { closeGate(); render(); syncNow(false); openShared(); if (message) toast(message, { tone: 'ok' }); return; }
      enter(isNew, message);
    }
  });

  // chrome
  $('#fab').addEventListener('click', () => { haptic(8); openQuickAdd(); });
  $('#avatarBtn').addEventListener('click', profileSheet);
  $('#syncDot').addEventListener('click', () => { if (!ui.profile) return; if (!signedIn()) showGate('relogin', { email: account.email }); else syncNow(true); });
  document.querySelectorAll('.tab[data-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); haptic(4); go(a.getAttribute('data-tab')); }));
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (ui.profile && TABS.indexOf(h) !== -1 && h !== ui.tab) go(h, { instant: true }); });
  const view = $('#view');
  view.addEventListener('click', onViewClick);
  view.addEventListener('input', (e) => { if (e.target.id === 'actSearch') { ui.search = e.target.value; renderActivityList(); } });
  view.addEventListener('change', (e) => {
    if (e.target.id === 'rateInput') {
      if (setRate(e.target.value)) toast('Rate updated · 1 ' + cur.base + ' = ' + state.rate + ' ' + cur.alt, { tone: 'ok' });
      else e.target.value = state.rate;
    }
  });
  window.addEventListener('scroll', () => $('#topbar').classList.toggle('scrolled', window.scrollY > 4), { passive: true });
  let rz = null, lastW = window.innerWidth;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (ui.tab === 'insights' && Math.abs(window.innerWidth - lastW) > 30 && !sheetOpen()) { lastW = window.innerWidth; render(); } }, 200); });
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (!typing && !sheetOpen() && !gateOpen() && ui.profile && (e.key === 'n' || e.key === '+')) { e.preventDefault(); openQuickAdd(); }
  });

  // file restore
  $('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { toast('That file is too large to be a backup.', { tone: 'err' }); return; }
    const r = new FileReader();
    r.onload = () => openRestore(String(r.result), f.name);
    r.onerror = () => toast('Couldn’t read that file.', { tone: 'err' });
    r.readAsText(f);
  });

  // events from the data layer
  on('ledger', (d) => {
    if (!ui.profile) return;
    if (!sheetOpen() || d.source === 'sync') render(); else setTimeout(() => { if (!sheetOpen()) render(); }, 380);
    if (d.source !== 'sync') scheduleSync();
  });
  on('cloud', () => { renderSyncDot(); if (ui.tab === 'more' && !sheetOpen() && !/INPUT|SELECT/.test(document.activeElement && document.activeElement.tagName)) render(); });
  on('account', () => { if (!ui.profile) return; applyUser(account.user); ui.profile = profileFromAccount(); render(); });
  on('budgets', () => render());
  on('prefs', () => render());
  on('toast', (t) => toast(t.msg, { tone: t.tone, duration: t.duration }));
  on('signed-out', () => { if (!ui.profile) return; closeSheet(); cancelTimers(); renderSyncDot(); showGate('relogin', { email: account.email }); });

  // sync when coming back to the app or back online
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ui.profile && signedIn()) syncNow(false);
  });
  window.addEventListener('online', () => { if (ui.profile && signedIn()) syncNow(false); });
  setInterval(() => { if (ui.profile && signedIn() && document.visibilityState === 'visible') syncNow(false); }, 120000);

  // Shared from another app (Android: long-press a bank SMS → Share → Smart Spend).
  const sp = new URLSearchParams(location.search);
  const shared = ['share_title', 'share_text', 'share_url'].map((k) => sp.get(k) || '').filter(Boolean).join('\n').trim();
  if (shared) {
    history.replaceState(null, '', location.pathname + '#home');
    try { sessionStorage.setItem('ss3.share', shared.slice(0, 5000)); } catch (e) { /* private mode */ }
  }

  if (loadSession()) enter(false);
  else if (account.email || lastSignedOutWithData()) showGate('relogin');
  else showGate('welcome');
}

/** The session ended on its own (not a log out) and this device still holds that account's entries. */
function lastSignedOutWithData() {
  try { const d = JSON.parse(localStorage.getItem('ss3.auth') || 'null'); return !!(d && d.email && !d.token); } catch (e) { return false; }
}

boot();
