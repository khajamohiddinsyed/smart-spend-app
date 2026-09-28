# Smart Spend

**Know where your money goes. Just type it.**

Smart Spend is a spending and income tracker you talk to in plain words. Instead of filling in forms, you write what happened, like "spent 40 on fuel and 18 coffee yesterday", and it becomes tidy entries with the right amounts, categories and dates.

**Use it:** https://khajamohiddinsyed.github.io/smart-spend-app/, free, in any browser. Add it to your home screen on Android or iPhone and it opens like an app.

## How it works

1. **Create an account** with your email and a password, and pick your currency. You can also pick a second currency to see amounts in, for example earning in riyals and thinking in rupees.
2. **Tell it what happened.** Tap **+** and type the way you'd text a friend. Several things in one message are fine.
3. **Check the preview.** Before anything is saved you see each entry: the item, the amount, money in or out, the category and the date. Tap a category to change it.
4. **Add.** The entries are saved on your device straight away and synced to your account, so they appear on every phone or computer you log in on.

## What makes it different

### It understands how people actually write

| You type | You get |
|---|---|
| `juice 15` | **Juice**, 15. The amount goes in the amount and the item name stays clean. |
| `spent 40 on fuel and 18 coffee yesterday` | Two entries, **Fuel** 40 and **Coffee** 18, both dated yesterday |
| `salary 14,500 credited` | Money **in**, under Salary |
| `on 24th sep: taxi 30, lunch 45` | Both entries on 24 September |
| `3 coffee x 12` · `2 coffees @ 15` · `3 shirts 40 each` | Quantity × price, worked out: 36, 30, 120 |
| `rent 2.5k` · `petrol 2 lakh` · `fifty for parking` | 2,500 · 200,000 · 50 |
| `groceries ٤٥٠` | Arabic and Persian digits work |
| `₹500 recharge` (on a riyal account with rupees as the second currency) | Converted to riyals at your own rate |

- **Dates in plain words:** today, yesterday, last friday, 3 days ago, last week, 24th sep, 24/09, sep 24 2026. A date at the start of a line carries to everything after it.
- **Money in or out** is worked out from the words: salary, received, refund, cashback and credited mean money in; spent, paid and bought mean money out.
- **Categories** come from hundreds of shop, brand and everyday words (Uber, Netflix, Carrefour, Swiggy, pharmacy, rent…). A typo like "resturant" still matches.
- **It learns.** Change a category once and similar entries get it next time.
- **Currencies:** 27 to choose from. The symbols and words people use are understood (₹, rs, rupees, $, dirham, riyals, €…), and "rs" means Pakistani rupees on a PKR account.

### It shows you the month at a glance

- The balance for the month, money in and out, and how much of what came in you kept.
- A 6-month chart of money in and out, and your spending pace against last month.
- Where the money went, by category.
- Monthly budgets per category, with a warning at 80% and when you go over.
- A calendar with a dot for each day that has entries, plus search and filters.

### It works everywhere, even offline

- **Offline first:** entries are saved on the device the moment you add them and sync when there's a connection. Nothing is lost on a flight or in a basement.
- **On every device:** log in on your phone and your computer and you see the same entries. If the same entry was changed in two places, the latest edit wins.
- **Installable:** add it to the home screen and it opens full screen from its own icon, like any app.

### Your account stays yours

- **Your password never leaves your device.** It's scrambled in the browser before anything is sent, so the server only ever sees the scrambled form.
- **A recovery code** is shown when you sign up. It's the only way to reset a forgotten password, so keep it safe. You can make a new one in Settings.
- **Changing your password** signs out your other devices.
- **Your data:** save a backup file of your entries at any time, restore from one, or delete your account and every entry for good.

## Under the hood

The app is plain JavaScript with no framework, served by GitHub Pages. Accounts and sync run on a Cloudflare Worker with a D1 (SQLite) database. The sync rules and endpoints are described in [docs/API.md](docs/API.md).
