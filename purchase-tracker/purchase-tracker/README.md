# Purchase Tracker

Facebook Marketplace → USPS → eBay inventory, for camera/lens resale. A Chrome extension only **reads pages and posts what it saw**;
Google Apps Script owns **all** spreadsheet logic. No APIs, no credentials, and login/CAPTCHA/checkpoints/password prompts are never bypassed.

Flow: Main scanner sheet (`Purchased? = Y`) → **Purchased** tab (backend) → **Inventory** tab (one row per product). **Purchase Dashboard** is a read-only view of Purchased.

## Files
- Apps Script: `Config.gs` (the only file you edit — **no changes needed for this update**), `Logic.gs`, `Code.gs`, `Dashboard.gs`, `Inventory.gs`.
- Extension: `manifest.json`, `background.js`, `login-guard.js`, `parse-order.js`, `fb-extractor.js` (listing fallback), `parse-usps.js`, `usps-extractor.js`,
  `parse-signals.js`, `signals-extractor.js`, `options.html`, `options.js`, **new (1.3.0):** `parse-orders.js`, `orders-extractor.js`.

## Upgrade steps (extension 1.3.0, mid-November 2026: Facebook "Purchased orders" page)
1. **Apps Script**: replace `Code.gs` and `Logic.gs` with the new files (`Dashboard.gs`, `Inventory.gs`, `Config.gs` unchanged), then
   **redeploy the Web App** as a *New version* (Deploy → Manage deployments → ✏️ → New version). No new columns, no setup run needed.
   What changed there (all backward compatible — an older extension keeps working against the new script and vice versa):
   - `Code.gs`: `getWork` items now also carry `seller`, `cost`, `ask`, `purchasedAt` (yyyy-MM-dd), `fbTitle`, `product`, `trackingNumber`
     (used to match orders); new **read-only** action `previewFbResults` (used by the Probe button); the `FB_CHECKED` log line says
     `orders page (matched by …)`.
   - `Logic.gs` (`applyFbResult_` only): an optional `estimatedDelivery` (Facebook's "Estimated Arrival") fills a **blank** `Estimated Delivery`
     (USPS's date always wins); a cancellation seen on the orders page is labelled `Canceled — Facebook orders page (…)` in `Cancel Signal`.
   If you skip the redeploy, runs still work (matching then relies on listing ID and titles only, and the probe shows "preview unavailable").
2. **Chrome extension**: copy the whole `extension/` folder over the old one, `chrome://extensions` → **Reload**. No new permissions
   (`https://www.facebook.com/*` already covers `/marketplace/you/orders`).
3. Options → **Probe orders page** and compare what it found with your real orders before trusting the run.

## How Facebook is read now (1.3.0)
One visit per run to **https://www.facebook.com/marketplace/you/orders** replaces opening every listing:
1. Wait (≤ 15 s) for the order cards — each has a status (Confirmed / Shipped / Delivered / Canceled / Refunded …), the listing title
   (often truncated with "…") and the order date. Scroll (≤ 10 times) until a card is older than the oldest purchase still being tracked
   (its `Purchased At` − 6 days) or nothing more loads.
2. For each card that could belong to a tracked purchase (date inside some purchase's window, or a linked listing/order ID), click it and read
   the **Order status** dialog: full title, price ("$200.00 · Quantity: 1"), status headline, `Estimated Arrival`, carrier + tracking number
   (`USPS / UPS / FedEx / DHL TRACKING NUMBER: …`), the timeline (`Order Confirmed Nov 8 at 9:41 PM`, `Shipped …`; a step with a timestamp is
   done), the seller, and IDs from links / the URL. The dialog is closed again. **"View order details" is never opened** — it shows your
   address and contact info, which are never read or stored. Everything is found by visible text, not by Facebook's class names.
3. Orders are matched to Purchased rows, strongest first, **one-to-one**:
   1. **listing ID / FB order ID** (when the card or dialog links them);
   2. **seller + price** — seller name matches the `Seller` column (same rules as Meta Pay) and the price equals `Purchase Cost` or
      `Ask Price (FB)` to the cent, order date inside the window (−6 … +2 days around `Purchased At`);
   3. **title + date** — ≥ 60 % of the (truncated) order title's significant words found in `FB Listing Title`, or a scanner product name's
      words all/mostly found in the order title (model numbers weigh double), order date inside the window.
   An order that fits two purchases equally well (or a purchase that fits two orders) is **ambiguous: nothing changes**, it is logged
   (`Orders page: AMBIGUOUS …`).
4. Each matched purchase gets one result through the existing `submitFbResult` endpoint (same payload: `fbStatusRaw`, `canceled`, `outcome`,
   `trackingNumber`, `carrier`, `orderId`, `orderTotal`, `seller`, `itemTitle`, plus `estimatedDelivery`, `timeline`, `source: orders-page`).
   `FB Status (raw)` looks like `Shipped | Estimated Arrival: Nov 19 | Order Confirmed: Nov 8 at 9:41 PM | Shipped: Nov 9 at 7:08 PM`.
5. Then USPS checks (including tracking numbers found a moment ago), then Meta Pay + notifications as secondary confirmation (unchanged).

Status mapping (the backend never downgrades a status):
| Orders page | Purchased tab |
|---|---|
| Confirmed / Order placed | `Purchased` (dashboard: Awaiting Shipment) |
| Shipped / In transit / Out for delivery | tracking + carrier stored → `Tracking Available`, which becomes `Shipped` as soon as USPS confirms acceptance (the backend's `Shipped` means *verified carrier possession*; that is what drives the inventory transfer and the overdue rule) |
| Delivered | `Delivered` — Facebook-confirmed delivery, transferred to Inventory right away |
| Canceled / Refunded / Expired | `Canceled` + `Cancel Signal` (`Refunded — Facebook orders page (Refunded)`, `Refund Received = Y` for refunds) — this page is explicit evidence; a purchase already in Inventory gets `Review: …` instead |

**A tracked purchase that is not on the orders page is never canceled.** It is logged (`<id> not found on orders page — unchanged`) and nothing
is sent for it. By default its listing page is then read the old way as a **fallback** (Options: "If a purchase is not found on the orders
page, check its listing page instead"); that fallback never cancels without explicit evidence either (a missing View Order button only
counts as a failed check). If the orders page cannot be read at all (layout not recognised), every due purchase falls back the same way.
A login wall / checkpoint on the orders page is re-checked once, then reported (red badge, `Purchase Log`) and **never bypassed**; the remaining
Facebook checks of that run are skipped, USPS and Meta Pay still run. If clicking a card ever navigates the tab away, the list is reloaded and the
read resumes where it stopped (≤ 3 attempts).

## Upgrade steps (earlier, November 2026: order-status fix, Seller, Meta Pay / notifications)
1. **Apps Script** (script.google.com → your Purchase Tracker project): replace the contents of `Logic.gs`, `Code.gs` and `Dashboard.gs`
   with the new files (`Inventory.gs` is unchanged). **Keep your `Config.gs` exactly as it is** — every new setting has a default in `Code.gs`.
2. Run **`setupPurchaseDashboard()`** once. It appends the new Purchased columns at the far right — `Seller`, `FB Listing Title`,
   `Meta Pay Status`, `Seller Attempts` (plus `Cancel Signal` / `Refund Received` only if your sheet doesn't already have them; existing
   columns are never moved, renamed or cleared). If you forget, the 10-minute `reconcile()` adds them on its own (logged as `COLUMNS_ADDED`).
3. **Redeploy the Web App**: Deploy → Manage deployments → ✏️ edit → Version: **New version** → Deploy. The URL stays the same.
   (Without this the extension keeps talking to the old code; it then logs "update/redeploy the Apps Script".)
4. **Chrome extension** — on the machine that runs it (your secondary desktop / test machine): copy the whole `extension/` folder over the old
   one, open `chrome://extensions`, press **Reload** on Purchase Tracker. Chrome will show the new site access for
   **`accountscenter.facebook.com`** (needed to read the Meta Pay wallet) — accept it. If the extension was disabled because of the new
   permission, re-enable it.
5. Open the extension **Options** → **Test connection**, then run the probes below on real purchases before trusting the automation.

## Probes (Options page; nothing is written to the sheet)
- **Probe orders page** (new): opens `marketplace/you/orders` in a background tab, reads every card and opens **every** card's Order status
  dialog back to the oldest tracked purchase. Shows `orders` (one `summary` line each, e.g.
  `Shipped · "Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more" · 2026-11-08 · $200.00 · seller Tabitha Shippee · USPS 9334610579400004369609`,
  plus status, ETA, timeline, IDs), `matches` (purchase ↔ order, `via` listing ID / seller+price / title+date, and what would be sent),
  `ambiguous`, `notFound` (never canceled) and `wouldChange` — the backend's read-only preview of the cell changes. `probe.dialogTexts` holds
  the raw dialog text in case the parser needs adjusting. Without a backend connection it still shows the page.
- **Probe order** (listing URL/ID — fallback path): opens the listing, clicks **View Order**, reads the **Order status** dialog. Expect `trackingNumber`,
  `carrier`, `fbStatusRaw` (e.g. `Delivered | Your order was delivered. | Order Confirmed`), `seller`, `itemTitle`, `orderView: true`.
  Try it on listing `1288988733112094` (Canon EOS 760D): it should show `9334610579700004096766` and `Olga Serdinskaya`.
- **Probe seller only**: reads just the seller from the listing page (falls back to the Order status dialog).
- **Probe Meta Pay**: lists the wallet rows it read (seller, status, date, amount) and `wouldChange` — a read-only preview of which Purchased
  rows the backend would update. `REAUTH_REQUIRED` means Meta asked for your password: open the wallet once by hand, then retry.
  Scheduled runs and this probe use the same code. The wallet list is rendered client-side and can show up late in a background tab, so the
  reader waits for the page to be ready, the "Transactions" heading and the rows (up to ~15 s, +5 s once the heading is visible). If it still
  finds no rows, it reloads the tab **once**, waits ~5 s and reads again. Only after that does it report `META_PAY_NO_TRANSACTIONS`, with
  `retried once after reload — …` in the log, plus heading/visibility and a short text snippet to help with diagnosis.
- **Probe notifications**: lists recognised order events from Marketplace notifications plus the same read-only `wouldChange` preview.
- **Probe USPS** (unchanged).

## What was wrong with tracking retrieval (fixed)
- **Wrong dialog read.** Facebook can render the listing itself in a `[role=dialog]` overlay. The extractor took "the longest visible dialog"
  and treated "a dialog mentioning order/ship" as the opened order — the listing dialog matched both (it contains "View Order" and "Ships for…"),
  so it read the listing **instead of** the Order status dialog and reported success with no tracking. Result on the sheet: tracking never
  arrived and the purchase showed **Overdue — no tracking number yet**. Now the extractor only accepts a dialog that looks like an
  *order view* ("Order status", "TRACKING NUMBER", "Order information", "Item is sold and shipped by", "$… · Quantity"), preferring the one
  that appeared after the click, and waits for its text to stop changing before reading.
- **Service worker killed mid-check.** A long `executeScript` await does not keep an MV3 worker alive; it could be terminated after ~30 s,
  leaving the queue stalled until the next 3-hour alarm. Pages are now read under a keep-alive, and every step arms a 5-minute watchdog alarm
  (max 3 tries per item, then `STEP_ABORTED`).
- **Listing URL taken from the sheet as-is** (`m.facebook.com`, query strings) could load a different UI without "View Order". Always the
  canonical `https://www.facebook.com/marketplace/item/<id>/` now.
- Click fallback (full pointer/mouse sequence) when a plain click opens nothing; more "View order / Order details / Track package" wordings;
  carrier-labelled lines (`USPS TRACKING NUMBER: …`) are parsed with their carrier; external carrier links yield the tracking number directly.
- Facebook-confirmed delivery now transfers to Inventory immediately (previously on the next reconcile).

## Seller
- `Seller` (and `FB Listing Title`) are filled from the orders page's Order status dialog ("Seller information"), or — in the listing
  fallback — from the listing page / its dialog. They only fill blanks; nothing is overwritten. Seller-backfill rows are matched on the
  orders page too (by ID or title + date) and only fall back to their listing page when not found there.
- **Future purchases**: captured on every Facebook order check (even a failed one, as long as the listing page loaded).
- **Backfill**: active rows get it from their regular order checks; rows the order checks no longer visit (shipped, delivered, canceled)
  get a light **seller-only** check — at most every 6 h, at most 3 tries per row (`Seller Attempts`).
- The dashboard names the seller in overdue alerts: `OVERDUE — Contact Seller (Olga Serdinskaya) · 9 days …`.

## Canceled / Refunded / Expired
`Purchase Status` stays the single terminal value **`Canceled`** (so work lists, transfers and dashboard counters behave as before);
**what** happened is recorded in `Cancel Signal` (`Refunded — Meta Pay (…)`, `Expired — Facebook order status (…)`,
`Canceled — Facebook order status (…)`, …) and `Refund Received = Y` for refunds. The dashboard's Attention column shows
it, e.g. `Refunded (Meta Pay) — no action needed`. Sources, strongest first:
1. **Facebook orders page** card/dialog status `Canceled` / `Expired` / `Refunded` (or, for the listing fallback, the Order status dialog headline).
2. **Meta Pay wallet** (shows the **seller's name**, not the listing): matched by the `Seller` column, verified by date
   (wallet date 6 days before … 2 days after `Purchased At`) and amount (exact cents vs `Purchase Cost`); a partial name
   ("Tysha A Rodriguez" vs "Tysha Rodriguez") needs the exact amount or the same day. Pairs are assigned one-to-one, best first;
   **ties change nothing** (logged as ambiguous). Every matched row gets `Meta Pay Status` (e.g. `Delivered · 2026-11-03 · $262.84`);
   Meta Pay *Delivered* counts as Facebook-confirmed delivery; *May be delayed* becomes a dashboard alert.
3. **Marketplace notifications** naming the listing (linked listing ID or the full Facebook listing title). A notice older than the purchase,
   a cancellation *request*, or a re-bought listing with an unknown notice time never acts. A loose word-only match is recorded as
   `Review: possibly …` (dashboard alert), never applied.
4. A **missing View Order button never cancels on its own**, even on a page that loaded normally. A listing showing **Sold** or
   **Pending** is an active order: status unchanged, not counted as an FB error. Without either it is an ordinary FB check failure.

Safety: Meta Pay and notifications never cancel a purchase USPS has accepted, Facebook says was delivered, or that is already in Inventory —
they set `Cancel Signal = Review: …` with a note and a **Check Order** alert instead. Facebook's own order page cancels anything not yet in
Inventory (as before). A row with a **blank Seller** can still be matched by a leftover wallet transaction on exact amount (cents) + date window, but only
when exactly one row and one transaction fit. Wallet transactions that still match no row are listed in the `META_PAY_SCAN` log line.
Signals are scanned once per run only while some purchase could still be canceled; each can be switched off on the Options page.

Optional `Config.gs` overrides (not required): `FB_SELLER_RECHECK_MINUTES` (360), `SELLER_MAX_ATTEMPTS` (3), `META_PAY_DAYS_BEFORE` (6), `META_PAY_DAYS_AFTER` (2).

## Purchase Dashboard
Row 1–2 summary (Needs Attention, Total Active, Capital Tied Up, Awaiting Shipment, In Transit, Delivered, Overdue, Canceled, Missing Cost, Last Updated); row 3 headers; data from row 4.
Columns: Product, Order Status, Attention / Action Needed, Purchase Date, Days Since Purchase, Purchase Cost, Estimated Resale, Est. Profit, Tracking, Estimated Delivery, Facebook Listing, Inventory, Record, Purchase ID (+ hidden helper). Layout unchanged by this update.
Statuses: Purchased, Awaiting Shipment, Label Created, Shipped / In Transit, Out for Delivery, Delivered, Overdue, Canceled, Status Unknown.
- **Overdue:** 7+ days since purchase with no carrier possession (acceptance or later) and not delivered/canceled. Label Created never counts as possession. Time-driven; needs no extension activity.
- **Capital Tied Up:** actual cost of active (undelivered) rows; rows with missing cost are excluded and counted under Missing Cost, never treated as $0.
- Refreshes every 10 minutes; never writes to Purchased, Main or Inventory. If the layout is not recognised it refuses and tells you to run `setupPurchaseDashboard()`.

## Facebook-confirmed delivery
If the order dialog/page says "Delivered" / "Your order was delivered" (or the matched Meta Pay row says Delivered), the purchase counts as
Delivered and is eligible for Inventory even without USPS data.

## Inventory (one row per product)
Transfer happens once a purchase has USPS acceptance (or Facebook-delivered). A listing with N products in the Main sheet becomes N rows, each with its own estimated resale from Main.
- Purchase Cost is split across items in **whole cents** that sum exactly (e.g. 100/3 → 33.34, 33.33, 33.33). Blank cost → blank Item Cost, auto-filled later when you enter the cost; changing the cost re-allocates only while the stored signature differs.
- **Purchase Cost source of truth:** if the Main sheet's paid-price column has a value, it wins — editing only the Purchased cell is reverted on the next reconcile. Change the cost in Main (or leave Main's cell blank and edit Purchased).
- Key columns: `Purchase ID`, `Item Key` (`<Purchase ID>#<n>`) make transfers idempotent and crash-healing. Rows are alternately tinted per listing (hidden `Group Shade` column + conditional format) and labelled `Listing Item: n of N`.
- The script only writes Status while blank or In Transit / Waiting on Delivery / Delivered. Listed/Sold, and all manual columns, are never overwritten.

### Migration (`setupInventoryV2`)
Repeatable. Copies the tab as `Inventory backup <timestamp>` first, renames Cost → Item Cost and Facebook URL → Facebook Listing, deletes **only** Tracking Number, USPS Status and Estimated Delivery (tracking now lives on the dashboard), appends new columns on the right. Existing rows are preserved as-is; legacy rows (Purchase ID, no Item Key) are never duplicated.

## Date cutoff
Purchases dated before 2026-10-25 (spreadsheet time zone) are ignored by the dashboard, monitoring, signals and transfer. Their Purchased rows are never changed or deleted.

## Extension setup
Options page → set Web App URL and API token (`showApiToken()` in Apps Script). Work runs in background tabs, one page per 30 s step; unsent results are kept in an outbox.

## Safe test plan
1. `createDashboardTestRecords()` adds 10 `TEST-` rows. They are invisible to the extension, signals and inventory transfer.
2. Run `refreshPurchaseDashboard()`; check statuses, colours, counters.
3. `removeDashboardTestRecords()` deletes only `TEST-` rows.
4. Probe order / seller / Meta Pay / notifications on real purchases (see above) and compare `wouldChange` with what you expect before the first scheduled run.

## Tests
`npm test` (= `node --test tests/*.test.js`). Apps Script runs against a fake Sheets harness (`tests/harness.js`); the in-page extractors run
against a tiny fake DOM (`tests/fake-dom.js`); the service worker runs against a fake `chrome` (`tests/fake-worker.js`, used by
`background.test.js` and `orders-run.test.js`). Orders page: `parse-orders.test.js` (cards, dialog, tracking prefixes, ETA, timeline, seller,
status mapping, matching, ambiguity, not-found), `orders-extractor.test.js` (real page function: scrolling, dialogs, login wall, resume),
`orders-run.test.js` (run flow, fallback, probe), `orders-integration.test.js` (end-to-end into the Purchased tab).

## Not verified (honest limits)
- **The orders page was built from screenshots, not from a captured page.** Card/dialog markup, whether cards are links, how the list loads
  older orders, whether the Close button is labelled "Close", and whether any link exposes the listing/order ID are unknown. Run
  **Probe orders page** first; if it shows `ORDERS_NOT_FOUND` or cards without dialogs, send its `probe.textPreview` / `dialogTexts`.
- Matching without IDs depends on the `Seller` column + an exact price, or on titles: a purchase whose cost includes shipping/tax (≠ the
  listing price) and whose seller is unknown is matched by title + date only.
- **Real Google Sheets rendering is untested**: checkboxes, conditional-format colours, column deletion, tab copy, hidden columns, banding, filters.
- The **Meta Pay** and **notifications** page layouts were never captured live: run their probes first. If a probe shows nothing recognised,
  send its `textPreview` so the parser can be adjusted.
- Whether Facebook ever renders less in a never-focused background tab is unknown; probes report `env.visibility` / `bodyLength` to diagnose it.
- A filter active on the dashboard during a refresh may hide rows until re-applied.
