// Bottom sheets: quick add, edit, budgets, restore, currency, password, recovery code, help.

import { $, esc, plural, fmtDate, fromISO, round2, haptic, todayISO, MONTHS_FULL, pad } from './core.js';
import { CATEGORIES, catOf } from './categories.js';
import { parseInput } from './parser.js';
import {
  state, addItems, updateTxn, deleteTxn, restoreSnapshot, getBudgets, setBudget, readBackup, applyBackup
} from './ledger.js';
import { account, updateAccount, changePassword, newRecoveryCode, deleteAccount, MIN_PASSWORD } from './auth.js';
import { cur, CURRENCIES, currencyInfo, suggestedRate, fmtMoney } from './currency.js';
import { ui } from './appstate.js';
import { icon, catIcon, openSheet, updateSheet, closeSheet, toast, money, moneyAlt, armed, prefs } from './ui.js';
import { examplePhrases } from './views.js';

const EXPENSE_CATS = CATEGORIES.filter((c) => c.id !== 'Salary' && c.id !== 'Freelance');

/* ============================== QUICK ADD ============================== */

let qa = null;

function catChips(selected) {
  return '<div class="chips" role="group" aria-label="Category">' +
    '<button class="chip auto" data-qa="cat" data-cat="" aria-pressed="' + !selected + '">' + icon('spark') + 'Auto</button>' +
    CATEGORIES.map((c) => '<button class="chip" data-qa="cat" data-cat="' + c.id + '" style="--cat:' + c.color + '" aria-pressed="' + (selected === c.id) + '"><i></i>' + esc(c.label) + '</button>').join('') + '</div>';
}

function qaCtx() {
  const d = fromISO(qa.date);
  return { anchor: qa.date, refYear: d.getFullYear(), refMonth: d.getMonth(), forced: qa.forced, rate: state.rate, learned: state.learned };
}

function qaPreview() {
  const box = $('#qaPreview');
  if (!box) return;
  const text = $('#qaText').value;
  if (!text.trim()) { box.innerHTML = ''; qa.items = []; syncQaButton(); return; }
  const res = parseInput(text, qaCtx());
  qa.items = res.items;
  let html = '<div class="pv-h">' + (res.items.length ? 'Will add ' + plural(res.items.length, 'entry', 'entries') : 'Add an amount, like “coffee 12”') + '</div>';
  html += res.items.map((it) => {
    const c = catOf(it.category);
    const when = dateLabel(it.date) + (it.dated ? ' · from your text' : '');
    const note = it.forced ? 'your pick' : it.catSource === 'learned' ? 'learned' : it.catSource === 'typo' ? it.catHint : '';
    return '<div class="pv-item">' + catIcon(it.category) +
      '<div style="min-width:0"><div class="pv-t">' + esc(it.title) + '</div><div class="pv-m"><span>' + esc(c.label) + (note ? ' · ' + esc(note) : '') + '</span><span>' + esc(when) + '</span>' +
      (it.currency ? '<span class="note">' + esc(fmtMoney(it.original, it.currency)) + ' converted</span>' : '') +
      (it.foreign ? '<span class="note">' + esc(it.foreign) + ' isn’t converted; recorded as ' + esc(cur.base) + '</span>' : '') +
      (it.product ? '<span class="note">' + it.product.qty + ' × ' + esc(String(it.product.unit)) + '</span>' : '') + '</div></div>' +
      '<div class="pv-a num ' + (it.type === 'in' ? 'in-c' : '') + '">' + (it.type === 'in' ? '+' : '−') + esc(money(it.amount).replace(/^−/, '')) + '<small>' + esc(moneyAlt(it.amount)) + '</small></div></div>';
  }).join('');
  if (res.skipped.length) html += '<div class="pv-skip">No amount found in: ' + res.skipped.map((s) => '“' + esc(s) + '”').join(', ') + '</div>';
  if (res.budgets && res.budgets.length) html += '<div class="pv-skip">Not added, because a budget isn’t money spent: ' + res.budgets.map((s) => '“' + esc(s) + '”').join(', ') + '. To set one, go to Insights → Budgets.</div>';
  box.innerHTML = html;
  syncQaButton();
}
function syncQaButton() {
  const b = document.querySelector('[data-qa="save"]');
  if (b) { b.disabled = !qa.items.length; b.textContent = qa.items.length > 1 ? 'Add ' + qa.items.length + ' entries' : 'Add entry'; }
}
function dateLabel(iso) { return iso === todayISO() ? 'Today' : fmtDate(iso); }
function yesterdayISO() { const d = fromISO(todayISO()); d.setDate(d.getDate() - 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dateRow() {
  const t = todayISO(), y = yesterdayISO(), custom = qa.date !== t && qa.date !== y;
  return '<div class="qa-date" role="group" aria-label="Date">' +
    '<button type="button" data-qa="d-set" data-d="' + t + '" aria-pressed="' + (qa.date === t) + '">Today</button>' +
    '<button type="button" data-qa="d-set" data-d="' + y + '" aria-pressed="' + (qa.date === y) + '">Yesterday</button>' +
    '<label class="pick" aria-pressed="' + custom + '">' + icon('activity') + '<span>' + (custom ? esc(fmtDate(qa.date)) : 'Pick a date') + '</span>' +
    '<input type="date" id="qaDate" value="' + qa.date + '" aria-label="Pick a date"></label></div>';
}
function setQaDate(iso) { qa.date = iso; $('#qaDateRow').innerHTML = dateRow(); qaPreview(); }

export function openQuickAdd(prefill) {
  qa = { date: ui.selected, forced: null, items: [], timer: null };
  const body =
    '<label class="sr" for="qaText">What happened?</label>' +
    '<textarea class="input" id="qaText" data-autofocus rows="3" placeholder="e.g. ' + esc(examplePhrases()[0].text) + '" autocomplete="off" spellcheck="false">' + esc(prefill || '') + '</textarea>' +
    '<div class="examples">' + examplePhrases().map((e) => '<button data-qa="ex" data-ex="' + esc(e.text) + '">' + esc(e.text) + '</button>').join('') + '</div>' +
    '<div class="field-lbl">Date</div><div id="qaDateRow">' + dateRow() + '</div>' +
    '<p class="help" style="margin:6px 0 12px">A date you type, like “24th sep” or “yesterday”, still wins for that entry.</p>' +
    '<div class="field-lbl">Category</div>' +
    '<div id="qaCats">' + catChips(null) + '</div>' +
    '<div class="pv" id="qaPreview" aria-live="polite"></div>';
  openSheet({
    title: 'Add entry', body, focusOnTouch: true,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-qa="save" disabled>Add entry</button>',
    onOpen: () => { if (prefill) qaPreview(); },
    input: (e) => {
      if (e.target.id === 'qaText') { clearTimeout(qa.timer); qa.timer = setTimeout(qaPreview, 110); }
    },
    change: (e) => {
      if (e.target.id === 'qaDate' && e.target.value) setQaDate(e.target.value);
    },
    click: (e, t) => {
      const pick = t.closest('.qa-date .pick');
      if (pick && t.tagName !== 'INPUT') { const inp = $('#qaDate'); try { inp.showPicker(); } catch (err) { inp.focus(); } return; }
      const b = t.closest('[data-qa]');
      if (!b) return;
      const act = b.getAttribute('data-qa');
      if (act === 'ex') { $('#qaText').value = b.getAttribute('data-ex'); qaPreview(); }
      else if (act === 'd-set') setQaDate(b.getAttribute('data-d'));
      else if (act === 'cat') { const c = b.getAttribute('data-cat') || null; qa.forced = qa.forced === c ? null : c; $('#qaCats').innerHTML = catChips(qa.forced); qaPreview(); }
      else if (act === 'save') saveQuick();
    }
  });
  $('#qaText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveQuick(); } });
}

function saveQuick() {
  if (!qa || !qa.items.length) return;
  const snapBefore = { txns: state.txns.map((t) => Object.assign({}, t)), rate: state.rate, sample: state.sample, learned: JSON.parse(JSON.stringify(state.learned)) };
  const added = addItems(qa.items);
  added.forEach((t) => { ui.flash[t.id] = true; });
  haptic(12);
  closeSheet();
  const other = [...new Set(added.map((t) => t.date))].filter((d) => d !== ui.selected);
  toast('Added ' + plural(added.length, 'entry', 'entries') + (other.length === 1 ? ' · ' + fmtDate(other[0]) : ''), {
    tone: 'ok', actionLabel: 'Undo', onAction: () => { restoreSnapshot(snapBefore); toast('Removed'); }
  });
}

/* ================================ EDIT ================================ */

export function openEdit(id) {
  const t = state.txns.find((x) => x.id === id);
  if (!t) return;
  let type = t.type;
  const body = '<form class="form" id="editForm" novalidate>' +
    '<label class="field">Description<input class="input" id="edTitle" maxlength="120" value="' + esc(t.title) + '" autocomplete="off"></label>' +
    '<div class="row-2"><label class="field">Amount (' + cur.base + ')<input class="input num" id="edAmt" type="number" inputmode="decimal" step="0.01" min="0.01" value="' + t.amount + '"><span class="help num" id="edInr">' + (cur.alt ? '≈ ' + esc(moneyAlt(t.amount)) : '') + '</span></label>' +
    '<label class="field">Date<input class="input" id="edDate" type="date" value="' + t.date + '"></label></div>' +
    '<div class="field">Type<div class="flow" id="edFlow"><button type="button" data-type="in" aria-pressed="' + (type === 'in') + '">' + icon('arrowIn') + 'Money in</button><button type="button" data-type="out" aria-pressed="' + (type === 'out') + '">' + icon('arrowOut') + 'Money out</button></div></div>' +
    '<label class="field">Category<select class="input" id="edCat">' + CATEGORIES.map((c) => '<option value="' + c.id + '"' + (c.id === t.category ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') + '</select></label>' +
    '<div class="msg" id="edMsg" role="alert"></div></form>';
  openSheet({
    title: 'Edit entry', body,
    foot: '<button class="btn danger" data-ed="delete">' + icon('trash') + 'Delete</button><button class="btn primary" data-ed="save">Save</button>',
    input: (e) => { if (e.target.id === 'edAmt' && cur.alt) { const v = parseFloat(e.target.value); $('#edInr').textContent = v > 0 ? '≈ ' + moneyAlt(v) : ''; } },
    submit: () => save(),
    click: (e, b) => {
      const f = b.closest('#edFlow [data-type]');
      if (f) { type = f.getAttribute('data-type'); document.querySelectorAll('#edFlow [data-type]').forEach((x) => x.setAttribute('aria-pressed', String(x === f))); return; }
      const a = b.closest('[data-ed]');
      if (!a) return;
      if (a.getAttribute('data-ed') === 'save') save();
      if (a.getAttribute('data-ed') === 'delete' && armed(a)) { closeSheet(); removeWithUndo(t.id); }
    }
  });
  function save() {
    const title = $('#edTitle').value.replace(/\s+/g, ' ').trim(), amount = round2(parseFloat($('#edAmt').value)), date = $('#edDate').value;
    const errs = [];
    $('#edTitle').classList.toggle('bad', !title); if (!title) errs.push('a description');
    const badAmt = !(amount > 0 && amount <= 1e9); $('#edAmt').classList.toggle('bad', badAmt); if (badAmt) errs.push('an amount above 0');
    const badDate = !/^\d{4}-\d{2}-\d{2}$/.test(date); $('#edDate').classList.toggle('bad', badDate); if (badDate) errs.push('a date');
    if (errs.length) { $('#edMsg').textContent = 'Please enter ' + errs.join(', ') + '.'; return; }
    updateTxn(t.id, { title: title.slice(0, 120), amount, date, type, category: $('#edCat').value });
    ui.flash[t.id] = true;
    closeSheet();
    toast('Saved', { tone: 'ok' });
  }
}

export function removeWithUndo(id) {
  const r = deleteTxn(id);
  if (!r) return;
  haptic(18);
  const title = r.removed.title.length > 26 ? r.removed.title.slice(0, 25) + '…' : r.removed.title;
  toast('Deleted “' + title + '”', { actionLabel: 'Undo', onAction: () => { restoreSnapshot(r.snap); toast('Restored', { tone: 'ok' }); } });
}

/* =============================== BUDGETS =============================== */

export function openBudgets() {
  const b = getBudgets();
  const body = '<p class="help" style="margin:0 0 14px">Monthly limits in ' + cur.base + '. Leave a box empty for no limit. You’ll see a warning at 80% and when you go over.</p>' +
    '<form class="form" id="budForm" novalidate>' + EXPENSE_CATS.map((c) =>
      '<label class="field" style="flex-direction:row;align-items:center;gap:12px">' + catIcon(c.id) + '<span style="flex:1;color:var(--text);font-size:15px">' + esc(c.label) + '</span>' +
      '<input class="input num" style="width:130px;text-align:right" type="number" inputmode="decimal" min="0" step="1" data-bud="' + c.id + '" value="' + (b[c.id] || '') + '" placeholder="No limit" aria-label="' + esc(c.label) + ' budget"></label>').join('') + '</form>';
  openSheet({
    title: 'Budgets', body,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-bud-save>Save budgets</button>',
    submit: () => saveB(),
    click: (e, t) => { if (t.closest('[data-bud-save]')) saveB(); }
  });
  function saveB() {
    document.querySelectorAll('[data-bud]').forEach((inp) => setBudget(inp.getAttribute('data-bud'), inp.value));
    closeSheet();
    toast('Budgets saved', { tone: 'ok' });
  }
}

/* ================================ RESTORE ================================ */

/** A backup file was chosen: show what's in it, then replace the ledger on confirm. */
export function openRestore(fileText, fileName) {
  let data, r;
  try { data = JSON.parse(fileText); } catch (e) { toast('That file isn’t a Smart Spend backup (not valid JSON).', { tone: 'err' }); return; }
  if (data && data.format === 'smartspend-encrypted') { toast('That’s an encrypted backup from the older Smart Spend. Open it there and save a plain backup file instead.', { tone: 'err', duration: 8000 }); return; }
  r = readBackup(data);
  if (r.error) { toast(r.error, { tone: 'err' }); return; }
  const other = data.baseCurrency && data.baseCurrency !== cur.base;
  openSheet({
    title: 'Restore a backup',
    body: '<div class="set-group"><div class="set-row"><span class="set-ico">' + icon('activity') + '</span><span class="set-main"><b>' + plural(r.txns.length, 'entry', 'entries') + '</b><span>' +
      esc(fileName || 'Backup file') + (r.profile ? ' · saved by ' + esc(r.profile) : '') + (r.dropped ? ' · ' + r.dropped + ' unreadable skipped' : '') + '</span></span></div></div>' +
      (other ? '<div class="warnbox" style="margin-top:12px">This backup was recorded in <b>' + esc(data.baseCurrency) + '</b> and your account uses <b>' + esc(cur.base) + '</b>. The amounts are kept as they are, not converted.</div>' : '') +
      '<p class="help" style="margin-top:12px">Restoring replaces the ' + plural(state.txns.length, 'entry', 'entries') + ' in your account, on all your devices. You can undo right after.</p>',
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-rs="apply">Restore</button>',
    click: (e, t) => {
      if (!t.closest('[data-rs="apply"]')) return;
      if (other) r.rate = null;
      const snap = applyBackup(r);
      closeSheet();
      toast('Restored ' + plural(r.txns.length, 'entry', 'entries'), { tone: 'ok', actionLabel: 'Undo', onAction: () => { restoreSnapshot(snap); toast('Restore undone'); } });
    }
  });
}

/* =============================== CURRENCY =============================== */

function options(selected, none) {
  return (none ? '<option value="">None</option>' : '') + CURRENCIES.map((c) => '<option value="' + c.code + '"' + (c.code === selected ? ' selected' : '') + '>' + c.code + ' · ' + esc(c.name) + '</option>').join('');
}

export function openCurrencySettings() {
  const body = '<form class="form" id="curForm" novalidate>' +
    '<label class="field">Your currency<select class="input" id="csBase">' + options(cur.base) + '</select>' +
    '<span class="help">Amounts are recorded in this currency. Changing it keeps the numbers you already entered as they are.</span></label>' +
    '<label class="field">Also show amounts in<select class="input" id="csAlt">' + options(cur.alt || '', true) + '</select></label>' +
    '<div id="csRateRow"></div><div class="msg" id="csMsg" role="alert"></div></form>';
  openSheet({
    title: 'Currency', body,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-cs="save">Save</button>',
    onOpen: () => rateRow(),
    change: (e) => { if (e.target.id === 'csBase' || e.target.id === 'csAlt') rateRow(); },
    submit: () => save(),
    click: (e, t) => { if (t.closest('[data-cs="save"]')) save(); }
  });
  function rateRow() {
    const base = $('#csBase').value, alt = $('#csAlt').value, row = $('#csRateRow');
    if (!alt || alt === base) { row.innerHTML = ''; return; }
    const same = base === cur.base && alt === cur.alt;
    const old = $('#csRate');
    const v = old && old.dataset.pair === base + alt ? old.value : same ? state.rate : suggestedRate(base, alt);
    row.innerHTML = '<label class="field">Exchange rate<span class="rate-inline" style="justify-content:flex-start"><span class="muted">1 ' + base + ' =</span>' +
      '<input class="input num" id="csRate" data-pair="' + base + alt + '" type="number" inputmode="decimal" step="any" min="0" value="' + v + '" style="max-width:140px"><span class="muted">' + alt + '</span></span>' +
      (same ? '' : '<span class="help">A rough starting value; set the rate you use.</span>') + '</label>';
  }
  async function save() {
    const base = $('#csBase').value, alt = $('#csAlt').value && $('#csAlt').value !== base ? $('#csAlt').value : null;
    const rate = alt ? parseFloat($('#csRate').value) : null;
    if (alt && !(rate > 0)) { $('#csMsg').textContent = 'Enter the exchange rate.'; return; }
    const btn = document.querySelector('[data-cs="save"]');
    btn.disabled = true;
    try {
      const now = Date.now();
      await updateAccount({ currency: base, altCurrency: alt, rate, rateUpdatedAt: now });
      if (alt) { state.rate = rate; state.rateUpdatedAt = now; }
      closeSheet();
      toast('Currency saved · ' + base + (alt ? ' with ' + alt : ''), { tone: 'ok' });
    } catch (e) { btn.disabled = false; $('#csMsg').textContent = e.code === 'offline' ? 'You’re offline. Currency changes need a connection.' : e.message; }
  }
}

/* =============================== PASSWORD =============================== */

function pwField(id, label, ac) { return '<label class="field">' + label + '<input class="input" id="' + id + '" type="password" autocomplete="' + ac + '"></label>'; }

export function openChangePassword() {
  openSheet({
    title: 'Change password',
    body: '<form class="form" id="pwForm" novalidate>' + pwField('pwOld', 'Current password', 'current-password') + pwField('pwNew', 'New password', 'new-password') +
      '<p class="help" style="margin:0">At least ' + MIN_PASSWORD + ' characters. Your other devices will be logged out; log in there with the new password.</p><div class="msg" id="pwMsg" role="alert"></div></form>',
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-pw="save">Change password</button>',
    submit: () => save(),
    click: (e, t) => { if (t.closest('[data-pw="save"]')) save(); }
  });
  async function save() {
    const btn = document.querySelector('[data-pw="save"]');
    btn.disabled = true; $('#pwMsg').className = 'msg info'; $('#pwMsg').textContent = 'Changing…';
    try { await changePassword($('#pwOld').value, $('#pwNew').value); closeSheet(); toast('Password changed. Other devices were logged out.', { tone: 'ok' }); }
    catch (e) { btn.disabled = false; $('#pwMsg').className = 'msg'; $('#pwMsg').textContent = e.message; }
  }
}

export function openNewRecoveryCode() {
  openSheet({
    title: 'New recovery code',
    body: '<form class="form" id="rcForm" novalidate><p class="help" style="margin:0">A new code replaces the old one, which stops working. Enter your password to continue.</p>' +
      pwField('rcPass', 'Password', 'current-password') + '<div class="msg" id="rcMsg2" role="alert"></div></form>',
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-rc="go">Make a new code</button>',
    submit: () => go(),
    click: async (e, t) => {
      if (t.closest('[data-rc="go"]')) go();
      if (t.closest('[data-rc="copy"]')) {
        const code = $('#rcNew').textContent;
        try { await navigator.clipboard.writeText(code); toast('Copied', { tone: 'ok' }); } catch (err) { toast('Select the code and copy it.'); }
      }
    }
  });
  async function go() {
    const btn = document.querySelector('[data-rc="go"]');
    btn.disabled = true;
    try {
      const code = await newRecoveryCode($('#rcPass').value);
      updateSheet('<p class="help" style="margin:0 0 12px">Save this somewhere safe. It’s the only way to reset your password.</p><div class="rc-code mono" id="rcNew">' + esc(code) + '</div>',
        '<button class="btn" data-rc="copy">Copy</button><button class="btn primary" data-close>Done</button>');
    } catch (e) { btn.disabled = false; $('#rcMsg2').textContent = e.message; }
  }
}

export function openDeleteAccount(done) {
  openSheet({
    title: 'Delete account',
    body: '<div class="warnbox">This deletes your account and all ' + plural(state.txns.length, 'entry', 'entries') + ' from the server and this device. It can’t be undone. Save a backup file first if you might want them.</div>' +
      '<form class="form" id="daForm" novalidate style="margin-top:14px">' + pwField('daPass', 'Password', 'current-password') + '<div class="msg" id="daMsg" role="alert"></div></form>',
    foot: '<button class="btn" data-close>Cancel</button><button class="btn danger" data-da="go">Delete my account</button>',
    submit: () => {},
    click: (e, t) => { const b = t.closest('[data-da="go"]'); if (b && armed(b, 'Tap again to delete everything')) go(b); }
  });
  async function go(btn) {
    btn.disabled = true;
    try { await deleteAccount($('#daPass').value); closeSheet(); done(); }
    catch (e) { btn.disabled = false; $('#daMsg').textContent = e.message; }
  }
}

/* ================================= HELP ================================= */

export function openTypingHelp() {
  const b = currencyInfo(cur.base), a = cur.alt ? currencyInfo(cur.alt) : null;
  const rows = [
    ['Several things at once', examplePhrases()[0].text, 'Split on “and”, commas, new lines, “then”.'],
    ['Money in', examplePhrases()[1].text, 'Salary, received, got, refund, cashback, credited…'],
    ['Dates', 'dinner 85 last friday', 'today, yesterday, 3 days ago, last week, 24th sep, 24/09, sep 24 2026.'],
    ['A date for the whole line', 'on 24th sep: taxi 30, lunch 45', 'The first date carries to the rest of the line.'],
    ['Quantity × price', examplePhrases()[3].text, 'Also “2 coffees @ 15” and “3 shirts 40 each”.'],
    ['Words and shorthand', 'rent 2.5k', '2.5k, 1 lakh, “fifty”, Arabic digits (٤٥٠) all work.'],
    ['Categories', 'uber 30', 'Hundreds of shop and brand names (Uber, Netflix, Carrefour, Swiggy…); a typo like “resturant” still matches.'],
    ['It learns', 'pick a category once', 'Change a category and similar entries get it next time.']
  ];
  if (a) rows.splice(5, 0, ['Your second currency', a.symbol.trim() + '500 recharge', 'Converted to ' + b.code + ' at 1 ' + b.code + ' = ' + state.rate + ' ' + a.code + '.']);
  openSheet({
    title: 'What can I type?',
    body: '<p class="help" style="margin:0 0 14px;font-size:14px">Write it the way you’d text a friend. You always see a preview before anything is saved.</p>' +
      '<div class="help-list">' + rows.map((r) => '<div class="hl"><b>' + esc(r[0]) + '</b><button class="ex-chip" data-th="' + esc(r[1]) + '">' + esc(r[1]) + '</button><span>' + esc(r[2]) + '</span></div>').join('') + '</div>' +
      '<p class="help" style="margin-top:14px">It doesn’t read receipts or bank messages, and it works best in English.</p>',
    foot: '<button class="btn primary" data-close>Got it</button>',
    click: (e, t) => { const x = t.closest('[data-th]'); if (x && /\d/.test(x.getAttribute('data-th'))) { closeSheet(); setTimeout(() => openQuickAdd(x.getAttribute('data-th')), 320); } }
  });
}

export function openInstallHelp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(navigator.userAgent);
  const steps = {
    android: ['Open Smart Spend in <b>Chrome</b>.', 'Tap the <b>⋮</b> menu at the top right.', 'Tap <b>Add to Home screen</b> (or <b>Install app</b>).', 'Choose <b>Install</b>, not <b>Create shortcut</b>, and confirm. Only Install opens it full screen like an app.'],
    ios: ['Open Smart Spend in <b>Safari</b>.', 'Tap the <b>Share</b> button.', 'Tap <b>Add to Home Screen</b>, then <b>Add</b>.'],
    desktop: ['In Chrome or Edge, click the install icon at the right of the address bar.', 'Or open the browser menu and choose <b>Install Smart Spend</b>.']
  };
  const block = (title, list, first) => '<div class="card" style="padding:14px 16px;margin-bottom:10px' + (first ? ';border-color:var(--accent)' : '') + '"><b>' + title + '</b><ol style="margin:8px 0 0;padding-left:20px;line-height:1.6">' + list.map((x) => '<li>' + x + '</li>').join('') + '</ol></div>';
  const order = ios ? ['ios', 'android', 'desktop'] : android ? ['android', 'ios', 'desktop'] : ['desktop', 'android', 'ios'];
  const names = { android: 'Android', ios: 'iPhone and iPad', desktop: 'Computer' };
  openSheet({
    title: 'Add to your home screen',
    body: '<p class="help" style="margin:0 0 14px;font-size:14px">Smart Spend then opens full screen from its own icon, like any app, and works offline.</p>' +
      order.map((k, i) => block(names[k], steps[k], i === 0)).join(''),
    foot: '<button class="btn primary" data-close>Done</button>'
  });
}
