# Smart Spend

Type what you spent or received in plain words ("spent 40 on fuel and 18 coffee") and Smart Spend turns it into entries, sorts them into categories, and shows where the money went. Free accounts, any of 27 currencies, works offline, syncs across devices.

**Live:** https://khajamohiddinsyed.github.io/smart-spend-app/

## What's here

| Folder | What it is |
|---|---|
| `app/` | The web app: plain ES modules, no build step, installable (PWA), works offline. Served by GitHub Pages. |
| `api/` | The server: one Cloudflare Worker with a D1 (SQLite) database. Accounts, sessions and sync. |
| `index.html` | The landing page. |
| `docs/API.md` | The API and the sync rules. |

## How it fits together

- **Accounts.** Email and password. The browser stretches the password (PBKDF2-SHA256, 200,000 rounds) and sends only the result; the Worker stores an HMAC of that with its own salt. At sign-up each person gets a recovery code, the only way to reset a password (there's no email service).
- **Offline first.** Entries are saved on the device immediately, then sent to the Worker. Each accepted change gets a per-account change number, so a device only downloads what it hasn't seen. When the same entry changed on two devices, the latest edit wins.
- **Currencies.** Each account has a main currency (amounts are stored in it) and an optional second one with its own rate. The parser reads symbols and words for both (₹, rs, rupees, $, dirham, riyals…).

## Run it locally

```bash
cd api && npm install && npm run db:local && npm run dev
```

In another terminal, serve the site on port 8797 (the API allows that origin):

```bash
python3 -m http.server 8797 --bind 127.0.0.1
```

Open http://127.0.0.1:8797/app/. On localhost the app talks to the local Worker at http://127.0.0.1:8787. API tests: `cd api && npm test` (with `npm run dev` running).

## Deploy

```bash
cd api
npx wrangler login
npx wrangler d1 create smart-spend        # put the database_id it prints into wrangler.toml
npm run db:remote
npm run deploy                            # prints https://smart-spend-api.<subdomain>.workers.dev
```

Put that URL in `app/js/config.js` and in the `connect-src` of `app/index.html`, bump `VERSION` in `app/sw.js`, and push. GitHub Pages serves the rest.

## Limits on Cloudflare's free plan

100,000 Worker requests a day (an active person makes roughly 20–40), 5 GB of D1 storage, and 100,000 database writes a day. That's a few thousand people using it every day. Beyond that, the Workers Paid plan ($5/month) raises all of these.
