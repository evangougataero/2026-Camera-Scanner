/**
 * Config.gs — YOUR settings. This is the ONLY file you edit by hand.
 * Code.gs, Logic.gs and Dashboard.gs can be overwritten by any update without touching these values.
 *
 * Do not paste a CONFIG block anywhere else: the project must contain exactly one `var CONFIG`.
 */
// ===========================================================================
// CONFIG — edit this block, then run setup()
// ===========================================================================
var CONFIG = {
  SCANNER: {
    spreadsheetId: 'PASTE_SCANNER_SPREADSHEET_ID',   // the long id in the sheet URL
    tab: 'Main',                                      // same tab the scanner writes to
    headerRow: 1,
    // Known from the scanner's server.js (columns it writes). Letters are 1-based sheet columns.
    nameCol: 'A',      // item name
    urlCol: 'B',       // Facebook listing URL (only on the first row of a listing)
    askCol: 'D',       // Facebook ASKING price (never used as cost)
    resaleCol: 'E',    // estimated resale, one per item row
    // NOT visible in the scanner code, so located by header text in the header row:
    purchasedHeader: 'Purchased?',
    // Optional: header of a column where you type what you ACTUALLY paid. First match wins.
    // If none exists, Purchase Cost stays blank (flagged in Notes) — it is never copied from ask price.
    costHeaders: ['Purchase Price', 'Purchase Cost', 'Price Paid', 'Paid', 'Bought For']
  },

  PURCHASED: {
    spreadsheetId: '',               // blank = same spreadsheet as the scanner (simplest)
    tab: 'Purchased',
    logTab: 'Purchase Log'
  },

  INVENTORY: {
    spreadsheetId: 'PASTE_EBAY_INVENTORY_SPREADSHEET_ID',
    tab: 'PASTE_INVENTORY_TAB_NAME',
    headerRow: 1,
    // Column that stores the Purchase ID so each inventory row stays linked to its purchase.
    // setup() adds it at the end of the header row if it is missing.
    linkHeader: 'Purchase ID',
    autoAddLinkColumn: true,
    // The column used to find the next empty row (must be a plain INPUT column, not a formula
    // that always returns something).
    anchorHeader: 'Product',
    // LEGACY (old one-row-per-listing layout). Only used by setupInventoryV2() to recognise the old Cost / Facebook URL /
    // Tracking Number / USPS Status / Estimated Delivery headers when migrating. New rows are written per product (Inventory.gs).
    columns: [
      { header: 'Product',            field: 'Product' },
      { header: 'Facebook URL',       field: 'Facebook URL' },
      { header: 'Cost',               field: '__cost' },            // Purchase Cost, else FB order total
      { header: 'Estimated Resale',   field: 'Estimated Resale' },
      { header: 'Tracking Number',    field: 'Tracking Number',   live: true },
      { header: 'USPS Status',        field: 'USPS Status (raw)', live: true },
      { header: 'Estimated Delivery', field: 'Estimated Delivery', live: true }
    ],
    statusHeader: 'Status',
    statusInTransit: 'In Transit',
    statusDelivered: 'Delivered',
    // The script only ever changes the status cell (and live fields) while it holds one of these
    // values or is blank. Anything else (Listed, Sold, ...) is YOUR data and is never touched.
    managedStatuses: ['In Transit', 'Waiting on Delivery', 'Delivered'],
    // Optional: headers of formula columns to copy down from the row above for new rows.
    copyFormulaFromAbove: []
  },

  // Purchases dated BEFORE this day (spreadsheet time zone) are ignored by the dashboard, monitoring and inventory
  // transfer. Their rows are never changed or deleted. Set '' to disable.
  PURCHASE_SCOPE_START: '2026-10-25',

  FB_RECHECK_MINUTES: 150,           // extension re-checks an order at most this often
  FB_TRACKING_RECHECK_MINUTES: 1440, // while a label exists but USPS has not accepted: re-check Facebook daily (cancellation watch)
  FB_ERROR_BACKOFF_AFTER: 3,         // after this many consecutive errors...
  FB_ERROR_BACKOFF_MINUTES: 720,     // ...only retry every 12 h
  FB_BATCH_LIMIT: 15,                // max listings handed to the extension per run
  USPS_RECHECK_MINUTES: 150,         // extension re-checks a tracking number at most this often
  USPS_BATCH_LIMIT: 15,
  LOG_MAX_ROWS: 6000,

  DASHBOARD: {
    tab: 'Purchase Dashboard',
    overdueDays: 7,                  // full days since the purchase timestamp with no verified carrier possession
    refreshMinutes: 10
  }
};

/**
 * Lost your scanner spreadsheet id (e.g. after overwriting an old Code.gs)? Run this: the onEdit trigger that
 * setup() installed remembers it. Copy the id from the log into CONFIG.SCANNER.spreadsheetId above.
 */
function recoverScannerSpreadsheetId() {
  var ids = ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'onScannerEdit'; })
    .map(function (t) { return t.getTriggerSourceId(); });
  var msg = ids.length ? 'Scanner spreadsheet id(s) from the installed onScannerEdit trigger: ' + ids.join(', ')
                       : 'No onScannerEdit trigger found. Copy the id from your scanner sheet URL: docs.google.com/spreadsheets/d/<ID>/edit';
  Logger.log(msg);
  return msg;
}
