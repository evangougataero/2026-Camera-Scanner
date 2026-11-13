# Purchase Tracker

Facebook Marketplace → USPS → eBay inventory, for camera/lens resale. A Chrome extension only **reads pages and posts what it saw**;
Google Apps Script owns **all** spreadsheet logic. No APIs, no credentials, and login/CAPTCHA/checkpoints/password prompts are never bypassed.

Flow: Main scanner sheet (`Purchased? = Y`) → **Purchased** tab (backend) → **Inventory** tab (one row per product). **Purchase Dashboard** is a read-only view of Purchased.

## Files
- Apps Script: `Config.gs` (the only file you edit — **no changes needed for this update**), `Logic.gs`, `Code.gs`, `Dashboard.gs`, `Inventory.gs`.
- Extension: `manifest.json`, `background.js`, `parse-order.js`, `fb-extractor.js`, `parse-usps.js`, `usps-extractor.js`, `options.html`, `options.js`,
  **new:** `parse-signals.js`, `signals-extractor.js`.

## Upgrade steps (November 2026: order-status fix, Seller, Meta Pay / notifications)
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
- **Probe order** (listing URL/ID): opens the listing, clicks **View Order**, reads the **Order status** dialog. Expect `trackingNumber`,
  `carrier`, `fbStatusRaw` (e.g. `Delivered | Your order was delivered. | Order Confirmed`), `seller`, `itemTitle`, `orderView: true`.
  Try it on listing `1288988733112094` (Canon EOS 760D): it should show `9334610579700004096766` and `Olga Serdinskaya`.
- **Probe seller only**: reads just the seller from the listing page (falls back to the Order status dialog).
- **Probe Meta Pay**: lists the wallet rows it read (seller, status, date, amount) and `wouldChange` — a read-only preview of which Purchased
  rows the backend would update. `REAUTH_REQUIRED` means Meta asked for your password: open the wallet once by hand, then retry.
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
- `Seller` (and `FB Listing Title`) are filled from the listing page ("Seller information / Seller details" or the seller's profile link)
  or from the Order status dialog ("Item is sold and shipped by …"). They only fill blanks; nothing is overwritten.
- **Future purchases**: captured on every Facebook order check (even a failed one, as long as the listing page loaded).
- **Backfill**: active rows get it from their regular order checks; rows the order checks no longer visit (shipped, delivered, canceled)
  get a light **seller-only** check — at most every 6 h, at most 3 tries per row (`Seller Attempts`).
- The dashboard names the seller in overdue alerts: `OVERDUE — Contact Seller (Olga Serdinskaya) · 9 days …`.

## Canceled / Refunded / Expired
`Purchase Status` stays the single terminal value **`Canceled`** (so work lists, transfers and dashboard counters behave as before);
**what** happened is recorded in `Cancel Signal` (`Refunded — Meta Pay (…)`, `Expired — Facebook order status (…)`,
`Canceled — Facebook listing: View Order button missing`, …) and `Refund Received = Y` for refunds. The dashboard's Attention column shows
it, e.g. `Refunded (Meta Pay) — no action needed`. Sources, strongest first:
1. **Facebook Order status dialog** headline `Canceled` / `Expired` / `Refunded`.
2. **Meta Pay wallet** (shows the **seller's name**, not the listing): matched by the `Seller` column, verified by date
   (wallet date 6 days before … 2 days after `Purchased At`) and amount (exact cents vs `Purchase Cost`); a partial name
   ("Tysha A Rodriguez" vs "Tysha Rodriguez") needs the exact amount or the same day. Pairs are assigned one-to-one, best first;
   **ties change nothing** (logged as ambiguous). Every matched row gets `Meta Pay Status` (e.g. `Delivered · 2026-11-03 · $262.84`);
   Meta Pay *Delivered* counts as Facebook-confirmed delivery; *May be delayed* becomes a dashboard alert.
3. **Marketplace notifications** naming the listing (linked listing ID or the full Facebook listing title). A notice older than the purchase,
   a cancellation *request*, or a re-bought listing with an unknown notice time never acts. A loose word-only match is recorded as
   `Review: possibly …` (dashboard alert), never applied.
4. **Healthy listing page with no View Order button** (unchanged rule).

Safety: Meta Pay and notifications never cancel a purchase USPS has accepted, Facebook says was delivered, or that is already in Inventory —
they set `Cancel Signal = Review: …` with a note and a **Check Order** alert instead. Facebook's own order page cancels anything not yet in
Inventory (as before). Wallet cancellations that match no row (usually: the row has no Seller yet) are listed in the `META_PAY_SCAN` log line.
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
against a tiny fake DOM (`tests/fake-dom.js`); the service worker runs against a fake `chrome` (`tests/background.test.js`).

## Not verified (honest limits)
- **Real Google Sheets rendering is untested**: checkboxes, conditional-format colours, column deletion, tab copy, hidden columns, banding, filters.
- The fake DOM is shaped from the screenshots, not captured from Facebook. The **Meta Pay** and **notifications** page layouts were never
  captured live: run their probes first. If a probe shows nothing recognised, send its `textPreview` so the parser can be adjusted.
- Whether Facebook ever renders less in a never-focused background tab is unknown; probes now report `env.visibility` / `bodyLength` to diagnose it.
- The "healthy page without View Order => Canceled" rule is still a heuristic (now also requires the listing title or seller to have loaded).
- A filter active on the dashboard during a refresh may hide rows until re-applied.
