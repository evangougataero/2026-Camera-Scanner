/**
 * Inventory.gs — eBay Inventory, one row per PRIMARY PRODUCT of a Facebook listing.
 *
 *   Purchased record (1 per listing)  ->  N inventory rows, one per product row in the Main scanner sheet
 *
 * Each row is tied to its purchase by two stable keys the script writes once and never changes:
 *   Purchase ID (the listing's purchase)   and   Item Key = "<Purchase ID>#<n>"
 * so a repeated sync can never create duplicates, and sorting/filtering/editing never breaks the link.
 *
 * AUTOMATIC (written when the row is created): Product, Listing Item, Facebook Listing, Estimated Resale, Item Cost,
 *   Purchase ID, Item Key, Group Shade, Status.
 * AFTER creation the script only ever touches: Item Cost (when the listing's Purchase Cost changes) and Status
 *   (only while it is blank or one of managedStatuses).
 * MANUAL, never written after the row exists: Listed on eBay?, Total Sale Price, eBay Fees, Shipping Label Cost, Sale Date.
 */
var INV = {
  ITEM: 'Listing Item', LISTING: 'Facebook Listing', RESALE: 'Estimated Resale', COST: 'Item Cost',
  LISTED: 'Listed on eBay?', SALE_PRICE: 'Total Sale Price', FEES: 'eBay Fees', SHIP: 'Shipping Label Cost', SALE_DATE: 'Sale Date',
  KEY: 'Item Key', SHADE: 'Group Shade'
};
var INV_TINT = '#E8F0FE';

// ---------------------------------------------------------------------------
// Opening / locating rows
// ---------------------------------------------------------------------------
function openInventory_() {
  var I = CONFIG.INVENTORY;
  var ss = openById_(I.spreadsheetId, 'CONFIG.INVENTORY.spreadsheetId');
  var sh = ss.getSheetByName(I.tab);
  if (!sh) throw new Error('Inventory tab not found: ' + I.tab);
  var hm = headerMap_(sh, I.headerRow);
  if (!hm[I.linkHeader]) {
    if (!I.autoAddLinkColumn) throw new Error('Inventory link column "' + I.linkHeader + '" missing.');
    var col = Math.max(sh.getLastColumn(), 0) + 1;
    sh.getRange(I.headerRow, col).setValue(I.linkHeader);
    hm = headerMap_(sh, I.headerRow);
    log_('', 'INVENTORY_LINK_COLUMN_ADDED', 'column ' + col);
  }
  if (!hm[I.anchorHeader]) throw new Error('Inventory anchor column "' + I.anchorHeader + '" missing. Headers: ' + Object.keys(hm).join(', '));
  return { ss: ss, sh: sh, hm: hm, cfg: I };
}

/** Transfers are blocked (loudly, in the log) until setupInventoryV2() has put the sheet on the new layout. */
function openInventoryV2_() {
  var inv = openInventory_();
  var missing = [INV.KEY, INV.COST].filter(function (h) { return !inv.hm[h]; });
  if (missing.length) throw new Error('Inventory is not on the new layout (missing: ' + missing.join(', ') + '). Run setupInventoryV2() once.');
  return inv;
}

function inventoryRowsFor_(inv, purchaseId) {
  var first = inv.cfg.headerRow + 1, last = inv.sh.getLastRow();
  if (last < first) return [];
  var n = last - first + 1;
  var links = inv.sh.getRange(first, inv.hm[inv.cfg.linkHeader], n, 1).getValues();
  var keys = inv.hm[INV.KEY] ? inv.sh.getRange(first, inv.hm[INV.KEY], n, 1).getValues() : [];
  var out = [];
  for (var i = 0; i < n; i++) {
    if (String(links[i][0]).trim() === String(purchaseId)) out.push({ row: first + i, key: keys[i] ? String(keys[i][0]).trim() : '' });
  }
  return out;
}

/** First row after the last row that has a Product OR an Item Key (so a half-written row is never overwritten). */
function nextInventoryRow_(inv) {
  var first = inv.cfg.headerRow + 1, last = inv.sh.getLastRow();
  if (last < first) return first;
  var n = last - first + 1, lastFilled = first - 1;
  var prod = inv.sh.getRange(first, inv.hm[inv.cfg.anchorHeader], n, 1).getValues();
  var keys = inv.hm[INV.KEY] ? inv.sh.getRange(first, inv.hm[INV.KEY], n, 1).getValues() : [];
  for (var i = 0; i < n; i++) {
    if (String(prod[i][0]).trim() !== '' || (keys[i] && String(keys[i][0]).trim() !== '')) lastFilled = first + i;
  }
  return lastFilled + 1;
}

function nextShade_(inv) {
  var row = nextInventoryRow_(inv) - 1;
  if (row < inv.cfg.headerRow + 1 || !inv.hm[INV.SHADE]) return 0;
  var v = inv.sh.getRange(row, inv.hm[INV.SHADE]).getValue();
  return (v === 0 || v === 1) ? 1 - v : 0;                       // alternate listing by listing
}

/** Writes a cell ONLY if it is currently empty: never overwrites anything already there. */
function invSet_(inv, row, header, value, text) {
  var col = inv.hm[header];
  if (!col || value === '' || value === null || value === undefined) return;
  var cell = inv.sh.getRange(row, col);
  if (String(cell.getValue()) !== '') return;
  if (text) cell.setNumberFormat('@');
  cell.setValue(text ? String(value) : value);
}

function pickScannerListing_(listings, rec) {
  var id = str_(rec['Listing ID']);
  var matches = (listings || []).filter(function (l) { return l.listingId === id; });
  return matches.filter(function (l) { return l.purchased; })[0] || matches[0] || null;
}

function fillInventoryRow_(inv, row, rec, item, idx, n, cost, shade) {
  var pid = String(rec['Purchase ID']);
  invSet_(inv, row, inv.cfg.linkHeader, pid, true);                // link + key FIRST: a crash mid-row heals on the next run
  invSet_(inv, row, INV.KEY, itemKey_(pid, idx), true);
  invSet_(inv, row, inv.cfg.anchorHeader, item.name);
  invSet_(inv, row, INV.ITEM, idx + ' of ' + n);
  var url = str_(rec['Facebook URL']);
  if (/^https?:\/\//.test(url)) invSet_(inv, row, INV.LISTING, hyperlink_(url, 'Open listing'));
  invSet_(inv, row, INV.RESALE, item.resale);
  invSet_(inv, row, INV.COST, cost);
  invSet_(inv, row, INV.SHADE, shade);
  if (inv.cfg.statusHeader) invSet_(inv, row, inv.cfg.statusHeader, inventoryStatusFor_(rec, inv.cfg));
  var cb = inv.hm[INV.LISTED];
  if (cb && String(inv.sh.getRange(row, cb).getValue()) === '') inv.sh.getRange(row, cb).insertCheckboxes();   // unchecked; yours to tick
  inv.sh.getRange(row, 1, 1, inv.sh.getLastColumn())
    .setBorder(null, null, true, null, null, null, '#C9D1D9', SpreadsheetApp.BorderStyle.SOLID);
}

// ---------------------------------------------------------------------------
// Transfer: Purchased -> Inventory (idempotent)
// ---------------------------------------------------------------------------
function transferEligible_() {
  var rd = readPurchased_();
  var eligible = rd.records.filter(isTransferEligible_);
  if (!eligible.length) return 0;
  var inv;
  try { inv = openInventoryV2_(); }
  catch (e) { log_('', 'TRANSFER_BLOCKED', e.message); return 0; }
  var scanListings = [];
  try { scanListings = readScannerListings_().listings; } catch (e) { log_('', 'TRANSFER_SCANNER_UNREADABLE', e.message); }

  var count = 0;
  eligible.forEach(function (rec) {
    var pid = String(rec['Purchase ID']);
    var ts = nowStr_();
    var existing = inventoryRowsFor_(inv, pid);                    // idempotency check FIRST
    var legacy = existing.some(function (e) { return e.key === ''; });   // a pre-v2 row (one row per listing): leave as is
    var firstRow = 0;

    if (legacy) {
      firstRow = existing[0].row;
      log_(pid, 'TRANSFER_HEALED', 'legacy inventory row ' + firstRow + ' kept as is');
    } else {
      var listing = pickScannerListing_(scanListings, rec);
      var items = buildInventoryItems_(listing, rec);
      if (!listing) log_(pid, 'TRANSFER_NOTE', 'scanner listing not found; created a single row from the purchase record');
      var costs = allocateCost_(rec['Purchase Cost'], items.length);
      var byKey = {};
      existing.forEach(function (e) { byKey[e.key] = e.row; });
      var shade = existing.length ? (inv.sh.getRange(existing[0].row, inv.hm[INV.SHADE] || 1).getValue()) : nextShade_(inv);
      if (shade !== 0 && shade !== 1) shade = 0;

      items.forEach(function (item, i) {
        var key = itemKey_(pid, i + 1);
        var row = byKey[key];
        if (!row) {
          row = nextInventoryRow_(inv);
          if (row > inv.sh.getMaxRows()) inv.sh.insertRowsAfter(inv.sh.getMaxRows(), row - inv.sh.getMaxRows());
          (inv.cfg.copyFormulaFromAbove || []).forEach(function (h) {
            var c = inv.hm[h];
            if (c && row > inv.cfg.headerRow + 1 && inv.sh.getRange(row - 1, c).getFormula()) {
              inv.sh.getRange(row - 1, c).copyTo(inv.sh.getRange(row, c), SpreadsheetApp.CopyPasteType.PASTE_FORMULA, false);
            }
          });
          invSet_(inv, row, inv.cfg.linkHeader, pid, true);        // claim the row before anything else
          invSet_(inv, row, INV.KEY, key, true);
        }
        fillInventoryRow_(inv, row, rec, item, i + 1, items.length, costs[i], shade);
        if (i === 0) firstRow = row;
      });
      var back = String(inv.sh.getRange(firstRow, inv.hm[inv.cfg.linkHeader]).getValue()).trim();
      if (back !== pid) { log_(pid, 'TRANSFER_VERIFY_FAILED', 'row ' + firstRow); return; }
      log_(pid, 'TRANSFERRED', items.length + ' product row(s) from row ' + firstRow);
    }

    var note = parseMoney_(rec['Purchase Cost']) === '' && !legacy
      ? appendNote_(rec['Notes'], ts, 'Transferred with NO Item Cost: it will fill in automatically once Purchase Cost is entered') : rec['Notes'];
    updateRecord_(pid, { 'Transferred to eBay?': 'Y', 'Inventory Row': firstRow, 'Transferred At': ts, 'Notes': note, 'Inventory Sync Sig': inventorySig_(rec) });
    count++;
  });
  return count;
}

/** After transfer: keeps Status and Item Cost current. Never touches the manual sales columns. */
function syncInventoryStatus_() {
  var rd = readPurchased_();
  var todo = rd.records.filter(function (r) {
    return !isTestRecord_(r) && isInScope_(r) && str_(r['Transferred to eBay?']).toUpperCase() === 'Y' &&
           !isTerminalStatus_(r['Purchase Status']) && str_(r['Inventory Sync Sig']) !== inventorySig_(r);
  });
  if (!todo.length) return 0;
  var inv;
  try { inv = openInventoryV2_(); } catch (e) { log_('', 'INV_SYNC_BLOCKED', e.message); return 0; }
  var n = 0;
  todo.forEach(function (rec) {
    var pid = String(rec['Purchase ID']);
    var rows = inventoryRowsFor_(inv, pid);
    if (!rows.length) { log_(pid, 'INV_ROW_NOT_FOUND', 'link column has no ' + pid); return; }
    var prev = inventorySigParts_(rec['Inventory Sync Sig']), now = inventorySigParts_(inventorySig_(rec));

    // Item Cost: re-allocate only when the listing's Purchase Cost itself changed (not on every shipping update)
    if (prev && prev.cost !== now.cost && inv.hm[INV.COST]) {
      var keyed = rows.filter(function (r) { return r.key !== ''; });
      var total = keyed.length;
      keyed.forEach(function (r) {                                  // "i of N" keeps N stable even if you delete a row
        var m = String(inv.sh.getRange(r.row, inv.hm[INV.ITEM] || 1).getValue()).match(/of\s+(\d+)/);
        if (m) total = Math.max(total, parseInt(m[1], 10));
      });
      var costs = allocateCost_(rec['Purchase Cost'], total);
      keyed.forEach(function (r) {
        var k = parseInt(r.key.split('#')[1], 10);
        var v = costs[k - 1];
        if (v === '' || v === undefined) return;                    // never blank a cell
        var cell = inv.sh.getRange(r.row, inv.hm[INV.COST]);
        if (cell.getValue() !== v) cell.setValue(v);
      });
    }

    // Status: only while it is blank or one of our own values (Listed / Sold are yours)
    if (inv.cfg.statusHeader && inv.hm[inv.cfg.statusHeader]) {
      rows.forEach(function (r) {
        var cell = inv.sh.getRange(r.row, inv.hm[inv.cfg.statusHeader]);
        var cur = String(cell.getValue()).trim();
        if (cur === '' || inv.cfg.managedStatuses.indexOf(cur) !== -1) cell.setValue(inventoryStatusFor_(rec, inv.cfg));
        else log_(pid, 'INV_SYNC_SKIPPED', 'row ' + r.row + ' status "' + cur + '" is user-managed');
      });
    }
    updateRecord_(pid, { 'Inventory Sync Sig': inventorySig_(rec) });
    log_(pid, 'INV_SYNCED', rec['USPS Stage']);
    n++;
  });
  return n;
}

// ---------------------------------------------------------------------------
// One-time migration / layout setup
// ---------------------------------------------------------------------------
function legacyInventoryHeaders_() {
  var cols = CONFIG.INVENTORY.columns || [];
  function hdr(field) { var c = cols.filter(function (x) { return x.field === field; })[0]; return c ? c.header : ''; }
  function uniq(a) { return a.filter(function (v, i) { return v && a.indexOf(v) === i; }); }
  return {
    cost: uniq([hdr('__cost'), 'Cost']),
    url: uniq([hdr('Facebook URL'), 'Facebook URL']),
    remove: uniq([hdr('Tracking Number'), hdr('USPS Status (raw)'), hdr('Estimated Delivery'), 'Tracking Number', 'USPS Status', 'Estimated Delivery'])
  };
}

function inventoryReport_() {
  try {
    var inv = openInventory_();
    var missing = [INV.KEY, INV.COST].filter(function (h) { return !inv.hm[h]; });
    return missing.length ? 'Inventory: still on the OLD layout (missing ' + missing.join(', ') + ') — run setupInventoryV2() before the next transfer.'
                          : 'Inventory: new per-product layout is in place.';
  } catch (e) { return 'Inventory NOT ready: ' + e.message; }
}

/**
 * Puts the Inventory tab on the new layout. SAFE and repeatable:
 *  - makes a full copy of the tab first (only when it is about to rename/delete something);
 *  - renames the old Cost column to "Item Cost" and "Facebook URL" to "Facebook Listing" (data and formulas stay);
 *  - deletes ONLY the columns Tracking Number, USPS Status and Estimated Delivery;
 *  - appends the new columns at the far right; never moves, clears or rewrites any existing row or sales data;
 *  - existing rows (one per listing) are kept exactly as they are; they simply have no Item Key.
 */
function setupInventoryV2() {
  return withLock_(function () {
    var I = CONFIG.INVENTORY, report = [];
    var ss = openById_(I.spreadsheetId, 'CONFIG.INVENTORY.spreadsheetId');
    var sh = ss.getSheetByName(I.tab);
    if (!sh) throw new Error('Inventory tab not found: ' + I.tab);
    var hm = headerMap_(sh, I.headerRow);
    if (!hm[I.anchorHeader]) throw new Error('Inventory needs a "' + I.anchorHeader + '" column. Headers found: ' + Object.keys(hm).join(', '));
    var legacy = legacyInventoryHeaders_();

    var costOld = !hm[INV.COST] ? legacy.cost.filter(function (h) { return hm[h]; })[0] : '';
    var urlOld = !hm[INV.LISTING] ? legacy.url.filter(function (h) { return hm[h]; })[0] : '';
    var toRemove = legacy.remove.filter(function (h) { return hm[h]; });

    if (costOld || urlOld || toRemove.length) {                        // backup BEFORE any structural change
      var backup = sh.copyTo(ss);
      backup.setName('Inventory backup ' + nowStr_(ss).replace(/[: ]/g, '-'));
      report.push('Backup of the tab saved as "' + 'Inventory backup ' + nowStr_(ss).replace(/[: ]/g, '-') + '".');
    }
    if (costOld) { sh.getRange(I.headerRow, hm[costOld]).setValue(INV.COST); report.push('Renamed "' + costOld + '" -> "' + INV.COST + '" (existing values kept).'); hm = headerMap_(sh, I.headerRow); }
    if (urlOld) { sh.getRange(I.headerRow, hm[urlOld]).setValue(INV.LISTING); report.push('Renamed "' + urlOld + '" -> "' + INV.LISTING + '".'); hm = headerMap_(sh, I.headerRow); }
    toRemove.map(function (h) { return hm[h]; }).sort(function (a, b) { return b - a; }).forEach(function (c) { sh.deleteColumn(c); });
    if (toRemove.length) { report.push('Deleted columns: ' + toRemove.join(', ') + '.'); hm = headerMap_(sh, I.headerRow); }

    var wanted = [INV.ITEM, INV.LISTING, INV.RESALE, INV.COST, INV.LISTED, INV.SALE_PRICE, INV.FEES, INV.SHIP, INV.SALE_DATE, I.linkHeader, INV.KEY, INV.SHADE];
    var created = {};
    wanted.forEach(function (h) {
      if (!hm[h]) {
        sh.getRange(I.headerRow, Math.max(sh.getLastColumn(), 0) + 1).setValue(h).setFontWeight('bold');
        hm = headerMap_(sh, I.headerRow); created[h] = true;
      }
    });
    var made = Object.keys(created);
    report.push(made.length ? 'Added columns at the far right: ' + made.join(', ') + '.' : 'All new-layout columns already present.');

    var first = I.headerRow + 1, rows = Math.max(sh.getMaxRows() - I.headerRow, 1);
    [INV.RESALE, INV.COST, INV.SALE_PRICE, INV.FEES, INV.SHIP].forEach(function (h) { if (created[h]) sh.getRange(first, hm[h], rows, 1).setNumberFormat('$#,##0.00'); });
    if (created[INV.SALE_DATE]) sh.getRange(first, hm[INV.SALE_DATE], rows, 1).setNumberFormat('mmm d, yyyy');
    [I.linkHeader, INV.KEY].forEach(function (h) { if (created[h]) sh.getRange(first, hm[h], rows, 1).setNumberFormat('@'); });
    [I.linkHeader, INV.KEY].forEach(function (h) { sh.getRange(first, hm[h], rows, 1).setFontColor('#888888').setFontSize(8); });
    sh.hideColumns(hm[INV.SHADE]);

    // existing rows: alternate their group shade, and give the new checkbox column to rows that already hold a product
    var last = sh.getLastRow();
    if (last >= first) {
      var n = last - first + 1;
      var prod = sh.getRange(first, hm[I.anchorHeader], n, 1).getValues();
      var link = sh.getRange(first, hm[I.linkHeader], n, 1).getValues();
      var key = sh.getRange(first, hm[INV.KEY], n, 1).getValues();
      var shade = sh.getRange(first, hm[INV.SHADE], n, 1).getValues();
      var prev = 1;
      for (var i = 0; i < n; i++) {
        var has = String(prod[i][0]).trim() !== '';
        if (String(link[i][0]).trim() !== '' && String(key[i][0]).trim() === '' && String(shade[i][0]) === '') {
          prev = 1 - prev; sh.getRange(first + i, hm[INV.SHADE]).setValue(prev);
        } else if (shade[i][0] === 0 || shade[i][0] === 1) prev = shade[i][0];
        if (has && created[INV.LISTED]) sh.getRange(first + i, hm[INV.LISTED]).insertCheckboxes();
      }
    }

    // group tint (rule is replaced, never duplicated)
    var formula = '=$' + colToLetter_(hm[INV.SHADE]) + first + '=1';
    var keep = sh.getConditionalFormatRules().filter(function (r) {
      var bc = r.getBooleanCondition ? r.getBooleanCondition() : null;          // null for gradient rules
      var f = bc ? bc.getCriteriaValues()[0] : r.formula;
      return f !== formula;
    });
    keep.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setBackground(INV_TINT)
      .setRanges([sh.getRange(first, 1, rows, sh.getLastColumn())]).build());
    sh.setConditionalFormatRules(keep);
    report.push('Group shading: alternate Facebook listings are tinted; each product row is labelled "Listing Item: n of N".');

    Logger.log(report.join('\n'));
    return report.join('\n');
  }, 60000);
}
