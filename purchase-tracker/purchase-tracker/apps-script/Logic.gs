/**
 * Logic.gs — PURE functions only (no SpreadsheetApp / UrlFetchApp / etc.).
 * Everything here is unit-tested in Node (see /tests). Code.gs does the I/O.
 *
 * Written with `var` + function declarations on purpose, so the same file
 * loads both in Apps Script and in Node's `vm` test harness.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var PURCHASED_HEADERS = [
  'Purchase ID', 'Listing ID', 'Purchased At', 'Product', 'Facebook URL',
  'Ask Price (FB)', 'Purchase Cost', 'Estimated Resale', 'Scanner Row',
  'Purchase Status',
  'FB Status (raw)', 'FB Order ID', 'FB Order Total (raw)',
  'Carrier', 'Tracking Number',
  'USPS Status (raw)', 'USPS Category (raw)', 'USPS Stage', 'USPS Accepted At',
  'Estimated Delivery', 'Delivered At',
  'Last FB Check', 'Last USPS Check', 'FB Error Count', 'Notes',
  'Transferred to eBay?', 'Inventory Row', 'Transferred At', 'Inventory Sync Sig',
  // Added Nov 2026 — appended at the END of an existing sheet by setup()/setupPurchaseDashboard(); an older sheet that
  // already has 'Cancel Signal' / 'Refund Received' (formerly unused) keeps them where they are.
  'Seller', 'FB Listing Title', 'Meta Pay Status', 'Cancel Signal', 'Refund Received', 'Seller Attempts'
];

// Columns that hold long digit strings: must be stored as TEXT or Sheets will
// round 16+ digit numbers (Facebook IDs, USPS tracking numbers).
var TEXT_FIELDS = {
  'Purchase ID': true, 'Listing ID': true, 'FB Order ID': true,
  'Tracking Number': true, 'Inventory Sync Sig': true
};

var PURCHASE_STATUS = {
  PURCHASED: 'Purchased',            // bought, awaiting shipment
  TRACKING: 'Tracking Available',    // tracking number known, USPS has not accepted yet
  SHIPPED: 'Shipped',                // USPS accepted / in transit
  DELIVERED: 'Delivered',
  CANCELED: 'Canceled',
  VOIDED: 'Voided'                   // marked Y by mistake, then un-marked
};

var STAGE = {
  LABEL_CREATED: 'Label Created',
  AWAITING_ITEM: 'Awaiting Item',
  ACCEPTED: 'Accepted',
  IN_TRANSIT: 'In Transit',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
  UNKNOWN: 'Unknown'
};

var STAGE_RANK = {
  'Label Created': 1, 'Awaiting Item': 2, 'Accepted': 3,
  'In Transit': 4, 'Out for Delivery': 5, 'Delivered': 6
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function str_(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }

function isYes_(v) {
  var s = str_(v).toUpperCase();
  return s === 'Y' || s === 'YES';
}

function extractListingId_(url) {
  var m = String(url || '').match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : '';
}

function parseMoney_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : '';
  var s = str_(v).replace(/[$,\s]/g, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return '';
  return parseFloat(s);
}

function toMs_(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (Object.prototype.toString.call(v) === '[object Date]') return v.getTime();
  return Date.parse(String(v));
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** Returns 'yyyy-MM-dd' or '' — never invents a date. */
function normalizeDate_(v) {
  if (!v) return '';
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  if (!/\b(19|20)\d{2}\b/.test(s)) return '';        // no year => ambiguous => refuse
  var d = new Date(s);
  if (isNaN(d.getTime())) return '';
  return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
}

/** Dashboard test rows (Purchase ID "TEST-…") are invisible to the Facebook/USPS work lists and the inventory transfer. */
function isTestRecord_(rec) { return /^TEST-/.test(str_(rec['Purchase ID'])); }

/**
 * Purchases dated before the cutoff (Config: PURCHASE_SCOPE_START) are left alone: not shown on the dashboard, not
 * monitored, not transferred. Their rows are never modified or deleted. Code.gs sets SCOPE_START_MS (0 = no cutoff).
 */
var SCOPE_START_MS = 0;
function isInScope_(rec) {
  if (isTestRecord_(rec) || !SCOPE_START_MS) return true;
  var t = toMs_(rec['Purchased At']);
  return isNaN(t) ? true : t >= SCOPE_START_MS;      // an unreadable date is never silently dropped
}

/**
 * Facebook's own wording: the sentence, or the order-status HEADING "Delivered" (first status line); or the matched
 * Meta Pay wallet row says "Delivered" (Facebook's payment record for the same order). USPS is not required.
 */
function fbSaysDelivered_(rec) {
  var raw = str_(rec['FB Status (raw)']);
  if (/order was delivered|has been delivered/i.test(raw)) return true;
  if (/^delivered\b/i.test(str_(rec['Meta Pay Status']))) return true;
  return raw.split(' | ')[0].trim().toLowerCase() === 'delivered';
}

function isTerminalStatus_(status) {
  return status === PURCHASE_STATUS.CANCELED || status === PURCHASE_STATUS.VOIDED;
}

/** Append a timestamped note, skipping exact repeats, capped at ~800 chars. */
function appendNote_(existing, ts, text) {
  var cur = str_(existing);
  var segs = cur ? cur.split(' | ') : [];
  var last = segs.length ? segs[segs.length - 1] : '';
  // strip "yyyy-MM-dd HH:mm " prefix of last segment for comparison
  if (last.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} /, '') === text) return cur;
  segs.push(ts + ' ' + text);
  var out = segs.join(' | ');
  if (out.length > 800) out = '…' + out.slice(out.length - 800);
  return out;
}

// ---------------------------------------------------------------------------
// Scanner sheet grouping (multi-row, merged listings)
// ---------------------------------------------------------------------------

/**
 * values: 2D array of data rows (header excluded).
 * firstRowNumber: sheet row number of values[0].
 * cols: zero-based indexes {name,url,ask,resale,purchased,cost(-1 if none)}.
 *
 * A listing starts on a row whose URL column has /marketplace/item/<id>.
 * Following rows with an empty URL cell belong to it (merged-cell layout used
 * by the scanner for multi-item listings).
 */
function groupScannerListings_(values, firstRowNumber, cols) {
  var listings = [], cur = null;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var id = extractListingId_(row[cols.url]);
    if (id) {
      cur = {
        listingId: id, url: str_(row[cols.url]), row: firstRowNumber + i,
        rowEnd: firstRowNumber + i, names: [], items: [], ask: '', resale: 0, hasResale: false,
        purchased: false, cost: ''
      };
      listings.push(cur);
      cur.ask = parseMoney_(row[cols.ask]);
    } else if (str_(row[cols.url]) !== '') {
      cur = null;                       // some other non-listing content: stop attaching
      continue;
    } else if (!cur) {
      continue;
    } else if (str_(row[cols.name]) === '' && str_(row[cols.resale]) === '' &&
               str_(row[cols.purchased]) === '') {
      // fully blank row ends the listing
      var blank = true;
      for (var c = 0; c < row.length; c++) if (str_(row[c]) !== '') { blank = false; break; }
      if (blank) { cur = null; continue; }
    }
    if (!cur) continue;
    cur.rowEnd = firstRowNumber + i;
    var nm = str_(row[cols.name]);
    var rs = parseMoney_(row[cols.resale]);
    if (nm) { cur.names.push(nm); cur.items.push({ name: nm, resale: rs }); }
    if (rs !== '') { cur.resale += rs; cur.hasResale = true; }
    if (isYes_(row[cols.purchased])) cur.purchased = true;
    if (cols.cost >= 0 && cur.cost === '') cur.cost = parseMoney_(row[cols.cost]);
  }
  return listings;
}

// ---------------------------------------------------------------------------
// Feature 1: planning purchase sync (idempotent)
// ---------------------------------------------------------------------------

function attemptNumber_(purchaseId) {
  var m = String(purchaseId || '').match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : 1;
}

/**
 * listings: from groupScannerListings_.
 * records:  existing Purchased rows (objects keyed by header).
 * forceIds: {listingId:true} for listings the user JUST toggled to Y via an
 *           edit event (lets a canceled/voided listing be re-purchased).
 *
 * Returns {creates:[{listing,attempt}], voids:[{record,transferred}]}.
 */
function planSync_(listings, records, forceIds) {
  forceIds = forceIds || {};
  var byId = {};
  listings.forEach(function (l) {
    var g = byId[l.listingId] || (byId[l.listingId] = { any: false, yGroup: null });
    if (l.purchased && !g.any) { g.any = true; g.yGroup = l; }
  });
  var recsById = {};
  records.forEach(function (r) {
    var id = str_(r['Listing ID']);
    (recsById[id] = recsById[id] || []).push(r);
  });

  var creates = [], voids = [];
  Object.keys(byId).forEach(function (id) {
    var g = byId[id];
    if (!g.any) return;
    var recs = recsById[id] || [];
    var open = recs.filter(function (r) { return !isTerminalStatus_(r['Purchase Status']); });
    if (open.length) return;                                   // already recorded
    if (recs.length === 0 || forceIds[id]) {
      var max = 0;
      recs.forEach(function (r) { max = Math.max(max, attemptNumber_(r['Purchase ID'])); });
      creates.push({ listing: g.yGroup, attempt: max + 1 });
    }
    // else: only canceled/voided history and no fresh edit => do NOT recreate
  });

  records.forEach(function (r) {
    if (isTerminalStatus_(r['Purchase Status']) || isTestRecord_(r)) return;
    var g = byId[str_(r['Listing ID'])];
    if (g && !g.any) {                                          // found in scanner, not Y
      voids.push({ record: r, transferred: str_(r['Transferred to eBay?']).toUpperCase() === 'Y' });
    }
    // not found in scanner at all (row deleted/moved) => leave untouched
  });
  return { creates: creates, voids: voids };
}

/**
 * Cost typed into the scanner sheet AFTER the purchase row was created.
 * For every open purchase, if the scanner listing now has a number in the cost column and it differs from the
 * Purchased row, the scanner value wins. A blank scanner cost never erases anything (a cost typed directly into
 * the Purchased tab is left alone). Returns [{purchaseId, cost, previous}].
 */
function planCostUpdates_(listings, records) {
  var costById = {};
  (listings || []).forEach(function (l) {
    if (l.cost === '' || l.cost === undefined || l.cost === null) return;
    if (costById[l.listingId] === undefined || l.purchased) costById[l.listingId] = l.cost;
  });
  var out = [];
  (records || []).forEach(function (r) {
    if (isTerminalStatus_(r['Purchase Status']) || isTestRecord_(r) || !isInScope_(r)) return;
    var c = costById[str_(r['Listing ID'])];
    if (c === undefined) return;
    var prev = parseMoney_(r['Purchase Cost']);
    if (prev === '' || Math.abs(prev - c) > 0.004) out.push({ purchaseId: str_(r['Purchase ID']), cost: c, previous: prev });
  });
  return out;
}

function buildPurchaseRecord_(listing, attempt, ts, costFromScanner) {
  var notes = '';
  var cost = (costFromScanner !== undefined && costFromScanner !== '') ? costFromScanner : '';
  if (cost === '') notes = ts + ' Purchase Cost not provided by scanner sheet — enter it (ask price is NOT used as cost)';
  return {
    'Purchase ID': listing.listingId + '-' + attempt,
    'Listing ID': listing.listingId,
    'Purchased At': ts,
    'Product': listing.names.join(' + '),
    'Facebook URL': listing.url,
    'Ask Price (FB)': listing.ask,
    'Purchase Cost': cost,
    'Estimated Resale': listing.hasResale ? listing.resale : '',
    'Scanner Row': listing.row,
    'Purchase Status': PURCHASE_STATUS.PURCHASED,
    'FB Error Count': 0,
    'Notes': notes,
    'Transferred to eBay?': ''
  };
}

// ---------------------------------------------------------------------------
// Feature 2: Facebook results
// ---------------------------------------------------------------------------

/** Minutes between Facebook ORDER checks for this row, or -1 when the row is not monitored on Facebook. */
function fbCheckInterval_(rec, cfg) {
  if (isTestRecord_(rec) || !isInScope_(rec)) return -1;
  var st = rec['Purchase Status'];
  if (st === PURCHASE_STATUS.PURCHASED) return str_(rec['Tracking Number']) ? -1 : cfg.FB_RECHECK_MINUTES;
  // A label can exist while the seller never ships (or cancels): keep an eye on it, slowly.
  if (st === PURCHASE_STATUS.TRACKING && str_(rec['USPS Accepted At']) === '') return cfg.FB_TRACKING_RECHECK_MINUTES == null ? 1440 : cfg.FB_TRACKING_RECHECK_MINUTES;
  return -1;                                                                // terminal, or USPS has the package
}

/** Which purchased rows the extension should check right now. */
function isFbCheckDue_(rec, nowMs, cfg) {
  var minutes = fbCheckInterval_(rec, cfg);
  if (minutes < 0) return false;
  var errs = parseInt(rec['FB Error Count'], 10) || 0;
  if (errs >= cfg.FB_ERROR_BACKOFF_AFTER) minutes = Math.max(minutes, cfg.FB_ERROR_BACKOFF_MINUTES);
  var last = toMs_(rec['Last FB Check']);
  if (isNaN(last)) return true;
  return (nowMs - last) >= minutes * 60000;
}

/**
 * Seller backfill for rows the ORDER checks no longer visit (shipped / delivered / canceled, or a stray tracking-only row).
 * Monitored rows get their seller from every regular order check, so they are never listed here. Each row is tried at
 * most cfg.SELLER_MAX_ATTEMPTS times, cfg.FB_SELLER_RECHECK_MINUTES apart. Voided and test rows are never visited.
 */
function isSellerBackfillDue_(rec, nowMs, cfg) {
  if (isTestRecord_(rec) || !isInScope_(rec)) return false;
  if (rec['Purchase Status'] === PURCHASE_STATUS.VOIDED || str_(rec['Seller'])) return false;
  if (!/^\d{6,25}$/.test(str_(rec['Listing ID'])) && !extractListingId_(rec['Facebook URL'])) return false;
  if (fbCheckInterval_(rec, cfg) >= 0) return false;                       // regular order checks will capture it
  var max = cfg.SELLER_MAX_ATTEMPTS == null ? 3 : cfg.SELLER_MAX_ATTEMPTS;
  if ((parseInt(rec['Seller Attempts'], 10) || 0) >= max) return false;
  var last = toMs_(rec['Last FB Check']);
  var minutes = cfg.FB_SELLER_RECHECK_MINUTES == null ? 360 : cfg.FB_SELLER_RECHECK_MINUTES;
  return isNaN(last) || (nowMs - last) >= minutes * 60000;
}

/** Seller / Facebook listing title from any extension result: only fills blanks, never overwrites. */
function sellerPatch_(rec, res) {
  var p = {};
  var seller = str_(res && res.seller).slice(0, 80);
  var title = str_(res && res.itemTitle).slice(0, 200);
  if (seller && !str_(rec['Seller'])) p['Seller'] = seller;
  if (title && !str_(rec['FB Listing Title'])) p['FB Listing Title'] = title;
  return p;
}

/** Result of a seller-only ("mode: seller") check. Never touches status, tracking or the FB error count. */
function applySellerResult_(rec, res, ts) {
  var p = sellerPatch_(rec, res || {});
  p['Last FB Check'] = ts;
  if (!p['Seller'] && !str_(rec['Seller'])) p['Seller Attempts'] = (parseInt(rec['Seller Attempts'], 10) || 0) + 1;
  return p;
}

// ---------------------------------------------------------------------------
// Cancellation / refund / expiry signals (Facebook order page, Meta Pay wallet, Marketplace notifications)
// ---------------------------------------------------------------------------

var CANCEL_KIND_LABEL = { canceled: 'Canceled', refunded: 'Refunded', expired: 'Expired' };

/**
 * Patch for a cancellation-type signal. Purchase Status stays the single terminal value 'Canceled' (so every existing
 * rule — work lists, transfer, dashboard counters — keeps working); WHAT happened is recorded in 'Cancel Signal'
 * ("Refunded — Meta Pay (…)") and 'Refund Received' = Y for refunds.
 *   strict=true  (indirect sources: Meta Pay, notifications): only while nothing proves the order shipped or was delivered.
 *   strict=false (Facebook's own order page): any open order that is not yet in inventory.
 * In every blocked case the signal is recorded as "Review: …" with a note — never silently dropped, never applied.
 */
function cancelPatch_(rec, kind, source, detail, ts, strict) {
  var label = CANCEL_KIND_LABEL[kind] || 'Canceled';
  var signal = (label + ' — ' + source + (detail ? ' (' + detail + ')' : '')).slice(0, 250);
  var cur = str_(rec['Cancel Signal']);
  var p = {};
  if (rec['Purchase Status'] === PURCHASE_STATUS.VOIDED) return p;
  if (kind === 'refunded' && str_(rec['Refund Received']).toUpperCase() !== 'Y') p['Refund Received'] = 'Y';
  if (rec['Purchase Status'] === PURCHASE_STATUS.CANCELED) {
    // Already canceled: only enrich (first reason wins, a refund confirmation is always recorded).
    if (!cur || (kind === 'refunded' && !/^Refunded/.test(cur))) {
      p['Cancel Signal'] = signal;
      p['Notes'] = appendNote_(rec['Notes'], ts, signal);
    }
    return p;
  }
  var transferred = str_(rec['Transferred to eBay?']).toUpperCase() === 'Y';
  var blocked = transferred || (strict && !canAutoCancel_(rec));
  if (blocked) {
    var review = 'Review: ' + signal;
    if (cur !== review) {
      p['Cancel Signal'] = review;
      p['Notes'] = appendNote_(rec['Notes'], ts, source + ' reports ' + label.toUpperCase() + ' but the purchase ' +
        (transferred ? 'is already in eBay inventory' : 'already shipped or was delivered') + ' — review manually (status not changed)');
    }
    return p;
  }
  p['Purchase Status'] = PURCHASE_STATUS.CANCELED;
  p['Cancel Signal'] = signal;
  p['FB Error Count'] = 0;
  p['Notes'] = appendNote_(rec['Notes'], ts, label + ': ' + source + (detail ? ' (' + detail + ')' : ''));
  return p;
}

/** Systemic errors (not the listing's fault) are never counted against it. */
function isSystemicFbError_(code) { return code === 'LOGIN_REQUIRED' || code === 'CHECKPOINT'; }

/**
 * Turns an extension result into a patch. NEVER emits blanks, never downgrades.
 * res: {ok, error, detail, fbStatusRaw, canceled, trackingNumber, carrier, orderId, orderTotal}
 */
/** An order may be auto-canceled from a missing View Order button only while nothing proves it shipped. */
function canAutoCancel_(rec) {
  return !isTerminalStatus_(rec['Purchase Status']) && str_(rec['USPS Accepted At']) === '' &&
         rec['USPS Stage'] !== STAGE.DELIVERED && !fbSaysDelivered_(rec);
}

function applyFbResult_(rec, res, ts) {
  var p = sellerPatch_(rec, res || {});                  // seller/title are useful even when the order view failed
  p['Last FB Check'] = ts;
  if (!res || res.ok !== true) {
    var code = (res && res.error) || 'UNKNOWN_ERROR';
    // SIMPLE RULE: the listing page loaded normally (logged in, real listing, fully rendered) but has no View Order
    // button => the order is gone => Canceled. Page-load failures, login walls, CAPTCHAs, removed listings and
    // extraction failures never reach this branch (the extension only sets pageHealthy when the page is genuinely fine).
    if (code === 'ORDER_DETAILS_NOT_FOUND' && res && res.pageHealthy === true && canAutoCancel_(rec)) {
      p['Purchase Status'] = PURCHASE_STATUS.CANCELED;
      p['FB Error Count'] = 0;
      p['Cancel Signal'] = 'Canceled — Facebook listing: View Order button missing';
      p['Notes'] = appendNote_(rec['Notes'], ts, 'Canceled: View Order button missing on a listing page that loaded normally');
      return p;
    }
    p['FB Error Count'] = (parseInt(rec['FB Error Count'], 10) || 0) + 1;
    p['Notes'] = appendNote_(rec['Notes'], ts, 'FB check failed: ' + code + (res && res.detail ? ' (' + String(res.detail).slice(0, 300) + ')' : ''));
    return p;
  }
  p['FB Error Count'] = 0;
  var merged = {}; var k;
  for (k in rec) merged[k] = rec[k];

  if (str_(res.fbStatusRaw)) p['FB Status (raw)'] = str_(res.fbStatusRaw).slice(0, 300);
  if (str_(res.orderId) && !str_(rec['FB Order ID'])) p['FB Order ID'] = str_(res.orderId);
  if (str_(res.orderTotal)) p['FB Order Total (raw)'] = str_(res.orderTotal);

  if (str_(res.trackingNumber)) {
    if (!str_(rec['Tracking Number'])) {
      p['Tracking Number'] = str_(res.trackingNumber);
      p['Carrier'] = str_(res.carrier) || 'Unknown';
      if (p['Carrier'] !== 'USPS') {
        p['Notes'] = appendNote_(p['Notes'] || rec['Notes'], ts, 'Carrier is ' + p['Carrier'] + ' — USPS auto-tracking does not apply; no automatic eBay transfer');
      }
    } else if (str_(rec['Tracking Number']) !== str_(res.trackingNumber)) {
      p['Notes'] = appendNote_(p['Notes'] || rec['Notes'], ts, 'Facebook now shows a DIFFERENT tracking number (' + str_(res.trackingNumber) + '); kept the original');
    }
  }

  if (res.canceled === true && !isTerminalStatus_(rec['Purchase Status'])) {
    var kind = CANCEL_KIND_LABEL[res.outcome] ? res.outcome : 'canceled';
    if (str_(rec['Transferred to eBay?']).toUpperCase() === 'Y') {
      p['Notes'] = appendNote_(p['Notes'] || rec['Notes'], ts, 'Facebook reports ' + CANCEL_KIND_LABEL[kind].toUpperCase() + ' after eBay transfer — review inventory manually');
      p['Cancel Signal'] = 'Review: ' + CANCEL_KIND_LABEL[kind] + ' — Facebook order status';
    } else {
      p['Purchase Status'] = PURCHASE_STATUS.CANCELED;
      p['Cancel Signal'] = CANCEL_KIND_LABEL[kind] + ' — Facebook order status' + (str_(res.fbStatusRaw) ? ' (' + str_(res.fbStatusRaw).split(' | ')[0] + ')' : '');
      if (kind === 'refunded') p['Refund Received'] = 'Y';
    }
  }

  for (k in p) merged[k] = p[k];
  var derived = derivePurchaseStatus_(merged);
  if (derived !== rec['Purchase Status']) p['Purchase Status'] = derived;
  return p;
}

var STATUS_ORDER = ['Purchased', 'Tracking Available', 'Shipped', 'Delivered'];

/** Monotonic: a status can move forward but is never downgraded (protects manual edits too). */
function derivePurchaseStatus_(rec) {
  var cur = rec['Purchase Status'];
  if (isTerminalStatus_(cur)) return cur;
  var d = PURCHASE_STATUS.PURCHASED;
  if (rec['USPS Stage'] === STAGE.DELIVERED || fbSaysDelivered_(rec)) d = PURCHASE_STATUS.DELIVERED;
  else if (str_(rec['USPS Accepted At'])) d = PURCHASE_STATUS.SHIPPED;
  else if (str_(rec['Tracking Number'])) d = PURCHASE_STATUS.TRACKING;
  var ci = STATUS_ORDER.indexOf(cur);
  return ci > STATUS_ORDER.indexOf(d) ? cur : d;
}

// ---------------------------------------------------------------------------
// Feature 3: USPS
// ---------------------------------------------------------------------------

function classifyUspsText_(text) {
  var t = String(text || '').toLowerCase().trim();
  if (!t) return STAGE.UNKNOWN;
  if (/out for delivery/.test(t)) return STAGE.OUT_FOR_DELIVERY;
  if (/\bdelivered\b/.test(t) && !/not delivered|undelivered|will be delivered|to be delivered|expected|attempt/.test(t)) return STAGE.DELIVERED;
  if (/your item was picked up at (the|a) .*post office|individual picked up/.test(t)) return STAGE.DELIVERED;   // customer collected it
  if (/alert|exception|notice left|attempt|undeliverable|return(ed)? to sender|held at|hold for pickup|available for pickup|refused|unclaimed|dead letter|insufficient address|damaged|delay|no access|unable to deliver|status not updated/.test(t)) return STAGE.EXCEPTION;
  // "Shipment Received, Package Acceptance Pending" is NOT acceptance yet.
  if (/acceptance pending|pending acceptance|awaiting (the )?(item|package)|waiting for (the )?(item|package)/.test(t)) return STAGE.AWAITING_ITEM;
  if (/label created|label has been|pre-?\s?shipment|shipping label|shipment information sent|electronic shipping|info received|shipping info/.test(t)) return STAGE.LABEL_CREATED;
  if (/accepted|acceptance|in possession|picked up|received (by|at) usps/.test(t)) return STAGE.ACCEPTED;
  if (/transit|moving through|in network|depart|arriv|process|en ?route|forward|dispatch|sort|facility|post office|hub/.test(t)) return STAGE.IN_TRANSIT;
  return STAGE.UNKNOWN;
}

function stageRank_(stage) { return STAGE_RANK[stage] || 0; }

var MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
var WEEKDAY_IDX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function fmtUtc_(y, mo, d) {
  var dt = new Date(Date.UTC(y, mo, d));
  if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return '';       // e.g. "Feb 30"
  return y + '-' + pad2_(mo + 1) + '-' + pad2_(d);
}

/**
 * Finds the first date in free text ("Saturday, October 24, 2026 by 8:00pm", "MONDAY 26 October 2026",
 * "Friday, October 23"). Returns 'yyyy-MM-dd' or ''. A date with no year is accepted ONLY if its weekday
 * is given and matches exactly one plausible date (-14..+90 days) — otherwise it is left blank, never guessed.
 */
function inferDate_(text, nowMs) {
  var s = String(text || '');
  var iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  var mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  var wk = '(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+)?';
  var m1 = s.match(new RegExp(wk + mon + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?', 'i'));      // October 24, 2026
  var m2 = s.match(new RegExp(wk + '(\\d{1,2})(?:st|nd|rd|th)?\\s+' + mon + '(?:,?\\s+(\\d{4}))?', 'i'));   // 24 October 2026
  var wd, mo, day, yr;
  if (m1 && (!m2 || m1.index <= m2.index)) { wd = m1[1]; mo = m1[2]; day = m1[3]; yr = m1[4]; }
  else if (m2) { wd = m2[1]; day = m2[2]; mo = m2[3]; yr = m2[4]; }
  else return '';
  var mi = MONTH_IDX[String(mo).toLowerCase().slice(0, 3)], d = parseInt(day, 10);
  if (yr) return fmtUtc_(parseInt(yr, 10), mi, d);
  if (!wd) return '';
  var base = new Date(nowMs || Date.now()).getUTCFullYear(), want = WEEKDAY_IDX[String(wd).toLowerCase().slice(0, 3)], hits = [];
  [base - 1, base, base + 1].forEach(function (y) {
    var f = fmtUtc_(y, mi, d);
    var t = Date.UTC(y, mi, d), n = nowMs || Date.now();
    var plausible = t >= n - 14 * 86400000 && t <= n + 90 * 86400000;      // a delivery estimate is never a year away
    if (f && plausible && new Date(t).getUTCDay() === want) hits.push(f);
  });
  return hits.length === 1 ? hits[0] : '';
}

/**
 * Turns what the extension SAW on tools.usps.com into the shape applyUspsResult_ expects.
 * res: {ok, status, history:[lines], expectedDelivery:'raw text', notFound, error, detail}
 * Acceptance is judged from the current status; history lines count only when the status itself is
 * unrecognised/exception, because page noise must never cause a false transfer.
 */
function parseUspsPage_(res, nowMs) {
  if (!res || res.ok !== true) {
    return { ok: false, notFound: !!(res && res.notFound), error: (res && res.error) || 'UNKNOWN', detail: res && res.detail };
  }
  if (res.notFound) return { ok: false, notFound: true, error: 'NOT_FOUND' };
  var status = str_(res.status);
  if (!status && !(res.history && res.history.length)) return { ok: false, error: 'NO_STATUS_FOUND' };
  var history = (res.history || []).map(str_).filter(function (l) { return l && l.length <= 100; });
  var stage = classifyUspsText_(status);
  if (stage === STAGE.UNKNOWN && res.summary) stage = classifyUspsText_(res.summary);
  if (stage === STAGE.UNKNOWN && history.length) stage = classifyUspsText_(history[0]);
  var accepted = stageRank_(stage) >= 3;
  if (!accepted && (stage === STAGE.UNKNOWN || stage === STAGE.EXCEPTION)) {
    accepted = history.some(function (l) { return stageRank_(classifyUspsText_(l)) >= 3; });
  }
  return {
    ok: true, status: status, category: '', summary: '', stage: stage, accepted: accepted,
    acceptedAt: '', deliveredAt: '', expectedDelivery: inferDate_(res.expectedDelivery, nowMs)
  };
}

/**
 * parsed: output of parseUspsPage_, or {ok:false,notFound:true,...}.
 * Never overwrites good data with empty data; never regresses to pre-shipment
 * after USPS already accepted the package.
 */
function applyUspsResult_(rec, parsed, ts, tsIso) {
  var p = { 'Last USPS Check': ts };
  if (!parsed || parsed.ok !== true) {
    if (parsed && parsed.notFound) {
      p['Notes'] = appendNote_(rec['Notes'], ts, 'USPS: tracking number not found (yet)');
    } else {
      p['Notes'] = appendNote_(rec['Notes'], ts, 'USPS check failed: ' + ((parsed && parsed.error) || 'UNKNOWN') + (parsed && parsed.detail ? ' (' + parsed.detail + ')' : ''));
    }
    return p;
  }
  var prevStage = rec['USPS Stage'], prevRank = stageRank_(prevStage);
  var newRank = stageRank_(parsed.stage);
  var regressed = prevRank >= 3 && newRank >= 1 && newRank <= 2;
  var unknown = parsed.stage === STAGE.UNKNOWN;
  var note = '';

  if (regressed) {
    note = 'USPS status went backwards (' + prevStage + ' → ' + parsed.stage + '); kept previous. Raw: ' + parsed.status;
  } else if (unknown) {
    note = 'USPS status not recognised: "' + parsed.status + '" / "' + parsed.category + '"';
    if (parsed.status) p['USPS Status (raw)'] = parsed.status;
    if (parsed.category) p['USPS Category (raw)'] = parsed.category;
  } else {
    p['USPS Stage'] = parsed.stage;
    if (parsed.status) p['USPS Status (raw)'] = parsed.status;
    if (parsed.category) p['USPS Category (raw)'] = parsed.category;
  }

  if (parsed.accepted && !str_(rec['USPS Accepted At']) && !regressed) {
    p['USPS Accepted At'] = parsed.acceptedAt ? parsed.acceptedAt.replace('T', ' ').replace(/Z$/, ' UTC') : ts;
  }
  if (parsed.expectedDelivery) p['Estimated Delivery'] = parsed.expectedDelivery;
  if (parsed.stage === STAGE.DELIVERED && !regressed && !str_(rec['Delivered At'])) {
    p['Delivered At'] = parsed.deliveredAt ? parsed.deliveredAt.replace('T', ' ').replace(/Z$/, ' UTC') : ts;
    if (!str_(rec['USPS Accepted At']) && !p['USPS Accepted At']) p['USPS Accepted At'] = p['Delivered At'];
  }
  if (note) p['Notes'] = appendNote_(rec['Notes'], ts, note);

  var merged = {}, k;
  for (k in rec) merged[k] = rec[k];
  for (k in p) merged[k] = p[k];
  var derived = derivePurchaseStatus_(merged);
  if (derived !== rec['Purchase Status']) p['Purchase Status'] = derived;
  return p;
}

/** Which rows the USPS poller should check. */
function isUspsCheckDue_(rec) {
  if (isTestRecord_(rec) || !isInScope_(rec)) return false;
  if (isTerminalStatus_(rec['Purchase Status'])) return false;
  if (!str_(rec['Tracking Number'])) return false;
  var carrier = str_(rec['Carrier']).toUpperCase();
  if (carrier && carrier !== 'USPS') return false;
  if (rec['USPS Stage'] === STAGE.DELIVERED || rec['Purchase Status'] === PURCHASE_STATUS.DELIVERED) return false;
  return true;
}

/** Throttle for the extension's USPS work list (the page is only loaded when due). */
function isUspsWorkDue_(rec, nowMs, minMinutes) {
  if (!isUspsCheckDue_(rec)) return false;
  var last = toMs_(rec['Last USPS Check']);
  return isNaN(last) || (nowMs - last) >= minMinutes * 60000;
}

// ---------------------------------------------------------------------------
// Feature 4: eBay transfer eligibility + inventory status
// ---------------------------------------------------------------------------

/** Tracking number alone is NOT enough: USPS must have accepted the package (or Facebook explicitly says it was delivered). */
function isTransferEligible_(rec) {
  if (isTestRecord_(rec) || !isInScope_(rec)) return false;
  if (isTerminalStatus_(rec['Purchase Status'])) return false;
  if (str_(rec['Transferred to eBay?']).toUpperCase() === 'Y') return false;
  return str_(rec['USPS Accepted At']) !== '' || fbSaysDelivered_(rec);
}

function inventoryStatusFor_(rec, invCfg) {
  return (rec['USPS Stage'] === STAGE.DELIVERED || fbSaysDelivered_(rec)) ? invCfg.statusDelivered : invCfg.statusInTransit;
}

/** "v2|<usps stage>|<purchase cost>": status refresh and Item Cost re-allocation are triggered independently. */
function inventorySig_(rec) {
  var stage = (rec['USPS Stage'] === STAGE.DELIVERED || fbSaysDelivered_(rec)) ? STAGE.DELIVERED : str_(rec['USPS Stage']);
  var c = parseMoney_(rec['Purchase Cost']);
  return 'v2|' + stage + '|' + (c === '' ? '' : c);
}
function inventorySigParts_(sig) {
  var m = String(sig || '').match(/^v2\|([^|]*)\|(.*)$/);
  return m ? { stage: m[1], cost: m[2] } : null;
}

/**
 * Splits a listing's cost across its primary products, in whole cents, so the parts ALWAYS add up to the total
 * (the first `remainder` items get the extra cent). Missing/invalid cost => blanks (never $0).
 */
function allocateCost_(total, n) {
  var out = [], t = parseMoney_(total), i;
  if (!n || n < 1) return out;
  if (t === '') { for (i = 0; i < n; i++) out.push(''); return out; }
  var cents = Math.round(t * 100), base = Math.floor(cents / n), rem = cents - base * n;
  for (i = 0; i < n; i++) out.push((base + (i < rem ? 1 : 0)) / 100);
  return out;
}

/** One entry per PRIMARY PRODUCT ROW of the scanner listing (units are not counted); falls back to the purchase record. */
function buildInventoryItems_(listing, rec) {
  if (listing && listing.items && listing.items.length) return listing.items.map(function (i) { return { name: i.name, resale: i.resale }; });
  return [{ name: str_(rec['Product']), resale: parseMoney_(rec['Estimated Resale']) }];
}

function itemKey_(purchaseId, n) { return String(purchaseId) + '#' + n; }

function colToLetter_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m) / 26); }
  return s;
}

// ---------------------------------------------------------------------------
// Feature 5: Meta Pay wallet + Marketplace notifications -> Purchased rows (pure matching)
// ---------------------------------------------------------------------------

/** "Olga  Serdínskaya" -> "olga serdinskaya" (accents, case, punctuation and spacing ignored). */
function normalizePersonName_(s) {
  var t = str_(s);
  try { t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* old runtime: keep accents */ }
  return t.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * 2 = same name; 1 = partial (same first AND last word, e.g. "Tysha A Rodriguez" vs "Tysha Rodriguez", or one name's
 * words all contained in the other's with at least two words); 0 = different.
 */
function sellerMatchLevel_(a, b) {
  var na = normalizePersonName_(a), nb = normalizePersonName_(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  var ta = na.split(' ').filter(function (w) { return w.length > 1; }), tb = nb.split(' ').filter(function (w) { return w.length > 1; });
  if (ta.length < 2 || tb.length < 2) return 0;
  if (ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return 1;
  var sub = function (x, y) { return x.every(function (w) { return y.indexOf(w) !== -1; }); };
  return (sub(ta, tb) || sub(tb, ta)) ? 1 : 0;
}

/** Days from the purchase timestamp to a wallet date ('yyyy-MM-dd', taken at noon UTC). Negative = wallet date earlier. */
function walletDayOffset_(walletDate, purchasedAt) {
  var m = str_(walletDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var p = toMs_(purchasedAt);
  if (!m || isNaN(p)) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3], 12) - p) / 86400000;
}

/** Meta Pay status -> 'canceled' | 'refunded' | 'expired' | 'delivered' | 'delayed' | 'active'. */
function metaPayKind_(status) {
  var s = str_(status).toLowerCase();
  if (/^cancell?ed/.test(s)) return 'canceled';
  if (/^partially refunded/.test(s)) return 'active';
  if (/^refunded/.test(s)) return 'refunded';
  if (/^expired/.test(s)) return 'expired';
  if (/^delivered/.test(s)) return 'delivered';
  if (/delay/.test(s)) return 'delayed';
  return 'active';
}

/** Rows a Meta Pay / notification signal may update: real, in scope, not voided. Canceled rows only get refund info. */
function isSignalCandidate_(rec) {
  return !isTestRecord_(rec) && isInScope_(rec) && rec['Purchase Status'] !== PURCHASE_STATUS.VOIDED;
}

/** Does the backend have purchases a cancellation signal could still affect? (Tells the extension to scan signals.) */
function wantsSignals_(records) {
  return (records || []).some(function (r) {
    return isSignalCandidate_(r) && !isTerminalStatus_(r['Purchase Status']) && r['Purchase Status'] !== PURCHASE_STATUS.DELIVERED &&
           r['USPS Stage'] !== STAGE.DELIVERED && !fbSaysDelivered_(r);
  });
}

function fmtMoney_(v) { return v === '' || v === undefined || v === null ? '' : '$' + Number(v).toFixed(2); }

/**
 * Meta Pay transactions [{seller, status, date:'yyyy-MM-dd', amount}] -> planned updates.
 *
 * The wallet shows the SELLER NAME (not the listing), so a transaction is matched to a Purchased row by its Seller
 * column, then VERIFIED by date and amount so repeat sellers and partial names cannot collide:
 *   - date gate: wallet date between `daysBefore` days before and `daysAfter` days after "Purchased At"
 *     (you mark Y in the scanner after paying, so the wallet date is usually the same day or earlier);
 *   - a partial name match additionally needs the exact amount (to the cent) or the same day;
 *   - candidates are scored (name, exact amount, date distance) and assigned one-to-one, best first;
 *     a tie between two rows (or two transactions) is reported as ambiguous and NOTHING is changed for it.
 * Canceled / Refunded / Expired -> cancelPatch_ (strict). Every matched row gets 'Meta Pay Status' ("Delivered · 2026-11-03 · $262.84").
 * Returns {updates:[{purchaseId, patch, event, detail}], unmatched:[tx], ambiguous:[{tx, purchaseIds}]}.
 */
function planMetaPayUpdates_(transactions, records, ts, cfg) {
  cfg = cfg || {};
  var before = cfg.daysBefore == null ? 6 : cfg.daysBefore, after = cfg.daysAfter == null ? 2 : cfg.daysAfter;
  var txs = (transactions || []).filter(function (t) { return t && str_(t.seller) && str_(t.status); });
  var recs = (records || []).filter(function (r) { return isSignalCandidate_(r) && str_(r['Seller']); });
  var pairs = [];
  txs.forEach(function (tx, ti) {
    var amt = parseMoney_(tx.amount);
    recs.forEach(function (rec, ri) {
      var lvl = sellerMatchLevel_(tx.seller, rec['Seller']);
      if (!lvl) return;
      var d = walletDayOffset_(tx.date, rec['Purchased At']);
      var cost = parseMoney_(rec['Purchase Cost']);
      var amtKnown = cost !== '' && amt !== '';
      var amtMatch = amtKnown && Math.abs(cost - amt) <= 0.011;
      if (d === null) { if (!amtMatch) return; }
      else if (d < -before - 0.5 || d > after + 0.5) return;
      var sameDay = d !== null && Math.abs(d) <= 1;
      if (lvl === 1 && !amtMatch && !sameDay) return;
      var score = lvl * 100 + (amtMatch ? 50 : 0) - (amtKnown && !amtMatch ? 10 : 0) - (d === null ? 20 : Math.round(Math.abs(d) * 5));
      pairs.push({ ti: ti, ri: ri, score: score });
    });
  });
  pairs.sort(function (a, b) { return b.score - a.score; });
  var txUsed = {}, recUsed = {}, ambiguousTx = {}, assigned = [];
  pairs.forEach(function (pr) {
    if (txUsed[pr.ti] || recUsed[pr.ri] || ambiguousTx[pr.ti]) return;
    var rival = pairs.some(function (o) {
      return o !== pr && o.score === pr.score && ((o.ti === pr.ti && !recUsed[o.ri]) || (o.ri === pr.ri && !txUsed[o.ti] && !ambiguousTx[o.ti]));
    });
    if (rival) {
      ambiguousTx[pr.ti] = pairs.filter(function (o) { return (o.ti === pr.ti || o.ri === pr.ri) && o.score === pr.score; })
        .map(function (o) { return str_(recs[o.ri]['Purchase ID']); });
      return;
    }
    txUsed[pr.ti] = true; recUsed[pr.ri] = true;
    assigned.push(pr);
  });

  var updates = [];
  assigned.forEach(function (pr) {
    var tx = txs[pr.ti], rec = recs[pr.ri];
    var kind = metaPayKind_(tx.status);
    var amount = parseMoney_(tx.amount);
    var label = str_(tx.status) + (str_(tx.date) ? ' · ' + str_(tx.date) : '') + (amount !== '' ? ' · ' + fmtMoney_(amount) : '');
    var p = {};
    if (str_(rec['Meta Pay Status']) !== label) p['Meta Pay Status'] = label;
    if (CANCEL_KIND_LABEL[kind]) {
      var cp = cancelPatch_(rec, kind, 'Meta Pay', label + ', seller ' + str_(tx.seller), ts, true);
      for (var k in cp) p[k] = cp[k];
    } else if (kind === 'delivered' && !isTerminalStatus_(rec['Purchase Status'])) {
      var merged = {}, x;
      for (x in rec) merged[x] = rec[x];
      for (x in p) merged[x] = p[x];
      var derived = derivePurchaseStatus_(merged);
      if (derived !== rec['Purchase Status']) p['Purchase Status'] = derived;
    }
    if (Object.keys(p).length) {
      updates.push({ purchaseId: str_(rec['Purchase ID']), patch: p, event: p['Purchase Status'] === PURCHASE_STATUS.CANCELED ? 'META_PAY_CANCELED' : 'META_PAY_STATUS',
                     detail: label + ' | ' + str_(tx.seller) });
    }
  });
  var unmatched = txs.filter(function (t, i) { return !txUsed[i] && !ambiguousTx[i]; });
  var ambiguous = Object.keys(ambiguousTx).map(function (i) { return { tx: txs[i], purchaseIds: ambiguousTx[i] }; });
  return { updates: updates, unmatched: unmatched, ambiguous: ambiguous };
}

var TITLE_STOPWORDS = { the: 1, a: 1, an: 1, and: 1, with: 1, for: 1, of: 1, in: 1, on: 1, to: 1, w: 1, plus: 1, lens: 1, camera: 1, body: 1, kit: 1, used: 1, new: 1 };

function titleTokens_(s) {
  return normalizePersonName_(s).split(' ').filter(function (w) { return w && !TITLE_STOPWORDS[w]; });
}

/**
 * How well a notification sentence names a purchase: 2 = the listing ID is linked, or the full Facebook listing title
 * appears verbatim; 1 = every significant word (at least 3) of the title or of one scanner product name appears; 0 = no.
 */
function notificationMatchLevel_(n, rec) {
  if ((n.listingIds || []).indexOf(str_(rec['Listing ID'])) !== -1) return 2;
  var text = ' ' + normalizePersonName_(n.text) + ' ';
  var title = normalizePersonName_(rec['FB Listing Title']);
  if (title.length >= 8 && text.indexOf(' ' + title + ' ') !== -1) return 2;
  var words = {};
  text.trim().split(' ').forEach(function (w) { words[w] = true; });
  var names = [str_(rec['FB Listing Title'])].concat(str_(rec['Product']).split(/\s\+\s/));
  var partial = names.some(function (nm) {
    var tk = titleTokens_(nm);
    return tk.length >= 3 && tk.every(function (w) { return words[w]; });
  });
  return partial ? 1 : 0;
}

/**
 * Marketplace notifications [{text, kind, listingIds, atMs}] -> planned updates.
 * Only canceled / refunded / expired notices act. A notice must name exactly ONE candidate row (else: ambiguous, no change),
 * must not predate the purchase (a relative time like "1w" is an upper bound; one day of slack), and for a re-bought
 * listing (attempt 2+) its time must be known. A weak (word-only) match is recorded as "Review: …" and never cancels.
 */
function planNotificationUpdates_(notifications, records, ts) {
  var recs = (records || []).filter(isSignalCandidate_);
  var updates = [], ambiguous = [], unmatched = [], touched = {};
  (notifications || []).forEach(function (n) {
    if (!n || !CANCEL_KIND_LABEL[n.kind]) return;
    var at = n.atMs === '' || n.atMs === undefined || n.atMs === null ? NaN : Number(n.atMs);
    var hits = [];
    recs.forEach(function (rec) {
      if (touched[str_(rec['Purchase ID'])]) return;
      var lvl = notificationMatchLevel_(n, rec);
      if (!lvl) return;
      var pms = toMs_(rec['Purchased At']);
      if (!isNaN(at) && !isNaN(pms) && at + 86400000 < pms) return;            // notice is older than this purchase
      if (isNaN(at) && attemptNumber_(rec['Purchase ID']) > 1) return;         // could be about the earlier attempt
      if (n.kind !== 'refunded' && rec['Purchase Status'] === PURCHASE_STATUS.CANCELED) return;   // already canceled: nothing new
      if (n.kind === 'refunded' && str_(rec['Refund Received']).toUpperCase() === 'Y') return;
      hits.push({ rec: rec, lvl: lvl });
    });
    if (!hits.length) { unmatched.push(n); return; }
    var best = Math.max.apply(null, hits.map(function (h) { return h.lvl; }));
    var top = hits.filter(function (h) { return h.lvl === best; });
    if (top.length > 1) { ambiguous.push({ notification: n, purchaseIds: top.map(function (h) { return str_(h.rec['Purchase ID']); }) }); return; }
    var rec = top[0].rec, label = CANCEL_KIND_LABEL[n.kind];
    var detail = '"' + str_(n.text).slice(0, 140) + '"';
    var p;
    if (best === 2) p = cancelPatch_(rec, n.kind, 'Marketplace notification', detail, ts, true);
    else {
      p = {};
      if (rec['Purchase Status'] !== PURCHASE_STATUS.CANCELED && !/^Review:/.test(str_(rec['Cancel Signal']))) {
        p['Cancel Signal'] = ('Review: possibly ' + label + ' — Marketplace notification ' + detail).slice(0, 250);
        p['Notes'] = appendNote_(rec['Notes'], ts, 'Marketplace notification may refer to this purchase (' + label + '): ' + detail + ' — confirm on Facebook');
      }
    }
    if (Object.keys(p).length) {
      touched[str_(rec['Purchase ID'])] = true;
      updates.push({ purchaseId: str_(rec['Purchase ID']), patch: p, event: p['Purchase Status'] === PURCHASE_STATUS.CANCELED ? 'NOTIFICATION_CANCELED' : 'NOTIFICATION_SIGNAL', detail: label + ' ' + detail });
    }
  });
  return { updates: updates, ambiguous: ambiguous, unmatched: unmatched };
}
