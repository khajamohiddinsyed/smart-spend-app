# Maintaining Smart Spend

Notes for the maintainer. The live service runs on the maintainer's Cloudflare account.

- Local API: `cd api && npm install && npm run db:local && npm run dev` (port 8787). Serve the site with `python3 -m http.server 8797 --bind 127.0.0.1` and open http://127.0.0.1:8797/app/. On localhost the app uses the local API.
- Tests: `cd api && npm test` against the local API, or `API=https://smart-spend-api.smart-spend-api.workers.dev node test/api.test.mjs` against production. The tests delete the accounts they create.
- Deploy the API: `cd api && npm run db:remote && npm run deploy`.
- Release the app: bump `APP_VERSION` in `app/js/core.js` and `VERSION` in `app/sw.js`, then push `main`. GitHub Pages serves it.
- Storage keys start with `ss3.` and cache names with `ss3-` because another app shares the github.io origin.
