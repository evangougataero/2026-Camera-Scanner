'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');

const SCANNER_ID = 'scanner-ss', INV_ID = 'inventory-ss';
const ID1 = '1111111111111111', ID2 = '2222222222222222', ID3 = '3333333333333333';
const TN1 = '9400111899223033005282';
const SCAN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy',
  'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'O', 'P', 'Relisted', 'Purchase Price'];
const K = 11, COST = 18, DAY = 86400000;
const P1 = `${ID1}-1`, P2 = `${ID2}-1`, P3 = `${ID3}-1`;
const LEGACY_HEADERS = ['Product', 'Facebook URL', 'Cost', 'Estimated Resale', 'Tracking Number', 'USPS Status', 'Estimated Delivery', 'Status', 'eBay Sold Price', 'Profit'];

function world() {
  const w = buildContext();
  const scan = w.addSpreadsheet(SCANNER_ID);
  const main = scan.insertSheet('Main');
  SCAN_HEADERS.forEach((h, i) => main.put(1, i + 1, h));
  const put = (r, o) => Object.keys(o).forEach((c) => main.put(r, +c, o[c]));
  put(2, { 1: 'Canon R6 Body', 2: `https://www.facebook.com/marketplace/item/${ID1}/`, 4: 1800, 5: 2200 });
  put(3, { 1: 'Sigma 35mm', 2: `https://www.facebook.com/marketplace/item/${ID2}/`, 4: 800, 5: 400 });
  put(4, { 1: 'Sigma 50mm', 5: 450 });
  put(5, { 1: 'Nikon Z6 with a really long product name that should wrap rather than widen the column', 2: `https://www.facebook.com/marketplace/item/${ID3}/`, 4: 900, 5: 1300 });
  const inv = w.addSpreadsheet(INV_ID);
  const sh = inv.insertSheet('Inventory');
  LEGACY_HEADERS.forEach((h, i) => sh.put(1, i + 1, h));
  w.ctx.CONFIG.SCANNER.spreadsheetId = SCANNER_ID;
  w.ctx.CONFIG.INVENTORY.spreadsheetId = INV_ID;
  w.ctx.CONFIG.INVENTORY.tab = 'Inventory';
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '';
  w.run('setup()');
  w.run('setupInventoryV2()');
  w.ss = scan; w.main = main; w.inv = sh; w.pur = scan.getSheetByName('Purchased');
  w.setY = (row, v, old) => { main.put(row, K, v); w.ctx.__e = { range: main.getRange(row, K), value: v, oldValue: old === undefined ? '' : old }; w.run('onScannerEdit(__e)'); };
  w.post = (body) => JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify(Object.assign({ token: w.props.API_TOKEN }, body)) } }).text);
  w.usps = (pid, result) => w.post({ action: 'submitUspsResult', purchaseId: pid, result: Object.assign({ ok: true }, result) });
  w.fb = (pid, result) => w.post({ action: 'submitFbResult', purchaseId: pid, result });
  w.dash = () => scan.getSheetByName('Purchase Dashboard');
  w.dashRows = () => {
    const s = w.dash(), out = [], heads = [];
    for (let c = 1; c <= 15; c++) heads.push(s._get(3, c));
    for (let r = 4; r <= s.getLastRow(); r++) {
      if (s._get(r, 14) === '') continue;
      const o = {}; heads.forEach((h, i) => { o[h] = s._get(r, i + 1); }); out.push(o);
    }
    return out;
  };
  w.summary = () => { const s = w.dash(), o = {}; for (let c = 1; c <= 10; c++) o[s._get(1, c)] = s._get(2, c); return o; };
  w.snapshot = (sheet) => JSON.stringify(sheet._data);
  w.setPurchasedAt = (pid, ms) => {
    const hm = w.run('headerMap_')(w.pur, 1);
    for (let r = 2; r <= w.pur.getLastRow(); r++) if (String(w.pur._get(r, hm['Purchase ID'])) === pid) w.pur._data[`${r},${hm['Purchased At']}`] = new Date(ms);
  };
  w.buy = (row, id, cost) => { if (cost !== undefined) w.main.put(row, COST, cost); w.setY(row, 'Y'); };
  w.invCol = (h) => w.run('headerMap_')(sh, 1)[h];
  return w;
}

test('setup: new layout (summary rows 1-2, header row 3), hidden helper column, one filter, one refresh trigger, no note row', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  const sh = w.dash();
  assert.equal(w.ss.order[0], 'Purchase Dashboard');
  const heads = []; for (let c = 1; c <= 14; c++) heads.push(sh._get(3, c));
  assert.equal(heads.join('|'), 'Product|Order Status|Attention / Action Needed|Purchase Date|Days Since Purchase|Purchase Cost|Estimated Resale|Est. Profit|Tracking|Estimated Delivery|Facebook Listing|Inventory|Record|Purchase ID');
  const labels = []; for (let c = 1; c <= 10; c++) labels.push(sh._get(1, c));
  assert.equal(labels.join('|'), 'Needs Attention|Total Active|Capital Tied Up (undelivered)|Awaiting Shipment|In Transit|Delivered|Overdue|Canceled|Missing Cost|Last Updated');
  assert.equal(sh._frozen, 3); assert.deepEqual(sh._hidden, [15]); assert.equal(sh._filterCreates, 1);
  assert.equal(sh.getConditionalFormatRules().length, w.ctx.DASH_RULES.length + 2);
  assert.equal(w.triggers.filter((t) => t.fn === 'refreshPurchaseDashboard').length, 1);
});

test('the explanatory text is gone: no cell on the dashboard contains it, before or after purchases exist', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1); w.run('refreshPurchaseDashboard()');
  const all = Object.keys(w.dash()._data).map((k) => String(w.dash()._data[k]));
  assert.ok(!all.some((v) => /Active = not delivered|Capital = actual|no confirmed refund|not assumed recovered|excluded, not counted/i.test(v)));
});

test('YOUR situation: a dashboard from the old layout whose first row you deleted is rebuilt once; refreshes never write into an unrecognised layout', () => {
  const w = world();
  const s = w.ss.insertSheet('Purchase Dashboard', 0);
  // old layout minus the deleted title row: labels(1) values(2) NOTE(3) header(4) data(5+)
  ['Needs Attention', 'Total Active'].forEach((v, i) => s.put(1, i + 1, v)); s.put(2, 1, 9);
  s.put(3, 1, 'Active = not delivered/canceled/refunded. Capital = actual Purchase Cost of active purchases (asking price is never used); 5 active purchase(s) with no cost entered are excluded');
  ['Product', 'Order Status'].forEach((v, i) => s.put(4, i + 1, v));
  s.put(5, 1, 'stale row A'); s.put(6, 1, 'stale row B'); s.put(7, 1, 'stale row C');
  w.buy(2, ID1, 1650);
  const frozen = w.snapshot(s);
  assert.match(w.run('refreshPurchaseDashboard()'), /layout changed/);                    // the 10-minute trigger must not scribble over it
  assert.equal(w.snapshot(s), frozen);
  w.run('setupPurchaseDashboard()');                                                       // one-time rebuild
  assert.equal(s._get(1, 1), 'Needs Attention'); assert.equal(s._get(3, 1), 'Product');
  assert.equal(w.dashRows().length, 1); assert.equal(w.dashRows()[0]['Purchase ID'], P1);
  const vals = Object.keys(s._data).map((k) => String(s._data[k]));
  assert.ok(!vals.some((v) => /stale row|Capital = actual/.test(v)));
  assert.equal(s._get(4, 14), P1); assert.equal(s._get(5, 14), '');                         // data starts on row 4, nothing left below
  assert.equal(w.run('refreshPurchaseDashboard()'), '1 purchase(s)');                      // and refreshes work from now on
  assert.equal(s._get(3, 1), 'Product');                                                    // header row is never recreated elsewhere
});

test('setup is idempotent: repeat runs add no triggers, rules, filters or rows; existing triggers untouched', () => {
  const w = world();
  w.buy(2, ID1, 1650);
  const before = w.triggers.map((t) => t.fn).sort().join();
  w.run('setupPurchaseDashboard()'); w.run('setupPurchaseDashboard()'); w.run('setupPurchaseDashboard()');
  assert.equal(w.triggers.map((t) => t.fn).sort().join(), before.split(',').concat('refreshPurchaseDashboard').sort().join());
  assert.equal(w.dash().getConditionalFormatRules().length, w.ctx.DASH_RULES.length + 2);
  assert.equal(w.dash()._filterCreates, 1);
  assert.equal(w.dashRows().length, 1);
  assert.ok(w.triggers.some((t) => t.fn === 'onScannerEdit') && w.triggers.some((t) => t.fn === 'reconcile'));
});

test('backend columns: a missing one is APPENDED; no existing header moves, renames or disappears', () => {
  const w = world();
  const hm0 = w.run('headerMap_')(w.pur, 1);
  w.pur._data[`1,${hm0['Inventory Sync Sig']}`] = '';
  const before = []; for (let c = 1; c <= 29; c++) before.push(w.pur._get(1, c));
  assert.match(w.run('setupPurchaseDashboard()'), /added new columns at the far right: Inventory Sync Sig/);
  for (let c = 1; c <= 28; c++) if (c !== hm0['Inventory Sync Sig']) assert.equal(w.pur._get(1, c), before[c - 1]);
});

test('the dashboard NEVER writes to Purchased, Main or Inventory', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650); w.buy(3, ID2, 800);
  w.fb(P1, { ok: true, fbStatusRaw: 'Order Confirmed', trackingNumber: TN1, carrier: 'USPS' });
  w.usps(P1, { status: 'USPS in possession of item', history: ['USPS in possession of item'] });
  const snap = [w.snapshot(w.pur), w.snapshot(w.main), w.snapshot(w.inv)];
  w.run('refreshPurchaseDashboard()'); w.run('refreshPurchaseDashboard()'); w.advance(30 * DAY); w.run('refreshPurchaseDashboard()');
  assert.deepEqual([w.snapshot(w.pur), w.snapshot(w.main), w.snapshot(w.inv)], snap);
});

test('rows: one per purchase keyed by Purchase ID, no duplicates across refreshes; Voided purchases hidden', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650); w.buy(3, ID2, 800); w.buy(5, ID3, 1000);
  for (let i = 0; i < 4; i++) w.run('refreshPurchaseDashboard()');
  let rows = w.dashRows();
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map((r) => r['Purchase ID'])).size, 3);
  assert.ok(rows.every((r) => typeof r['Purchase ID'] === 'string'));
  w.setY(5, '', 'Y'); w.run('refreshPurchaseDashboard()');
  rows = w.dashRows();
  assert.equal(rows.length, 2); assert.ok(!rows.some((r) => r['Purchase ID'] === P3));
});

test('new purchases appear on the next scheduled refresh, with links back to the backend record', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  assert.equal(w.dashRows().length, 0);
  w.buy(2, ID1, 1650); w.run('refreshPurchaseDashboard()');
  const r = w.dashRows()[0];
  assert.equal(r['Product'], 'Canon R6 Body'); assert.equal(r['Order Status'], 'Purchased'); assert.equal(r['Purchase Cost'], 1650);
  assert.equal(r['Est. Profit'], 550); assert.equal(r['Days Since Purchase'], 0);
  assert.match(r['Facebook Listing'], /^=HYPERLINK\("https:\/\/www\.facebook\.com\/marketplace\/item\/1111/);
  assert.match(r['Record'], /^=HYPERLINK\("#gid=\d+&range=A2","↗ row 2"\)$/);
  assert.equal(r['Inventory'], '—');
});

test('NORMAL ORDER -> LABEL -> OVERDUE -> ACCEPTED -> DELIVERED with no extension activity (time-driven only)', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  w.fb(P1, { ok: true, fbStatusRaw: 'Order Confirmed' });
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Awaiting Shipment');
  w.fb(P1, { ok: true, fbStatusRaw: 'Order Confirmed | Shipped', trackingNumber: TN1, carrier: 'USPS' });
  w.usps(P1, { status: 'Shipping Label Created, USPS Awaiting Item', history: ['Shipping Label Created, USPS Awaiting Item'] });
  w.advance(5 * DAY); w.run('refreshPurchaseDashboard()');
  let r = w.dashRows()[0];
  assert.equal(r['Order Status'], 'Label Created'); assert.equal(r['Attention / Action Needed'], 'No Action Needed');
  assert.match(r['Tracking'], new RegExp('tools.usps.com/tracking/' + TN1));
  w.advance(3 * DAY); w.run('refreshPurchaseDashboard()');
  r = w.dashRows()[0];
  assert.equal(r['Order Status'], 'Overdue'); assert.equal(r['Days Since Purchase'], 8);
  assert.match(r['Attention / Action Needed'], /^OVERDUE — Contact Seller · 8 days/); assert.equal(r['Needs Attention'], 'Y');
  assert.equal(w.summary()['Overdue'], 1); assert.equal(w.summary()['Needs Attention'], 1);
  assert.equal(w.inv.rowObj(2)['Product'] || '', '');                                       // still NOT in inventory
  w.usps(P1, { status: 'USPS in possession of item', history: ['USPS in possession of item'], expectedDelivery: 'Saturday, November 7, 2026' });
  w.run('refreshPurchaseDashboard()');
  r = w.dashRows()[0];
  assert.equal(r['Order Status'], 'Shipped / In Transit'); assert.equal(r['Attention / Action Needed'], 'No Action Needed');
  assert.equal(r['Inventory'], '✓ In Inventory'); assert.equal(w.inv.rowObj(2)['Product'], 'Canon R6 Body'); assert.ok(r['Estimated Delivery'] instanceof Date);
  w.usps(P1, { status: 'Delivered, Front Door/Porch', history: ['Delivered, Front Door/Porch'] });
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Delivered'); assert.equal(w.summary()['Delivered'], 1); assert.equal(w.summary()['Total Active'], 0);
});

test('an order with NO tracking becomes overdue on its own at 7 days (Example C)', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  w.advance(6 * DAY); w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Purchased');
  w.advance(1 * DAY + 60000); w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Overdue'); assert.match(w.dashRows()[0]['Attention / Action Needed'], /no tracking number yet/);
});

test('Facebook-confirmed delivery shows Delivered on the dashboard and transfers to inventory, with no USPS check', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  w.fb(P1, { ok: true, fbStatusRaw: 'Delivered | Your order was delivered. | Order Confirmed', trackingNumber: TN1, carrier: 'USPS' });
  w.run('reconcile()'); w.run('refreshPurchaseDashboard()');
  const r = w.dashRows()[0];
  assert.equal(r['Order Status'], 'Delivered'); assert.equal(r['Attention / Action Needed'], 'No Action Needed');
  assert.equal(r['Inventory'], '✓ In Inventory');
  assert.equal(w.post({ action: 'getUspsWork', force: true }).items.length, 0);             // monitoring stopped
});

test('CANCELLATION: View Order missing on a healthy page => Canceled on the dashboard; no Possible/Refunded states', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650); w.buy(3, ID2, 800);
  w.fb(P1, { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true });
  w.run('refreshPurchaseDashboard()');
  const r = w.dashRows().find((x) => x['Purchase ID'] === P1);
  assert.equal(r['Order Status'], 'Canceled'); assert.equal(r['Purchase Cost'], 1650); assert.equal(r['Needs Attention'], '');
  const s = w.summary();
  assert.equal(s['Canceled'], 1); assert.equal(s['Total Active'], 1); assert.equal(s['Capital Tied Up (undelivered)'], 800);
  assert.equal(w.pur.getLastRow(), 3);                                                      // both records preserved
  assert.equal(w.post({ action: 'getWork', force: true }).items.some((i) => i.purchaseId === P1), false);   // monitoring stops
  assert.ok(!w.dashRows().some((x) => /Possible|Refunded/.test(x['Order Status'])));
});

test('CANCELLATION: nothing that merely looks like a failure cancels an order', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  [{ ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: false }, { ok: false, error: 'PAGE_LOAD_TIMEOUT' }, { ok: false, error: 'LOGIN_REQUIRED' },
   { ok: false, error: 'CHECKPOINT' }, { ok: false, error: 'LISTING_UNAVAILABLE' }, { ok: false, error: 'TAB_CLOSED' }].forEach((res) => w.fb(P1, res));
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Purchased');
  w.fb(P1, { ok: true, fbStatusRaw: 'Order Confirmed' });
  w.fb(P1, { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true });             // only a healthy page + no button cancels
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Order Status'], 'Canceled');
});

test('a canceled purchase that is already in Inventory keeps its Inventory rows (flagged, not removed)', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  w.fb(P1, { ok: true, trackingNumber: TN1, carrier: 'USPS', fbStatusRaw: 'Shipped' });
  w.usps(P1, { status: 'USPS in possession of item', history: ['USPS in possession of item'] });
  const inv = w.snapshot(w.inv);
  w.fb(P1, { ok: true, canceled: true });
  w.fb(P1, { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true });              // accepted by USPS: never auto-canceled
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.snapshot(w.inv), inv);
  assert.equal(w.dashRows()[0]['Inventory'], '✓ In Inventory');
  assert.notEqual(w.dashRows()[0]['Order Status'], 'Canceled');
});

test('purchases dated before 2026-10-25 are excluded from rows, counters, alerts and monitoring, but kept in Purchased', () => {
  const w = world();
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '2026-10-25';
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);                                                                      // marked 2026-10-19 (old)
  w.advance(7 * DAY);                                                                       // now 2026-10-26
  w.buy(3, ID2, 800);                                                                       // new
  w.run('refreshPurchaseDashboard()');
  const rows = w.dashRows();
  assert.equal(rows.length, 1); assert.equal(rows[0]['Purchase ID'], P2);
  const s = w.summary();
  assert.equal(s['Total Active'], 1); assert.equal(s['Capital Tied Up (undelivered)'], 800); assert.equal(s['Overdue'], 0); assert.equal(s['Needs Attention'], 0);
  assert.equal(w.pur.getLastRow(), 3);                                                      // the old record is still there, untouched
  assert.equal(JSON.stringify(w.post({ action: 'getWork', force: true }).items.map((i) => i.purchaseId)), JSON.stringify([P2]));
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '';                                                   // cutoff is configurable / removable
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows().length, 2);
});

test('missing cost: delivered row keeps its status, cost flagged, capital excludes it instead of treating it as $0', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1); w.buy(3, ID2, 800);
  w.fb(P1, { ok: true, trackingNumber: TN1, carrier: 'USPS', fbStatusRaw: 'Shipped', orderTotal: '$462.50' });
  w.usps(P1, { status: 'Delivered, Front Door/Porch', history: ['Delivered, Front Door/Porch'] });
  w.run('refreshPurchaseDashboard()');
  const r = w.dashRows().find((x) => x['Purchase ID'] === P1);
  assert.equal(r['Order Status'], 'Delivered'); assert.equal(r['Purchase Cost'], ''); assert.equal(r['Est. Profit'], '');
  assert.match(r['Attention / Action Needed'], /^Enter Purchase Cost \(Facebook order total: \$462\.50\)/);
  const s = w.summary();
  assert.equal(s['Capital Tied Up (undelivered)'], 800); assert.equal(s['Missing Cost'], 1);
});

test('summary + sort order: overdue first; awaiting + in transit + overdue = total active', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650); w.buy(3, ID2, 800); w.buy(5, ID3, 1000);
  w.setPurchasedAt(P2, w.clock.now - 9 * DAY);
  w.fb(P3, { ok: true, trackingNumber: TN1.replace(/..$/, '99'), carrier: 'USPS', fbStatusRaw: 'Shipped' });
  w.usps(P3, { status: 'In Transit', history: ['In Transit'] });
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows()[0]['Purchase ID'], P2);
  const s = w.summary();
  assert.equal(s['Overdue'], 1); assert.equal(s['Needs Attention'], 1);
  assert.equal(s['Awaiting Shipment'] + s['In Transit'] + s['Overdue'], s['Total Active']);
});

test('the pipeline still works with the dashboard installed (transfer once, no duplicates, other inventory rows untouched)', () => {
  const w = world();
  w.inv.put(2, w.invCol('Product'), 'Old Lens'); w.inv.put(2, w.invCol('Status'), 'Sold'); w.inv.put(2, w.invCol('eBay Sold Price'), 250);
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  w.fb(P1, { ok: true, trackingNumber: TN1, carrier: 'USPS', fbStatusRaw: 'Shipped' });
  w.usps(P1, { status: 'Shipping Label Created, USPS Awaiting Item', history: ['Shipping Label Created, USPS Awaiting Item'] });
  w.run('refreshPurchaseDashboard()'); w.run('reconcile()');
  assert.equal(w.inv.getLastRow(), 2);                                                      // label only => nothing transferred
  w.usps(P1, { status: 'USPS in possession of item', history: ['USPS in possession of item'] });
  w.run('refreshPurchaseDashboard()'); w.run('reconcile()'); w.run('reconcile()');
  assert.equal(w.inv.getLastRow(), 3);
  assert.equal(w.inv.rowObj(2)['Status'], 'Sold'); assert.equal(w.inv.rowObj(2)['eBay Sold Price'], 250);
  assert.equal(w.inv.rowObj(3)['Purchase ID'], P1); assert.equal(w.pur.getLastRow(), 2);
});

test('Facebook rechecks continue slowly for label-only orders but stop once USPS accepts', () => {
  const w = world();
  w.buy(2, ID1, 1650);
  w.fb(P1, { ok: true, trackingNumber: TN1, carrier: 'USPS', fbStatusRaw: 'Shipped' });
  assert.equal(w.post({ action: 'getWork' }).items.length, 0);
  w.advance(25 * 3600000);
  assert.equal(w.post({ action: 'getWork' }).items.length, 1);
  w.usps(P1, { status: 'USPS in possession of item', history: ['USPS in possession of item'] });
  w.advance(48 * 3600000);
  assert.equal(w.post({ action: 'getWork' }).items.length, 0);
});

test('a failing dashboard can never break the pipeline: refresh returns a message instead of throwing', () => {
  const w = world();
  assert.match(w.run('refreshPurchaseDashboard()'), /not set up/);
  w.run('setupPurchaseDashboard()');
  w.ctx.CONFIG.PURCHASED.tab = 'Missing Tab';
  assert.match(w.run('refreshPurchaseDashboard()'), /^error:/);
});

test('test records: every scenario renders; invisible to the extension lists and the real Inventory; removal is surgical', () => {
  const w = world();
  w.run('setupPurchaseDashboard()');
  w.buy(2, ID1, 1650);
  const invBefore = w.snapshot(w.inv);
  assert.match(w.run('createDashboardTestRecords()'), /10 test records added/);
  const by = {}; w.dashRows().forEach((r) => { by[r['Purchase ID']] = r; });
  const st = (n) => by['TEST-' + n]['Order Status'];
  assert.equal(st(1), 'Purchased'); assert.equal(st(2), 'Awaiting Shipment'); assert.equal(st(3), 'Label Created');
  assert.equal(st(4), 'Overdue'); assert.equal(st(5), 'Overdue'); assert.equal(st(6), 'Shipped / In Transit');
  assert.equal(st(7), 'Out for Delivery'); assert.equal(st(8), 'Delivered'); assert.equal(st(9), 'Delivered'); assert.equal(st(10), 'Canceled');
  assert.match(by['TEST-8']['Attention / Action Needed'], /^Enter Purchase Cost/); assert.equal(by['TEST-6']['Inventory'], '✓ In Inventory');
  assert.ok(!w.post({ action: 'getWork', force: true }).items.some((i) => /^TEST-/.test(i.purchaseId)));
  assert.ok(!w.post({ action: 'getUspsWork', force: true }).items.some((i) => /^TEST-/.test(i.purchaseId)));
  w.run('reconcile()'); w.run('reconcile()');
  assert.equal(w.snapshot(w.inv), invBefore);
  assert.equal(w.fetchLog.length, 0);
  w.run('createDashboardTestRecords()');
  assert.equal(w.dashRows().filter((r) => /^TEST-/.test(r['Purchase ID'])).length, 10);
  assert.match(w.run('removeDashboardTestRecords()'), /10 test record/);
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dashRows().length, 1); assert.equal(w.dashRows()[0]['Purchase ID'], P1); assert.equal(w.pur.getLastRow(), 2);
});

test('settings live ONLY in Config.gs, so overwriting Code.gs/Logic.gs/Dashboard.gs/Inventory.gs can never wipe them', () => {
  const dir = require('path').join(__dirname, '..', 'apps-script'), fs = require('fs');
  const declarations = (f) => (fs.readFileSync(require('path').join(dir, f), 'utf8').match(/^var CONFIG\s*=/gm) || []).length;
  assert.equal(declarations('Config.gs'), 1);
  ['Code.gs', 'Logic.gs', 'Dashboard.gs', 'Inventory.gs'].forEach((f) => assert.equal(declarations(f), 0, f + ' must not define CONFIG'));
});

test('unfilled Config gives an actionable error; recovery helper finds the scanner id from the installed trigger', () => {
  const w = world();
  assert.match(w.run('recoverScannerSpreadsheetId()'), new RegExp(SCANNER_ID));
  w.ctx.CONFIG.SCANNER.spreadsheetId = 'PASTE_SCANNER_SPREADSHEET_ID';
  assert.throws(() => w.run('setupPurchaseDashboard()'), /Config\.gs is not filled in: CONFIG\.SCANNER\.spreadsheetId is still "PASTE_SCANNER_SPREADSHEET_ID"/);
});

test('an OLDER Config.gs (no DASHBOARD block, no PURCHASE_SCOPE_START, old inventory column list) still works: defaults apply, so you do NOT have to replace your Config.gs', () => {
  const w = world();
  delete w.ctx.CONFIG.DASHBOARD; delete w.ctx.CONFIG.FB_TRACKING_RECHECK_MINUTES; delete w.ctx.CONFIG.PURCHASE_SCOPE_START;
  w.ctx.CONFIG.INVENTORY.columns = [{ header: 'Product', field: 'Product' }, { header: 'Cost', field: '__cost' }];      // stale mapping is simply ignored
  w.run('setupPurchaseDashboard()'); w.buy(2, ID1, 1650);
  assert.equal(w.run('scopeStartMs_()') > 0, true);                                         // default cutoff 2026-10-25 applies
  w.advance(7 * DAY); w.buy(3, ID2, 800);
  assert.equal(w.run('refreshPurchaseDashboard()'), '1 purchase(s)');
  assert.equal(w.post({ action: 'getWork' }).items.length, 1);
});
