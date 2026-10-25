# Purchase Tracker

Facebook Marketplace → USPS → eBay inventory, for camera/lens resale. A Chrome extension only **reads pages and posts what it saw**;
Google Apps Script owns **all** spreadsheet logic. No APIs, no credentials, and login/CAPTCHA/checkpoints are never bypassed.

Flow: Main scanner sheet (`Purchased? = Y`) → **Purchased** tab (backend) → **Inventory** tab (one row per product). **Purchase Dashboard** is a read-only view of Purchased.

## Files
- Apps Script: `Config.gs` (the only file you edit), `Logic.gs`, `Code.gs`, `Dashboard.gs`, `Inventory.gs` (new).
- Extension: `background.js`, `parse-order.js`, `fb-extractor.js` changed; the rest unchanged.

## Upgrade steps
1. Apps Script: replace `Logic.gs`, `Code.gs`, `Dashboard.gs`; add new file `Inventory.gs`. **Keep your `Config.gs`** (the cutoff defaults to 2026-10-25; you may add `PURCHASE_SCOPE_START: '2026-10-25'`, `''` disables it).
2. Run **`setupInventoryV2()`** once (backs up the Inventory tab first, then migrates it).
3. Run **`setupPurchaseDashboard()`** once (rebuilds the dashboard on the new layout; your old dashboard tab is derived data and is replaced).
4. Deploy → Manage deployments → edit → **New version** (the web app must be redeployed).
5. `chrome://extensions` → reload the extension.

Transfers to Inventory are **blocked (logged as `TRANSFER_BLOCKED`)** until step 2 is done.

## Purchase Dashboard
Row 1–2 summary (Needs Attention, Total Active, Capital Tied Up, Awaiting Shipment, In Transit, Delivered, Overdue, Canceled, Missing Cost, Last Updated); row 3 headers; data from row 4.
Columns: Product, Order Status, Attention / Action Needed, Purchase Date, Days Since Purchase, Purchase Cost, Estimated Resale, Est. Profit, Tracking, Estimated Delivery, Facebook Listing, Inventory, Record, Purchase ID (+ hidden helper).
Statuses: Purchased, Awaiting Shipment, Label Created, Shipped / In Transit, Out for Delivery, Delivered, Overdue, Canceled, Status Unknown. No Possible Cancellation / Refunded states.
- **Overdue:** 7+ days since purchase with no carrier possession (acceptance or later) and not delivered/canceled. Label Created never counts as possession. Time-driven; needs no extension activity.
- **Capital Tied Up:** actual cost of active (undelivered) rows; rows with missing cost are excluded and counted under Missing Cost, never treated as $0.
- Refreshes every 10 minutes; never writes to Purchased, Main or Inventory. If the layout is not recognised it refuses and tells you to run `setupPurchaseDashboard()`.

## Cancellation (simple rule)
If the extension loads the listing page **normally** (logged in, fully loaded, real `/marketplace/item/` page, no login/checkpoint) and there is **no "View order details" button**, the purchase becomes **Canceled** — unless USPS has already accepted it or Facebook says it was delivered. Timeouts, login/CAPTCHA, "listing unavailable" and extraction failures **never** cancel; they count as errors and retry.
Caveat: "healthy page" is a heuristic. A Facebook layout change that hides the button on a healthy page would cancel active orders. Canceled is terminal; fix by hand in Purchased if wrong.

## Facebook-confirmed delivery
If the order page says "Delivered" / "Your order was delivered", the purchase counts as Delivered and is eligible for Inventory even without USPS data.

## Inventory (one row per product)
Transfer happens once a purchase has USPS acceptance (or Facebook-delivered). A listing with N products in the Main sheet becomes N rows, each with its own estimated resale from Main.
- Purchase Cost is split across items in **whole cents** that sum exactly (e.g. 100/3 → 33.34, 33.33, 33.33). Blank cost → blank Item Cost, auto-filled later when you enter the cost; changing the cost re-allocates only while the stored signature differs.
- Key columns: `Purchase ID`, `Item Key` (`<Purchase ID>#<n>`) make transfers idempotent and crash-healing. Rows are alternately tinted per listing (hidden `Group Shade` column + conditional format) and labelled `Listing Item: n of N`.
- New/renamed columns: `Item Cost` (was Cost), `Facebook Listing` (was Facebook URL, now an "Open listing" link), `Listing Item`, `Listed on eBay?` (checkbox), `Total Sale Price`, `eBay Fees`, `Shipping Label Cost`, `Sale Date`.
- The script only writes Status while blank or In Transit / Waiting on Delivery / Delivered. Listed/Sold, and all manual columns, are never overwritten.

### Migration (`setupInventoryV2`)
Repeatable. Copies the tab as `Inventory backup <timestamp>` first, renames Cost → Item Cost and Facebook URL → Facebook Listing, deletes **only** Tracking Number, USPS Status and Estimated Delivery (tracking now lives on the dashboard), appends new columns on the right. Existing rows are preserved as-is; legacy rows (Purchase ID, no Item Key) are never duplicated.

## Date cutoff
Purchases dated before 2026-10-25 (spreadsheet time zone) are ignored by the dashboard, monitoring and transfer. Their Purchased rows are never changed or deleted.

## Extension setup / probes
Options page → set Web App URL and API token (`showApiToken()` in Apps Script). Use **Probe Facebook** and **Probe USPS** to check extraction on a real listing/tracking number. Work runs in background tabs, one listing per 30 s step; unsent results are kept in an outbox.

## Safe test plan
1. `createDashboardTestRecords()` adds 10 `TEST-` rows (normal, awaiting, label, overdue ×2, in transit ✓ inventory, out for delivery, delivered/missing cost, FB-delivered, canceled). They are invisible to the extension and to inventory transfer.
2. Run `refreshPurchaseDashboard()`; check statuses, colours, counters.
3. `removeDashboardTestRecords()` deletes only `TEST-` rows.
4. Inventory check: with a real purchase, enter a cost in Main, and confirm one inventory row per product after USPS acceptance.

## Not verified (honest limits)
- Automated tests (139) run against a fake Sheets/Apps Script harness. **Real Google Sheets rendering is untested**: checkboxes, conditional-format colours, column deletion, tab copy, hidden columns, banding, filters.
- Real Facebook cancellation pages were never observed; the cancellation rule relies on the heuristic above.
- The unused `FB Order Button Seen`, `Cancel Signal`, `Refund Received` columns remain in an existing Purchased sheet (ignored by the code).
- A filter active on the dashboard during a refresh may hide rows until re-applied.
