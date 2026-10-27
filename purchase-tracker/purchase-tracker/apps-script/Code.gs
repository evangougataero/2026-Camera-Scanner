/**
 * Purchase Tracker — Google Apps Script (standalone project).
 *
 * Owns ALL spreadsheet logic:
 *   - onScannerEdit      installable onEdit trigger on the scanner spreadsheet
 *   - reconcile          every 10 min: catches missed edits, retries transfers
 *   - doPost             tiny JSON bridge for the Chrome extension (Facebook + USPS page checks)
 *
 * No USPS/Facebook APIs and no credentials: the extension reads the public pages and posts
 * what it saw here. Transfers to eBay inventory happen immediately after a USPS result and
 * again every 10 minutes (reconcile), even with Chrome closed.
 * Pure logic lives in Logic.gs (unit-tested). Run setup() once after editing CONFIG.
 */

// Settings live in Config.gs (yours; never overwritten by code updates).

// ===========================================================================
// Small utilities
// ===========================================================================
function colLetterToIndex_(letter) {
  var n = 0, s = String(letter).toUpperCase();
  for (var i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

function openById_(id, label) {
  if (!id || /^PASTE_/.test(id)) {
    throw new Error('Config.gs is not filled in: ' + (label || 'spreadsheetId') + ' is still "' + (id || '') + '". ' +
      'Put your spreadsheet id there (run recoverScannerSpreadsheetId() to find the scanner one).');
  }
  return SpreadsheetApp.openById(id);
}
function scannerSS_() { return openById_(CONFIG.SCANNER.spreadsheetId, 'CONFIG.SCANNER.spreadsheetId'); }
function purchasedSS_() { return CONFIG.PURCHASED.spreadsheetId ? openById_(CONFIG.PURCHASED.spreadsheetId, 'CONFIG.PURCHASED.spreadsheetId') : scannerSS_(); }

function nowStr_(ss) {
  return Utilities.formatDate(new Date(), (ss || purchasedSS_()).getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
}
function nowSecStr_(ss) {
  return Utilities.formatDate(new Date(), (ss || purchasedSS_()).getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function withLock_(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 30000)) throw new Error('LOCK_TIMEOUT');
  try { return fn(); } finally { lock.releaseLock(); }
}

function headerMap_(sheet, headerRow) {
  var lastCol = sheet.getLastColumn();
  var map = {};
  if (lastCol < 1) return map;
  var vals = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  for (var i = 0; i < vals.length; i++) {
    var h = String(vals[i]).trim();
    if (h && !map[h]) map[h] = i + 1;
  }
  return map;
}

// ===========================================================================
// Purchased table access
// ===========================================================================
function purchasedSheet_() {
  var ss = purchasedSS_();
  var sh = ss.getSheetByName(CONFIG.PURCHASED.tab);
  if (!sh) throw new Error('Purchased tab missing — run setup().');
  return sh;
}

/** Midnight (spreadsheet time zone) of CONFIG.PURCHASE_SCOPE_START; 0 = no cutoff. Defaults to 2026-10-25 if Config.gs predates it. */
function scopeStartMs_() {
  var s = CONFIG.PURCHASE_SCOPE_START === undefined ? '2026-10-25' : CONFIG.PURCHASE_SCOPE_START;
  if (!s) return 0;
  return Utilities.parseDate(String(s), purchasedSS_().getSpreadsheetTimeZone(), 'yyyy-MM-dd').getTime();
}

function readPurchased_() {
  SCOPE_START_MS = scopeStartMs_();
  var sh = purchasedSheet_();
  var hm = headerMap_(sh, 1);
  var last = sh.getLastRow();
  var records = [];
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, sh.getLastColumn()).getValues();
    for (var i = 0; i < vals.length; i++) {
      var o = { _row: i + 2 };
      for (var h in hm) o[h] = vals[i][hm[h] - 1];
      if (str_(o['Purchase ID']) !== '') records.push(o);
    }
  }
  return { sh: sh, hm: hm, records: records };
}

/** Re-locates the row by Purchase ID at write time (rows may have been sorted). Never writes blanks. */
function updateRecord_(purchaseId, patch) {
  var sh = purchasedSheet_();
  var hm = headerMap_(sh, 1);
  var last = sh.getLastRow();
  if (last < 2) return false;
  var ids = sh.getRange(2, hm['Purchase ID'], last - 1, 1).getValues();
  var row = 0;
  for (var i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(purchaseId)) { row = i + 2; break; }
  if (!row) return false;
  for (var field in patch) {
    var v = patch[field];
    if (v === undefined || v === null || v === '') continue;          // preserve existing data
    if (!hm[field]) continue;
    var cell = sh.getRange(row, hm[field]);
    if (TEXT_FIELDS[field]) cell.setNumberFormat('@');
    cell.setValue(TEXT_FIELDS[field] ? String(v) : v);
  }
  return true;
}

function appendRecord_(rec) {
  var sh = purchasedSheet_();
  var hm = headerMap_(sh, 1);
  var row = Math.max(sh.getLastRow(), 1) + 1;
  for (var field in rec) {
    var v = rec[field];
    if (!hm[field] || v === undefined || v === null || v === '') continue;
    var cell = sh.getRange(row, hm[field]);
    if (TEXT_FIELDS[field]) cell.setNumberFormat('@');
    cell.setValue(TEXT_FIELDS[field] ? String(v) : v);
  }
  return row;
}

function log_(purchaseId, event, detail) {
  try {
    var ss = purchasedSS_();
    var sh = ss.getSheetByName(CONFIG.PURCHASED.logTab);
    if (!sh) return;
    sh.appendRow([nowSecStr_(ss), purchaseId || '', event, String(detail || '').slice(0, 500)]);
  } catch (e) { Logger.log('log_ failed: ' + e); }
}

// ===========================================================================
// Feature 1: scanner -> Purchased
// ===========================================================================
function scannerColumns_(sc) {
  var S = CONFIG.SCANNER;
  var hm = headerMap_(sc, S.headerRow);
  if (!hm[S.purchasedHeader]) {
    throw new Error('Scanner header "' + S.purchasedHeader + '" not found in row ' + S.headerRow +
      '. Headers seen: ' + Object.keys(hm).join(', '));
  }
  var cost = -1;
  for (var i = 0; i < S.costHeaders.length; i++) {
    if (hm[S.costHeaders[i]]) { cost = hm[S.costHeaders[i]] - 1; break; }
  }
  return {
    name: colLetterToIndex_(S.nameCol) - 1, url: colLetterToIndex_(S.urlCol) - 1,
    ask: colLetterToIndex_(S.askCol) - 1, resale: colLetterToIndex_(S.resaleCol) - 1,
    purchased: hm[S.purchasedHeader] - 1, cost: cost,
    purchasedCol1: hm[S.purchasedHeader]
  };
}

function readScannerListings_() {
  var sc = scannerSS_().getSheetByName(CONFIG.SCANNER.tab);
  if (!sc) throw new Error('Scanner tab not found: ' + CONFIG.SCANNER.tab);
  var cols = scannerColumns_(sc);
  var first = CONFIG.SCANNER.headerRow + 1;
  var last = sc.getLastRow();
  if (last < first) return { listings: [], cols: cols };
  var width = Math.max(sc.getLastColumn(), cols.purchased + 1, 17);
  var values = sc.getRange(first, 1, last - first + 1, width).getValues();
  return { listings: groupScannerListings_(values, first, cols), cols: cols };
}

/** 1-based column of the scanner cost header (first of CONFIG.SCANNER.costHeaders that exists), or 0. */
function costColumn1_(hm) {
  var list = CONFIG.SCANNER.costHeaders || [];
  for (var i = 0; i < list.length; i++) if (hm[list[i]]) return hm[list[i]];
  return 0;
}

/** Idempotent. Safe to call from onEdit, reconcile, or by hand any number of times. */
function syncFromScanner_(forceRows) {
  var scan = readScannerListings_();
  var rd = readPurchased_();
  var forceIds = {};
  (forceRows || []).forEach(function (r) {
    scan.listings.forEach(function (l) { if (r >= l.row && r <= l.rowEnd) forceIds[l.listingId] = true; });
  });
  var plan = planSync_(scan.listings, rd.records, forceIds);
  var ts = nowStr_();

  plan.creates.forEach(function (c) {
    var rec = buildPurchaseRecord_(c.listing, c.attempt, ts, c.listing.cost);
    appendRecord_(rec);
    log_(rec['Purchase ID'], 'PURCHASE_CREATED', 'scanner row ' + c.listing.row);
  });
  plan.voids.forEach(function (v) {
    var r = v.record;
    if (v.transferred) {
      updateRecord_(r['Purchase ID'], { 'Notes': appendNote_(r['Notes'], ts, 'Un-marked in scanner AFTER eBay transfer — NOT voided; review inventory row manually') });
      log_(r['Purchase ID'], 'UNMARK_AFTER_TRANSFER', 'left intact');
    } else {
      updateRecord_(r['Purchase ID'], {
        'Purchase Status': PURCHASE_STATUS.VOIDED,
        'Notes': appendNote_(r['Notes'], ts, 'Voided: Purchased? un-marked in scanner')
      });
      log_(r['Purchase ID'], 'PURCHASE_VOIDED', 'un-marked in scanner');
    }
  });

  // Cost typed into the scanner sheet after the purchase row exists (creation only read it once).
  var costUpdates = planCostUpdates_(scan.listings, rd.records);
  costUpdates.forEach(function (u) {
    var rec = rd.records.filter(function (r) { return str_(r['Purchase ID']) === u.purchaseId; })[0] || {};
    updateRecord_(u.purchaseId, {
      'Purchase Cost': u.cost,
      'Notes': appendNote_(rec['Notes'], ts, 'Purchase Cost set from scanner sheet: $' + u.cost + (u.previous === '' ? '' : ' (was $' + u.previous + ')'))
    });
    log_(u.purchaseId, 'COST_SYNCED', '$' + u.cost + (u.previous === '' ? '' : ' (was $' + u.previous + ')'));
  });
  return { created: plan.creates.length, voided: plan.voids.length, costUpdated: costUpdates.length };
}

/** Installable trigger (created by setup()). */
function onScannerEdit(e) {
  try {
    if (!e || !e.range) return;
    var sh = e.range.getSheet();
    if (sh.getName() !== CONFIG.SCANNER.tab) return;
    var hm = headerMap_(sh, CONFIG.SCANNER.headerRow);
    var pc = hm[CONFIG.SCANNER.purchasedHeader];
    var cc = costColumn1_(hm);
    var hitsPurchased = !!pc && e.range.getColumn() <= pc && e.range.getLastColumn() >= pc;
    var hitsCost = !!cc && e.range.getColumn() <= cc && e.range.getLastColumn() >= cc;
    if (!hitsPurchased && !hitsCost) return;

    var force = [];
    // Newly typed Y on a single cell => allow a fresh purchase attempt for canceled/voided listings.
    if (hitsPurchased && e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 &&
        isYes_(e.value) && !isYes_(e.oldValue)) force.push(e.range.getRow());

    withLock_(function () { syncFromScanner_(force); }, 25000);
  } catch (err) {
    log_('', 'ONEDIT_ERROR', err && err.message);   // reconcile() will catch up
  }
}

// ===========================================================================
// Periodic: reconcile + transfers
// ===========================================================================
function reconcile() {
  withLock_(function () {
    syncFromScanner_([]);
    transferEligible_();
    syncInventoryStatus_();
    trimLog_();
  }, 60000);
}

function trimLog_() {
  var sh = purchasedSS_().getSheetByName(CONFIG.PURCHASED.logTab);
  if (sh && sh.getLastRow() > CONFIG.LOG_MAX_ROWS) sh.deleteRows(2, 1000);
}

// Inventory transfer / sync lives in Inventory.gs (one row per primary product).

// ===========================================================================
// Feature 2 (sheet side): tiny JSON API for the Chrome extension
// ===========================================================================
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function doGet() { return json_({ ok: true, service: 'purchase-tracker', note: 'POST only' }); }

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'BAD_JSON' }); }
  var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!token || body.token !== token) return json_({ ok: false, error: 'UNAUTHORIZED' });

  try {
    switch (body.action) {
      case 'ping': return json_({ ok: true, time: nowSecStr_() });
      case 'getWork': return json_(apiGetWork_(body));
      case 'getUspsWork': return json_(apiGetUspsWork_(body));
      case 'submitUspsResult': return json_(withLock_(function () { return apiSubmitUsps_(body); }, 60000));
      case 'submitFbResult': return json_(withLock_(function () { return apiSubmitFb_(body); }, 30000));
      case 'reportIssue':
        log_('', 'EXTENSION_ISSUE', (body.code || '') + ' ' + (body.message || ''));
        return json_({ ok: true });
      default: return json_({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'SERVER_ERROR', detail: String(err && err.message || err) });
  }
}

function apiGetWork_(body) {
  var rd = readPurchased_();
  var now = Date.now();
  var limit = Math.min(parseInt(body.limit, 10) || CONFIG.FB_BATCH_LIMIT, CONFIG.FB_BATCH_LIMIT);
  var cfg = body.force
    ? { FB_RECHECK_MINUTES: 0, FB_TRACKING_RECHECK_MINUTES: 0, FB_ERROR_BACKOFF_AFTER: 1e9, FB_ERROR_BACKOFF_MINUTES: 0 }
    : CONFIG;
  var items = rd.records.filter(function (r) { return isFbCheckDue_(r, now, cfg); })
    .slice(0, limit)
    .map(function (r) { return { purchaseId: String(r['Purchase ID']), listingId: String(r['Listing ID']), url: str_(r['Facebook URL']), orderId: str_(r['FB Order ID']) }; });
  return { ok: true, items: items };
}

function apiSubmitFb_(body) {
  var rd = readPurchased_();
  var rec = rd.records.filter(function (r) { return String(r['Purchase ID']) === String(body.purchaseId); })[0];
  if (!rec) return { ok: false, error: 'UNKNOWN_PURCHASE_ID' };
  if (isTerminalStatus_(rec['Purchase Status'])) return { ok: true, ignored: 'terminal' };
  var res = body.result || {};
  if (!res.ok && isSystemicFbError_(res.error)) {          // login wall etc. must not count against the listing
    log_(rec['Purchase ID'], 'FB_SYSTEMIC', res.error);
    return { ok: true, ignored: 'systemic' };
  }
  var ts = nowStr_();
  var patch = applyFbResult_(rec, res, ts);
  updateRecord_(rec['Purchase ID'], patch);
  log_(rec['Purchase ID'], res.ok ? 'FB_CHECKED' : 'FB_CHECK_FAILED',
       res.ok ? ((patch['Purchase Status'] || rec['Purchase Status']) + ' | ' + (res.fbStatusRaw || '') + (res.trackingNumber ? ' | tracking found' : '')) : res.error);
  return { ok: true, status: patch['Purchase Status'] || rec['Purchase Status'] };
}

function apiGetUspsWork_(body) {
  var rd = readPurchased_();
  var now = Date.now();
  var min = body.force ? 0 : CONFIG.USPS_RECHECK_MINUTES;
  var limit = Math.min(parseInt(body.limit, 10) || CONFIG.USPS_BATCH_LIMIT, CONFIG.USPS_BATCH_LIMIT);
  var items = rd.records.filter(function (r) { return isUspsWorkDue_(r, now, min); })
    .slice(0, limit)
    .map(function (r) { return { purchaseId: String(r['Purchase ID']), trackingNumber: String(r['Tracking Number']) }; });
  return { ok: true, items: items };
}

/** The extension sends what it SAW on the USPS page; classification happens here (pure, tested). */
function apiSubmitUsps_(body) {
  var rd = readPurchased_();
  var rec = rd.records.filter(function (r) { return String(r['Purchase ID']) === String(body.purchaseId); })[0];
  if (!rec) return { ok: false, error: 'UNKNOWN_PURCHASE_ID' };
  if (!isUspsCheckDue_(rec)) return { ok: true, ignored: 'not-trackable' };
  var res = body.result || {};
  if (res.error === 'USPS_BLOCKED') { log_(rec['Purchase ID'], 'USPS_BLOCKED', 'bot check / access denied'); return { ok: true, ignored: 'systemic' }; }
  if (res.ok && String(res.trackingNumber || rec['Tracking Number']) !== String(rec['Tracking Number'])) {
    return { ok: false, error: 'TRACKING_MISMATCH' };                      // page showed a different package
  }
  var parsed = parseUspsPage_(res, Date.now());
  var ts = nowStr_();
  var patch = applyUspsResult_(rec, parsed, ts);
  updateRecord_(rec['Purchase ID'], patch);
  log_(rec['Purchase ID'], parsed.ok ? 'USPS_CHECKED' : 'USPS_CHECK_FAILED', parsed.ok ? (parsed.stage + ' / ' + parsed.status) : (parsed.error || (parsed.notFound ? 'not found yet' : '')));
  var moved = transferEligible_();                                           // acceptance => inventory row now
  syncInventoryStatus_();
  return { ok: true, stage: patch['USPS Stage'] || rec['USPS Stage'], transferred: moved };
}

// ===========================================================================
// One-time setup
// ===========================================================================
function setup() {
  var report = [];
  var sc = scannerSS_();
  var scannerSheet = sc.getSheetByName(CONFIG.SCANNER.tab);
  if (!scannerSheet) throw new Error('Scanner tab not found: ' + CONFIG.SCANNER.tab);
  var cols = scannerColumns_(scannerSheet);                       // throws with the header list if Purchased? is missing
  report.push('Scanner: "' + CONFIG.SCANNER.purchasedHeader + '" is column ' + cols.purchasedCol1 +
    (cols.cost >= 0 ? '; cost column = ' + (cols.cost + 1) : '; no paid-price column found (Purchase Cost will be blank)'));

  // Purchased + Log tabs
  var ss = purchasedSS_();
  var sh = ss.getSheetByName(CONFIG.PURCHASED.tab) || ss.insertSheet(CONFIG.PURCHASED.tab);
  var hm = headerMap_(sh, 1);
  PURCHASED_HEADERS.forEach(function (h) {
    if (!hm[h]) { sh.getRange(1, Math.max(sh.getLastColumn(), 0) + 1).setValue(h); hm = headerMap_(sh, 1); }
  });
  sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  sh.setFrozenRows(1);
  Object.keys(TEXT_FIELDS).forEach(function (h) { sh.getRange(2, hm[h], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@'); });
  ['Purchased At', 'Last FB Check', 'Last USPS Check', 'Transferred At'].forEach(function (h) {
    sh.getRange(2, hm[h], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('yyyy-mm-dd hh:mm');
  });
  if (!ss.getSheetByName(CONFIG.PURCHASED.logTab)) {
    var lg = ss.insertSheet(CONFIG.PURCHASED.logTab);
    lg.appendRow(['Time', 'Purchase ID', 'Event', 'Detail']); lg.setFrozenRows(1);
  }
  report.push('Purchased tab ready (' + CONFIG.PURCHASED.tab + ').');

  report.push(inventoryReport_());

  // API token
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', Utilities.getUuid() + Utilities.getUuid().replace(/-/g, ''));
  report.push('API token created. Run showApiToken() to copy it into the extension options.');

  // Triggers (idempotent)
  var mine = { onScannerEdit: 1, reconcile: 1, pollUsps: 1 };   // pollUsps listed so old triggers get cleaned up
  ScriptApp.getProjectTriggers().forEach(function (t) { if (mine[t.getHandlerFunction()]) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('onScannerEdit').forSpreadsheet(CONFIG.SCANNER.spreadsheetId).onEdit().create();
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(10).create();
  report.push('Triggers installed: onScannerEdit (on edit), reconcile (10 min).');

  Logger.log(report.join('\n'));
  return report.join('\n');
}

function showApiToken() {
  Logger.log('API_TOKEN = ' + PropertiesService.getScriptProperties().getProperty('API_TOKEN'));
}
