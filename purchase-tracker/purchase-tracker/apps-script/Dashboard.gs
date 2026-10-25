/**
 * Dashboard.gs — "Purchase Dashboard" tab: a READ-ONLY, script-written view of the Purchased tab.
 *
 *   Main (scanner) -> Purchased (source of truth) -> Inventory      (unchanged pipeline)
 *                          \\-> Purchase Dashboard (this file; nothing reads from it)
 *
 * The dashboard never feeds back into the pipeline. It is rebuilt from Purchased on a 10-minute trigger
 * (and by setupPurchaseDashboard()), keyed by Purchase ID, so it cannot hold duplicates and the 7-day
 * overdue rule fires even when Chrome is closed. Enter/correct data in Purchased (or the scanner), not here.
 *
 * Section 1 is pure (no Google services) and unit-tested. Section 2 does the sheet I/O.
 */

// ===========================================================================
// 1. PURE LOGIC
// ===========================================================================
var DASH_STATUS = {
  PURCHASED: 'Purchased', AWAITING: 'Awaiting Shipment', LABEL: 'Label Created', TRANSIT: 'Shipped / In Transit',
  OFD: 'Out for Delivery', DELIVERED: 'Delivered', OVERDUE: 'Overdue', CANCELED: 'Canceled', UNKNOWN: 'Status Unknown'
};

var NO_ACTION = 'No Action Needed';

function dashDaysSince_(rec, nowMs) {
  var t = toMs_(rec['Purchased At']);
  if (isNaN(t)) return '';
  return Math.max(0, Math.floor((nowMs - t) / 86400000));        // FULL days since the ORIGINAL purchase timestamp
}

function toDateOnly_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? '' : v;
  var m = str_(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) : '';
}

/**
 * One backend record -> one dashboard row model (or null: Voided = a mistaken Y; or dated before the cutoff).
 *
 * SOURCE PRECEDENCE (strongest first):
 *   Canceled > Delivered (USPS, or Facebook's own delivered wording; USPS is NOT required) > USPS out-for-delivery
 *   > USPS acceptance (the ONLY proof of carrier possession) > 7-day overdue > tracking number/label (NOT proof of
 *   shipping) > Facebook order seen > purchase recorded. Missing information is shown as Purchased / Status Unknown.
 */
function dashRow_(rec, nowMs, cfg) {
  cfg = cfg || {};
  var overdueDays = cfg.overdueDays || 7;
  var st = rec['Purchase Status'];
  if (st === PURCHASE_STATUS.VOIDED || !isInScope_(rec)) return null;

  var days = dashDaysSince_(rec, nowMs);
  var stage = str_(rec['USPS Stage']);
  var tracking = str_(rec['Tracking Number']);
  var carrier = str_(rec['Carrier']);
  var possession = str_(rec['USPS Accepted At']) !== '' || stageRank_(stage) >= 3;
  var delivered = stage === STAGE.DELIVERED || st === PURCHASE_STATUS.DELIVERED || fbSaysDelivered_(rec);
  var canceled = st === PURCHASE_STATUS.CANCELED;
  var cost = parseMoney_(rec['Purchase Cost']);
  var resale = parseMoney_(rec['Estimated Resale']);
  var overdue = !canceled && !possession && !delivered && days !== '' && days >= overdueDays;

  var status;
  if (canceled) status = DASH_STATUS.CANCELED;
  else if (delivered) status = DASH_STATUS.DELIVERED;
  else if (stage === STAGE.OUT_FOR_DELIVERY) status = DASH_STATUS.OFD;
  else if (possession) status = DASH_STATUS.TRANSIT;
  else if (overdue) status = DASH_STATUS.OVERDUE;
  else if (tracking) status = (carrier && carrier.toUpperCase() !== 'USPS') ? DASH_STATUS.UNKNOWN : DASH_STATUS.LABEL;
  else if (str_(rec['FB Status (raw)'])) status = DASH_STATUS.AWAITING;
  else status = DASH_STATUS.PURCHASED;

  // ---- attention issues (only CURRENT, actionable problems) ----
  var issues = [];
  if (!canceled) {
    if (overdue) {
      var detail = !tracking ? 'no tracking number yet'
        : (stage ? ('USPS: ' + (str_(rec['USPS Status (raw)']) || stage)) : 'USPS status not retrieved yet');
      issues.push({ p: 2, msg: 'OVERDUE — Contact Seller · ' + days + ' days without verified carrier acceptance (' + detail + ')' });
    }
    if (cost === '') {
      var fbTotal = parseMoney_(rec['FB Order Total (raw)']);
      issues.push({ p: 3, msg: 'Enter Purchase Cost' + (fbTotal !== '' ? ' (Facebook order total: $' + fbTotal.toFixed(2) + ')' : '') });
    }
    if (possession && stage === STAGE.EXCEPTION) issues.push({ p: 4, msg: 'Check Tracking — USPS: ' + (str_(rec['USPS Status (raw)']) || 'delivery exception') });
    if (status === DASH_STATUS.UNKNOWN) issues.push({ p: 4, msg: 'Check Tracking — ' + carrier + ' is not auto-tracked' });
    // Facebook checks failing NOW (old test errors have a stale Last FB Check and are ignored)
    var lastFb = toMs_(rec['Last FB Check']);
    if (!delivered && !possession && (parseInt(rec['FB Error Count'], 10) || 0) >= 3 && !isNaN(lastFb) && (nowMs - lastFb) <= 48 * 3600000) {
      issues.push({ p: 4, msg: 'Check Order — Facebook checks keep failing' });
    }
  }
  issues.sort(function (a, b) { return a.p - b.p; });

  var attention;
  if (canceled) attention = 'Canceled — no action needed';
  else if (issues.length) attention = issues[0].msg + (issues.length > 1 ? ' (+' + (issues.length - 1) + ' more)' : '');
  else attention = NO_ACTION;

  var group;
  if (canceled) group = 9;
  else if (status === DASH_STATUS.OVERDUE) group = 1;
  else if (status === DASH_STATUS.DELIVERED) group = issues.length ? 7 : 8;
  else if (issues.length) group = 2;
  else group = status === DASH_STATUS.OFD ? 3 : status === DASH_STATUS.TRANSIT ? 4 : status === DASH_STATUS.LABEL ? 5 : 6;

  var bucket = (status === DASH_STATUS.CANCELED || status === DASH_STATUS.DELIVERED) ? 'none' : 'active';

  var pms = toMs_(rec['Purchased At']);
  return {
    purchaseId: str_(rec['Purchase ID']), backendRow: rec._row || '',
    product: str_(rec['Product']), purchaseDate: isNaN(pms) ? '' : new Date(pms), purchaseMs: isNaN(pms) ? 0 : pms,
    days: days, cost: cost, resale: resale,
    profit: (cost !== '' && resale !== '') ? Math.round((resale - cost) * 100) / 100 : '',
    orderStatus: status, attention: attention, needsAttention: issues.length > 0,
    tracking: tracking, carrier: carrier, eta: toDateOnly_(rec['Estimated Delivery']),
    listingUrl: str_(rec['Facebook URL']),
    inInventory: str_(rec['Transferred to eBay?']).toUpperCase() === 'Y',
    group: group, bucket: bucket
  };
}

function dashSort_(rows) {
  return rows.slice().sort(function (a, b) {
    if (a.group !== b.group) return a.group - b.group;
    return a.group <= 1 ? (a.purchaseMs - b.purchaseMs) : (b.purchaseMs - a.purchaseMs);   // overdue: oldest first
  });
}

/**
 * Summary rules (all from ACTUAL Purchase Cost, never ask price):
 *  - Active = not delivered / canceled.   Awaiting + In Transit + Overdue = Active.
 *  - Capital tied up = sum of cost over Active rows. Rows with NO cost are excluded and counted under Missing Cost (never $0).
 */
function dashSummary_(rows) {
  var s = { attention: 0, active: 0, capital: 0, capitalMissing: 0, awaiting: 0, transit: 0, delivered: 0, overdue: 0, canceled: 0, missingCost: 0 };
  rows.forEach(function (r) {
    var st = r.orderStatus;
    var live = st !== DASH_STATUS.CANCELED;
    if (live && r.needsAttention) s.attention++;
    if (live && r.cost === '') s.missingCost++;
    if (r.bucket === 'active') {
      s.active++;
      if (r.cost === '') s.capitalMissing++; else s.capital += r.cost;
    }
    if (st === DASH_STATUS.PURCHASED || st === DASH_STATUS.AWAITING || st === DASH_STATUS.LABEL || st === DASH_STATUS.UNKNOWN) s.awaiting++;
    else if (st === DASH_STATUS.TRANSIT || st === DASH_STATUS.OFD) s.transit++;
    else if (st === DASH_STATUS.DELIVERED) s.delivered++;
    else if (st === DASH_STATUS.OVERDUE) s.overdue++;
    else if (st === DASH_STATUS.CANCELED) s.canceled++;
  });
  s.capital = Math.round(s.capital * 100) / 100;
  return s;
}

// ---- layout + conditional-format spec (one source for the sheet formulas AND the tests) ----
// Layout: row 1 = summary labels, row 2 = summary values, row 3 = table header, row 4+ = purchases.
var DASH = { LABEL_ROW: 1, VALUE_ROW: 2, HEADER_ROW: 3, FIRST_ROW: 4, FILTER_COLS: 14, TOTAL_COLS: 15 };

var DASH_COLUMNS = [
  { header: 'Product', width: 300 },                  // A
  { header: 'Order Status', width: 135 },             // B
  { header: 'Attention / Action Needed', width: 340 },// C
  { header: 'Purchase Date', width: 100 },            // D
  { header: 'Days Since Purchase', width: 80 },       // E
  { header: 'Purchase Cost', width: 95 },             // F
  { header: 'Estimated Resale', width: 95 },          // G
  { header: 'Est. Profit', width: 90 },               // H
  { header: 'Tracking', width: 175 },                 // I
  { header: 'Estimated Delivery', width: 100 },       // J
  { header: 'Facebook Listing', width: 95 },          // K
  { header: 'Inventory', width: 105 },                // L
  { header: 'Record', width: 70 },                    // M
  { header: 'Purchase ID', width: 120 },              // N
  { header: 'Needs Attention', width: 60 }            // O (helper, hidden)
];

function colLetter_(i) { return String.fromCharCode(64 + i); }            // 1-based, A..O

function condFormula_(cond, row) {
  var parts = cond.all.map(function (c) {
    var ref = '$' + c.col + row;
    switch (c.op) {
      case 'eq': return ref + '="' + c.v + '"';
      case 'ne': return ref + '<>"' + c.v + '"';
      case 'blank': return ref + '=""';
      case 'notblank': return ref + '<>""';
      case 'startsWith': return 'LEFT(' + ref + ',' + c.v.length + ')="' + c.v + '"';
    }
    throw new Error('bad op ' + c.op);
  });
  return parts.length === 1 ? '=' + parts[0] : '=AND(' + parts.join(',') + ')';
}

function condEval_(cond, byCol) {
  return cond.all.every(function (c) {
    var v = byCol[c.col] === undefined || byCol[c.col] === null ? '' : String(byCol[c.col]);
    switch (c.op) {
      case 'eq': return v === c.v;
      case 'ne': return v !== c.v;
      case 'blank': return v === '';
      case 'notblank': return v !== '';
      case 'startsWith': return v.substr(0, c.v.length) === c.v;
    }
    return false;
  });
}

/**
 * Ordered by PRECEDENCE: in Google Sheets the first matching rule wins for a given property, so
 *   missing-cost cell  >  Canceled row  >  Overdue row
 *   >  status-cell colours  >  inventory tick  >  attention highlight.
 * => canceled beats overdue; a delivered row stays green while ONLY its Cost cell turns yellow.
 */
var DASH_RULES = [
  { name: 'missing cost', first: 'F', last: 'F', bg: '#FFF2A8', fg: '#5C4B00', bold: true,
    cond: { all: [{ col: 'A', op: 'notblank' }, { col: 'F', op: 'blank' }, { col: 'B', op: 'ne', v: 'Canceled' }] } },
  { name: 'canceled row', first: 'A', last: 'N', bg: '#F4C7C3', fg: '#7A1F1F', cond: { all: [{ col: 'B', op: 'eq', v: 'Canceled' }] } },
  { name: 'overdue row', first: 'A', last: 'N', bg: '#FCD9C4', fg: '#7A2E00', cond: { all: [{ col: 'B', op: 'eq', v: 'Overdue' }] } },
  { name: 'delivered', first: 'B', last: 'B', bg: '#D4EDDA', fg: '#1E5E2E', cond: { all: [{ col: 'B', op: 'eq', v: 'Delivered' }] } },
  { name: 'out for delivery', first: 'B', last: 'B', bg: '#9EC5F0', fg: '#0B3A72', bold: true, cond: { all: [{ col: 'B', op: 'eq', v: 'Out for Delivery' }] } },
  { name: 'in transit', first: 'B', last: 'B', bg: '#DCEBFA', fg: '#17406E', cond: { all: [{ col: 'B', op: 'eq', v: 'Shipped / In Transit' }] } },
  { name: 'label created', first: 'B', last: 'B', bg: '#FFF8D1', fg: '#5C5200', cond: { all: [{ col: 'B', op: 'eq', v: 'Label Created' }] } },
  { name: 'awaiting shipment', first: 'B', last: 'B', bg: '#E4E4E4', fg: '#444444', cond: { all: [{ col: 'B', op: 'eq', v: 'Awaiting Shipment' }] } },
  { name: 'purchased', first: 'B', last: 'B', bg: '#F1F1F1', fg: '#555555', cond: { all: [{ col: 'B', op: 'eq', v: 'Purchased' }] } },
  { name: 'status unknown', first: 'B', last: 'B', bg: '#EAE4F2', fg: '#4A3B63', cond: { all: [{ col: 'B', op: 'eq', v: 'Status Unknown' }] } },
  { name: 'in inventory', first: 'L', last: 'L', bg: '#D4EDDA', fg: '#1E6B2E', bold: true, cond: { all: [{ col: 'L', op: 'startsWith', v: '✓' }] } },
  { name: 'attention cell', first: 'C', last: 'C', bg: '#FFE9A8', fg: '#5C3B00', bold: true, cond: { all: [{ col: 'O', op: 'eq', v: 'Y' }] } }
];

/** Rule the sheet would apply to one cell column (first match wins per property); used by tests. */
function dashEffectiveBg_(byCol, col) {
  for (var i = 0; i < DASH_RULES.length; i++) {
    var r = DASH_RULES[i];
    if (col >= r.first && col <= r.last && condEval_(r.cond, byCol)) return r.name;
  }
  return '';
}

function hyperlink_(url, text) {
  return '=HYPERLINK("' + String(url).replace(/"/g, '""') + '","' + String(text).replace(/"/g, '""') + '")';
}

function trackingUrl_(carrier, n) {
  var c = String(carrier || '').toUpperCase();
  if (c === 'UPS') return 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n);
  if (c === 'FEDEX') return 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n);
  if (c === 'USPS' || c === '') return 'https://tools.usps.com/tracking/' + encodeURIComponent(n);
  return 'https://www.google.com/search?q=' + encodeURIComponent(n);
}

/** Model -> the 15 cells of one sheet row (links are HYPERLINK formulas). */
function dashToSheetRow_(r, purchasedGid) {
  return [
    r.product, r.orderStatus, r.attention, r.purchaseDate, r.days, r.cost, r.resale, r.profit,
    r.tracking ? hyperlink_(trackingUrl_(r.carrier, r.tracking), r.tracking) : '',
    r.eta,
    /^https?:\/\//.test(r.listingUrl) ? hyperlink_(r.listingUrl, 'Open listing') : '',
    r.inInventory ? '✓ In Inventory' : '—',
    r.backendRow ? hyperlink_('#gid=' + purchasedGid + '&range=A' + r.backendRow, '↗ row ' + r.backendRow) : '',
    r.purchaseId,
    r.needsAttention ? 'Y' : ''
  ];
}

// ===========================================================================
// 2. SHEET I/O
// ===========================================================================
/** Defaults let the dashboard work even with an older Config.gs that has no DASHBOARD block. */
function dashCfg_() { return CONFIG.DASHBOARD || { tab: 'Purchase Dashboard', overdueDays: 7, refreshMinutes: 10 }; }

function dashSheet_(create) {
  var ss = purchasedSS_();
  var sh = ss.getSheetByName(dashCfg_().tab);
  if (!sh && create) sh = ss.insertSheet(dashCfg_().tab, 0);
  return sh;
}

/** Adds any missing backend columns at the END of the Purchased header row. Never renames/moves/deletes. */
function ensureBackendColumns_() {
  var sh = purchasedSheet_();
  var hm = headerMap_(sh, 1), added = [];
  PURCHASED_HEADERS.forEach(function (h) {
    if (!hm[h]) { sh.getRange(1, Math.max(sh.getLastColumn(), 0) + 1).setValue(h); hm = headerMap_(sh, 1); added.push(h); }
  });
  return added;
}

/** True when the tab already has the current layout (summary in rows 1-2, table header in row 3). */
function layoutIsCurrent_(sh) {
  return sh.getRange(DASH.LABEL_ROW, 1).getValue() === 'Needs Attention' && sh.getRange(DASH.HEADER_ROW, 1).getValue() === 'Product';
}

/** Wipes an OLD-layout dashboard (including one you trimmed by hand) so it can be rebuilt cleanly. It is a derived view; nothing else reads it. */
function resetDashboardSheet_(sh) {
  if (sh.getFilter()) sh.getFilter().remove();
  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.clearConditionalFormatRules();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
}

function applyDashboardFormatting_(sh) {
  if (sh.getMaxRows() < 200) sh.insertRowsAfter(sh.getMaxRows(), 200 - sh.getMaxRows());
  if (sh.getMaxColumns() < DASH.TOTAL_COLS) sh.insertColumnsAfter(sh.getMaxColumns(), DASH.TOTAL_COLS - sh.getMaxColumns());
  var maxRows = sh.getMaxRows();
  var bodyRows = maxRows - DASH.FIRST_ROW + 1;

  DASH_COLUMNS.forEach(function (c, i) { sh.setColumnWidth(i + 1, c.width); });
  sh.getRange(DASH.HEADER_ROW, 1, 1, DASH.TOTAL_COLS).setValues([DASH_COLUMNS.map(function (c) { return c.header; })])
    .setFontWeight('bold').setBackground('#1F3A5F').setFontColor('#FFFFFF').setWrap(true).setVerticalAlignment('middle');
  sh.getRange(DASH.LABEL_ROW, 1, 1, 10).setValues([DASH_LABELS]);                       // labels exist from setup on, so the layout check passes
  sh.setFrozenRows(DASH.HEADER_ROW);
  sh.hideColumns(DASH.TOTAL_COLS);

  var body = sh.getRange(DASH.FIRST_ROW, 1, bodyRows, DASH.FILTER_COLS);
  body.setVerticalAlignment('middle').setFontSize(10);
  sh.getRange(DASH.FIRST_ROW, 1, bodyRows, 1).setWrap(true);                        // long product names wrap, column stays narrow
  sh.getRange(DASH.FIRST_ROW, 3, bodyRows, 1).setWrap(true);
  sh.getRange(DASH.FIRST_ROW, 4, bodyRows, 1).setNumberFormat('mmm d, yyyy');
  sh.getRange(DASH.FIRST_ROW, 5, bodyRows, 1).setNumberFormat('0').setHorizontalAlignment('center');
  sh.getRange(DASH.FIRST_ROW, 6, bodyRows, 3).setNumberFormat('$#,##0.00');
  sh.getRange(DASH.FIRST_ROW, 10, bodyRows, 1).setNumberFormat('mmm d, yyyy');
  sh.getRange(DASH.FIRST_ROW, 14, bodyRows, 1).setNumberFormat('@').setFontColor('#888888').setFontSize(8);   // Purchase ID as TEXT

  // summary strip (labels above values), no explanatory text
  sh.getRange(DASH.LABEL_ROW, 1, 1, 10).setFontSize(9).setFontColor('#555555').setWrap(true).setVerticalAlignment('bottom').setHorizontalAlignment('center');
  sh.getRange(DASH.VALUE_ROW, 1, 1, 10).setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#F7F7F7');
  sh.getRange(DASH.VALUE_ROW, 3).setNumberFormat('$#,##0.00');
  sh.getRange(DASH.VALUE_ROW, 10).setFontSize(9).setFontWeight('normal').setFontColor('#777777');

  sh.getBandings().forEach(function (b) { b.remove(); });
  sh.getRange(DASH.FIRST_ROW, 1, bodyRows, DASH.FILTER_COLS).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, false, false);

  var rules = [];
  DASH_RULES.forEach(function (r) {
    var b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(condFormula_(r.cond, DASH.FIRST_ROW))
      .setBackground(r.bg).setFontColor(r.fg);
    if (r.bold) b = b.setBold(true);
    var c1 = r.first.charCodeAt(0) - 64, c2 = r.last.charCodeAt(0) - 64;
    rules.push(b.setRanges([sh.getRange(DASH.FIRST_ROW, c1, bodyRows, c2 - c1 + 1)]).build());
  });
  [['G', '#FCD9C4', '#7A2E00'], ['A', '#FFE9A8', '#5C3B00']].forEach(function (x) {        // Overdue / Needs Attention counters
    var col = x[0].charCodeAt(0) - 64;
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + x[0] + '$' + DASH.VALUE_ROW + '>0')
      .setBackground(x[1]).setFontColor(x[2]).setRanges([sh.getRange(DASH.VALUE_ROW, col)]).build());
  });
  sh.setConditionalFormatRules(rules);

  // one persistent filter (created once so a user's active filter is never reset by a refresh)
  if (!sh.getFilter()) sh.getRange(DASH.HEADER_ROW, 1, maxRows - DASH.HEADER_ROW + 1, DASH.FILTER_COLS).createFilter();
}

var DASH_LABELS = ['Needs Attention', 'Total Active', 'Capital Tied Up (undelivered)', 'Awaiting Shipment', 'In Transit',
  'Delivered', 'Overdue', 'Canceled', 'Missing Cost', 'Last Updated'];

function writeSummary_(sh, s, nowStr) {
  sh.getRange(DASH.LABEL_ROW, 1, 1, 10).setValues([DASH_LABELS]);
  sh.getRange(DASH.VALUE_ROW, 1, 1, 10).setValues([[s.attention, s.active, s.capital, s.awaiting, s.transit, s.delivered, s.overdue, s.canceled, s.missingCost, nowStr]]);
}

/** Rebuilds the dashboard from Purchased. Idempotent; safe to run any number of times. Never writes to Purchased. */
function refreshPurchaseDashboard() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return 'skipped (busy)';
  try {
    var sh = dashSheet_(false);
    if (!sh) return 'dashboard not set up — run setupPurchaseDashboard()';
    // Never write into a layout we do not recognise (e.g. before setup has been re-run after an update).
    if (!layoutIsCurrent_(sh)) return 'layout changed — run setupPurchaseDashboard() once to rebuild it';
    var rd = readPurchased_();
    var nowMs = Date.now();
    var seen = {}, rows = [];
    rd.records.forEach(function (rec) {
      var id = str_(rec['Purchase ID']);
      if (seen[id]) return;                                          // keyed by Purchase ID: duplicates impossible
      seen[id] = true;
      var r = dashRow_(rec, nowMs, dashCfg_());
      if (r) rows.push(r);
    });
    rows = dashSort_(rows);
    var gid = rd.sh.getSheetId();
    var values = rows.map(function (r) { return dashToSheetRow_(r, gid); });

    var needLast = DASH.FIRST_ROW + Math.max(values.length, 1) - 1;
    if (needLast > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), needLast - sh.getMaxRows());
    var last = sh.getLastRow();
    if (last >= DASH.FIRST_ROW) sh.getRange(DASH.FIRST_ROW, 1, last - DASH.FIRST_ROW + 1, DASH.TOTAL_COLS).clearContent();
    if (values.length) sh.getRange(DASH.FIRST_ROW, 1, values.length, DASH.TOTAL_COLS).setValues(values);
    writeSummary_(sh, dashSummary_(rows), nowStr_());
    return rows.length + ' purchase(s)';
  } catch (e) {
    log_('', 'DASHBOARD_ERROR', e && e.message);
    return 'error: ' + (e && e.message);
  } finally { lock.releaseLock(); }
}

/** One-time (and safely repeatable) setup. Does not touch existing triggers, columns, IDs or data in Purchased. */
function setupPurchaseDashboard() {
  var report = [];
  var added = ensureBackendColumns_();
  report.push(added.length ? 'Purchased: added new columns at the far right: ' + added.join(', ') : 'Purchased: backend columns already present.');
  var existed = !!dashSheet_(false);
  var sh = dashSheet_(true);
  var rebuilt = false;
  if (!layoutIsCurrent_(sh)) { resetDashboardSheet_(sh); rebuilt = true; }
  applyDashboardFormatting_(sh);
  report.push(!existed ? 'Dashboard tab created as the first tab.'
    : rebuilt ? 'Dashboard rebuilt on the new layout (summary rows 1-2, table header row 3).' : 'Dashboard formatting re-applied; layout was already current.');

  var handler = 'refreshPurchaseDashboard';
  var mine = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === handler; });
  mine.slice(1).forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (!mine.length) ScriptApp.newTrigger(handler).timeBased().everyMinutes(dashCfg_().refreshMinutes).create();
  report.push('Trigger: ' + handler + ' every ' + dashCfg_().refreshMinutes + ' min (' + (mine.length ? 'already existed' : 'created') + ').');

  report.push('Populated: ' + refreshPurchaseDashboard());
  Logger.log(report.join('\n'));
  return report.join('\n');
}

// ===========================================================================
// 3. SAFE TEST DATA  (Purchase IDs "TEST-n": ignored by the extension work lists and by inventory transfer)
// ===========================================================================
function dashTestRecords_(nowMs) {
  var DAY = 86400000;
  function ago(d) { return new Date(nowMs - d * DAY); }
  function base(n, name, days, extra) {
    var o = { 'Purchase ID': 'TEST-' + n, 'Listing ID': 'TEST-L' + n, 'Purchased At': ago(days), 'Product': 'TEST — ' + name,
              'Facebook URL': 'https://www.facebook.com/marketplace/item/1/', 'Ask Price (FB)': 900, 'Purchase Cost': 500, 'Estimated Resale': 700,
              'Purchase Status': PURCHASE_STATUS.PURCHASED, 'FB Error Count': 0, 'Notes': 'TEST RECORD — safe to delete with removeDashboardTestRecords()' };
    for (var k in extra) o[k] = extra[k];
    return o;
  }
  var TN = '940010000000000000000';
  return [
    base(1, '1 Normal purchase (just bought)', 1, {}),
    base(2, '2 Awaiting shipment', 2, { 'FB Status (raw)': 'Order Confirmed' }),
    base(3, '3 Label created (not overdue)', 3, { 'Purchase Status': PURCHASE_STATUS.TRACKING, 'FB Status (raw)': 'Order Confirmed | Shipped', 'Carrier': 'USPS', 'Tracking Number': TN + '1', 'USPS Stage': STAGE.AWAITING_ITEM, 'USPS Status (raw)': 'Shipping Label Created, USPS Awaiting Item' }),
    base(4, '4 OVERDUE: label created 9 days ago', 9, { 'Purchase Status': PURCHASE_STATUS.TRACKING, 'FB Status (raw)': 'Order Confirmed | Shipped', 'Carrier': 'USPS', 'Tracking Number': TN + '2', 'USPS Stage': STAGE.AWAITING_ITEM, 'USPS Status (raw)': 'Shipping Label Created, USPS Awaiting Item' }),
    base(5, '5 OVERDUE: no tracking after 8 days', 8, { 'FB Status (raw)': 'Order Confirmed' }),
    base(6, '6 Accepted / in transit (in inventory)', 10, { 'Purchase Status': PURCHASE_STATUS.SHIPPED, 'Carrier': 'USPS', 'Tracking Number': TN + '3', 'USPS Stage': STAGE.IN_TRANSIT, 'USPS Status (raw)': 'Departed USPS Regional Facility', 'USPS Accepted At': ago(5), 'Estimated Delivery': new Date(nowMs + 3 * DAY), 'Transferred to eBay?': 'Y' }),
    base(7, '7 Out for delivery', 6, { 'Purchase Status': PURCHASE_STATUS.SHIPPED, 'Carrier': 'USPS', 'Tracking Number': TN + '4', 'USPS Stage': STAGE.OUT_FOR_DELIVERY, 'USPS Status (raw)': 'Out for Delivery', 'USPS Accepted At': ago(4), 'Transferred to eBay?': 'Y' }),
    base(8, '8 Delivered, cost missing', 12, { 'Purchase Cost': '', 'Purchase Status': PURCHASE_STATUS.DELIVERED, 'Carrier': 'USPS', 'Tracking Number': TN + '5', 'USPS Stage': STAGE.DELIVERED, 'USPS Status (raw)': 'Delivered, Front Door/Porch', 'USPS Accepted At': ago(9), 'Delivered At': ago(2), 'Transferred to eBay?': 'Y' }),
    base(9, '9 Delivered per Facebook only (no USPS check)', 6, { 'Purchase Status': PURCHASE_STATUS.TRACKING, 'FB Status (raw)': 'Delivered | Your order was delivered. | Order Confirmed', 'Carrier': 'USPS', 'Tracking Number': TN + '6' }),
    base(10, '10 Canceled', 5, { 'Purchase Status': PURCHASE_STATUS.CANCELED, 'FB Status (raw)': 'Order canceled' })
  ];
}

/** Adds 10 clearly-labelled sample purchases covering every dashboard state, then refreshes. Safe to re-run. */
function createDashboardTestRecords() {
  removeDashboardTestRecords();
  ensureBackendColumns_();
  var recs = dashTestRecords_(Date.now());
  withLock_(function () { recs.forEach(function (r) { appendRecord_(r); }); }, 30000);
  return recs.length + ' test records added. ' + refreshPurchaseDashboard();
}

/** Deletes ONLY rows whose Purchase ID starts with "TEST-". */
function removeDashboardTestRecords() {
  return withLock_(function () {
    var sh = purchasedSheet_();
    var hm = headerMap_(sh, 1);
    var last = sh.getLastRow(), removed = 0;
    if (last < 2) return 'no rows';
    var ids = sh.getRange(2, hm['Purchase ID'], last - 1, 1).getValues();
    for (var i = ids.length - 1; i >= 0; i--) {
      if (/^TEST-/.test(String(ids[i][0]))) { sh.deleteRows(i + 2, 1); removed++; }
    }
    return removed + ' test record(s) removed';
  }, 30000);
}
