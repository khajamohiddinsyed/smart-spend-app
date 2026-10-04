# Smart Spend — From Idea to Production

A complete walk-through of how Smart Spend was designed and built: the thinking behind
each decision, the frontend-to-backend architecture, and a **setup guide you can follow
to ship your own version** — even if your app's actual logic is completely different.

Smart Spend is a multi-user personal-finance web app: you create an account, type or paste
spending in plain English (it even reads bank/card SMS), and it syncs across your devices,
works offline, installs on a phone like a native app, and can answer plain-language
questions about your money — all on free cloud infrastructure.

- **Live app:** https://khajamohiddinsyed.github.io/smart-spend-app/
- **Stack:** Vanilla JS (no framework, no build step) · Cloudflare Workers + D1 (SQLite) · Workers AI · PWA · GitHub Pages
- **Size:** ~4,400 lines of frontend JS across 17 modules; one backend Worker file; 4 DB migrations

> 🆕 **New to terms like "Cloudflare Worker", "wrangler", or "PWA"?** Start with the
> [plain-English glossary](#appendix-a--plain-english-glossary) at the bottom — it defines every
> tool with an everyday analogy and, most importantly, **explains how they connect to each other.**

---

## Table of contents

1. [For your resume (ready to copy)](#1-for-your-resume-ready-to-copy)
2. [The thought process: idea → decisions](#2-the-thought-process-idea--decisions)
3. [Architecture at a glance](#3-architecture-at-a-glance)
4. [The frontend](#4-the-frontend)
5. [The backend](#5-the-backend)
6. [Data model & sync (the hard part)](#6-data-model--sync-the-hard-part)
7. [Auth & security](#7-auth--security)
8. [The "smart" bits: parsing & AI](#8-the-smart-bits-parsing--ai)
9. [Full feature list](#9-full-feature-list)
10. [Setup guide: build & ship your own](#10-setup-guide-build--ship-your-own)
11. [Making it yours (where to change the logic)](#11-making-it-yours-where-to-change-the-logic)
12. [What it costs (spoiler: $0)](#12-what-it-costs-spoiler-0)
13. [Lessons learned](#13-lessons-learned)
- [Appendix A — Plain-English glossary](#appendix-a--plain-english-glossary)

---

## 1. For your resume (ready to copy)

**Project one-liner**

> **Smart Spend** — a multi-user, offline-first personal-finance PWA with natural-language
> entry, bank-SMS parsing, cross-device sync, and an AI "ask your spending" assistant, built
> entirely on free serverless infrastructure (Cloudflare Workers + D1 + Workers AI).

**Resume bullets** (edit the numbers to match reality)

- Designed and built a full-stack, multi-user finance app end-to-end — **vanilla-JS PWA
  frontend** and a **serverless Cloudflare Workers + D1 (SQLite) backend** — with **zero
  build step** and **$0 hosting cost**.
- Implemented an **offline-first sync engine** (per-account change sequence, last-write-wins
  merge with deterministic tie-breaks) so edits made on any device reconcile correctly, even
  after being offline.
- Built **secure account auth from scratch**: client-side PBKDF2 key-stretching (200k rounds),
  server-side HMAC verification, hashed bearer-token sessions, recovery codes, and
  brute-force rate-limiting — no third-party auth provider.
- Added an **AI layer with a rules-first, LLM-fallback design** (Cloudflare Workers AI,
  Llama 3.3 70B) for natural-language expense entry and Q&A, where **all monetary math is
  computed deterministically in code and never by the model**, guaranteeing exact answers.
- Wrote a **bank/card SMS parser** that turns raw transaction texts into categorized,
  per-account ledger entries with de-duplication.
- Shipped **role-based admin tooling** (in-app admin area + a CLI) with a full **audit log**
  for user management, plus an automated **test suite** run against the live API.

**Skills demonstrated:** JavaScript (ES modules), REST API design, SQL schema & migrations,
serverless/edge computing, offline-first architecture, data synchronization & conflict
resolution, applied cryptography (PBKDF2/HMAC/SHA-256), PWAs & service workers, LLM
integration, SVG data-visualization, CI-style testing, product thinking.

**Interview talking points** (each maps to a real problem you solved — see the linked
sections): sync conflict resolution ([§6](#6-data-model--sync-the-hard-part)), keeping an
LLM from doing math ([§8](#8-the-smart-bits-parsing--ai)), auth without a provider
([§7](#7-auth--security)), shipping without a build pipeline ([§4](#4-the-frontend)).

---

## 2. The thought process: idea → decisions

Smart Spend started as a **single-user** tracker: one person, data saved in the browser and
backed up to a private GitHub repo with a personal token. That was fine for one developer but
broke the moment it needed real users — **you can't put a token in a public app**, and asking
users to manage tokens is a non-starter. That constraint drove the whole redesign.

Every big decision below was made to hit three goals: **real accounts**, **data that follows
you across devices**, and **genuinely free to run**.

| Decision | Why |
|---|---|
| **Accounts (email + password), not a profile + PIN** | Needed real identity to sync data per user and let people log in from any device. |
| **Cloudflare Workers + D1, not a VPS or Firebase** | Serverless = nothing to run/patch; the free tier (5 GB D1, generous requests) comfortably covers a small user base; one platform for compute, DB, and AI. |
| **Offline-first sync, not "always online"** | A finance app must work on a phone with no signal. Every change saves locally first, then syncs. |
| **No framework, no build step (plain ES modules)** | Fastest possible iteration, no toolchain to maintain, tiny payload, trivial hosting. The browser loads the modules directly. |
| **PWA, not a native app** | Installs to the home screen on Android/iOS with no app-store accounts, fees, or review delays. One codebase for web + "mobile." |
| **Rules-first parsing with an AI fallback** | Common inputs are handled instantly and offline by code; the LLM is only a safety net for unusual phrasing. |
| **The AI never computes money** | LLMs are unreliable at arithmetic. The model only returns a *structured filter*; the app/server does the sums, so totals are always exact. |
| **GitHub Pages for the frontend** | Free static hosting with HTTPS; the app is just static files. |

---

## 3. Architecture at a glance

```
          ┌──────────────────────────────────────────────┐
          │                 USER'S DEVICE                  │
          │                                                │
          │   PWA (installable)   ┌───────────────────┐    │
          │   static HTML/CSS/JS  │  local ledger      │    │
          │   service worker      │  (localStorage)    │    │
          │   ──────────────────  └─────────┬─────────┘    │
          └───────────────────────────────┬─┴──────────────┘
                     GitHub Pages          │  HTTPS  (bearer token)
                   (static hosting)        │  POST /api/sync, /login, ...
                                           ▼
          ┌──────────────────────────────────────────────┐
          │           CLOUDFLARE (free tier)              │
          │                                                │
          │   Worker  (api/src/index.js)                   │
          │   ├── auth, sessions, rate-limiting            │
          │   ├── sync engine                              │
          │   ├── admin endpoints + audit log              │
          │   └── AI endpoints ──────► Workers AI (Llama)  │
          │                                                │
          │   D1 database (SQLite): users, sessions,       │
          │       records, attempts, admin_log             │
          └──────────────────────────────────────────────┘
```

**Two deployables, two homes:** the frontend is static files on GitHub Pages; the backend is
one Worker + one D1 database on Cloudflare. They talk over a small JSON REST API, authenticated
with a bearer token.

---

## 4. The frontend

Plain ES modules loaded straight by the browser — **no React, no bundler, no build step.**
~4,400 lines across 17 focused modules in `app/js/`:

| Module | Responsibility |
|---|---|
| `main.js` | Boot, routing, events, gestures — wires everything together |
| `core.js` | Shared helpers: dates, money, storage, hashing, events |
| `gate.js` | Pre-login screens: welcome, register, login, reset password |
| `auth.js` | Account state + the signed-in session on this device |
| `ledger.js` | The account's ledger on this device (records, balances, totals) |
| `sync.js` | Offline-first sync with the server |
| `views.js` | The four main tabs (each returns HTML + optional chart hook) |
| `sheets.js` | Bottom sheets: quick add, edit, budgets, currency, help, admin |
| `ui.js` | Shared UI: icons, toasts, bottom-sheet mechanics, formatting |
| `parser.js` | Free-text → structured entry ("lunch 250 on card") |
| `bankmsg.js` | Bank/card SMS → entries |
| `categories.js` | Category knowledge base + keyword/typo matching |
| `ask.js` | "Ask your spending" query engine (computes answers locally) |
| `charts.js` | Hand-built SVG charts (donut, bars) |
| `currency.js` | Main currency + optional second currency |
| `appstate.js` | Transient screen state (not persisted) |
| `config.js` | Where the API lives (local vs. production) |

**PWA pieces:** `app/manifest.webmanifest` (name, icons, theme) makes it installable;
`app/sw.js` is the service worker that caches the app shell under a versioned key
(`ss3-<version>`) so it works offline and updates cleanly when the version bumps.

**Why this holds up:** a new contributor can open any one file and understand it in isolation;
there's nothing to compile, so "edit → refresh" is the entire dev loop.

---

## 5. The backend

A single Cloudflare Worker (`api/src/index.js`) exposes a small REST API. Cloudflare routes
every request to the Worker; the Worker talks to the **D1** database (SQLite) and, for the AI
features, to the **Workers AI** binding.

**The API surface:**

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/register` | — | Create an account |
| `POST /api/login` | — | Log in, get a bearer token |
| `POST /api/recover` | — | Reset password with a recovery code |
| `GET /api/me` | user | Current account + synced settings |
| `PATCH /api/me` | user | Update name/currency/categories/budgets |
| `DELETE /api/me` | user | Delete own account |
| `POST /api/logout` | user | End this session |
| `POST /api/password` | user | Change password |
| `POST /api/recovery-code` | user | Issue a new recovery code |
| `POST /api/sync` | user | **The core:** push & pull changes |
| `POST /api/ai/parse` | user | AI fallback for entry text |
| `POST /api/ai/ask` | user | AI fallback for questions |
| `POST /api/admin/unlock` | user | Re-verify password for admin actions |
| `GET /api/admin/users` | admin | List users |
| `POST /api/admin/reset` | admin | New recovery code for a user |
| `POST /api/admin/role` | admin | Promote/demote admin |
| `DELETE /api/admin/user` | admin | Delete a user |
| `GET /api/admin/entries` | admin | Read a user's entries |
| `GET /api/health` | — | Liveness check |

**Tooling:** `wrangler` (Cloudflare's CLI) runs the Worker locally (`wrangler dev`), applies
migrations, and deploys. Admin tasks run from a local CLI (`api/scripts/admin.mjs`) over the
maintainer's own Cloudflare login — nothing admin-only is reachable from the website without
an admin session.

---

## 6. Data model & sync (the hard part)

**Schema** (4 migrations, `api/migrations/`):

- **`users`** — identity, password/recovery hashes, currency settings, and the account's
  synced settings (categories, budgets) each with an `*_updated_at` stamp. `seq` is the last
  change number handed out for this user.
- **`sessions`** — one row per logged-in device; the id is the **SHA-256 of the bearer token**
  (the raw token is never stored). Has an expiry.
- **`records`** — the ledger. Each row is `(user_id, id)` with the entry's JSON in `data`
  (or `deleted = 1` for a deletion), an `updated_at` (the editing device's clock), a `canon`
  tie-breaker, and a server `seq`.
- **`attempts`** — brute-force counters for login/register/recover.
- **`admin_log`** — an append-only audit trail of every admin action.

**The sync engine** is the most interesting piece:

- **Offline-first.** Every change is written to the device immediately and queued; the UI never
  waits on the network.
- **Change numbers (`seq`).** The server assigns an increasing `seq` to each stored change. A
  device remembers the highest `seq` it has seen, so a sync only transfers *what's new* — two
  index lookups, not a full table scan.
- **Conflict resolution: last-write-wins, deterministically.** When the same entry was edited
  on two devices, the one with the greater `updated_at` wins; ties break on `canon` (and a
  deletion beats an edit). This is **commutative and idempotent** — syncs can arrive in any
  order, or twice, and every device converges on the same state.
- **Account-level settings** (name, currency, categories, budgets) travel in the same sync
  response, each with its own `*_updated_at` so one device changing the budget doesn't clobber
  another device's category edit.

> **This is the section to talk about in interviews.** "How do you merge edits from multiple
> offline devices without a server clock you can trust?" → per-field timestamps + a
> deterministic tie-break, so the merge is order-independent.

---

## 7. Auth & security

Built from scratch, no auth provider:

- **Password stretching on the client.** The browser runs **PBKDF2-SHA256, 200,000 rounds**
  over the password (salted with the user's email), so the raw password never leaves the
  device.
- **Verification on the server.** The server stores an **HMAC-SHA256** of that stretched key
  under a per-user server salt — so even a database leak doesn't reveal the stretched key.
- **Sessions.** The bearer token is random; the server stores only its **SHA-256**. Sessions
  expire (180 days) and can be revoked.
- **Recovery codes.** A 20-character Crockford base32 code (hashed the same way) lets a user
  reset a forgotten password without email.
- **Brute-force brakes.** Login/register/recover are rate-limited per key via the `attempts`
  table.
- **Admin actions are double-gated.** An admin must re-enter their password (`/api/admin/unlock`)
  before destructive actions, and every action is written to `admin_log`.
- **Least privilege everywhere.** CORS is restricted to known origins; the maintainer's
  Cloudflare login uses a **minimal OAuth scope set** (account/user read, Workers, D1, AI —
  nothing more).

---

## 8. The "smart" bits: parsing & AI

Two layers, same philosophy: **code first, AI only as a fallback, and the AI never does math.**

1. **Free-text entry** (`parser.js`): "lunch 250 on card", "added 500 to my card", "coffee 12"
   → `{amount, type, category, account, title}`. Handles amounts, money-in vs money-out,
   accounts/cards, and category guessing with typo-tolerant keyword matching.
2. **Bank/card SMS** (`bankmsg.js`): pastes like *"Your A/c XX5348 debited by Rs.120.00…"*
   become categorized, per-account entries, with de-duplication.
3. **Natural-language Q&A** (`ask.js` + `POST /api/ai/ask`): "highest amount spent in one day",
   "how much on food this week". A local parser handles the common shapes with **no network**;
   anything unusual goes to the LLM.

**The key design rule:** when the AI is used, it only returns a **structured filter** (metric,
category, period, grouping…). The app or Worker then computes the number from the ledger. The
model (**Cloudflare Workers AI, Llama 3.3 70B**) is never trusted with arithmetic — so answers
are always exact, and the feature still works offline for ordinary questions.

---

## 9. Full feature list

**For users:** email/password accounts · password reset via recovery code · pick a currency at
sign-up (any currency; optional second currency) · type or paste expenses in plain English ·
paste bank/card SMS · custom categories · monthly budgets · insights (donut + bar charts,
per-category drill-down) · running balance that carries month-to-month · "ask your spending"
Q&A · offline use · installable on phone (PWA) · syncs across devices.

**For admins:** in-app admin area + CLI · list users · reset a user's recovery code · promote/
demote admins · delete accounts · read a user's entries (with audit logging) · full audit trail.

**For developers:** no build step · automated API test suite · migrations · one-command deploy.

---

## 10. Setup guide: build & ship your own

This is the generic recipe. Your app's *domain logic* (what the records mean) will differ —
[§11](#11-making-it-yours-where-to-change-the-logic) shows where to change it — but the
**skeleton** (serverless backend, D1, auth, sync, PWA, free hosting) is reusable as-is.

### Prerequisites

- **Node.js** (18+) and **git**
- A free **Cloudflare account** (you create this yourself — it needs your email and, for
  verification, a card; sign-up is on cloudflare.com)
- A **GitHub account** for static hosting (or any static host)

### A. Backend (Cloudflare Worker + D1)

```bash
# 1. Install the Cloudflare CLI and log in (opens a browser)
npm install -g wrangler
wrangler login

# 2. Create a D1 (SQLite) database — note the database_id it prints
wrangler d1 create your-app
```

Create `api/wrangler.toml`:

```toml
name = "your-app-api"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = true

[vars]
ALLOWED_ORIGINS = "https://<you>.github.io,http://localhost:8797"

[[d1_databases]]
binding = "DB"
database_name = "your-app"
database_id = "PASTE-THE-ID-FROM-STEP-2"
migrations_dir = "migrations"

[ai]              # only if you want the AI features
binding = "AI"
remote = true
```

```bash
# 3. Apply the database schema
wrangler d1 migrations apply your-app --local     # local dev DB
wrangler d1 migrations apply your-app --remote     # live DB

# 4. Run it locally
npm run dev        # -> http://localhost:8787

# 5. Deploy to the world
npm run deploy     # prints https://your-app-api.<subdomain>.workers.dev

# 6. Create your first admin (after you've registered an account in the app)
npm run admin -- promote you@example.com
```

> **Secrets.** Never hard-code real keys. Use `wrangler secret put <NAME>` for anything
> sensitive; use test values locally.

### B. Frontend (static PWA)

```bash
# 1. Point the app at your API — edit app/js/config.js
#    (local dev URL vs your deployed Worker URL)

# 2. Serve the app folder locally on the port in ALLOWED_ORIGINS
npx http-server app -p 8797      # or any static server

# 3. Deploy: push the repo and enable GitHub Pages (Settings → Pages),
#    serving the app folder (or move app/ to /docs or the repo root).
```

**Updating a live PWA:** bump the version in `app/sw.js` (`VERSION`) and `app/js/core.js`
(`APP_VERSION`) on every release so the service worker fetches fresh files instead of serving
stale cache. (This is the single most common PWA gotcha.)

### C. Testing

```bash
cd api
API=https://your-app-api.<subdomain>.workers.dev npm test
```

The tests register throwaway accounts, exercise the endpoints, and clean up after themselves.

### D. Saving & publishing new changes (git)

Whenever you've made changes and want to save them to GitHub (which also redeploys the
frontend on GitHub Pages):

```bash
# from the repo root
git add -A                                  # stage every change
git commit -m "Describe what you changed"   # save a snapshot with a message
git push                                     # upload it to GitHub
```

Backend code changes also need a redeploy to take effect:

```bash
cd api && npm run deploy                     # push the Worker live
```

And if you changed anything in `app/`, bump the two version numbers first (so phones fetch the
new files instead of the cached ones): `VERSION` in `app/sw.js` and `APP_VERSION` in
`app/js/core.js`. A typical "ship a frontend change" sequence is therefore:

```bash
# 1. bump VERSION in app/sw.js and APP_VERSION in app/js/core.js
git add -A && git commit -m "Describe the change" && git push
```

> First time only, git needs to know who you are and where to push:
> `git config --global user.name "Your Name"`,
> `git config --global user.email "you@example.com"`, and the repo must have a remote
> (`git remote add origin https://github.com/<you>/<repo>.git`).

---

## 11. Making it yours (where to change the logic)

Keep the skeleton, swap the domain. For a *different* app (say, the training/course app):

| You keep (reuse as-is) | You change (your domain) |
|---|---|
| Accounts, sessions, recovery, rate-limiting (`auth` + `users`/`sessions`/`attempts`) | What a "record" is: edit the record JSON shape and the UI that creates it |
| The sync engine (`records` table + `/api/sync`) | Add your own tables via new migrations (`000X_*.sql`) |
| Admin area + audit log pattern | Which admin actions exist |
| PWA shell, service worker, hosting | Screens, branding, copy, icons |
| Rules-first + AI-fallback pattern | Your own parsers/queries (or drop AI entirely) |

**Rule of thumb:** the *plumbing* (auth, sync, offline, PWA, free hosting, migrations, admin,
tests) is generic infrastructure you copy; the *records and screens* are your product.

---

## 12. What it costs (spoiler: $0)

Everything runs on free tiers:

- **Cloudflare D1:** 5 GB storage free. (Smart Spend uses ~82 KB — about 0.0016%.)
- **Cloudflare Workers:** generous free request allowance.
- **Workers AI:** 10,000 neurons/day free (Llama 3.3 70B ≈ 27 neurons per question → ~370
  AI questions/day before the free limit; ordinary questions are answered locally and cost 0).
- **GitHub Pages:** free static hosting with HTTPS.

For a handful of users, the realistic ceiling is request/row-write counts, **not** storage —
and you're nowhere near any of them.

---

## 13. Lessons learned

- **Constraints clarify architecture.** "A public app can't hold a secret token" is the single
  sentence that produced the entire accounts + serverless design.
- **Offline-first is a data-model decision, not a feature you bolt on.** Deciding early that the
  device writes first and the server reconciles shaped the whole sync protocol.
- **Let the LLM classify, not calculate.** Keeping all math in deterministic code made the AI
  features trustworthy and kept them working offline.
- **No build step is a feature.** Zero toolchain meant zero toolchain rot and an instant dev
  loop — worth it for a project this size.
- **Version your service worker or suffer.** Nearly every "my change isn't showing up" was a
  stale PWA cache; a disciplined version bump fixed it for good.

---

*Written as both a portfolio case study and a reusable setup guide. The infrastructure here
is domain-agnostic — clone the skeleton, swap the records, ship your own.*

---

## Appendix A — Plain-English glossary

No code here — just the tools, services, and ideas, each with an everyday analogy. If you've
never built an app before, read this first; the rest of the document will make much more sense.

### The building blocks

- **Frontend** — the part you see and tap: screens, buttons, charts. It runs *in your phone or
  browser*. Think: the dining area of a restaurant.
- **Backend** — the part you *don't* see: it stores data and does the heavy lifting on a
  computer somewhere else. Think: the kitchen.
- **Server** — a computer, always on, that the backend runs on. Traditionally you rent and
  babysit one.
- **Serverless** — you *still* use servers, but you never rent, run, or patch one. You just
  upload your code and the cloud runs it on demand, charging only when it's used. Think: taking
  a taxi instead of buying and maintaining a car.
- **Cloudflare** — a large cloud company whose free tier we use for the entire backend
  (computing, database, and AI, all in one place).
- **Cloudflare Worker** — Cloudflare's serverless code. It's a small program that "wakes up"
  whenever a request comes in (e.g. "log me in", "save this expense"), does the job, and goes
  back to sleep. It *is* our backend. Think: a vending machine — it does nothing until you press
  a button, then instantly serves you.
- **Edge / CDN** — Cloudflare runs your Worker in data centers all over the world, so it
  executes *close to the user* and feels fast everywhere. "The edge" just means "the server
  nearest the user."
- **Database** — the organized place where data is permanently stored (users, expenses…).
  Think: a giant, searchable filing cabinet.
- **Cloudflare D1 / SQLite** — our specific database. D1 is Cloudflare's hosted version of
  **SQLite**, a popular, lightweight database. This is where every account and entry lives.
- **Workers AI** — Cloudflare's service that runs AI models for you. We use it only as a
  fallback to understand unusual phrases.
- **LLM (Large Language Model)** — the kind of AI behind ChatGPT-style tools (we use "Llama
  3.3"). Great at understanding language, unreliable at math — which is why in this app it only
  *interprets* questions and never *calculates* money.
- **Neuron** — Cloudflare's unit for measuring AI usage (like how electricity is measured in
  kilowatt-hours). The free tier gives 10,000 neurons a day.
- **Wrangler** — Cloudflare's command-line tool (you type commands into a terminal). It's the
  remote control for your backend: it runs your Worker on your own computer for testing, sets up
  the database, and publishes (deploys) your code to the world. If the Worker is the vending
  machine, wrangler is how you stock it and ship it.
- **API** — the menu of things the backend can do and the rules for asking (e.g. "to log in,
  send your email and password to *this* address"). The frontend and backend talk *only*
  through the API. Think: a restaurant menu — the waiter (frontend) can only order what the menu
  (API) lists.
- **Endpoint** — one item on that menu, i.e. one specific address + action, like
  `POST /api/login`.
- **REST** — just a common, tidy *style* of designing those endpoints. Nothing more exotic.
- **JSON** — the simple text format the frontend and backend use to exchange data (names and
  values, like a labeled form). You don't need to read it; just know it's the "shipping
  container" the two sides pass back and forth.
- **PWA (Progressive Web App)** — a website built so it can be *installed* to a phone's home
  screen and used like a normal app, including offline — with no app store, no fees, no review.
  It's how this app is "mobile" without being a native app.
- **Service worker** — a tiny helper the PWA installs in the browser. It keeps a copy of the
  app so it loads instantly and works with no internet. (Its one quirk: you must give it a new
  version number when you change the app, or phones keep showing the old copy — see the
  version-bump note.)
- **Static hosting** — serving plain, pre-made files (the frontend) to anyone who visits. Cheap
  or free, because the host doesn't have to *compute* anything, just hand out files.
- **GitHub** — a website where code lives, with version history. A **repository ("repo")** is
  one project's folder there.
- **GitHub Pages** — GitHub's free static hosting. We keep the frontend files in the repo and
  GitHub serves them to the world at a web address, for free.
- **git / commit / push** — **git** is the tool that tracks every change to your code. A
  **commit** is one saved snapshot with a short note of what changed; a **push** uploads your
  commits to GitHub. (For this project, pushing also updates the live site.) Think: *commit* =
  "save a labeled version", *push* = "publish it."
- **Migration** — a dated, step-by-step script that sets up or changes the database's structure
  (e.g. "add a 'budgets' column"). Running the migrations builds the filing cabinet's drawers in
  the right order, and keeps every copy of the database identical.
- **Environment variable / Secret** — a setting kept *outside* the code (like the list of
  allowed website addresses), and a **secret** is a sensitive one (like a password or API key)
  that must never be written into the code or shared.
- **Token / Bearer token** — a temporary digital "wristband" the backend gives you when you log
  in. Your app shows it on every later request to prove it's you, so you don't resend your
  password each time.
- **Session** — the record of one logged-in device, tied to that token. Logging out or expiry
  ends the session.
- **OAuth / Scope** — **OAuth** is the "Log in with Google/Cloudflare" style of granting access
  without sharing your password. A **scope** is *how much* access you grant — we deliberately
  grant the backend tool the *minimum* scopes it needs, nothing more.
- **CORS** — a browser safety rule about *which websites* are allowed to call your API. We
  explicitly list our own site, so random websites can't use our backend.
- **Offline-first** — a design where the app saves everything on your device *first* and never
  waits for the internet; it syncs to the cloud afterward whenever a connection is available.
- **Sync** — keeping the data on your phone, your laptop, and the cloud all matching, even after
  edits were made in different places. (The clever part — how it merges conflicting edits — is
  explained in [§6](#6-data-model--sync-the-hard-part).)

### How the pieces connect (the integrations — this is the important part)

Individual tools are easy; the magic is in how they're wired together. Here's the whole system
as a set of hand-offs:

- **Your phone ↔ the backend.** The **frontend** (on your phone) sends requests to the
  **Worker** over the internet, using the **API** menu, carrying your **token** to prove who you
  are. The Worker replies with **JSON**. *Nothing* else connects these two — the API is the only
  door.
- **The Worker ↔ the database.** When the Worker needs to save or look up data, it reads/writes
  the **D1** database. Cloudflare "binds" the database to the Worker, so the Worker can reach it
  directly without passwords in the code.
- **The Worker ↔ the AI.** For an unusual phrase, the Worker asks **Workers AI** to interpret it,
  gets back a structured answer, and then does the actual math itself. Again, Cloudflare "binds"
  the AI to the Worker.
- **You (the developer) ↔ Cloudflare.** You use **wrangler** from your computer to run the Worker
  locally, apply **migrations** to the database, and **deploy** the finished Worker to
  Cloudflare's **edge**.
- **You ↔ GitHub ↔ your users.** You **commit** and **push** the frontend files to a **GitHub
  repo**; **GitHub Pages** then serves those files to anyone who visits — that's how users get
  the app. Pushing new code is also how you release updates (with a **service-worker** version
  bump so phones pick them up).

**One concrete example — what happens when you add an expense:**

1. You type "lunch 250 on card" in the **frontend** and tap save.
2. The frontend saves it on your device immediately (**offline-first**) — no waiting.
3. Later (or instantly, if online) the frontend calls the **sync endpoint** on the **Worker**,
   showing your **token**.
4. The Worker writes the new entry into the **D1 database** and notes a change number.
5. Your other devices call sync, receive that change, and now show the same expense (**sync**).
6. If you'd typed something unusual, step 1 would have briefly asked **Workers AI** to interpret
   the words — but the amount would still be handled by code, never the AI.

That chain — *frontend → API → Worker → database (+ AI), with git/GitHub Pages delivering the
app and wrangler delivering the backend* — **is the entire system.**
