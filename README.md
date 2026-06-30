# Shopping-Prices

Daily price scraper for the [רשימת קניות](https://shopping-list-app.karzag.workers.dev) app.

Runs in **GitHub Actions** (the corporate network blocks scraping locally). It downloads the official "מחירים שקופים" price feeds, matches the user's shopping-list items to real catalog products, and writes the real prices into Firestore for the app to read.

## Chains / access
- **Shufersal** — direct public feed (`prices.shufersal.co.il`)
- **Carrefour** — direct public feed (`prices.carrefour.co.il`)
- **Rami Levy, Yohananof** — Cerberus portal (`url.publishedprices.co.il`, login = chain name, empty password)

## Status
Phase 1 — validating cloud access + XML parsing for all chains (`scrape.mjs`, run via the **scrape-prices** workflow → Actions tab → Run workflow).
