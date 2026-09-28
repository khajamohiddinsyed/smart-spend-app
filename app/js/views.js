// The four tabs. Each returns HTML (all user text escaped) plus an optional after() to draw charts.

import {
  esc, plural, MONTHS, MONTHS_FULL, DOW, todayISO, toISO, fromISO, fmtDayHeading, fmtDate, addMonths, daysInMonth,
  monthKey, round2, APP_VERSION, store
} from './core.js';
import { CATEGORIES, catOf, customCategories } from './categories.js';
import { state, inMonth, totals, categorySpend, monthlySeries, cumulativeSpend, sortedTxns, dayAggregates, getBudgets, knownAccounts, accountTotals, isCard } from './ledger.js';
import { describe } from './sync.js';
import { ui } from './appstate.js';
import { cur, currencyInfo, fmtMoney } from './currency.js';
import { icon, catIcon, avatar, money, moneyAlt, moneyCompact, signed, prefs, displayValue, showCode } from './ui.js';
import { isAdmin } from './auth.js';
import { inOutColumns, paceLines } from './charts.js';

const monthLabel = (y, m) => MONTHS_FULL[m] + ' ' + y;
const isThisMonth = (y, m) => { const t = fromISO(todayISO()); return t.getFullYear() === y && t.getMonth() === m; };

function monthSwitch() {
  const { y, m } = ui.month;
  return '<div class="month-switch">' +
    '<button data-act="month-prev" aria-label="Previous month">' + icon('back') + '</button>' +
    '<span>' + MONTHS[m] + ' ' + y + '</span>' +
    '<button data-act="month-next" aria-label="Next month"' + (isThisMonth(y, m) ? ' disabled style="opacity:.35"' : '') + '>' + icon('next') + '</button></div>';
}

const cardSpend = (list) => list.reduce((s, t) => s + (t.type === 'out' && isCard(t.account) ? t.amount : 0), 0);

function curToggle() {
  if (!cur.alt) return '';
  const on = showCode();
  return '<div class="cur-toggle" role="group" aria-label="Show amounts in">' +
    '<button data-act="cur" data-show="base" aria-pressed="' + (on === cur.base) + '">' + cur.base + '</button>' +
    '<button data-act="cur" data-show="alt" aria-pressed="' + (on === cur.alt) + '">' + cur.alt + '</button></div>';
}

/** Example phrases in the account's own currency, for the guide and the Add sheet. */
export function examplePhrases() {
  const c = currencyInfo(cur.base), k = c.perUsd / 3.75;
  const n = (v) => {                                   // keep the round numbers when the currency is close in value
    if (k > 0.5 && k < 2) return v;
    const x = v * k;
    return x >= 1000 ? Math.round(x / 100) * 100 : x >= 100 ? Math.round(x / 10) * 10 : Math.max(1, Math.round(x));
  };
  const list = [
    { text: 'spent ' + n(40) + ' on fuel and ' + n(18) + ' coffee', what: 'Two entries from one sentence, each with its own category.' },
    { text: 'salary ' + n(14500).toLocaleString('en-US') + ' credited', what: 'Words like salary, received or refund make it money in.' },
    { text: 'groceries ' + n(212) + ' yesterday', what: 'Dates in plain words: yesterday, last friday, 24th sep, 3 days ago.' },
    { text: '3 x ' + n(12) + ' movie tickets', what: 'Quantity × price is worked out for you.' }
  ];
  if (cur.alt) {
    const a = currencyInfo(cur.alt);
    const v = 5.7 * a.perUsd, amt = v >= 100 ? Math.round(v / 10) * 10 : Math.max(1, Math.round(v));
    list.push({ text: a.symbol.trim() + amt + ' phone recharge', what: 'Amounts in ' + a.code + ' are converted to ' + cur.base + ' at your rate.' });
  }
  return list;
}

export function rowHtml(t) {
  const c = catOf(t.category);
  return '<div class="row-wrap" data-wrap="' + esc(t.id) + '">' +
    '<div class="row-actions"><button data-act="row-del" data-id="' + esc(t.id) + '" aria-label="Delete ' + esc(t.title) + '">' + icon('trash') + 'Delete</button></div>' +
    '<button class="row ' + t.type + (ui.flash[t.id] ? ' flash' : '') + '" data-act="row-open" data-id="' + esc(t.id) + '">' +
    catIcon(t.category) +
    '<span class="row-main"><span class="row-title">' + esc(t.title) + '</span><span class="row-meta">' + esc(c.label) + ' · ' + esc(fmtDayHeading(t.date)) + (t.account ? ' · ' + (isCard(t.account) ? '💳 ' : '') + esc(t.account) : '') + '</span></span>' +
    '<span class="row-amt"><span class="p num">' + esc(signed(t.amount, t.type)) + '</span><span class="s num">' + esc(moneyAlt(t.amount)) + '</span></span>' +
    '</button></div>';
}

function budgetStates(y, m) {
  const b = getBudgets(), spent = {};
  categorySpend(inMonth(state.txns, y, m)).forEach((r) => { spent[r.id] = r.sum; });
  return Object.keys(b).map((id) => {
    const used = spent[id] || 0, pct = used / b[id];
    return { id, budget: b[id], used, pct, level: pct >= 1 ? 'over' : pct >= 0.8 ? 'near' : 'ok' };
  }).sort((a, b2) => b2.pct - a.pct);
}

/* ================================ HOME ================================ */

export function homeView() {
  const p = ui.profile, { y, m } = ui.month;
  const list = inMonth(state.txns, y, m), t = totals(list);
  let html = '';

  if (!state.txns.length) {
    const ex = examplePhrases();
    return {
      html: '<section class="hero onboard"><div class="hero-top"><span class="muted" style="font-weight:650">Welcome, ' + esc(p.name) + '</span></div>' +
        '<div class="hero-value" style="font-size:30px;margin-top:12px">Add your first entry</div>' +
        '<p class="hero-note" style="font-size:14px">No forms to fill in. Tell Smart Spend what happened, the way you’d text a friend.</p>' +
        '<ol class="steps">' +
        '<li><span class="n">1</span><div><b>Tap the + button</b><span>Or the “What did you spend or receive?” bar. Both open the same box.</span></div></li>' +
        '<li><span class="n">2</span><div><b>Type what happened</b><span>Like “' + esc(ex[0].text) + '”. Several things in one go are fine.</span></div></li>' +
        '<li><span class="n">3</span><div><b>Check the preview, then Add</b><span>You’ll see the amount, category and date before anything is saved. Tap a category to change it; Smart Spend learns from that.</span></div></li>' +
        '</ol>' +
        '<div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap"><button class="btn primary" data-act="quick">' + icon('plus') + 'Add your first entry</button>' +
        '<button class="btn" data-act="demo">' + icon('flask') + 'Try with sample data</button></div></section>' +
        '<section class="card"><div class="card-h"><div><h2>Try one of these</h2><div class="sub">Tap to open it in the Add box</div></div>' +
        '<button class="link" data-act="typing-help">What else can I type?</button></div><div class="ex-list">' +
        ex.map((e) => '<button class="ex" data-act="example" data-text="' + esc(e.text) + '"><span class="q">“' + esc(e.text) + '”</span><span class="w">' + esc(e.what) + '</span></button>').join('') +
        '</div></section>' + installBanner()
    };
  }

  const inPct = t.tin + t.tout > 0 ? (t.tin / (t.tin + t.tout)) * 100 : 50;
  const rate = t.tin > 0 ? Math.round((t.net / t.tin) * 100) : null;
  html += '<section class="hero" aria-label="This month">' +
    '<div class="hero-top">' + monthSwitch() +
    curToggle() + '</div>' +
    '<div class="hero-label">Net balance · ' + esc(monthLabel(y, m)) + '</div>' +
    '<div class="hero-value"' + (cur.alt ? ' data-act="cur-flip" title="Tap to switch currency"' : '') + '>' + esc((t.net > 0 ? '+' : '') + money(t.net)) + '</div>' +
    (cur.alt ? '<div class="hero-alt num">' + esc((t.net > 0 ? '+' : '') + moneyAlt(t.net)) + '</div>' : '') +
    '<div class="split-bar" aria-hidden="true"><i style="width:' + inPct.toFixed(1) + '%;background:var(--in)"></i><i style="flex:1;background:var(--out)"></i></div>' +
    '<div class="hero-split">' +
    '<div><span class="k"><i style="background:var(--in)"></i>Money in</span><span class="v num">' + esc(money(t.tin)) + '</span></div>' +
    '<div><span class="k"><i style="background:var(--out)"></i>Money out</span><span class="v num">' + esc(money(t.tout)) + '</span></div></div>' +
    '<div class="hero-note">' + (rate == null ? (t.tout ? 'No money in recorded this month yet.' : 'Nothing recorded this month yet.') :
      rate >= 0 ? 'You kept <b>' + rate + '%</b> of what came in.' : 'Spending is <b>' + Math.abs(rate) + '%</b> above what came in.') +
      (cardSpend(list) ? ' 💳 ' + esc(money(cardSpend(list))) + ' of the spending was on credit cards.' : '') + '</div>' +
    '</section>';

  html += installBanner();

  const alerts = isThisMonth(y, m) ? budgetStates(y, m).filter((b) => b.level !== 'ok') : [];
  if (alerts.length) {
    const a = alerts[0], c = catOf(a.id);
    html += '<div class="alert' + (a.level === 'over' ? ' bad' : '') + '" role="status">' + icon('alert') +
      '<div><b>' + esc(c.label) + (a.level === 'over' ? ' is over budget' : ' is close to its budget') + '</b><div class="muted">' +
      esc(money(a.used)) + ' of ' + esc(money(a.budget)) + ' used' + (alerts.length > 1 ? ' · ' + (alerts.length - 1) + ' more in Insights' : '') + '</div></div></div>';
  }

  html += '<button class="quick-bar" data-act="quick"><span class="qi">' + icon('spark') + '</span>What did you spend or receive?</button>';

  const cats = categorySpend(list), topMax = cats.length ? cats[0].sum : 1;
  const spend = '<section class="card"><div class="card-h"><div><h2>Spending</h2><div class="sub">' + esc(money(t.tout)) + ' in ' + esc(MONTHS_FULL[m]) + '</div></div>' +
    '<button class="link" data-act="go" data-go="insights">Insights</button></div>' +
    (cats.length ? cats.slice(0, 4).map((r) => {
      const c = catOf(r.id);
      return '<button class="hbar tap" data-act="cat-view" data-cat="' + esc(r.id) + '"><span class="nm"><i style="background:' + c.color + '"></i><span>' + esc(c.label) + '</span></span>' +
        '<span class="vl num">' + esc(money(r.sum)) + '<small>' + Math.round((r.sum / t.tout) * 100) + '%</small></span>' +
        '<span class="track"><i style="width:' + Math.max(2, (r.sum / topMax) * 100).toFixed(1) + '%"></i></span></button>';
    }).join('') : '<p class="muted" style="margin:0">No spending in ' + esc(MONTHS_FULL[m]) + '.</p>') + '</section>';

  const recent = sortedTxns(state.txns).slice(0, 6);
  const rec = '<section class="card"><div class="card-h"><div><h2>Recent</h2><div class="sub">Swipe left to delete · tap to edit</div></div>' +
    '<button class="link" data-act="go" data-go="activity">See all</button></div><div class="list">' + recent.map(rowHtml).join('') + '</div></section>';

  html += '<div class="grid-2"><div class="stack">' + rec + '</div><div class="stack">' + spend + '</div></div>';
  return { html };
}

function installBanner() {
  if (ui.standalone || prefs.installDismissed) return '';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (!ui.install && !ios) return '';
  return '<div class="install">' + '<span class="qi" style="color:var(--accent)">' + icon('phone') + '</span>' +
    '<p><b>Install Smart Spend</b>' + (ios ? 'In Safari, tap Share, then Add to Home Screen.' : 'Opens full screen and works offline.') + '</p>' +
    (ios ? '' : '<button class="btn sm primary" data-act="install">Install</button>') +
    '<button class="icon-btn" data-act="install-dismiss" aria-label="Dismiss">' + icon('close') + '</button></div>';
}

/* ============================== ACTIVITY ============================== */

function scopedTxns() {
  const { y, m } = ui.month;
  let list = ui.scope === 'all' ? state.txns : ui.scope === 'day' ? state.txns.filter((t) => t.date === ui.selected) : inMonth(state.txns, y, m);
  const q = ui.search.trim().toLowerCase();
  if (q) list = state.txns.filter((t) => (t.title + ' ' + catOf(t.category).label + ' ' + t.amount + ' ' + (t.account || '')).toLowerCase().indexOf(q) !== -1);
  if (ui.account !== 'all') list = list.filter((t) => (t.account || '') === ui.account);
  if (ui.category !== 'all') list = list.filter((t) => t.category === ui.category);
  return list;
}

export function activityListHtml() {
  const base = scopedTxns();
  const list = sortedTxns(base.filter((t) => ui.filter === 'all' || t.type === ui.filter));
  if (!list.length) {
    const what = ui.search ? 'No entries match “' + esc(ui.search) + '”.' : ui.scope === 'day' ? 'Nothing on ' + esc(fmtDate(ui.selected)) + '.' : 'Nothing here yet.';
    return '<div class="empty"><div class="e-ico">' + icon('activity') + '</div><b>' + what + '</b>Add an entry with the + button; entries without a date land on the selected day.</div>';
  }
  const byDay = new Map();
  list.forEach((t) => { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); });
  let html = '';
  byDay.forEach((rows, d) => {
    const n = rows.reduce((s, t) => s + (t.type === 'in' ? t.amount : -t.amount), 0);
    html += '<div class="day-h"><span>' + esc(fmtDayHeading(d)) + '</span><span class="num">' + esc((n > 0 ? '+' : '') + money(n)) + '</span></div>' + rows.map(rowHtml).join('');
  });
  return html;
}

export function activityCounts() {
  const base = scopedTxns();
  return { all: base.length, in: base.filter((t) => t.type === 'in').length, out: base.filter((t) => t.type === 'out').length };
}

function categoryBanner() {
  if (ui.category === 'all') return '';
  const c = catOf(ui.category);
  return '<div class="filter-banner">' + catIcon(ui.category) + '<span>Showing <b>' + esc(c.label) + '</b></span>' +
    '<button class="btn sm" data-act="cat-clear">' + icon('close') + 'Clear</button></div>';
}

function accountChips() {
  const accts = knownAccounts();
  if (!accts.length) return '';
  const chip = (k, label) => '<button class="chip" data-act="acct" data-acct="' + esc(k) + '" aria-pressed="' + (ui.account === k) + '">' + label + '</button>';
  return '<div class="chips acct-chips" role="group" aria-label="Account">' + chip('all', 'All accounts') +
    accts.map((a) => chip(a, (isCard(a) ? '💳 ' : '🏦 ') + esc(a))).join('') + chip('', 'Cash &amp; other') + '</div>';
}

function calendarHtml() {
  const { y, m } = ui.month;
  const lead = new Date(y, m, 1).getDay(), dim = daysInMonth(y, m), cells = Math.ceil((lead + dim) / 7) * 7;
  const agg = dayAggregates(), today = todayISO();
  let html = DOW.map((d) => '<div class="dow">' + d.slice(0, 2) + '</div>').join('');
  for (let i = 0; i < cells; i++) {
    const d = new Date(y, m, 1 - lead + i), iso = toISO(d), a = agg[iso];
    const cls = ['day'];
    if (d.getMonth() !== m) cls.push('other');
    if (iso === today) cls.push('today');
    if (iso === ui.selected) { cls.push('sel'); if (ui.scope !== 'day') cls.push('soft'); }
    const dots = a ? (a.tin ? '<i class="di"></i>' : '') + (a.tout ? '<i class="do"></i>' : '') : '';
    const label = MONTHS_FULL[d.getMonth()] + ' ' + d.getDate() + (a ? ', ' + plural(a.n, 'entry', 'entries') : '');
    html += '<button class="' + cls.join(' ') + '" data-act="day" data-date="' + iso + '" aria-label="' + esc(label) + '" aria-pressed="' + (iso === ui.selected) + '">' +
      '<span class="num">' + d.getDate() + '</span><span class="dots">' + dots + '</span></button>';
  }
  return html;
}

export function activityView() {
  const c = activityCounts(), { y, m } = ui.month;
  const html =
    '<div class="search"><input class="input" id="actSearch" type="search" placeholder="Search entries" value="' + esc(ui.search) + '" autocomplete="off" aria-label="Search entries">' + icon('search') + '</div>' +
    '<section class="card">' +
    '<div class="cal-head"><h3>' + esc(monthLabel(y, m)) + '</h3>' +
    '<button class="btn sm" data-act="cal-today">Today</button>' +
    '<button class="icon-btn" data-act="month-prev" aria-label="Previous month">' + icon('back') + '</button>' +
    '<button class="icon-btn" data-act="month-next" aria-label="Next month">' + icon('next') + '</button></div>' +
    '<div class="week" style="margin-top:12px" id="calGrid">' + calendarHtml() + '</div>' +
    '<div class="cal-foot"><div class="legend"><span><i style="background:var(--in);border-radius:50%"></i>Money in</span><span><i style="background:var(--out);border-radius:50%"></i>Money out</span></div>' +
    '<div class="seg" role="group" aria-label="Show" style="min-width:220px">' +
    ['day', 'month', 'all'].map((s) => '<button data-act="scope" data-scope="' + s + '" aria-pressed="' + (ui.scope === s) + '">' + (s === 'day' ? 'Day' : s === 'month' ? 'Month' : 'All') + '</button>').join('') +
    '</div></div></section>' +
    '<div class="seg" role="group" aria-label="Filter" id="actFilter">' +
    [['all', 'All'], ['in', 'In'], ['out', 'Out']].map(([k, l]) => '<button data-act="filter" data-filter="' + k + '" aria-pressed="' + (ui.filter === k) + '">' + l + ' <span class="c">' + c[k] + '</span></button>').join('') + '</div>' +
    accountChips() + categoryBanner() +
    '<div class="list" id="actList">' + activityListHtml() + '</div>';
  return { html };
}

/* ============================== INSIGHTS ============================== */

function tile(label, v, d) {
  return '<div class="tile" title="' + esc(label + ': ' + money(v)) + '"><div class="k">' + label + ' <span class="dim">· ' + showCode() + '</span></div><div class="v num">' + esc(moneyCompact(v)) + '</div>' + d + '</div>';
}

function delta(cur, prev, upIsGood) {
  if (!prev && !cur) return '<span class="d flat">—</span>';
  if (!prev) return '<span class="d flat">new this month</span>';
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return '<span class="d flat">same as ' + MONTHS[addMonths(ui.month.y, ui.month.m, -1).m] + '</span>';
  const up = pct > 0, good = up === upIsGood;
  return '<span class="d ' + (good ? 'good' : 'bad') + '">' + (up ? '▲ ' : '▼ ') + Math.abs(pct) + '%<span class="dim" style="font-weight:500">&nbsp;vs ' + MONTHS[addMonths(ui.month.y, ui.month.m, -1).m] + '</span></span>';
}

export function insightsView() {
  const { y, m } = ui.month, pm = addMonths(y, m, -1);
  const now = totals(inMonth(state.txns, y, m)), prev = totals(inMonth(state.txns, pm.y, pm.m));
  const cats = categorySpend(inMonth(state.txns, y, m)), budgets = budgetStates(y, m);
  const series = monthlySeries(y, m, 6);
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px">' + monthSwitch() +
    curToggle() + '</div>';
  html += '<div class="tiles">' +
    tile('Spent', now.tout, delta(now.tout, prev.tout, false)) + tile('Received', now.tin, delta(now.tin, prev.tin, true)) + tile('Kept', now.net, delta(now.net, prev.net, true)) + '</div>';

  const inout = '<section class="card"><div class="card-h"><div><h2>Money in and out</h2><div class="sub">Last 6 months</div></div>' +
    '<div class="legend"><span><i style="background:var(--in)"></i>In</span><span><i style="background:var(--out)"></i>Out</span></div></div>' +
    '<div id="chartInOut"></div>' +
    '<details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:13px">View as table</summary>' +
    '<table class="num" style="width:100%;margin-top:8px;border-collapse:collapse;font-size:13px">' +
    '<tr class="muted"><th style="text-align:left;padding:6px 0">Month</th><th style="text-align:right">In</th><th style="text-align:right">Out</th><th style="text-align:right">Net</th></tr>' +
    series.map((s) => '<tr style="border-top:1px solid var(--border)"><td style="padding:6px 0">' + MONTHS[s.m] + ' ' + s.y + '</td><td style="text-align:right">' + esc(money(s.tin)) + '</td><td style="text-align:right">' + esc(money(s.tout)) + '</td><td style="text-align:right">' + esc(money(s.net)) + '</td></tr>').join('') +
    '</table></details></section>';

  const pace = '<section class="card"><div class="card-h"><div><h2>Spending pace</h2><div class="sub">Running total through ' + esc(MONTHS_FULL[m]) + '</div></div>' +
    '<div class="legend"><span><i class="line" style="background:var(--accent)"></i>' + MONTHS[m] + '</span><span><i class="line" style="background:var(--text-3)"></i>' + MONTHS[pm.m] + '</span></div></div>' +
    '<div id="chartPace"></div></section>';

  const where = '<section class="card"><div class="card-h"><div><h2>Where it went</h2><div class="sub">' + esc(money(now.tout)) + ' across ' + plural(cats.length, 'category', 'categories') + '</div></div></div>' +
    (cats.length ? cats.map((r) => {
      const c = catOf(r.id);
      const open = !!ui.expanded[r.id];
      const rows = open ? sortedTxns(inMonth(state.txns, y, m).filter((x) => x.type === 'out' && x.category === r.id)) : [];
      return '<button class="hbar tap' + (open ? ' open' : '') + '" data-act="cat-toggle" data-cat="' + esc(r.id) + '" aria-expanded="' + open + '"><span class="nm"><i style="background:' + c.color + '"></i><span>' + esc(c.label) + '</span><span class="dim" style="font-weight:500;font-size:12px">' + plural(r.n, 'entry', 'entries') + '</span></span>' +
        '<span class="vl num">' + esc(money(r.sum)) + '<small>' + Math.round((r.sum / now.tout) * 100) + '%</small><span class="chev caret">' + icon('next') + '</span></span>' +
        '<span class="track"><i style="width:' + Math.max(2, (r.sum / cats[0].sum) * 100).toFixed(1) + '%"></i></span></button>' +
        (open ? '<div class="cat-drop">' + rows.map((x) => '<button class="drop-row" data-act="drop-edit" data-id="' + esc(x.id) + '"><span class="dr-t">' + esc(x.title) + '</span><span class="dr-d">' + esc(fmtDayHeading(x.date)) + (x.account ? ' · ' + esc(x.account) : '') + '</span><span class="dr-a num">' + esc(money(x.amount)) + '</span></button>').join('') + '</div>' : '');
    }).join('') : '<p class="muted" style="margin:0">No spending recorded in ' + esc(MONTHS_FULL[m]) + '.</p>') + '</section>';

  const bud = '<section class="card"><div class="card-h"><div><h2>Budgets</h2><div class="sub">Monthly limits per category</div></div>' +
    '<button class="btn sm" data-act="budgets">' + icon('target') + (budgets.length ? 'Edit' : 'Set budgets') + '</button></div>' +
    (budgets.length ? budgets.map((b) => {
      const c = catOf(b.id);
      const st = b.level === 'over' ? icon('alert') + 'Over by ' + esc(money(b.used - b.budget)) : b.level === 'near' ? icon('alert') + Math.round(b.pct * 100) + '% used' : money(b.budget - b.used) + ' left';
      return '<div class="hbar meter ' + b.level + '"><span class="nm"><i style="background:' + c.color + '"></i><span>' + esc(c.label) + '</span></span>' +
        '<span class="vl num">' + esc(money(b.used)) + '<small>of ' + esc(money(b.budget)) + '</small></span>' +
        '<span class="track"><i style="width:' + Math.min(100, Math.max(2, b.pct * 100)).toFixed(1) + '%"></i></span>' +
        '<span class="state" style="grid-column:1/-1">' + st + '</span></div>';
    }).join('') : '<p class="muted" style="margin:0">Set a monthly limit for any category and you’ll get a warning at 80% and when you go over.</p>') + '</section>';

  const accts = accountTotals(inMonth(state.txns, y, m)).filter((a) => a.tout || a.tin);
  const cardOut = accts.filter((a) => isCard(a.account)).reduce((s, a) => s + a.tout, 0);
  const byAcct = accts.some((a) => a.account) ? '<section class="card"><div class="card-h"><div><h2>By account</h2><div class="sub">Where the money moved in ' + esc(MONTHS_FULL[m]) + '</div></div></div>' +
    accts.map((a) => '<div class="acct-row"><span class="nm">' + (a.account ? (isCard(a.account) ? '💳 ' : '🏦 ') + esc(a.account) : '💵 Cash &amp; other') + '</span>' +
      '<span class="vl num">' + (a.tout ? '<b>−' + esc(money(a.tout)) + '</b>' : '') + (a.tin ? '<small class="in-c">+' + esc(money(a.tin)) + '</small>' : '') + '</span></div>').join('') +
    (cardOut ? '<p class="help" style="margin:12px 0 0">💳 ' + esc(money(cardOut)) + ' of this month’s spending was on credit cards. That’s borrowed money you pay back when the card bill comes.</p>' : '') + '</section>' : '';
  html += '<div class="grid-2"><div class="stack">' + inout + pace + '</div><div class="stack">' + where + byAcct + bud + '</div></div>';

  const after = () => {
    const code = showCode(), fmt = (v) => fmtMoney(Math.round(v), code).replace(/\.0+$/, '');
    const host = document.getElementById('chartInOut');
    if (host) inOutColumns(host, series.map((s) => ({ label: MONTHS[s.m], full: MONTHS_FULL[s.m] + ' ' + s.y, tin: displayValue(s.tin), tout: displayValue(s.tout) })), fmt, code);
    const ph = document.getElementById('chartPace');
    if (ph) {
      const b = getBudgets(), totalBudget = Object.keys(b).reduce((s, k) => s + b[k], 0);
      const conv = (arr) => arr.map((v) => (v == null ? null : displayValue(v)));
      paceLines(ph, conv(cumulativeSpend(y, m)), conv(cumulativeSpend(pm.y, pm.m)), displayValue(totalBudget), fmt, code, MONTHS[m], MONTHS[pm.m]);
    }
  };
  return { html, after };
}

/* ================================ MORE ================================ */

export function moreView() {
  const p = ui.profile, cs = describe();
  const set = (act, ico, title, sub, extra) => '<button class="set-row' + (extra || '') + '" data-act="' + act + '"><span class="set-ico">' + icon(ico) + '</span><span class="set-main"><b>' + title + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</span><span class="chev">' + icon('next') + '</span></button>';
  const b = currencyInfo(cur.base);
  let html = '<section class="card profile-card">' + avatar(p, 56) +
    '<div style="flex:1;min-width:0"><div class="pc-name">' + esc(p.name) + '</div><div class="muted" style="font-size:13px;overflow:hidden;text-overflow:ellipsis">' + esc(p.email) + '</div></div>' +
    '<button class="btn sm" data-act="logout">' + icon('lock') + '<b>Log out</b></button></section>';

  html += '<div class="section-label">Money</div><div class="set-group">' +
    set('currency', 'coins', 'Currency', esc(b.code + ' · ' + b.name) + (cur.alt ? ' · also shown in ' + cur.alt : '')) +
    (cur.alt ? '<div class="set-row"><span class="set-ico">' + icon('coins') + '</span><span class="set-main"><b>Exchange rate</b><span>Converts ' + cur.alt + ' amounts you type</span></span>' +
      '<span class="rate-inline"><span class="muted" style="font-size:13px">1 ' + cur.base + ' =</span><input class="input num" id="rateInput" inputmode="decimal" type="number" step="any" min="0" value="' + state.rate + '" aria-label="' + cur.alt + ' per ' + cur.base + '"></span></div>' +
      '<div class="set-row"><span class="set-ico">' + icon('coins') + '</span><span class="set-main"><b>Show amounts in</b><span>The other currency appears smaller</span></span>' + curToggle() + '</div>' : '') +
    set('categories', 'spark', 'Categories', customCategories().length ? plural(customCategories().length, 'of your own', 'of your own') + ' · ' + esc(customCategories().map((c) => c.emoji + ' ' + c.label).slice(0, 3).join(', ')) : 'Add your own, like Travel or Rent') +
    set('budgets', 'target', 'Budgets', 'Monthly limits per category') + '</div>';

  html += '<div class="section-label">Sync</div><div class="set-group">' +
    '<div class="set-row"><span class="set-ico" style="color:' + (cs.level === 'ok' ? 'var(--in-text)' : cs.level === 'error' ? 'var(--out-text)' : cs.level === 'warn' ? 'var(--warn)' : 'var(--text-2)') + '">' + icon('cloud') + '</span>' +
    '<span class="set-main"><b>' + esc(cs.title) + '</b><span>' + esc(cs.detail || 'Log in on another phone or computer with the same email to see your entries there.') + '</span></span>' +
    '<button class="btn sm primary" data-act="sync-now">' + icon('sync') + 'Sync now</button></div></div>';

  html += '<div class="section-label">Help</div><div class="set-group">' +
    set('typing-help', 'spark', 'What can I type?', 'Examples of everything Smart Spend understands') +
    (ui.standalone ? '' : set('install-help', 'phone', 'Add to your home screen', 'Opens like an app on Android and iPhone')) + '</div>';

  html += '<div class="section-label">Your data</div><div class="set-group">' +
    set('export', 'upload', 'Save a backup file', 'Download a .json copy to this device') +
    set('restore', 'download', 'Restore from a file', 'A Smart Spend backup file') +
    set('demo', 'flask', 'Load sample data', 'Six months of example entries') +
    '<button class="set-row danger" data-act="clear"><span class="set-ico">' + icon('wipe') + '</span><span class="set-main"><b>Clear all entries</b><span>On all your devices. You can undo right after</span></span></button></div>';

  html += '<div class="section-label">Appearance</div><div class="set-group"><div class="set-row"><span class="set-ico">' + icon('sun') + '</span><span class="set-main"><b>Theme</b></span>' +
    '<div class="seg" style="min-width:210px">' + [['dark', 'Dark'], ['light', 'Light'], ['system', 'Auto']].map(([k, l]) => '<button data-act="theme" data-theme="' + k + '" aria-pressed="' + (prefs.theme === k) + '">' + l + '</button>').join('') + '</div></div></div>';

  if (isAdmin()) html += '<div class="section-label">Admin</div><div class="set-group">' + set('admin', 'spark', 'Manage accounts', 'Users, access and roles') + '</div>';

  html += '<div class="section-label">Account</div><div class="set-group">' +
    set('change-password', 'lock', 'Change password', 'Logs out your other devices') +
    set('recovery-code', 'check', 'New recovery code', 'If you’ve lost the one you saved') +
    '<button class="set-row danger" data-act="delete-account"><span class="set-ico">' + icon('trash') + '</span><span class="set-main"><b>Delete account</b><span>Removes your account and every entry, for good</span></span></button></div>';

  html += '<div class="section-label">App</div><div class="set-group">' +
    '<div class="set-row"><span class="set-ico">' + icon('info') + '</span><span class="set-main"><b>Smart Spend ' + APP_VERSION + '</b><span>Entries are saved on this device first, then synced to your account. Your password never leaves this device.' + (store.available() ? '' : ' Browser storage is blocked here, so entries on this device last only for this session.') + '</span></span></div></div>';
  return { html };
}
