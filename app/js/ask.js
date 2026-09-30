// "Ask your spending": answers questions like "how much did I spend on food & drinks this week?"
// from the person's own entries. A local parser handles the common shapes with no network; the
// AI is only a fallback that turns an unusual question into the same filter. The NUMBER is always
// computed here from the ledger, never by the AI, so it's exact.

import { fromISO, toISO, todayDate, todayISO, round2 } from './core.js';
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
  const amts = flow.map((t) => t.amount);
  const min = amts.length ? round2(Math.min.apply(null, amts)) : 0;
  const max = amts.length ? round2(Math.max.apply(null, amts)) : 0;
  const average = amts.length ? round2(sum(flow) / flow.length) : 0;
  var ordered;
  if (spec.metric === 'min') ordered = flow.slice().sort((a, b) => a.amount - b.amount);
  else if (spec.metric === 'max') ordered = flow.slice().sort((a, b) => b.amount - a.amount);
  else ordered = (spec.metric === 'received' ? inn : spec.metric === 'net' ? rows : spec.metric === 'average' ? flow : out).slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt));
  return {
    spec, from, to,
    spent: sum(out), received: sum(inn), net: round2(sum(inn) - sum(out)),
    min, max, average, flowCount: flow.length,
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
  const cardOnly = /\b(card|credit card|on cards?)\b/i.test(s) && !/\d{4}/.test(s);
  const acctMatch = /\b(\d{4})\b/.exec(s);
  const isIn = WEEK.received.test(s);
  let metric = isIn ? 'received' : 'spent';
  if (WEEK.net.test(s)) metric = 'net';
  if (WEEK.count.test(s)) metric = 'count';
  if (/\b(lowest|smallest|cheapest|least|minimum|min)\b/.test(s)) metric = 'min';
  else if (/\b(highest|largest|biggest|most expensive|dearest|maximum|max|priciest|costliest)\b/.test(s)) metric = 'max';
  else if (/\b(average|avg|mean|on average|typical)\b/.test(s)) metric = 'average';
  const flow = isIn ? 'in' : 'out';
  // Need at least a period or a category to be confident it's a spending question.
  if (!period && !category && !cardOnly && !acctMatch && !WEEK.spent.test(s) && metric === 'spent') return null;
  if (!period && !category && !cardOnly && !acctMatch) return null;
  return {
    metric, flow, category, categoryLabel: category ? catOf(category).label : null,
    period: period || 'this_month', from: null, to: null,
    account: acctMatch ? acctMatch[1] : null, cardOnly
  };
}
