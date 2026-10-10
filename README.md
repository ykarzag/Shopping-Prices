# Shopping-Prices

Price feed for the [רשימת קניות](https://shopping-list-app.karzag.workers.dev) app.

Runs in **GitHub Actions** every 3 hours (06:00–21:00 Israel time). Each run:

1. Downloads the official "מחירים שקופים" price files (full + latest incremental) for the family's branches:
   Shufersal 98 (דיל קרית טבעון), Rami Levy 062 (צ'ק פוסט חיפה), Yohananof 013 (חוצות המפרץ),
   Victory 086 (טבעון, via laibcatalog.co.il — no files on Shabbat, previous prices are kept), Salah Dabbah 019 (צ'ק פוסט).
2. Merges them by barcode into one catalog and publishes it to the **`catalog` branch**:
   `https://raw.githubusercontent.com/ykarzag/Shopping-Prices/catalog/catalog.json`
   (`result.json` next to it has the run summary).
3. Matches new shopping-list items to catalog products via the Worker's `/match` endpoint
   and stores the chosen barcodes on the item in Firestore (`shoppingItems/{id}.priceMatch`).

The app downloads the catalog and does everything else on the phone: basket comparison,
barcode/name price check, and manual match fixes.

## Catalog format
`{ updated, chains, branches, products: [[key, name, size, weighted, priceA, priceB, priceC]] }` —
`key` is the barcode, or `"<chainIndex>:<code>"` for in-store codes (produce, weighed items);
a `null` price means that chain doesn't sell it.

## Local run
`NODE_TLS_REJECT_UNAUTHORIZED=0 SKIP_MATCH=1 node scrape.mjs` — catalog only.
`DRY_ITEMS="חלב,במבה" node scrape.mjs` — test matching without writing to Firestore.

Carrefour is not included: its site blocks GitHub Actions' IP ranges.
