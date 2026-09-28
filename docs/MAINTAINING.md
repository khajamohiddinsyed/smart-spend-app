# Maintaining Smart Spend

Notes for the maintainer. The live service runs on the maintainer's Cloudflare account.

- Local API: `cd api && npm install && npm run db:local && npm run dev` (port 8787). Serve the site with `python3 -m http.server 8797 --bind 127.0.0.1` and open http://127.0.0.1:8797/app/. On localhost the app uses the local API.
- Tests: `cd api && npm test` against the local API, or `API=https://smart-spend-api.smart-spend-api.workers.dev node test/api.test.mjs` against production. The tests delete the accounts they create.
- Deploy the API: `cd api && npm run db:remote && npm run deploy`.
- Release the app: bump `APP_VERSION` in `app/js/core.js` and `VERSION` in `app/sw.js`, then push `main`. GitHub Pages serves it.
- Storage keys start with `ss3.` and cache names with `ss3-` because another app shares the github.io origin.

## Helping people with their accounts

These run from the maintainer's computer with the maintainer's Cloudflare login (`npx wrangler login`); the website has no admin access. Run them in `api/`.

```bash
npm run admin -- list                  # everyone who has signed up, with entry counts
npm run admin -- reset  <email>        # locked out: makes a new recovery code
npm run admin -- delete <email>        # removes the account and every entry
```

- **Forgot password and lost the recovery code:** first make sure the request really comes from them (call them, for instance). Then run `reset` and send them the printed code privately. They tap **Forgot your password?**, enter their email, the code and a new password. Their entries aren't touched, the old code stops working, their other devices are logged out, and any login lockout is cleared.
- **Use `delete` only when someone asks for their account to be removed.** It can't be undone. For a forgotten password, use `reset`.
- Each command asks you to confirm by typing (`reset`, or the email address for `delete`). Add `--local` to work on the local development database. `node test/admin.test.mjs` checks the commands end to end with a throwaway account.
