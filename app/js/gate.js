// Before the app: welcome, create account, log in, reset password, and the recovery code.

import { $, esc, haptic } from './core.js';
import { register, login, recover, lastEmail, MIN_PASSWORD } from './auth.js';
import { CURRENCIES, guessCurrency, suggestedRate } from './currency.js';
import { icon } from './ui.js';

const g = { open: false, screen: 'welcome', err: '', busy: false, code: null, then: null, email: '' };
let hooks = { onSignedIn: () => {} };

export function initGate(h) {
  hooks = Object.assign(hooks, h);
  const root = $('#gate');
  root.addEventListener('click', (e) => {
    const a = e.target.closest('[data-g]');
    if (a) action(a.getAttribute('data-g'), a);
  });
  root.addEventListener('submit', (e) => {
    e.preventDefault();
    if (e.target.id === 'regForm') doRegister();
    if (e.target.id === 'loginForm') doLogin();
    if (e.target.id === 'forgotForm') doRecover();
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'rgCur' || e.target.id === 'rgAlt') rateRow();
    if (e.target.id === 'rcSaved') { const b = $('#rcGo'); if (b) b.disabled = !e.target.checked; }
  });
  document.addEventListener('keydown', (e) => {
    if (g.open && e.key === 'Escape' && (g.screen === 'register' || g.screen === 'login')) show('welcome');
    if (g.open && e.key === 'Escape' && g.screen === 'forgot') show('login');
  });
}

export const gateOpen = () => g.open;
export const gateScreen = () => g.screen;

export function show(screen, o = {}) {
  Object.assign(g, { open: true, screen, err: o.err || '', busy: false, code: o.code || null, then: o.then || null, email: o.email != null ? o.email : g.email });
  const root = $('#gate');
  root.hidden = false;
  $('#app').setAttribute('inert', '');
  render();
  root.scrollTop = 0;
  setTimeout(() => { const f = root.querySelector('[data-autofocus]'); if (f && window.matchMedia('(pointer: fine)').matches) f.focus({ preventScroll: true }); }, 40);
}

export function close() {
  g.open = false;
  $('#gate').hidden = true;
  $('#app').removeAttribute('inert');
}

const brand = '<div class="brand"><span class="logo">' + icon('logo') + '</span>Smart Spend</div>';
const back = (to, label) => '<button class="g-back" type="button" data-g="' + to + '">' + icon('back') + label + '</button>';
const msg = (id) => '<div class="msg" id="' + id + '" role="alert">' + esc(g.err) + '</div>';

function currencyOptions(selected, none) {
  return (none ? '<option value="">None</option>' : '') +
    CURRENCIES.map((c) => '<option value="' + c.code + '"' + (c.code === selected ? ' selected' : '') + '>' + c.code + ' · ' + esc(c.name) + '</option>').join('');
}
function passwordField(id, label, autocomplete, hint) {
  return '<label class="field">' + label + '<span class="pw"><input class="input" id="' + id + '" type="password" autocomplete="' + autocomplete + '" minlength="' + MIN_PASSWORD + '" required>' +
    '<button type="button" class="pw-eye" data-g="eye" data-for="' + id + '" aria-label="Show password">Show</button></span>' + (hint ? '<span class="help">' + hint + '</span>' : '') + '</label>';
}

function render() {
  let h = '';
  if (g.screen === 'welcome') {
    h = brand +
      '<h1 class="g-title">Know where your money goes.</h1>' +
      '<p class="g-sub">Type what you spent or received in plain words. Smart Spend turns it into tidy entries, sorts them into categories and shows you the month at a glance.</p>' +
      '<ul class="g-points">' +
      '<li>' + icon('spark') + '<span><b>Just type it.</b> “Spent 40 on fuel and 18 on coffee” becomes two entries.</span></li>' +
      '<li>' + icon('insights') + '<span><b>See the month.</b> Money in and out, where it went, budgets that warn you early.</span></li>' +
      '<li>' + icon('sync') + '<span><b>On every device.</b> Log in on your phone and computer; entries stay in sync, even offline.</span></li></ul>' +
      '<div class="g-actions"><button class="btn primary block" data-g="to-register" data-autofocus>Create a free account</button>' +
      '<button class="btn block" data-g="to-login">I have an account · Log in</button></div>';
  } else if (g.screen === 'register') {
    const base = guessCurrency();
    h = back('to-welcome', 'Back') + brand +
      '<h1 class="g-title">Create your account</h1><p class="g-sub">Free, and takes a minute. You can change the currency later in Settings.</p>' +
      '<form class="form" id="regForm" novalidate>' +
      '<label class="field">Your name<input class="input" id="rgName" autocomplete="name" autocapitalize="words" maxlength="40" required data-autofocus></label>' +
      '<label class="field">Email<input class="input" id="rgEmail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" required></label>' +
      passwordField('rgPass', 'Password', 'new-password', 'At least ' + MIN_PASSWORD + ' characters.') +
      '<label class="field">Your currency<select class="input" id="rgCur">' + currencyOptions(base) + '</select><span class="help">Every amount is recorded in this currency.</span></label>' +
      '<label class="field"><span>Also show amounts in <span class="dim">(optional)</span></span><select class="input" id="rgAlt">' + currencyOptions('', true) + '</select>' +
      '<span class="help">For example, earn in riyals and think in rupees. Leave it at None if you use one currency.</span></label>' +
      '<div id="rgRateRow"></div>' +
      msg('rgMsg') +
      '<button class="btn primary block" type="submit" id="rgGo">Create account</button>' +
      '<button class="gate-link" type="button" data-g="to-login">Already have an account? Log in</button></form>' +
      '<p class="g-fine">Your password is scrambled on this device before it’s sent, so it never reaches the server. Your entries are stored on the Smart Spend server so they can sync between your devices.</p>';
  } else if (g.screen === 'login' || g.screen === 'relogin') {
    const re = g.screen === 'relogin';
    h = (re ? '' : back('to-welcome', 'Back')) + brand +
      '<h1 class="g-title">' + (re ? 'Log in again' : 'Welcome back') + '</h1>' +
      '<p class="g-sub">' + (re ? 'Your session ended. Your entries on this device are safe and will sync once you’re in.' : 'Log in to see your entries on this device.') + '</p>' +
      '<form class="form" id="loginForm" novalidate>' +
      '<label class="field">Email<input class="input" id="lgEmail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="' + esc(g.email || lastEmail()) + '" required' + (g.email || lastEmail() ? '' : ' data-autofocus') + '></label>' +
      passwordField('lgPass', 'Password', 'current-password') +
      msg('lgMsg') +
      '<button class="btn primary block" type="submit" id="lgGo">Log in</button>' +
      '<button class="gate-link" type="button" data-g="to-forgot">Forgot your password?</button>' +
      (re ? '' : '<button class="gate-link" type="button" data-g="to-register">New here? Create an account</button>') + '</form>';
  } else if (g.screen === 'forgot') {
    h = back('to-login', 'Log in') + brand +
      '<h1 class="g-title">Reset your password</h1><p class="g-sub">Use the recovery code you saved when you created the account. Your entries stay as they are.</p>' +
      '<form class="form" id="forgotForm" novalidate>' +
      '<label class="field">Email<input class="input" id="fgEmail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" value="' + esc(g.email || lastEmail()) + '" required></label>' +
      '<label class="field">Recovery code<input class="input mono" id="fgCode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" data-autofocus></label>' +
      passwordField('fgPass', 'New password', 'new-password', 'At least ' + MIN_PASSWORD + ' characters.') +
      msg('fgMsg') +
      '<button class="btn primary block" type="submit" id="fgGo">Reset password</button></form>' +
      '<p class="g-fine">Lost the recovery code too? The password can’t be reset without it, because nobody else can prove the account is yours.</p>';
  } else if (g.screen === 'recovery') {
    h = brand +
      '<h1 class="g-title">Save your recovery code</h1>' +
      '<p class="g-sub">If you forget your password, this code is the only way back into your account. Write it down or keep it in your password manager.</p>' +
      '<div class="rc-code mono" id="rcCode">' + esc(g.code) + '</div>' +
      '<div class="g-row"><button class="btn" type="button" data-g="copy-code">' + icon('check') + 'Copy</button></div>' +
      '<div class="msg info" id="rcMsg"></div>' +
      '<label class="check"><input type="checkbox" id="rcSaved"><span>I’ve saved it somewhere safe<small>You can make a new one later in Settings.</small></span></label>' +
      '<button class="btn primary block" id="rcGo" data-g="code-done" disabled>Continue</button>';
  } else { g.screen = 'welcome'; render(); return; }
  $('#gate').innerHTML = '<div class="gate-card">' + h + '</div>';
  if (g.screen === 'register') rateRow();
}

function rateRow() {
  const row = $('#rgRateRow');
  if (!row) return;
  const base = $('#rgCur').value, alt = $('#rgAlt').value;
  if (!alt || alt === base) { row.innerHTML = alt === base && alt ? '<p class="help">That’s the same as your currency; you can leave it at None.</p>' : ''; return; }
  const old = $('#rgRate');
  const keep = old && old.dataset.pair === base + alt ? old.value : suggestedRate(base, alt);
  row.innerHTML = '<label class="field">Exchange rate<span class="rate-inline" style="justify-content:flex-start"><span class="muted">1 ' + base + ' =</span>' +
    '<input class="input num" id="rgRate" data-pair="' + base + alt + '" type="number" inputmode="decimal" step="any" min="0" value="' + keep + '" style="max-width:140px"><span class="muted">' + alt + '</span></span>' +
    '<span class="help">A rough starting value. Set the rate you actually use; you can change it any time.</span></label>';
}

const setMsg = (id, text, tone) => { const m = $('#' + id); if (m) { m.className = 'msg' + (tone ? ' ' + tone : ''); m.textContent = text; } };
function busy(id, on, label) { const b = $('#' + id); if (b) { b.disabled = on; if (label) b.textContent = label; } }

async function doRegister() {
  const name = $('#rgName').value.trim(), email = $('#rgEmail').value.trim(), password = $('#rgPass').value;
  const currency = $('#rgCur').value, alt = $('#rgAlt').value && $('#rgAlt').value !== currency ? $('#rgAlt').value : null;
  const rate = alt ? parseFloat($('#rgRate').value) : null;
  if (!name) return setMsg('rgMsg', 'Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return setMsg('rgMsg', 'Enter a valid email address.');
  if (password.length < MIN_PASSWORD) return setMsg('rgMsg', 'Use at least ' + MIN_PASSWORD + ' characters for the password.');
  if (alt && !(rate > 0)) return setMsg('rgMsg', 'Enter the exchange rate, or set “Also show amounts in” to None.');
  busy('rgGo', true, 'Creating your account…');
  setMsg('rgMsg', '');
  try {
    const code = await register({ name, email, password, currency, altCurrency: alt, rate });
    haptic(10);
    show('recovery', { code, then: 'new' });
  } catch (e) {
    busy('rgGo', false, 'Create account');
    setMsg('rgMsg', e.message);
    if (e.code === 'email_taken') g.email = email;
  }
}

async function doLogin() {
  const email = $('#lgEmail').value.trim(), password = $('#lgPass').value;
  if (!email) return setMsg('lgMsg', 'Enter your email.');
  busy('lgGo', true, 'Logging in…');
  setMsg('lgMsg', '');
  try {
    await login(email, password);
    haptic(10);
    close();
    hooks.onSignedIn(false);
  } catch (e) {
    busy('lgGo', false, 'Log in');
    g.email = email;
    setMsg('lgMsg', e.message);
  }
}

async function doRecover() {
  const email = $('#fgEmail').value.trim(), code = $('#fgCode').value, password = $('#fgPass').value;
  if (!email || !code.trim()) return setMsg('fgMsg', 'Enter your email and recovery code.');
  busy('fgGo', true, 'Resetting…');
  setMsg('fgMsg', '');
  try {
    const next = await recover(email, code, password);
    show('recovery', { code: next, then: 'reset' });
  } catch (e) {
    busy('fgGo', false, 'Reset password');
    setMsg('fgMsg', e.message);
  }
}

async function action(act, el) {
  if (act === 'to-welcome') show('welcome');
  else if (act === 'to-register') show('register');
  else if (act === 'to-login') show('login');
  else if (act === 'to-forgot') show('forgot', { email: ($('#lgEmail') && $('#lgEmail').value) || g.email });
  else if (act === 'eye') {
    const inp = $('#' + el.getAttribute('data-for'));
    const showing = inp.type === 'text';
    inp.type = showing ? 'password' : 'text';
    el.textContent = showing ? 'Show' : 'Hide';
    el.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  } else if (act === 'copy-code') {
    try { await navigator.clipboard.writeText(g.code); setMsg('rcMsg', 'Copied. Paste it into your notes or password manager.', 'info'); }
    catch (e) {
      const r = document.createRange(); r.selectNodeContents($('#rcCode'));
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      setMsg('rcMsg', 'Selected. Copy it with your keyboard or long-press.', 'info');
    }
  } else if (act === 'code-done') {
    const then = g.then;
    close();
    hooks.onSignedIn(then === 'new', then === 'reset' ? 'Password changed. Keep the new recovery code safe; the old one no longer works.' : null);
  }
}

