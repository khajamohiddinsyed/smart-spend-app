// Offline support: the app shell is cached; everything else goes to the network.
// The API is never cached. Cache names start with "ss3-" so this app never touches the caches
// of another app on the same github.io origin.
const VERSION = 'ss3-1.10';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/main.js', './js/core.js', './js/categories.js', './js/parser.js', './js/ledger.js', './js/currency.js', './js/auth.js', './js/config.js',
  './js/sync.js', './js/ui.js', './js/charts.js', './js/views.js', './js/sheets.js', './js/gate.js', './js/appstate.js', './js/bankmsg.js', './js/ask.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-64.png'
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never precaches stale files.
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ss3-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // the API: straight to the network
  if (req.mode === 'navigate') {
    // Network first for the page so updates arrive; cached copy when offline.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put('./index.html', copy));
      return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  // Cache first for the shell files, filling the cache as we go.
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});
