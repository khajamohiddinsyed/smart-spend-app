// Bank and card SMS: "Your A/c XX5348 debited by Rs. 120.00 on 20/09/26; NOORJAHAN credited…",
// "INR 431.09 spent on your … Credit Card ending XX9648 at TRAVEL FOOD SERVICES D on 24 SEP 2026".
// Each message becomes one entry: amount, in or out, who it was paid to or received from, the date,
// and the account or card it came from. Balances, limits, reference numbers and helpline text are
// ignored, because a person has several accounts and cards with different balances.

import { makeDate, monthIndex, toISO, round2 } from './core.js';
import { cur as CUR } from './currency.js';

const MONEY = /(?:rs\.?|inr|₹|sar|aed|usd|\$)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|inr|sar|aed)\b/gi;
const CUR_OF = (s) => (/sar/i.test(s) ? 'SAR' : /aed/i.test(s) ? 'AED' : /usd|\$/i.test(s) ? 'USD' : 'INR');
const NOT_TXN_AMOUNT = /(?:bal(?:ance)?|limit|avl|avbl|outstanding|due|min(?:imum)?|total\s+amt)\W*(?:\w+\W+){0,3}$/i;

const BANKS = [
  ['IDFC FIRST', /idfc/i], ['HDFC', /hdfc/i], ['ICICI', /icici/i], ['SBI Card', /sbi\s*card/i], ['SBI', /\bsbi\b|state bank/i],
  ['Axis', /\baxis\b/i], ['Kotak', /kotak/i], ['Yes Bank', /yes\s*bank/i], ['IndusInd', /indusind/i], ['PNB', /\bpnb\b|punjab national/i],
  ['Bank of Baroda', /bank of baroda|\bbob\b/i], ['Canara', /canara/i], ['Union Bank', /union bank/i], ['Federal', /federal bank/i],
  ['RBL', /\brbl\b/i], ['AU', /\bau\s+(?:small|bank)/i], ['Amex', /amex|american express/i], ['Citi', /\bciti/i], ['HSBC', /hsbc/i],
  ['Standard Chartered', /standard chartered|\bsc bank/i], ['OneCard', /onecard/i], ['Paytm', /paytm/i],
  ['Al Rajhi', /rajhi/i], ['SNB', /\bsnb\b|saudi national/i], ['Riyad', /riyad/i], ['SAB', /\bsab\b|\bsabb\b/i], ['Alinma', /alinma/i],
  ['Albilad', /albilad|al bilad/i], ['ANB', /\banb\b|arab national/i], ['BSF', /\bbsf\b|banque saudi/i], ['STC Bank', /stc\s*(?:bank|pay)/i],
  ['Emirates NBD', /emirates nbd|\benbd\b/i], ['ADCB', /adcb/i], ['FAB', /\bfab\b|first abu dhabi/i], ['Mashreq', /mashreq/i]
];

/** Looks like a bank or card transaction alert (not an OTP or a promotion). */
export function isBankMessage(text) {
  const t = String(text || '');
  if (!/(debited|credited|spent|refunded|withdrawn|reversed|purchase|transaction|txn|paid|sent)/i.test(t)) return false;
  if (!/(a\/c|acct|account|card|upi|vpa|bank|imps|neft|rtgs)/i.test(t)) return false;
  if (/\b(otp|one time password|verification code)\b/i.test(t)) return false;
  MONEY.lastIndex = 0;
  return MONEY.test(t);
}

/** Splits pasted text into single messages (blank lines, or one message per line). */
export function splitMessages(text) {
  const blocks = String(text).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out = [];
  blocks.forEach((b) => {
    const lines = b.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 1 && lines.filter(isBankMessage).length > 1) lines.forEach((l) => out.push(l));
    else out.push(b.replace(/\s*\n\s*/g, ' '));
  });
  return out;
}

function bankName(t) { for (const [name, re] of BANKS) if (re.test(t)) return name; return null; }

/** "HDFC Card 8432" / "IDFC FIRST A/c 5348", or null. */
export function accountOf(t) {
  const bank = bankName(t);
  let m = /card\s+(?:no\.?\s*)?(?:ending\s+(?:with\s+)?)?(?:in\s+)?[x*]*(\d{4})\b/i.exec(t) || /card\s+[x*]+\s*(\d{4})\b/i.exec(t);
  if (m) return (bank ? bank + ' ' : '') + 'Card ' + m[1];
  m = /\b(?:a\/c|acct|account)\s*(?:no\.?\s*)?[x*]*\d*?(\d{4})\b/i.exec(t);
  if (m) return (bank ? bank + ' ' : '') + 'A/c ' + m[1];
  return bank ? bank : null;
}

/** The transaction amount: the first money figure that isn't a balance or a limit. */
function amountOf(t) {
  MONEY.lastIndex = 0;
  let m;
  while ((m = MONEY.exec(t)) !== null) {
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    if (NOT_TXN_AMOUNT.test(before)) continue;
    const v = parseFloat((m[1] || m[2]).replace(/,/g, ''));
    if (v > 0) return { value: v, code: CUR_OF(m[0]) };
  }
  return null;
}

function dateOf(t, fallbackISO) {
  let m, d = null;
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})/.exec(t))) d = makeDate(+m[1], +m[2] - 1, +m[3]);
  else if ((m = /\b(\d{1,2})[\/\- ]([a-z]{3,9})[\/\-, ]+(\d{2,4})\b/i.exec(t)) && monthIndex(m[2]) >= 0) d = makeDate(yr(m[3]), monthIndex(m[2]), +m[1]);
  else if ((m = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/.exec(t))) d = makeDate(yr(m[3]), +m[2] - 1, +m[1]);
  return d ? toISO(d) : fallbackISO;
}
const yr = (s) => (s.length === 2 ? 2000 + +s : +s);

// Merchant and people names arrive shouted and cut short: "TRAVEL FOOD SERVICES D", "Amazon Pay INDIA PVT L",
// "NOORJAHAN WIFE OF NA", "PAX INNOVATION ICT SERVICBangalore    IN".
function cleanName(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(?:wife|son|daughter)\s+of\b.*$/i, '').replace(/\b[wsd]\/o\b.*$/i, '');
  s = s.replace(/(?:bangalore|bengaluru|mumbai|delhi|new delhi|chennai|hyderabad|pune|kolkata|gurgaon|gurugram|noida|riyadh|jeddah|dubai)\s*(?:in|ind|india|sa|ae)?\s*$/i, '');
  s = s.replace(/\s+(?:in|ind|india|sa|ksa|ae|uae)\s*$/i, '');
  s = s.replace(/\b(?:pvt|private)\s*l(?:td|imited|t)?\b.*$/i, '').replace(/\b(?:ltd|limited|llp|inc|co)\.?\s*$/i, '');
  s = s.replace(/\s+(?:india)\s*$/i, '').replace(/\s+[a-z]\s*$/i, '').replace(/[@.].*$/, (x) => (/@/.test(x) ? '' : x));
  s = s.replace(/[^\w &'-]+$/g, '').trim();
  if (!s || /^(?:na|n\/a|null|x+)$/i.test(s)) return '';
  if (s === s.toUpperCase() || s === s.toLowerCase()) {
    s = s.toLowerCase().split(' ').map((w) => (w.length <= 3 && /^(?:ict|atm|upi|ltd|llc|hdfc|sbi|icici)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }
  return s.slice(0, 60);
}

function counterparty(t, dir) {
  let m;
  if ((m = /;\s*([^;.]+?)\s+credited\b/i.exec(t))) return cleanName(m[1]);                     // "…; NOORJAHAN credited."
  if ((m = /refunded\s+by\s+(.+?)\s+on\b/i.exec(t))) return cleanName(m[1]);
  if ((m = /\bat\s+(.+?)\s+on\s+\d/i.exec(t)) || (m = /\bat\s+(.+?)\s+on\b/i.exec(t))) return cleanName(m[1]);
  if (dir === 'out' && (m = /\bto\s+(?:vpa\s+|a\/c\s+)?(.+?)(?:\s+on\b|\s+ref\b|[.;]|$)/i.exec(t)) && !/^(?:your|a\/c|x+\d)/i.test(m[1])) return cleanName(m[1]);
  if (dir === 'in' && (m = /\b(?:from|by)\s+(?:vpa\s+)?(.+?)(?:\s+on\b|\s+ref\b|\s+via\b|[.;]|$)/i.exec(t)) && !/^(?:your|a\/c|x+\d|upi|imps|neft)/i.test(m[1])) return cleanName(m[1]);
  return '';
}

function direction(t) {
  if (/\b(refund(?:ed)?|reversed|reversal|cashback)\b/i.test(t)) return 'in';
  if (/\b(debited|spent|paid|sent|withdrawn|purchase|payment of)\b/i.test(t)) return 'out';
  if (/\b(credited|received|deposited)\b/i.test(t)) return 'in';
  return 'out';
}

/**
 * One message → { title, amount, type, date, account, currency, original, foreign, merchant, refund } or null.
 * `rate` converts the account's second currency, like the free-text parser.
 */
export function parseBankMessage(text, fallbackISO, rate) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const amt = amountOf(t);
  if (!amt) return null;
  const type = direction(t), refund = /\brefund/i.test(t);
  const who = counterparty(t, type);
  const card = /card/i.test(accountOf(t) || '');
  let title;
  if (refund) title = who ? 'Refund from ' + who : 'Refund';
  else if (type === 'in') title = who ? 'Received from ' + who : 'Received';
  else title = who ? (card || /\bat\s/i.test(t) ? who : 'Paid to ' + who) : (card ? 'Card payment' : 'Paid');
  const inAlt = amt.code === CUR.alt && rate > 0;
  return {
    title, merchant: who, refund, type,
    amount: round2(inAlt ? amt.value / rate : amt.value),
    currency: inAlt ? amt.code : null,
    foreign: amt.code !== CUR.base && !inAlt ? amt.code : null,
    original: amt.value,
    date: dateOf(t, fallbackISO),
    account: accountOf(t)
  };
}
