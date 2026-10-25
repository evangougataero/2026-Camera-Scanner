'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');

const SCANNER_ID = 'scanner-ss', INV_ID = 'inventory-ss';
const ID1 = '1111111111111111', ID2 = '2222222222222222', ID3 = '3333333333333333';
const P1 = `${ID1}-1`, P2 = `${ID2}-1`, P3 = `${ID3}-1`;
const TN = (n) => '94001118992230330052' + (10 + n);
const SCAN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy',
  'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'O', 'P', 'Relisted', 'Purchase Price'];
const K = 11, COST = 18, DAY = 86400000;
const LEGACY_HEADERS = ['Product', 'Facebook URL', 'Cost', 'Estimated Resale', 'Tracking Number', 'USPS Status', 'Estimated Delivery', 'Status', 'eBay Sold Price', 'Profit'];

/** opts.migrate=false leaves the inventory on the old layout (to test the guard and the migration itself). */
function world(opts) {
  opts = Object.assign({ migrate: true }, opts);
  const w = buildContext();
  const scan = w.addSpreadsheet(SCANNER_ID);
  const main = scan.insertSheet('Main');
  SCAN_HEADERS.forEach((h, i) => main.put(1, i + 1, h));
  const put = (r, o) => Object.keys(o).forEach((c) => main.put(r, +c, o[c]));
  const url = (id) => `https://www.facebook.com/marketplace/item/${id}/`;
  put(2, { 1: 'Monitors (x2)', 2: url(ID1), 4: 300, 5: 250 });      // listing 1: THREE primary products
  put(3, { 1: 'Keyboard', 5: 40 });
  put(4, { 1: 'Mice (x3)', 5: 30 });
  put(5, { 1: 'Canon R6 Body', 2: url(ID2), 4: 1800, 5: 2200 });   // listing 2: one product
  put(6, { 1: 'Lens A', 2: url(ID3), 4: 700, 5: 500 });           // listing 3: two products
  put(7, { 1: 'Lens B', 5: 400 });
  const inv = w.addSpreadsheet(INV_ID);
  const sh = inv.insertSheet('Inventory');
  LEGACY_HEADERS.forEach((h, i) => sh.put(1, i + 1, h));
  sh.put(2, 1, 'Old Lens'); sh.put(2, 2, 'https://old.example/1'); sh.put(2, 3, 100); sh.put(2, 4, 180); sh.put(2, 5, 'OLDTRACK1'); sh.put(2, 6, 'Delivered');
  sh.put(2, 7, '2026-09-01'); sh.put(2, 8, 'Sold'); sh.put(2, 9, 250); sh.put(2, 10, 150);
  sh.put(3, 1, 'Old Body'); sh.put(3, 3, 900); sh.put(3, 8, 'In Transit'); sh.put(3, 11, 'OLD-1');       // legacy rows (col 11 = Purchase ID)
  sh.put(1, 11, 'Purchase ID');
  w.ctx.CONFIG.SCANNER.spreadsheetId = SCANNER_ID;
  w.ctx.CONFIG.INVENTORY.spreadsheetId = INV_ID;
  w.ctx.CONFIG.INVENTORY.tab = 'Inventory';
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '';
  w.run('setup()');
  if (opts.migrate) w.run('setupInventoryV2()');
  Object.assign(w, {
    ss: scan, invSS: inv, main, inv: sh, pur: scan.getSheetByName('Purchased'), logSheet: scan.getSheetByName('Purchase Log'),
    setY: (row, v, old) => { main.put(row, K, v); w.ctx.__e = { range: main.getRange(row, K), value: v, oldValue: old === undefined ? '' : old }; w.run('onScannerEdit(__e)'); },
    post: (body) => JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify(Object.assign({ token: w.props.API_TOKEN }, body)) } }).text),
    invCol: (h) => w.run('headerMap_')(sh, 1)[h],
    invRows: () => { const out = []; for (let r = 2; r <= sh.getLastRow(); r++) out.push(Object.assign({ _row: r }, sh.rowObj(r))); return out; },
    mine: () => w.invRows().filter((r) => String(r['Item Key'] || '') !== ''),
    records: () => { const out = []; for (let r = 2; r <= w.pur.getLastRow(); r++) out.push(w.pur.rowObj(r)); return out; },
    logEvents: () => { const o = []; for (let r = 2; r <= w.logSheet.getLastRow(); r++) o.push(w.logSheet.rowObj(r)['Event'] + ' ' + w.logSheet.rowObj(r)['Detail']); return o; },
    accept: (pid, status) => w.post({ action: 'submitUspsResult', purchaseId: pid, result: { ok: true, status: status || 'USPS in possession of item', history: [status || 'USPS in possession of item'] } })
  });
  // buy a listing (scanner row), record tracking, USPS accepts => transfers
  w.ship = (row, id, cost, accept) => {
    if (cost !== undefined) main.put(row, COST, cost);
    w.setY(row, 'Y');
    w.post({ action: 'submitFbResult', purchaseId: `${id}-1`, result: { ok: true, fbStatusRaw: 'Order Confirmed | Shipped', trackingNumber: TN(row), carrier: 'USPS' } });
    if (accept !== false) w.accept(`${id}-1`);
  };
  return w;
}

// ---------------------------------------------------------------- one row per primary product
test('a listing with 3 primary products becomes 3 inventory rows with their OWN names and Main-sheet resale values', () => {
  const w = world();
  w.ship(2, ID1, 120);
  const rows = w.mine();
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows.map((r) => r['Product'])), JSON.stringify(['Monitors (x2)', 'Keyboard', 'Mice (x3)']));
  assert.equal(JSON.stringify(rows.map((r) => r['Estimated Resale'])), JSON.stringify([250, 40, 30]));      // manual Main values, not the $300 ask
  assert.equal(JSON.stringify(rows.map((r) => r['Listing Item'])), JSON.stringify(['1 of 3', '2 of 3', '3 of 3']));
  assert.ok(rows.every((r) => r['Purchase ID'] === P1));
  assert.equal(JSON.stringify(rows.map((r) => r['Item Key'])), JSON.stringify([P1 + '#1', P1 + '#2', P1 + '#3']));
  assert.ok(rows.every((r) => /^=HYPERLINK\("https:\/\/www\.facebook\.com\/marketplace\/item\/1111111111111111\/","Open listing"\)$/.test(r['Facebook Listing'])));
  assert.ok(rows.every((r) => r['Status'] === 'In Transit'));
  assert.ok(!rows.some((r) => [300, 1800].includes(r['Estimated Resale'])));
  assert.equal(w.records()[0]['Transferred to eBay?'], 'Y');
});

test('Item Cost = listing cost ÷ number of primary product rows ($120 / 3 = $40 each); the parts always sum to the listing cost', () => {
  const w = world();
  w.ship(2, ID1, 120);
  assert.equal(JSON.stringify(w.mine().map((r) => r['Item Cost'])), JSON.stringify([40, 40, 40]));
  w.ship(6, ID3, 100);                                                                     // 2 products
  assert.equal(JSON.stringify(w.mine().filter((r) => r['Purchase ID'] === P3).map((r) => r['Item Cost'])), JSON.stringify([50, 50]));
  const w2 = world();
  w2.ship(2, ID1, 100);                                                                    // 100 / 3 does not divide evenly
  const costs = w2.mine().map((r) => r['Item Cost']);
  assert.equal(JSON.stringify(costs), JSON.stringify([33.34, 33.33, 33.33]));
  assert.equal(Math.round(costs.reduce((a, c) => a + c, 0) * 100), 10000);
});

test('missing listing cost => Item Cost left BLANK (never $0); it fills in automatically once Purchase Cost is entered', () => {
  const w = world();
  w.ship(2, ID1);                                                                          // no paid price anywhere
  assert.ok(w.mine().every((r) => r['Item Cost'] === ''));
  assert.match(w.records()[0]['Notes'], /NO Item Cost/);
  const hm = w.run('headerMap_')(w.pur, 1);
  w.pur.put(2, hm['Purchase Cost'], 90);                                                   // user types the cost into Purchased
  w.run('reconcile()');
  assert.equal(JSON.stringify(w.mine().map((r) => r['Item Cost'])), JSON.stringify([30, 30, 30]));
});

// ---------------------------------------------------------------- idempotence
test('repeat syncs never duplicate rows (reconcile, USPS rechecks, repeated transfer calls)', () => {
  const w = world();
  w.ship(2, ID1, 120);
  const before = w.invRows().length;
  for (let i = 0; i < 4; i++) { w.run('reconcile()'); w.accept(P1, 'Departed USPS Regional Facility'); w.run('transferEligible_()'); w.run('syncInventoryStatus_()'); }
  assert.equal(w.invRows().length, before);
  assert.equal(new Set(w.mine().map((r) => r['Item Key'])).size, 3);
});

test('crash mid-transfer (only 1 of 3 rows written) heals to exactly 3 rows with no duplicates', () => {
  const w = world();
  w.ship(2, ID1, 120, false);                                                              // tracking recorded, not yet accepted
  const r = w.invRows().length + 2;                                                        // first empty row below the data
  w.inv.put(r, w.invCol('Purchase ID'), P1); w.inv.put(r, w.invCol('Item Key'), P1 + '#1');     // row claimed, nothing else written
  w.accept(P1);
  const mine = w.mine().filter((x) => x['Purchase ID'] === P1);
  assert.equal(mine.length, 3);
  assert.equal(mine[0]['Product'], 'Monitors (x2)'); assert.equal(mine[0]['Item Cost'], 40);
  assert.equal(new Set(mine.map((x) => x['Item Key'])).size, 3);
});

// ---------------------------------------------------------------- grouping
test('rows are grouped by listing: same shade within a listing, alternating between listings, labelled "n of N"', () => {
  const w = world();
  w.ship(2, ID1, 120); w.ship(5, ID2, 1000); w.ship(6, ID3, 100);
  const shade = (pid) => [...new Set(w.mine().filter((r) => r['Purchase ID'] === pid).map((r) => r['Group Shade']))];
  assert.equal(shade(P1).length, 1); assert.equal(shade(P2).length, 1); assert.equal(shade(P3).length, 1);
  assert.notEqual(shade(P1)[0], shade(P2)[0]); assert.notEqual(shade(P2)[0], shade(P3)[0]);       // neighbours differ
  assert.equal(shade(P1)[0], shade(P3)[0]);
  assert.equal(JSON.stringify(w.mine().map((r) => r['Listing Item'])), JSON.stringify(['1 of 3', '2 of 3', '3 of 3', '1 of 1', '1 of 2', '2 of 2']));
  // sorting/filtering safe: every row carries its own purchase link and shade; the tint rule keys off the row itself
  const rules = w.inv.getConditionalFormatRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].formula, '=$' + w.ctx.colToLetter_(w.invCol('Group Shade')) + '2=1');
  assert.ok(w.inv._hidden.includes(w.invCol('Group Shade')));
});

// ---------------------------------------------------------------- manual data protection
test('manual eBay columns start empty (checkbox unchecked) and are NEVER touched by any later sync', () => {
  const w = world();
  w.ship(2, ID1, 120, false);
  w.accept(P1);                                                                            // transfer
  const rows = w.mine();
  assert.ok(rows.every((r) => r['Listed on eBay?'] === false && r['Total Sale Price'] === '' && r['eBay Fees'] === '' && r['Shipping Label Cost'] === '' && r['Sale Date'] === ''));
  const row = rows[1]._row;                                                                // the Keyboard row: user records a sale
  const set = (h, v) => w.inv.put(row, w.invCol(h), v);
  set('Listed on eBay?', true); set('Total Sale Price', 64.5); set('eBay Fees', 8.4); set('Shipping Label Cost', 7.25); set('Sale Date', '2026-11-02');
  const snapshot = JSON.stringify(w.inv.rowObj(row));
  w.accept(P1, 'Departed USPS Regional Facility');
  w.accept(P1, 'Delivered, Front Door/Porch');                                             // stage changes: status refresh
  const hm = w.run('headerMap_')(w.pur, 1);
  w.pur.put(2, hm['Purchase Cost'], 150);                                                  // cost changes: Item Cost refresh
  w.run('reconcile()'); w.run('reconcile()');
  const after = w.inv.rowObj(row);
  ['Listed on eBay?', 'Total Sale Price', 'eBay Fees', 'Shipping Label Cost', 'Sale Date', 'Product', 'Estimated Resale', 'Purchase ID', 'Item Key'].forEach((h) => {
    assert.equal(after[h], JSON.parse(snapshot)[h], h);
  });
  assert.equal(after['Item Cost'], 50);                                                    // the automatic part did update (150 / 3)
});

test('Item Cost is only re-allocated when the listing cost changes; a hand-edited Item Cost survives status updates', () => {
  const w = world();
  w.ship(2, ID1, 120, false); w.accept(P1);
  const row = w.mine()[0]._row;
  w.inv.put(row, w.invCol('Item Cost'), 55);                                               // manual correction
  w.accept(P1, 'Departed USPS Regional Facility'); w.run('reconcile()');
  assert.equal(w.inv.rowObj(row)['Item Cost'], 55);
});

test('Status follows shipping only while it is blank or an automatic value; Listed / Sold are yours', () => {
  const w = world();
  w.ship(2, ID1, 120);
  const [a, b] = w.mine();
  w.inv.put(b._row, w.invCol('Status'), 'Listed');
  w.accept(P1, 'Delivered, Front Door/Porch');
  assert.equal(w.inv.rowObj(a._row)['Status'], 'Delivered');
  assert.equal(w.inv.rowObj(b._row)['Status'], 'Listed');
});

// ---------------------------------------------------------------- Facebook-confirmed delivery
test('Facebook-confirmed delivery transfers the purchase even if USPS was never verified', () => {
  const w = world();
  w.main.put(5, COST, 1000); w.setY(5, 'Y');
  w.post({ action: 'submitFbResult', purchaseId: P2, result: { ok: true, fbStatusRaw: 'Delivered | Your order was delivered. | Order Confirmed', trackingNumber: TN(5), carrier: 'USPS' } });
  w.run('reconcile()');
  const rows = w.mine();
  assert.equal(rows.length, 1); assert.equal(rows[0]['Product'], 'Canon R6 Body'); assert.equal(rows[0]['Item Cost'], 1000);
  assert.equal(rows[0]['Status'], 'Delivered');
  assert.equal(w.records()[0]['Purchase Status'], 'Delivered');
});

// ---------------------------------------------------------------- canceled / label-only
test('label-only and canceled purchases never create inventory rows', () => {
  const w = world();
  w.ship(2, ID1, 120, false);
  w.accept(P1, 'Shipping Label Created, USPS Awaiting Item');
  w.run('reconcile()');
  assert.equal(w.mine().length, 0);
  w.post({ action: 'submitFbResult', purchaseId: P1, result: { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true } });     // View Order gone => Canceled
  assert.equal(w.records()[0]['Purchase Status'], 'Canceled');
  w.run('reconcile()');
  assert.equal(w.mine().length, 0);
});

// ---------------------------------------------------------------- cutoff
test('purchases dated before 2026-10-25 are left completely alone (no monitoring, no transfer); later ones work normally', () => {
  const w = world();
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '2026-10-25';
  w.ship(2, ID1, 120, false);                                                              // clock is 2026-10-19: before the cutoff
  assert.equal(w.post({ action: 'getWork', force: true }).items.length, 0);
  assert.equal(w.post({ action: 'getUspsWork', force: true }).items.length, 0);
  w.accept(P1);
  w.run('reconcile()');
  assert.equal(w.mine().length, 0);
  assert.equal(w.records().length, 1);                                                     // history preserved
  w.advance(7 * DAY);                                                                      // 2026-10-26: new purchases are in scope
  w.ship(5, ID2, 1000);
  assert.equal(w.mine().length, 1); assert.equal(w.mine()[0]['Purchase ID'], P2);
});

// ---------------------------------------------------------------- guard + migration
test('until the sheet is migrated, transfers are BLOCKED loudly and nothing is written', () => {
  const w = world({ migrate: false });
  const before = JSON.stringify(w.inv._data);
  w.ship(2, ID1, 120);
  assert.equal(JSON.stringify(w.inv._data), before);
  assert.ok(w.logEvents().some((e) => /TRANSFER_BLOCKED.*setupInventoryV2/.test(e)));
  assert.equal(w.records()[0]['Transferred to eBay?'], '');
  w.run('setupInventoryV2()');                                                             // after migration the pending purchase transfers
  w.run('reconcile()');
  assert.equal(w.mine().length, 3);
});

test('migration: backup first, Cost->Item Cost, URL->Facebook Listing, ONLY the 3 named columns deleted, existing rows & sales data intact', () => {
  const w = world({ migrate: false });
  const before = [2, 3].map((r) => w.inv.rowObj(r));
  const tabsBefore = Object.keys(w.invSS.sheets).length;
  const report = w.run('setupInventoryV2()');
  assert.match(report, /Backup of the tab saved/); assert.match(report, /Renamed "Cost" -> "Item Cost"/); assert.match(report, /Deleted columns: .*Tracking Number.*USPS Status.*Estimated Delivery/);
  assert.equal(Object.keys(w.invSS.sheets).length, tabsBefore + 1);
  const backup = w.invSS.sheets[Object.keys(w.invSS.sheets).find((n) => /^Inventory backup/.test(n))];
  assert.equal(backup._get(1, 5), 'Tracking Number');                                      // the backup still has the old columns
  const hm = w.run('headerMap_')(w.inv, 1);
  ['Tracking Number', 'USPS Status', 'Estimated Delivery', 'Cost'].forEach((h) => assert.equal(hm[h], undefined, h));
  ['Product', 'Facebook Listing', 'Item Cost', 'Estimated Resale', 'Status', 'eBay Sold Price', 'Profit', 'Purchase ID', 'Listing Item', 'Listed on eBay?',
   'Total Sale Price', 'eBay Fees', 'Shipping Label Cost', 'Sale Date', 'Item Key', 'Group Shade'].forEach((h) => assert.ok(hm[h], 'missing ' + h));
  const after = [2, 3].map((r) => w.inv.rowObj(r));
  ['Product', 'Estimated Resale', 'Status', 'eBay Sold Price', 'Profit'].forEach((h) => { assert.equal(after[0][h], before[0][h], h); assert.equal(after[1][h], before[1][h], h); });
  assert.equal(after[0]['Item Cost'], 100); assert.equal(after[0]['Facebook Listing'], 'https://old.example/1');       // renamed in place, values kept
  assert.equal(after[1]['Item Cost'], 900); assert.equal(after[1]['Purchase ID'], 'OLD-1');
  assert.notEqual(after[0]['Group Shade'], after[1]['Group Shade']);                       // legacy rows get alternating shades too
  assert.equal(after[0]['Listed on eBay?'], false);                                        // existing rows get the checkbox, unticked
});

test('migration is repeatable: no second backup, no further changes, existing data identical', () => {
  const w = world({ migrate: false });
  w.run('setupInventoryV2()');
  const snap = JSON.stringify(w.inv._data), tabs = Object.keys(w.invSS.sheets).length, rules = w.inv.getConditionalFormatRules().length;
  const second = w.run('setupInventoryV2()');
  assert.equal(JSON.stringify(w.inv._data), snap);
  assert.equal(Object.keys(w.invSS.sheets).length, tabs);
  assert.equal(w.inv.getConditionalFormatRules().length, rules);
  assert.doesNotMatch(second, /Backup|Deleted|Renamed/);
});

test('legacy rows (one row per old listing) are never re-created or split, even for a purchase that is later transferred', () => {
  const w = world();
  w.ship(2, ID1, 120);
  const legacy = w.invRows().filter((r) => r['Item Key'] === '' && r['Purchase ID'] === 'OLD-1');
  assert.equal(legacy.length, 1);
  // a purchase whose inventory row already exists in the OLD style (no Item Key) is healed, not duplicated
  const row = w.invRows().length + 2;
  w.inv.put(row, w.invCol('Product'), 'Canon R6 Body (old style)'); w.inv.put(row, w.invCol('Purchase ID'), P2);
  const count = w.invRows().length;
  w.ship(5, ID2, 1000);
  assert.equal(w.invRows().length, count);
  assert.equal(w.records().find((r) => r['Purchase ID'] === P2)['Transferred to eBay?'], 'Y');
});

test('missing scanner listing: falls back to a single row from the purchase record, flagged in the log', () => {
  const w = world();
  w.ship(5, ID2, 1000, false);
  w.main.put(5, 2, 'not a listing url');                                                   // listing disappears from Main before acceptance
  w.accept(P2);
  const rows = w.mine();
  assert.equal(rows.length, 1); assert.equal(rows[0]['Product'], 'Canon R6 Body'); assert.equal(rows[0]['Item Cost'], 1000);
  assert.ok(w.logEvents().some((e) => /scanner listing not found/.test(e)));
});

test('no dashboard or inventory operation ever deletes or blanks a Purchased record', () => {
  const w = world();
  w.ship(2, ID1, 120); w.ship(6, ID3, 100);
  const before = w.records().length;
  w.run('setupPurchaseDashboard()'); w.run('refreshPurchaseDashboard()'); w.run('setupInventoryV2()'); w.run('reconcile()');
  assert.equal(w.records().length, before);
});
