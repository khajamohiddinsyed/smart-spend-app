# Smart Spend API

Base URL: `https://smart-spend-api.smart-spend-api.workers.dev`. JSON in and out. Authenticated calls send `Authorization: Bearer <token>`. Only the origins in `ALLOWED_ORIGINS` may call it from a browser.

Errors are `{ "error": "<code>", "message": "<text to show>" }` with a 4xx/5xx status. A `401` with `signed_out` means the session ended; the app asks the person to log in again and keeps their local entries.

## Passwords

`authKey` = hex of PBKDF2-HMAC-SHA256(password, salt = `"smart-spend-auth|" + lower(email)`, 200,000 rounds, 32 bytes), computed in the browser. The server stores `HMAC-SHA256(key = random salt, authKey)`. Recovery codes are 20 Crockford base32 characters, stored the same way; input is case-insensitive, and spaces or dashes are ignored.

Login, registration and recovery are rate-limited per IP and per email (15-minute windows).

## Endpoints

| Call | Body | Returns |
|---|---|---|
| `POST /api/register` | `email, name, authKey, currency, altCurrency?, rate?` | `token, user, recoveryCode` |
| `POST /api/login` | `email, authKey` | `token, user` |
| `POST /api/recover` | `email, recoveryCode, newAuthKey` | `token, user, recoveryCode` (new); signs out every device |
| `GET /api/me` | | `user` |
| `PATCH /api/me` | any of `name, currency, altCurrency, rate, rateUpdatedAt` | `user` |
| `POST /api/password` | `authKey, newAuthKey` | signs out other devices |
| `POST /api/recovery-code` | `authKey` | `recoveryCode` (the old one stops working) |
| `DELETE /api/me` | `authKey` | deletes the account and every entry |
| `POST /api/logout` | | ends this session |
| `POST /api/sync` | see below | see below |
| `POST /api/admin/*` | admin only | `unlock`, `users`, `reset`, `role`, `entries`, delete user; each sensitive call re-checks the admin's password and is written to `admin_log` |
| `POST /api/ai/ask` | `question, today` | `{ spec }` — a filter (metric — spent/received/net/count/min/max/average — flow, category, period, account, cardOnly); the app computes the total locally. 60/day per person |
| `POST /api/ai/parse` | `text, today` | `entries: [{ title, amount, type, category, date, currency }]`; Workers AI, validated field by field; 40 a day per person |

`user` = `{ email, name, currency, altCurrency, rate, rateUpdatedAt, createdAt, categories, categoriesUpdatedAt }`. `categories` is the person's own list, `[{ id: 'c_…', label, emoji, words }]` (up to 30); `PATCH /api/me` with `categories` replaces it. Records may use those ids as their category. `rate` is how many `altCurrency` make 1 `currency`.

## Sync

Request: `{ since, changes: [record…] (at most 2000), rate?: { value, updatedAt } }`.

Response: `{ records: [record…], seq, more, rate, rateUpdatedAt, account: { currency, altCurrency, name }, rejected }`.

- A record is `{ id, title, amount, type: "in"|"out", category, date: "yyyy-mm-dd", createdAt, updatedAt }`, or `{ id, deleted: true, updatedAt }` for a deletion. Times are epoch milliseconds from the editing device. Amounts are in the account's main currency.
- **Merge:** a sent record replaces the stored one when its `updatedAt` is later. On a tie a deletion wins, then the greater of `title|amount(2dp)|type|category|date`.
- Every change the server accepts gets the account's next change number. The response holds every record with a change number above `since`, plus the server's copy of every record that was sent (so a device learns when its older edit lost). Store `seq` and send it as `since` next time. When `more` is true, call again with the new `since`.
- Deletions older than 180 days are removed.
- The rate follows the later `updatedAt`.
