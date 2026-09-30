// "Ask your spending": answers questions like "how much did I spend on food & drinks this week?"
// from the person's own entries. A local parser handles the common shapes with no network; the
// AI is only a fallback that turns an unusual question into the same filter. The NUMBER is always
// computed here from the ledger, never by the AI, so it's exact.

import { fromISO, toISO, todayDate, todayISO, round2, fmtDate, MONTHS_FULL } from './core.js';
import { state, isCard } from './ledger.js';
import { CATEGORIES, CAT_BY_ID, catOf, normText } from './categories.js';

/* ---------- date ranges ---------- */

function startOfWeek(d) { const x = new Date(d); const day = x.getDay(); x.setDate(x.getDate() - day); x.setHours(0, 0, 0, 0); return x; } // week starts Sunday
export function periodRange(period, from, to) {
  const t = todayDate(), y = t.getFullYear(), m = t.getMonth();
  const iso = (d) => toISO(d);
  switch (period) {
    case 'today': return { from: todayISO(), to: todayISO() };
    case 'yesterday': { const d = new Date(t); d.setDate(d.getDate() - 1); return { from: iso(d), to: iso(d) }; }
    case 'this_week': { const s = startOfWeek(t); return { from: iso(s), to: todayISO() }; }
    case 'last_week': { const s = startOfWeek(t); const a = new Date(s); a.setDate(a.getDate() - 7); const b = new Date(s); b.setDate(b.getDate() - 1); return { from: iso(a), to: iso(b) }; }
    case 'this_month': return { from: iso(new Date(y, m, 1)), to: todayISO() };
    case 'last_month': return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'this_year': return { from: iso(new Date(y, 0, 1)), to: todayISO() };
    case 'range': return { from: from || '0000-01-01', to: to || todayISO() };
    default: return { from: '0000-01-01', to: '9999-12-31' };   // all
  }
}
const PERIOD_LABEL = {
  today: 'today', yesterday: 'yesterday', this_week: 'this week', last_week: 'last week',
  this_month: 'this month', last_month: 'last month', this_year: 'this year', all: 'in total', range: ''
};

/* ---------- run a query against the ledger ---------- */

const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt);

// Bucket key/label for "per day / per week / per month / per year" questions.
function groupKey(dateISO, unit) {
  if (unit === 'month') return dateISO.slice(0, 7);
  if (unit === 'year') return dateISO.slice(0, 4);
  if (unit === 'week') return toISO(startOfWeek(fromISO(dateISO)));
  return dateISO; // day
}
function groupLabel(key, unit) {
  if (unit === 'month') { const p = key.split('-'); return MONTHS_FULL[+p[1] - 1] + ' ' + p[0]; }
  if (unit === 'year') return key;
  if (unit === 'week') { const e = new Date(fromISO(key)); e.setDate(e.getDate() + 6); return fmtDate(key) + ' – ' + fmtDate(toISO(e)); }
  return fmtDate(key); // day, e.g. "Sep 24, 2026"
}

export function runQuery(spec) {
  const { from, to } = periodRange(spec.period, spec.from, spec.to);
  const rows = state.txns.filter((t) => {
    if (t.date < from || t.date > to) return false;
    if (spec.category && t.category !== spec.category) return false;
    if (spec.cardOnly && !isCard(t.account)) return false;
    if (spec.account) { const a = normText(t.account || ''); if (a.indexOf(normText(spec.account)) === -1) return false; }
    return true;
  });
  const out = rows.filter((t) => t.type === 'out'), inn = rows.filter((t) => t.type === 'in');
  const sum = (l) => round2(l.reduce((s, t) => s + t.amount, 0));
  // Which side the min/max/average looks at: money in for received-type questions, else money out.
  const flow = spec.flow === 'in' ? inn : spec.flow === 'both' ? rows : out;

  // When grouping ("highest in one day"), each day/week/month is one data point: sum its entries,
  // then min/max/average compare whole periods instead of single entries.
  const grp = spec.groupBy;
  let buckets = null, bucket = null, series = flow.map((t) => t.amount);
  if (grp) {
    const map = new Map();
    flow.forEach((t) => {
      const k = groupKey(t.date, grp);
      let b = map.get(k);
      if (!b) { b = { key: k, label: groupLabel(k, grp), amount: 0, count: 0, rows: [] }; map.set(k, b); }
      b.amount += t.amount; b.count++; b.rows.push(t);
    });
    buckets = Array.from(map.values());
    buckets.forEach((b) => { b.amount = round2(b.amount); b.rows.sort(byDateDesc); });
    buckets.sort((a, b) => b.amount - a.amount);
    series = buckets.map((b) => b.amount);
    if (buckets.length) bucket = spec.metric === 'min' ? buckets[buckets.length - 1] : buckets[0];
  }

  const min = series.length ? round2(Math.min.apply(null, series)) : 0;
  const max = series.length ? round2(Math.max.apply(null, series)) : 0;
  const average = series.length ? round2(series.reduce((s, n) => s + n, 0) / series.length) : 0;

  var ordered;
  if (grp) ordered = bucket ? bucket.rows.slice() : [];   // show the winning period's own entries
  else if (spec.metric === 'min') ordered = flow.slice().sort((a, b) => a.amount - b.amount);
  else if (spec.metric === 'max') ordered = flow.slice().sort((a, b) => b.amount - a.amount);
  else ordered = (spec.metric === 'received' ? inn : spec.metric === 'net' ? rows : spec.metric === 'average' ? flow : out).slice()
    .sort(byDateDesc);
  return {
    spec, from, to,
    spent: sum(out), received: sum(inn), net: round2(sum(inn) - sum(out)),
    min, max, average, flowCount: flow.length,
    buckets, bucket,
    count: spec.metric === 'received' ? inn.length : spec.metric === 'net' ? rows.length : flow.length,
    rows: ordered
  };
}

/** A phrase describing what was asked, e.g. "on Food & Drinks this week on cards". */
export function describeSpec(spec) {
  const parts = [];
  if (spec.category) parts.push('on ' + (CAT_BY_ID[spec.category] ? catOf(spec.category).label : spec.categoryLabel || spec.category));
  const pl = PERIOD_LABEL[spec.period]; if (pl) parts.push(pl);
  if (spec.cardOnly) parts.push('on cards'); else if (spec.account) parts.push('on ' + spec.account);
  return parts.join(' ');
}

/* ---------- local parser (no network) ---------- */

const WEEK = { spent: /\b(spend|spent|spending|pay|paid|cost)\b/i, received: /\b(receiv|earn|income|got paid|credited|salary|made|added|add|loaded|load|top ?up|topped|deposit|deposited|put in)\b/i, net: /\b(net|balance|left|save[d]?|saving)\b/i, count: /\bhow many\b|\bnumber of\b|\bcount\b/i };

function matchPeriod(q) {
  if (/\btoday\b|\btonight\b/.test(q)) return 'today';
  if (/\byesterday\b/.test(q)) return 'yesterday';
  if (/\blast week\b|\bprevious week\b/.test(q)) return 'last_week';
  if (/\bthis week\b|\bthe week\b|\bweekly\b|\bpast week\b/.test(q)) return 'this_week';
  if (/\blast month\b|\bprevious month\b/.test(q)) return 'last_month';
  if (/\bthis month\b|\bthe month\b|\bmonthly\b/.test(q)) return 'this_month';
  if (/\bthis year\b|\bthe year\b|\byearly\b|\bytd\b/.test(q)) return 'this_year';
  if (/\ball time\b|\bever\b|\boverall\b|\bin total\b|\btotal\b|\btill date\b|\bto date\b|\bso far\b|\buntil now\b|\btill now\b|\btill today\b|\blifetime\b|\bsince (?:the )?beginning\b|\bfrom (?:the )?(?:start|beginning)\b/.test(q)) return 'all';
  return null;
}

// "in one day", "per month" … — group the entries into whole days/weeks/months and compare those.
function matchGroup(q) {
  if (/\b(per day|each day|a day|one day|single day|in a day|by day|daily)\b/.test(q)) return 'day';
  if (/\b(per week|each week|a week|in a week|by week)\b/.test(q)) return 'week';
  if (/\b(per month|each month|a month|in a month|by month)\b/.test(q)) return 'month';
  if (/\b(per year|each year|a year|in a year|by year|annually)\b/.test(q)) return 'year';
  return null;
}

function matchCategory(q) {
  const n = ' ' + normText(q) + ' ';
  if (/ food | drink | drinks | dining | restaurant | coffee | eat /.test(n)) return 'Dining';
  // custom categories and built-ins by their name/words
  let best = null;
  CATEGORIES.forEach((c) => {
    if (c.id === 'General') return;
    const names = [c.label].concat(c.words || []).concat(c.id === 'Cash' ? ['cash', 'atm'] : []);
    names.forEach((w) => { const nw = normText(w); if (nw && nw.length >= 3 && n.indexOf(' ' + nw) !== -1) best = best || c.id; });
  });
  return best;
}

/** Returns a spec when the question is clear enough, else null (then the caller asks the AI). */
export function parseQuestionLocal(q) {
  const s = ' ' + q.toLowerCase() + ' ';
  const period = matchPeriod(s);
  const category = matchCategory(s);
  const group = matchGroup(s);
  const cardOnly = /\b(card|credit card|on cards?)\b/i.test(s) && !/\d{4}/.test(s);
  const acctMatch = /\b(\d{4})\b/.exec(s);
  const isIn = WEEK.received.test(s);
  let metric = isIn ? 'received' : 'spent';
  if (WEEK.net.test(s)) metric = 'net';
  if (WEEK.count.test(s)) metric = 'count';
  if (/\b(lowest|smallest|cheapest|least|minimum|min)\b/.test(s)) metric = 'min';
  else if (/\b(highest|largest|biggest|most expensive|dearest|maximum|max|priciest|costliest)\b/.test(s) || /\bmost (?:i|money)?\s*(?:spen|paid|pay|cost)/.test(s)) metric = 'max';
  else if (/\b(average|avg|mean|on average|typical)\b/.test(s)) metric = 'average';
  const flow = isIn ? 'in' : 'out';
  // "how much per day" with no high/low word is really "average per day".
  const groupBy = group && (metric === 'min' || metric === 'max' || metric === 'average') ? group
    : group && (metric === 'spent' || metric === 'received') ? group : null;
  if (groupBy && metric !== 'min' && metric !== 'max') metric = 'average';
  // Need at least a period, category, card, account or a grouping to be confident it's a spending question.
  if (!period && !category && !cardOnly && !acctMatch && !groupBy && !WEEK.spent.test(s) && metric === 'spent') return null;
  if (!period && !category && !cardOnly && !acctMatch && !groupBy) return null;
  return {
    metric, flow, category, categoryLabel: category ? catOf(category).label : null,
    period: period || (groupBy ? 'all' : 'this_month'), from: null, to: null,
    account: acctMatch ? acctMatch[1] : null, cardOnly, groupBy
  };
}
