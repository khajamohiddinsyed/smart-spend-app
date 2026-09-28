// Currencies: the account's main currency (amounts are stored in it) and an optional
// second one shown alongside at the account's own rate. Also the words and symbols the
// parser recognises for each.

import { round2 } from './core.js';

// code, name, symbol shown before the amount, locale for grouping, decimals,
// rough units per US dollar (only to suggest a starting rate), words people type.
const LIST = [
  ['SAR', 'Saudi riyal', 'SAR ', 'en-US', 2, 3.75, 'sar|sr|s\\.r\\.?'],
  ['AED', 'UAE dirham', 'AED ', 'en-US', 2, 3.6725, 'aed|dhs?|dirhams?'],
  ['QAR', 'Qatari riyal', 'QAR ', 'en-US', 2, 3.64, 'qar|qr'],
  ['KWD', 'Kuwaiti dinar', 'KWD ', 'en-US', 3, 0.307, 'kwd|kd'],
  ['BHD', 'Bahraini dinar', 'BHD ', 'en-US', 3, 0.376, 'bhd|bd'],
  ['OMR', 'Omani rial', 'OMR ', 'en-US', 3, 0.3845, 'omr|ro'],
  ['EGP', 'Egyptian pound', 'EGP ', 'en-US', 2, 48, 'egp|le'],
  ['INR', 'Indian rupee', '₹', 'en-IN', 2, 88, 'inr'],
  ['PKR', 'Pakistani rupee', 'Rs ', 'en-PK', 0, 281, 'pkr'],
  ['BDT', 'Bangladeshi taka', '৳', 'en-IN', 2, 122, 'bdt|tk|taka'],
  ['LKR', 'Sri Lankan rupee', 'Rs ', 'en-US', 2, 300, 'lkr'],
  ['NPR', 'Nepalese rupee', 'Rs ', 'en-IN', 2, 140, 'npr'],
  ['PHP', 'Philippine peso', '₱', 'en-US', 2, 57, 'php|pesos?'],
  ['IDR', 'Indonesian rupiah', 'Rp ', 'id-ID', 0, 16300, 'idr|rp'],
  ['MYR', 'Malaysian ringgit', 'RM ', 'en-US', 2, 4.2, 'myr|rm|ringgit'],
  ['SGD', 'Singapore dollar', 'S$', 'en-US', 2, 1.29, 'sgd'],
  ['USD', 'US dollar', '$', 'en-US', 2, 1, 'usd'],
  ['EUR', 'Euro', '€', 'en-IE', 2, 0.86, 'eur|euros?'],
  ['GBP', 'British pound', '£', 'en-GB', 2, 0.75, 'gbp|quid'],
  ['CAD', 'Canadian dollar', 'C$', 'en-US', 2, 1.38, 'cad'],
  ['AUD', 'Australian dollar', 'A$', 'en-US', 2, 1.52, 'aud'],
  ['JPY', 'Japanese yen', '¥', 'ja-JP', 0, 148, 'jpy|yen'],
  ['CNY', 'Chinese yuan', 'CN¥', 'en-US', 2, 7.1, 'cny|rmb|yuan'],
  ['TRY', 'Turkish lira', '₺', 'tr-TR', 2, 41, 'lira'],
  ['ZAR', 'South African rand', 'R ', 'en-US', 2, 17.5, 'zar|rand'],
  ['NGN', 'Nigerian naira', '₦', 'en-US', 2, 1500, 'ngn|naira'],
  ['KES', 'Kenyan shilling', 'KSh ', 'en-US', 2, 129, 'kes|ksh']
];

export const CURRENCIES = LIST.map(([code, name, symbol, locale, dec, perUsd, words]) => ({ code, name, symbol, locale, dec, perUsd, words }));
const BY = {};
CURRENCIES.forEach((c) => { BY[c.code] = c; });
export const currencyInfo = (code) => BY[code] || BY.USD;

// Symbols people type, and the word each one stands for.
export const SYMBOLS = [['﷼', 'sar'], ['ر.س', 'sar'], ['د.إ', 'aed'], ['₹', 'inr'], ['৳', 'bdt'], ['₱', 'php'], ['€', 'eur'], ['£', 'gbp'], ['¥', 'jpy'], ['₺', 'lira'], ['₦', 'ngn'], ['$', 'dollars']];

// Words several currencies share. They mean the account's own currency when it is in the
// family (a PKR account's "rs" is Pakistani rupees), then its second currency, then the default.
const FAMILIES = [
  { words: 'rs\\.?|rupees?', codes: ['INR', 'PKR', 'LKR', 'NPR'] },
  { words: 'dollars?|bucks?', codes: ['USD', 'SGD', 'CAD', 'AUD'] },
  { words: 'pounds?', codes: ['GBP', 'EGP'] },
  { words: 'riyals?|rials?|ryals?', codes: ['SAR', 'QAR', 'OMR'] }
];

let tokCache = null;
/** { src: regex alternation of every currency word, codeOf(word) } for the current account. */
export function currencyTokens() {
  const key = cur.base + '|' + cur.alt;
  if (tokCache && tokCache.key === key) return tokCache;
  const specific = CURRENCIES.map((c) => ({ re: new RegExp('^(?:' + c.words + ')$', 'i'), code: c.code }));
  const fam = FAMILIES.map((f) => ({
    re: new RegExp('^(?:' + f.words + ')$', 'i'),
    code: f.codes.indexOf(cur.base) !== -1 ? cur.base : f.codes.indexOf(cur.alt) !== -1 ? cur.alt : f.codes[0]
  }));
  const all = specific.concat(fam);
  tokCache = {
    key,
    src: CURRENCIES.map((c) => c.words).concat(FAMILIES.map((f) => f.words), SYMBOLS.map((x) => x[0].replace(/[.$]/g, '\\$&'))).join('|'),
    codeOf(word) {
      let w = String(word).trim();
      const sym = SYMBOLS.find((x) => x[0] === w);
      if (sym) w = sym[1];
      for (let i = 0; i < all.length; i++) if (all[i].re.test(w)) return all[i].code;
      return null;
    }
  };
  return tokCache;
}

/** The account's currency setup: base (stored), alt (optional), rate = 1 base in alt. */
export const cur = { base: 'SAR', alt: null };
export function setCurrencies(base, alt) { cur.base = BY[base] ? base : 'USD'; cur.alt = alt && BY[alt] && alt !== cur.base ? alt : null; }

/** A starting rate for a pair, from rough per-dollar values. The person edits it. */
export function suggestedRate(base, alt) {
  const a = currencyInfo(base).perUsd, b = currencyInfo(alt).perUsd;
  const r = b / a;
  return r >= 100 ? Math.round(r) : r >= 1 ? round2(r) : Math.round(r * 10000) / 10000;
}

/** Guess a currency from the device's time zone and language. */
export function guessCurrency() {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* old browser */ }
  const byTz = {
    'Asia/Riyadh': 'SAR', 'Asia/Dubai': 'AED', 'Asia/Qatar': 'QAR', 'Asia/Kuwait': 'KWD', 'Asia/Bahrain': 'BHD', 'Asia/Muscat': 'OMR',
    'Africa/Cairo': 'EGP', 'Asia/Kolkata': 'INR', 'Asia/Calcutta': 'INR', 'Asia/Karachi': 'PKR', 'Asia/Dhaka': 'BDT', 'Asia/Colombo': 'LKR',
    'Asia/Kathmandu': 'NPR', 'Asia/Manila': 'PHP', 'Asia/Jakarta': 'IDR', 'Asia/Kuala_Lumpur': 'MYR', 'Asia/Singapore': 'SGD',
    'Europe/London': 'GBP', 'Asia/Tokyo': 'JPY', 'Asia/Shanghai': 'CNY', 'Europe/Istanbul': 'TRY', 'Africa/Johannesburg': 'ZAR',
    'Africa/Lagos': 'NGN', 'Africa/Nairobi': 'KES', 'Australia/Sydney': 'AUD', 'Australia/Melbourne': 'AUD', 'America/Toronto': 'CAD'
  };
  if (byTz[tz]) return byTz[tz];
  if (/^Europe\//.test(tz)) return 'EUR';
  if (/^America\//.test(tz)) return 'USD';
  return 'USD';
}

/* ---------- formatting ---------- */

const nfCache = {};
function nf(locale, dec, compact) {
  const k = locale + dec + (compact ? 'c' : '');
  if (!(k in nfCache)) {
    try {
      nfCache[k] = new Intl.NumberFormat(locale, compact ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: dec, maximumFractionDigits: dec });
    } catch (e) { nfCache[k] = null; }
  }
  return nfCache[k];
}
function plain(n, dec) { return Math.abs(n).toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** "SAR 1,234.50", "₹1,23,450.00", "−$12.00". */
export function fmtMoney(n, code) {
  const c = currencyInfo(code), f = nf(c.locale, c.dec);
  const v = Math.abs(n);
  return (n < 0 ? '−' : '') + c.symbol + (f ? f.format(v) : plain(v, c.dec));
}
/** Short form for tiles and chart axes: "SAR 6.5K", "₹1.7L". Pass bare=true to leave out the symbol. */
export function fmtMoneyCompact(n, code, bare) {
  const c = currencyInfo(code), v = Math.abs(n);
  let s;
  if (v < 1000) s = String(Math.round(v));
  else { const f = nf(c.locale === 'en-IN' ? 'en-IN' : 'en-US', 0, true); s = f ? f.format(v) : (v / 1000).toFixed(1) + 'K'; }
  return (n < 0 ? '−' : '') + (bare ? '' : c.symbol) + s;
}

/** Amount stored in the base currency → value in `code` (base or alt). */
export function convert(amount, code, rate) { return code === cur.alt ? round2(amount * (rate || 1)) : amount; }
