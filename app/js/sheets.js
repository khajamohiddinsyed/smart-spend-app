// Bottom sheets: quick add, edit, budgets, restore, currency, password, recovery code, help.

import { $, esc, plural, fmtDate, fromISO, round2, haptic, todayISO, MONTHS_FULL, pad, emit } from './core.js';
import { CATEGORIES, catOf, customCategories, detectCategory } from './categories.js';
import { parseInput } from './parser.js';
import {
  state, addItems, updateTxn, deleteTxn, restoreSnapshot, getBudgets, writeBudgets, readBackup, applyBackup, cleanAccount, knownAccounts, recategorize
} from './ledger.js';
import { account, api, signedIn, updateAccount, changePassword, newRecoveryCode, deleteAccount, MIN_PASSWORD,
  adminUnlock, adminUsers, adminEntries, adminReset, adminSetRole, adminDeleteUser, userColor } from './auth.js';
import { cur, CURRENCIES, currencyInfo, suggestedRate, fmtMoney } from './currency.js';
import { ui } from './appstate.js';
import { icon, catIcon, openSheet, updateSheet, closeSheet, toast, money, moneyAlt, armed, prefs } from './ui.js';
import { examplePhrases } from './views.js';
import { parseQuestionLocal, runQuery, describeSpec, periodRange } from './ask.js';

const expenseCats = () => CATEGORIES.filter((c) => c.id !== 'Salary' && c.id !== 'Freelance');

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
  const ai = qa.ai && qa.ai.text === text && qa.ai.res ? qa.ai.res : null;
  const res = ai || parseInput(text, qaCtx());
  if (!ai && qa.ai && qa.ai.text !== text) qa.ai = null;               // the text changed: back to the rules
  // A bank message pasted twice, or one already added, would count the same money twice.
  res.items.forEach((it) => {
    it.dup = !!(it.bank || it.account) && state.txns.some((t) => t.date === it.date && t.type === it.type && Math.abs(t.amount - it.amount) < 0.005 && (t.account || '') === (it.account || ''));
  });
  const seen = {};
  res.items.forEach((it) => { if (!it.bank && !it.account) return; const k = [it.date, it.type, it.amount, it.account].join('|'); if (seen[k]) it.dup = true; seen[k] = 1; });
  qa.items = res.items.filter((it) => !it.dup);
  const dups = res.items.length - qa.items.length;
  let html = '<div class="pv-h">' + (qa.items.length ? 'Will add ' + plural(qa.items.length, 'entry', 'entries') : dups ? 'Nothing new to add' : 'Add an amount, like “coffee 12”') + '</div>';
  html += res.items.map((it) => {
    const c = catOf(it.category);
    const when = dateLabel(it.date) + (it.bank ? ' · from the message' : it.dated ? ' · from your text' : '');
    const note = it.forced ? 'your pick' : it.catSource === 'ai' ? '✨ AI' : it.catSource === 'learned' ? 'learned' : it.catSource === 'typo' ? it.catHint : '';
    return '<div class="pv-item' + (it.dup ? ' dup' : '') + '">' + catIcon(it.category) +
      '<div style="min-width:0"><div class="pv-t">' + esc(it.title) + '</div><div class="pv-m"><span>' + esc(c.label) + (note ? ' · ' + esc(note) : '') + '</span><span>' + esc(when) + '</span>' +
      (it.currency ? '<span class="note">' + esc(fmtMoney(it.original, it.currency)) + ' converted</span>' : '') +
      (it.foreign ? '<span class="note">' + esc(it.foreign) + ' isn’t converted; recorded as ' + esc(cur.base) + '</span>' : '') +
      (it.product ? '<span class="note">' + it.product.qty + ' × ' + esc(String(it.product.unit)) + '</span>' : '') +
      (it.account ? '<span class="note acct">' + esc(it.account) + '</span>' : '') +
      (it.dup ? '<span class="note">Already added · skipped</span>' : '') + '</div></div>' +
      '<div class="pv-a num ' + (it.type === 'in' ? 'in-c' : '') + '">' + (it.type === 'in' ? '+' : '−') + esc(money(it.amount).replace(/^−/, '')) + '<small>' + esc(moneyAlt(it.amount)) + '</small></div></div>';
  }).join('');
  if (res.skipped.length) html += '<div class="pv-skip">No amount found in: ' + res.skipped.map((s) => '“' + esc(s) + '”').join(', ') + '</div>';
  if (res.budgets && res.budgets.length) html += '<div class="pv-skip">Not added, because a budget isn’t money spent: ' + res.budgets.map((s) => '“' + esc(s) + '”').join(', ') + '. To set one, go to Insights → Budgets.</div>';
  html += aiBar(text, res, !!ai);
  box.innerHTML = html;
  syncQaButton();
}
/* ---------- ✨ AI check: the fallback when the rules are unsure ---------- */

function rulesUnsure(res) {
  return !res.items.length || res.skipped.length > 0 || res.items.some((it) => !it.forced && it.category === 'General');
}
function aiBar(text, res, isAi) {
  if (!signedIn() || !/\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred)\b/i.test(text)) return '';
  if (qa.ai && qa.ai.status === 'loading') return '<div class="ai-bar"><button class="btn sm" disabled>✨ Checking with AI…</button></div>';
  if (isAi) return '<div class="ai-bar"><span class="help">✨ Suggested by AI. Check it before adding.</span><button class="link" data-qa="ai-undo">Use the regular preview</button></div>';
  const err = qa.ai && qa.ai.status === 'error' ? '<span class="help ai-err">' + esc(qa.ai.error) + '</span>' : '';
  const unsure = rulesUnsure(res);
  return '<div class="ai-bar' + (unsure ? ' unsure' : '') + '"><button class="btn sm' + (unsure ? ' primary' : '') + '" data-qa="ai">✨ ' + (unsure ? 'Check with AI' : 'Not right? Check with AI') + '</button>' +
    (unsure ? '<span class="help">Not sure about some of this. AI can take a second look.</span>' : '') + err + '</div>';
}

async function aiCheck() {
  const text = $('#qaText').value.trim();
  if (!text) return;
  const rules = parseInput(text, qaCtx());
  qa.ai = { text: $('#qaText').value, status: 'loading' };
  qaPreview();
  try {
    const r = await api('POST', '/api/ai/parse', { text, today: todayISO() });
    if (!qa.ai || qa.ai.text !== $('#qaText').value) return;          // edited meanwhile
    const items = (r.entries || []).map((e) => {
      const inAlt = e.currency && e.currency === cur.alt && state.rate > 0;
      const foreign = e.currency && e.currency !== cur.base && !inAlt ? e.currency : null;
      const amount = round2(inAlt ? e.amount / state.rate : e.amount);
      // Keep what the rules know for certain from bank messages: the account or card.
      const twin = rules.items.find((it) => it.account && (Math.abs(it.original - e.amount) < 0.005 || Math.abs(it.amount - amount) < 0.005));
      const forced = qa.forced;
      // A bank message is read exactly by the rules (amount, in or out, date, account); the AI
      // only gets a say in the category. Small models misread "…; VendingSoftware credited" as money in.
      if (twin) return Object.assign({}, twin, { category: forced || e.category, aiCategory: e.category, forced: !!forced, catSource: forced ? 'forced' : 'ai' });
      // Where the rules placed the same amount through a keyword (including your own category's
      // words) or something you taught them, keep that category; AI decides the ones they couldn't.
      const same = rules.items.find((it) => Math.abs(it.amount - amount) < 0.005 && it.type === e.type);
      const sure = same && same.category !== 'General' && /keyword|learned|forced/.test(same.catSource || '') ? same.category : null;
      const category = forced || sure || e.category;
      return {
        title: e.title || catOf(e.category).label, amount, type: e.type, category, aiCategory: sure || e.category, date: e.date,
        currency: inAlt ? e.currency : null, original: e.amount, foreign, product: null,
        forced: !!forced, catSource: forced ? 'forced' : sure ? same.catSource : 'ai', dated: e.date !== qa.date, account: twin ? twin.account : undefined, bank: !!twin
      };
    });
    if (!items.length) { qa.ai = { text: qa.ai.text, status: 'error', error: 'AI didn’t find any amounts either. Try writing it as “item amount”, like “lunch 25”.' }; qaPreview(); return; }
    qa.ai = { text: qa.ai.text, status: 'done', res: { items, skipped: [], budgets: [] } };
  } catch (e) {
    qa.ai = { text: qa.ai ? qa.ai.text : text, status: 'error', error: e.code === 'offline' ? 'You’re offline. AI checks need a connection.' : e.message };
  }
  qaPreview();
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
      else if (act === 'cat') {
        const c = b.getAttribute('data-cat') || null; qa.forced = qa.forced === c ? null : c; $('#qaCats').innerHTML = catChips(qa.forced);
        if (qa.ai && qa.ai.res) qa.ai.res.items.forEach((it) => { it.category = qa.forced || it.aiCategory; it.forced = !!qa.forced; it.catSource = qa.forced ? 'forced' : 'ai'; });
        qaPreview();
      }
      else if (act === 'save') saveQuick();
      else if (act === 'ai') aiCheck();
      else if (act === 'ai-undo') { qa.ai = null; qaPreview(); }
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
    '<label class="field">Account or card <span class="dim">(optional)</span><input class="input" id="edAcct" maxlength="40" list="acctList" value="' + esc(t.account || '') + '" placeholder="e.g. HDFC Card 8432" autocomplete="off">' +
    '<datalist id="acctList">' + knownAccounts().map((a) => '<option value="' + esc(a) + '">').join('') + '</datalist><span class="help">Include “Card” for a credit card, so it’s counted as card spending.</span></label>' +
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
    const acct = cleanAccount($('#edAcct').value);
    updateTxn(t.id, { title: title.slice(0, 120), amount, date, type, category: $('#edCat').value, account: acct || undefined });
    if (!acct) delete t.account;
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
    '<form class="form" id="budForm" novalidate>' + expenseCats().map((c) =>
      '<label class="field" style="flex-direction:row;align-items:center;gap:12px">' + catIcon(c.id) + '<span style="flex:1;color:var(--text);font-size:15px">' + esc(c.label) + '</span>' +
      '<input class="input num" style="width:130px;text-align:right" type="number" inputmode="decimal" min="0" step="1" data-bud="' + c.id + '" value="' + (b[c.id] || '') + '" placeholder="No limit" aria-label="' + esc(c.label) + ' budget"></label>').join('') + '</form>';
  openSheet({
    title: 'Budgets', body,
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-bud-save>Save budgets</button>',
    submit: () => saveB(),
    click: (e, t) => { if (t.closest('[data-bud-save]')) saveB(); }
  });
  async function saveB() {
    const next = {};
    document.querySelectorAll('[data-bud]').forEach((inp) => { const v = Number(inp.value); if (v > 0) next[inp.getAttribute('data-bud')] = round2(v); });
    const btn = document.querySelector('[data-bud-save]'); btn.disabled = true;
    try {
      await updateAccount({ budgets: next });
      writeBudgets(next);
      closeSheet();
      toast('Budgets saved', { tone: 'ok' });
    } catch (e) { btn.disabled = false; toast(e.code === 'offline' ? 'You’re offline. Budgets are saved to your account, so this needs a connection.' : e.message, { tone: 'err' }); }
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
    ['It learns', 'pick a category once', 'Change a category and similar entries get it next time.'],
    ['✨ AI second look', 'tap “Check with AI”', 'When the preview isn’t sure (for example an entry lands in General), AI reads your text again and suggests entries, using your own categories too. You still check and tap Add. It needs a connection; up to 40 checks a day.'],
    ['Your own categories', 'Settings → Categories', 'Add categories like Travel or Kids with words that belong to them (trip, hotel…). Entries with those words go there automatically.'],
    ['Bank and card messages', 'paste your bank SMS', 'Copy one or several bank or card SMS and paste them. Each becomes an entry with the amount, who it went to, the date and the account or card. Balances are ignored, and a message you already added is skipped.']
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

/* ============================== CATEGORIES ============================== */

const EMOJI_IDEAS = ['✈️', '🏠', '🏋️', '🎓', '🐾', '🎁', '👶', '💄', '🎮', '🕌', '🚗', '💼', '🧾', '📱', '🍼', '💊'];
const newCatId = () => 'c_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const splitWords = (v) => String(v || '').split(/[,\n]/).map((w) => w.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean).slice(0, 20);

/** Your own categories: add, rename, set their words, delete. Saved to the account, so every device gets them. */
export function openCategories(editId) {
  const mine = customCategories();
  const editing = editId === 'new' ? { id: null, label: '', emoji: EMOJI_IDEAS[mine.length % EMOJI_IDEAS.length], words: [] } : mine.find((c) => c.id === editId);
  let body, foot;
  if (editing) {
    body = '<form class="form" id="catForm" novalidate>' +
      '<div class="row-2" style="grid-template-columns:88px 1fr"><label class="field">Emoji<input class="input" id="cfEmoji" maxlength="8" value="' + esc(editing.emoji) + '" style="text-align:center;font-size:22px"></label>' +
      '<label class="field">Name<input class="input" id="cfName" maxlength="24" value="' + esc(editing.label) + '" placeholder="e.g. Travel" data-autofocus autocomplete="off"></label></div>' +
      '<div class="chips emoji-ideas">' + EMOJI_IDEAS.map((e) => '<button type="button" class="chip" data-cat-emoji="' + e + '">' + e + '</button>').join('') + '</div>' +
      '<label class="field">Words that mean this category <span class="dim">(optional)</span><textarea class="input" id="cfWords" rows="2" placeholder="trip, hotel, flight, visa">' + esc((editing.words || []).join(', ')) + '</textarea>' +
      '<span class="help">Separate with commas. Entries with these words, or the name itself, go here automatically.</span></label>' +
      '<div class="msg" id="cfMsg" role="alert"></div></form>';
    foot = (editing.id ? '<button class="btn danger" data-cat-act="delete">' + icon('trash') + 'Delete</button>' : '<button class="btn" data-cat-act="back">Back</button>') +
      '<button class="btn primary" data-cat-act="save">' + (editing.id ? 'Save' : 'Add category') + '</button>';
  } else {
    const builtIn = CATEGORIES.filter((c) => !c.custom);
    body = '<p class="help" style="margin:0 0 14px;font-size:14px">Add your own categories, like Travel, Rent or Kids. They work everywhere the built-in ones do and sync to all your devices.</p>' +
      '<div class="section-label" style="margin-top:0">Yours</div>' +
      (mine.length ? '<div class="set-group">' + mine.map((c) => '<button class="set-row" data-cat-edit="' + c.id + '">' + catIcon(c.id) +
        '<span class="set-main"><b>' + esc(c.label) + '</b><span>' + (c.words && c.words.length ? esc(c.words.join(', ')) : 'No extra words') + '</span></span><span class="chev">' + icon('next') + '</span></button>').join('') + '</div>'
        : '<div class="empty" style="padding:18px">None yet.</div>') +
      '<button class="btn block" style="margin-top:12px" data-cat-act="new">' + icon('plus') + 'Add a category</button>' +
      '<div class="section-label">Built in</div><div class="chips" style="flex-wrap:wrap">' + builtIn.map((c) => '<span class="chip" style="--cat:' + c.color + '"><i></i>' + esc(c.label) + '</span>').join('') + '</div>';
    foot = '<button class="btn primary" data-close>Done</button>';
  }
  openSheet({
    title: editing ? (editing.id ? 'Edit category' : 'New category') : 'Categories', body, foot,
    submit: () => save(),
    click: (e, t) => {
      const ed = t.closest('[data-cat-edit]');
      if (ed) { openCategories(ed.getAttribute('data-cat-edit')); return; }
      const em = t.closest('[data-cat-emoji]');
      if (em) { $('#cfEmoji').value = em.getAttribute('data-cat-emoji'); return; }
      const b = t.closest('[data-cat-act]');
      if (!b) return;
      const a = b.getAttribute('data-cat-act');
      if (a === 'new') openCategories('new');
      if (a === 'back') openCategories();
      if (a === 'save') save();
      if (a === 'delete' && armed(b, 'Tap again to delete')) remove(b);
    }
  });
  const msg = (m) => { const el = $('#cfMsg'); if (el) el.textContent = m; };
  const plain = () => customCategories().map((c) => ({ id: c.id, label: c.label, emoji: c.emoji, words: c.words || [] }));
  async function save() {
    const label = $('#cfName').value.replace(/\s+/g, ' ').trim();
    if (!label) return msg('Give the category a name.');
    const clash = CATEGORIES.find((c) => c.label.toLowerCase() === label.toLowerCase() && c.id !== editing.id);
    if (clash) return msg('There’s already a category called ' + clash.label + '.');
    const next = plain();
    const item = { id: editing.id || newCatId(), label, emoji: $('#cfEmoji').value.trim() || '🏷️', words: splitWords($('#cfWords').value) };
    const i = next.findIndex((c) => c.id === item.id);
    if (i >= 0) next[i] = item; else next.push(item);
    const btn = document.querySelector('[data-cat-act="save"]'); btn.disabled = true;
    try { await updateAccount({ categories: next }); toast((editing.id ? 'Saved ' : 'Added ') + item.emoji + ' ' + label, { tone: 'ok' }); openCategories(); }
    catch (e) { btn.disabled = false; msg(e.code === 'offline' ? 'You’re offline. Categories are saved to your account, so this needs a connection.' : e.message); }
  }
  async function remove(btn) {
    btn.disabled = true;
    const id = editing.id;
    try {
      const budgets = getBudgets(); delete budgets[id];
      await updateAccount({ categories: plain().filter((c) => c.id !== id), budgets });
      const moved = recategorize(id, 'General');                         // nothing is lost: they move to General
      writeBudgets(budgets);
      toast('Deleted ' + editing.label + (moved ? ' · ' + plural(moved, 'entry', 'entries') + ' moved to General' : ''), { tone: 'ok' });
      openCategories();
    } catch (e) { btn.disabled = false; msg(e.code === 'offline' ? 'You’re offline. Try again when you’re connected.' : e.message); }
  }
}

/* =============================== ADMIN =============================== */

// A separate area for admins: manage accounts, nothing to do with the money UI.
// Opening it re-checks the admin's password; the server enforces admin on every call.
let adminPw = null;

export function openAdmin() {
  adminPw = null;
  openSheet({
    title: 'Admin', body: '<form class="form" id="admForm" novalidate><p class="help" style="margin:0">Enter your password to open the admin area.</p>' +
      '<input class="input" id="admPass" type="password" autocomplete="current-password" data-autofocus><div class="msg" id="admMsg" role="alert"></div></form>',
    foot: '<button class="btn" data-close>Cancel</button><button class="btn primary" data-adm="unlock">Continue</button>',
    submit: () => unlock(),
    click: (e, t) => { if (t.closest('[data-adm="unlock"]')) unlock(); }
  });
  async function unlock() {
    const pw = $('#admPass').value;
    if (!pw) return;
    const btn = document.querySelector('[data-adm="unlock"]'); btn.disabled = true;
    try { await adminUnlock(pw); adminPw = pw; adminList(); }
    catch (e) { btn.disabled = false; $('#admMsg').textContent = e.code === 'wrong_password' ? 'That password isn’t right.' : e.message; }
  }
}

function adminUserRow(u) {
  return '<button class="set-row" data-adm-user="' + esc(u.email) + '"><span class="av" style="width:36px;height:36px;font-size:15px;background:' + userColor(u.email) + '">' + esc((u.name || u.email).charAt(0).toUpperCase()) + '</span>' +
    '<span class="set-main"><b>' + esc(u.name) + (u.isAdmin ? ' <span class="tag-admin">admin</span>' : '') + (u.self ? ' <span class="dim">(you)</span>' : '') + '</b><span>' + esc(u.email) + ' · ' + u.entries + ' entries</span></span><span class="chev">' + icon('next') + '</span></button>';
}

async function adminList() {
  updateSheet('<div class="empty" style="padding:22px">Loading…</div>', '<button class="btn" data-close>Close</button>');
  let users;
  try { users = await adminUsers(); } catch (e) { updateSheet('<div class="empty" style="padding:22px">' + esc(e.message) + '</div>'); return; }
  const body = '<p class="help" style="margin:0 0 12px">' + plural(users.length, 'account') + '. Tap one to manage it.</p>' +
    '<div class="set-group">' + users.map(adminUserRow).join('') + '</div>' +
    '<p class="help" style="margin-top:12px">You can read entries, reset access, make someone an admin, or delete an account. Every action is logged.</p>';
  openSheet({
    title: 'Admin · accounts', body, foot: '<button class="btn" data-close>Close</button>',
    click: (e, t) => { const b = t.closest('[data-adm-user]'); if (b) adminUser(users.find((x) => x.email === b.getAttribute('data-adm-user'))); }
  });
}

function adminUser(u) {
  const row = (act, ico, title, sub, danger) => '<button class="set-row' + (danger ? ' danger' : '') + '" data-au="' + act + '"><span class="set-ico">' + icon(ico) + '</span><span class="set-main"><b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</span><span class="chev">' + icon('next') + '</span></button>';
  const body = '<button class="g-back" data-au="back">' + icon('back') + 'All accounts</button>' +
    '<div class="set-group" style="margin:10px 0"><div class="set-row"><span class="av" style="width:40px;height:40px;background:' + userColor(u.email) + '">' + esc((u.name || u.email).charAt(0).toUpperCase()) + '</span><span class="set-main"><b>' + esc(u.name) + '</b><span>' + esc(u.email) + '</span></span></div></div>' +
    '<div class="set-group">' + row('entries', 'activity', 'View entries', u.entries + ' entries') +
      row('reset', 'lock', 'Reset recovery code', 'Hand them a new code to get back in') +
      row('role', u.isAdmin ? 'lock' : 'spark', u.isAdmin ? 'Remove admin' : 'Make admin', u.self ? 'This is you' : '') +
      (u.self ? '' : row('delete', 'trash', 'Delete account', 'Removes the account and all entries', true)) + '</div>' +
    '<div class="msg" id="auMsg" role="alert"></div>';
  openSheet({
    title: esc(u.name), body, foot: '<button class="btn" data-adm="back">All accounts</button>',
    click: (e, t) => {
      if (t.closest('[data-adm="back"]') || t.closest('[data-au="back"]')) { adminList(); return; }
      const b = t.closest('[data-au]'); if (!b) return;
      const a = b.getAttribute('data-au');
      if (a === 'entries') adminViewEntries(u);
      if (a === 'reset') adminDo(u, b, () => adminReset(u.email, adminPw).then((code) =>
        updateSheet('<button class="g-back" data-au="back">' + icon('back') + 'All accounts</button><h3 style="margin:10px 0">New recovery code for ' + esc(u.name) + '</h3>' +
          '<p class="help">Send it privately. They open <b>Forgot your password?</b>, enter their email, this code and a new password.</p><div class="rc-code mono">' + esc(code) + '</div>', '<button class="btn primary" data-adm="back">Done</button>')));
      if (a === 'role') adminDo(u, b, () => adminSetRole(u.email, !u.isAdmin, adminPw).then(() => { toast((u.isAdmin ? 'Removed admin from ' : 'Made admin: ') + u.name, { tone: 'ok' }); adminList(); }));
      if (a === 'delete' && armed(b, 'Tap again to delete for good')) adminDo(u, b, () => adminDeleteUser(u.email, adminPw).then(() => { toast('Deleted ' + u.name, { tone: 'ok' }); adminList(); }));
    }
  });
}

async function adminDo(u, btn, fn) {
  btn.disabled = true;
  try { await fn(); }
  catch (e) { btn.disabled = false; const m = $('#auMsg'); if (m) m.textContent = e.code === 'wrong_password' ? 'Your password check expired. Reopen Admin.' : e.message; }
}

async function adminViewEntries(u) {
  updateSheet('<div class="empty" style="padding:22px">Loading ' + esc(u.name) + '’s entries…</div>', '<button class="btn" data-adm="back">Back</button>');
  let data;
  try { data = await adminEntries(u.id); } catch (e) { updateSheet('<div class="empty" style="padding:22px">' + esc(e.message) + '</div>'); return; }
  const rows = data.records.map((r) => '<div class="drop-row" style="cursor:default"><span class="dr-t">' + esc(r.title) + '</span><span class="dr-d">' + esc(catOf(r.category).label) + ' · ' + esc(r.date) + (r.account ? ' · ' + esc(r.account) : '') + '</span><span class="dr-a num">' + (r.type === 'in' ? '+' : '−') + esc(String(r.amount)) + '</span></div>').join('');
  openSheet({
    title: esc(u.name) + ' · entries',
    body: '<button class="g-back" data-adm-user="' + esc(u.email) + '">' + icon('back') + 'Back</button>' +
      '<p class="help" style="margin:10px 0">' + plural(data.records.length, 'entry', 'entries') + '. Amounts are in each account’s own currency.</p>' +
      (rows || '<div class="empty" style="padding:22px">No entries.</div>'),
    foot: '<button class="btn" data-close>Close</button>',
    click: (e, t) => { const b = t.closest('[data-adm-user]'); if (b) adminUser(u); }
  });
}

/* ============================== ASK ============================== */

// Ask a plain question about your own spending. Local parser first; AI only for unusual phrasing.
// The number is always computed from the ledger (ask.js), never by the AI.
export function openAsk(prefill) {
  const ex = askExamples();
  openSheet({
    title: 'Ask your spending',
    body: '<form class="form" id="askForm" novalidate><div class="ask-in"><input class="input" id="askQ" autocomplete="off" placeholder="e.g. how much on food & drinks this week?" value="' + esc(prefill || '') + '" data-autofocus>' +
      '<button class="btn primary" type="submit" id="askGo">' + icon('spark') + 'Ask</button></div>' +
      '<div class="examples">' + ex.map((e) => '<button type="button" data-ask-ex="' + esc(e) + '">' + esc(e) + '</button>').join('') + '</div>' +
      '<div id="askOut" aria-live="polite"></div></form>',
    submit: () => run(),
    click: (e, t) => { const x = t.closest('[data-ask-ex]'); if (x) { $('#askQ').value = x.getAttribute('data-ask-ex'); run(); } if (t.closest('[data-ask="all"]')) seeAll(); }
  });
  if (prefill) run();
  let lastSpec = null;
  function seeAll() {
    if (!lastSpec) return;
    ui.category = lastSpec.category || 'all'; ui.account = 'all'; ui.cardsOnly = !!lastSpec.cardOnly; ui.filter = lastSpec.metric === 'received' ? 'in' : lastSpec.metric === 'net' ? 'all' : 'out';
    ui.search = '';
    if (lastSpec.period === 'all') { ui.scope = 'all'; ui.rangeFrom = ui.rangeTo = null; }         // no odd 1900–9999 range
    else { const r = periodRange(lastSpec.period, lastSpec.from, lastSpec.to); ui.scope = 'range'; ui.rangeFrom = r.from; ui.rangeTo = r.to; }
    closeSheet(); emit('go-activity');
  }
  async function run() {
    const q = $('#askQ').value.trim();
    if (!q) return;
    const out = $('#askOut'); out.innerHTML = '<div class="ask-thinking">Working it out…</div>';
    let spec = parseQuestionLocal(q), viaAI = false;
    if (!spec) {
      if (!signedIn()) { out.innerHTML = '<div class="msg">Log in to ask questions.</div>'; return; }
      try { spec = (await api('POST', '/api/ai/ask', { question: q, today: todayISO() })).spec; viaAI = true; }
      catch (e) { out.innerHTML = '<div class="msg">' + esc(e.code === 'offline' ? 'You’re offline. Try a simpler question like “food this week”.' : e.message) + '</div>'; return; }
    }
    lastSpec = spec;
    const r = runQuery(spec);
    out.innerHTML = askAnswerHtml(r, viaAI);
  }
}

function askExamples() {
  const c = customCategories()[0];
  return ['How much on food & drinks this week?', 'What did I spend today?', 'Spending on cards this month', c ? 'How much on ' + c.label + ' this month?' : 'How much on groceries last month?', 'How much did I receive this month?'];
}

function askAnswerHtml(r, viaAI) {
  const s = r.spec;
  const value = r[s.metric === 'count' ? 'count' : s.metric];
  const what = describeSpec(s) || (s.metric === 'received' ? 'received' : s.metric === 'net' ? 'net' : 'spent');
  let head;
  if (s.metric === 'count') head = '<b>' + plural(value, 'entry', 'entries') + '</b> ' + esc(what);
  else {
    const verb = s.metric === 'received' ? 'received' : s.metric === 'net' ? 'net' : 'spent';
    head = 'You ' + verb + ' <b>' + esc(money(value)) + '</b> ' + esc(what);
  }
  const rows = r.rows.slice(0, 6).map((t) => '<button class="drop-row" data-act="drop-edit" data-id="' + esc(t.id) + '"><span class="dr-t">' + esc(t.title) + '</span><span class="dr-d">' + esc(catOf(t.category).label) + ' · ' + esc(t.date) + (t.account ? ' · ' + esc(t.account) : '') + '</span><span class="dr-a num">' + esc(money(t.amount)) + '</span></button>').join('');
  return '<div class="ask-answer"><div class="ask-head">' + head + '</div>' +
    (r.rows.length ? '<div class="ask-sub">' + plural(r.rows.length, 'entry', 'entries') + (r.rows.length > 6 ? ' · showing 6' : '') + '</div><div class="cat-drop" style="border:0">' + rows + '</div>' : '<div class="ask-sub">No matching entries.</div>') +
    (r.rows.length ? '<button class="btn sm block" data-ask="all">See all in Activity</button>' : '') +
    (viaAI ? '<div class="ask-ai">✨ Understood by AI</div>' : '') + '</div>';
}
