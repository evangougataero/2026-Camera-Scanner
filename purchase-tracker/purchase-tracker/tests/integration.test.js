'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');

const SCANNER_ID = 'scanner-ss', INV_ID = 'inventory-ss';
const ID1 = '1111111111111111';   // 16 digits: would be corrupted by Sheets if stored as a number
const ID2 = '2222222222222222';
const ID3 = '3333333333333333';
const TN1 = '9400111899223033005282';
const TN2 = '9205590164917312751089';

const SCAN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy',
  'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'O', 'P', 'Relisted', 'Purchase Price'];
const K = 11, COST = 18;

function world() {
  const w = buildContext();
  const scan = w.addSpreadsheet(SCANNER_ID);
  const main = scan.insertSheet('Main');
  SCAN_HEADERS.forEach((h, i) => main.put(1, i + 1, h));
  const put = (r, o) => Object.keys(o).forEach((c) => main.put(r, +c, o[c]));
  put(2, { 1: 'Canon R6 Body', 2: `https://www.facebook.com/marketplace/item/${ID1}/`, 4: 1800, 5: 2200 });
  put(3, { 1: 'Sigma 35mm', 2: `https://www.facebook.com/marketplace/item/${ID2}/`, 4: 800, 5: 400 });
  put(4, { 1: 'Sigma 50mm', 5: 450 });
  put(5, { 1: 'Nikon Z6', 2: `https://www.facebook.com/marketplace/item/${ID3}/`, 4: 900, 5: 1300 });
  const inv = w.addSpreadsheet(INV_ID);
  const sh = inv.insertSheet('Inventory');
  ['Product', 'Facebook URL', 'Cost', 'Estimated Resale', 'Tracking Number', 'USPS Status', 'Estimated Delivery', 'Status', 'eBay Sold Price', 'Profit']
    .forEach((h, i) => sh.put(1, i + 1, h));
  // Pre-existing sold item with a user-owned row (must survive untouched)
  sh.put(2, 1, 'Old Lens'); sh.put(2, 3, 100); sh.put(2, 8, 'Sold'); sh.put(2, 9, 250);
  w.ctx.CONFIG.SCANNER.spreadsheetId = SCANNER_ID;
  w.ctx.CONFIG.INVENTORY.spreadsheetId = INV_ID;
  w.ctx.CONFIG.INVENTORY.tab = 'Inventory';
  w.ctx.CONFIG.PURCHASE_SCOPE_START = '';                       // these tests use dates before the real cutoff
  w.run('setup()');
  w.run('setupInventoryV2()');                                  // migrate the legacy-layout sheet above (also covers the migration path)
  w.main = main; w.inv = sh; w.pur = scan.getSheetByName('Purchased'); w.logSheet = scan.getSheetByName('Purchase Log');
  w.setY = (row, v, old) => { main.put(row, K, v); w.run('0'); w.ctx.__e = { range: main.getRange(row, K), value: v, oldValue: old === undefined ? '' : old }; w.run('onScannerEdit(__e)'); };
  w.records = () => { const out = []; for (let r = 2; r <= w.pur.getLastRow(); r++) out.push(w.pur.rowObj(r)); return out; };
  w.invCol = (h) => w.run('headerMap_')(w.inv, 1)[h];
  w.invRows = () => { const out = []; for (let r = 2; r <= w.inv.getLastRow(); r++) out.push(w.inv.rowObj(r)); return out; };
  w.post = (body) => JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify(Object.assign({ token: w.props.API_TOKEN }, body)) } }).text);
  w.usps = (pid, result) => w.post({ action: 'submitUspsResult', purchaseId: pid, result: Object.assign({ ok: true }, result) });
  return w;
}

const pg = (status, extra) => Object.assign({ status, history: [status] }, extra || {});
const P1 = `${ID1}-1`;

test('setup(): creates tabs, headers, API token and the three triggers (idempotent)', () => {
  const w = world();
  assert.ok(w.pur.getLastColumn() >= 28);
  assert.ok(w.props.API_TOKEN.length > 30);
  w.run('setup()'); w.run('setup()');
  const kinds = w.triggers.map((t) => t.fn).sort();
  assert.equal(JSON.stringify(kinds), JSON.stringify(['onScannerEdit', 'reconcile']));
  assert.equal(w.triggers.find((t) => t.fn === 'onScannerEdit').ss, SCANNER_ID);
  assert.ok(w.inv.getLastColumn() >= 11, 'link column added to inventory header');
  assert.match(w.run('inventoryReport_()'), /new per-product layout is in place/);
});

test('Feature 1: marking Y creates exactly one record; long IDs survive; ask price is not cost', () => {
  const w = world();
  w.setY(2, 'Y');
  const recs = w.records();
  assert.equal(recs.length, 1);
  const r = recs[0];
  assert.equal(r['Purchase ID'], `${ID1}-1`);
  assert.equal(r['Listing ID'], ID1);                       // string, not 1.111e15
  assert.equal(typeof r['Listing ID'], 'string');
  assert.equal(r['Product'], 'Canon R6 Body');
  assert.equal(r['Ask Price (FB)'], 1800);
  assert.equal(r['Purchase Cost'], '');
  assert.match(r['Notes'], /NOT used as cost/);
  assert.equal(r['Estimated Resale'], 2200);
  assert.equal(r['Purchase Status'], 'Purchased');
  assert.equal(w.main.getRange(2, K).getValue(), 'Y');       // scanner row untouched / not removed
});

test('Feature 1: duplicates are impossible (edit repeated, reconcile repeated, multi-item merge)', () => {
  const w = world();
  w.setY(2, 'Y'); w.setY(2, 'Y', 'Y'); w.run('reconcile()'); w.run('reconcile()');
  w.setY(3, 'Y');
  w.run('reconcile()');
  const recs = w.records();
  assert.equal(recs.length, 2);
  const multi = recs.find((x) => x['Listing ID'] === ID2);
  assert.equal(multi['Product'], 'Sigma 35mm + Sigma 50mm');
  assert.equal(multi['Estimated Resale'], 850);
});

test('Feature 1: paid price column in the scanner is used as cost when present', () => {
  const w = world();
  w.main.put(2, COST, 1650);
  w.setY(2, 'Y');
  assert.equal(w.records()[0]['Purchase Cost'], 1650);
});

test('Feature 1: mistaken Y is voided cleanly; re-marking creates attempt 2; nothing else is touched', () => {
  const w = world();
  w.setY(2, 'Y'); w.setY(5, 'Y');
  w.setY(2, '', 'Y');
  let recs = w.records();
  assert.equal(recs.find((x) => x['Listing ID'] === ID1)['Purchase Status'], 'Voided');
  assert.equal(recs.find((x) => x['Listing ID'] === ID3)['Purchase Status'], 'Purchased');
  w.run('reconcile()');
  assert.equal(w.records().length, 2);                       // reconcile does not resurrect it
  w.setY(2, 'Y', '');                                        // user re-marks
  recs = w.records();
  assert.equal(recs.length, 3);
  assert.equal(recs[2]['Purchase ID'], `${ID1}-2`);
  assert.equal(recs[2]['Purchase Status'], 'Purchased');
});

test('Feature 1: a Y added without the edit trigger (paste/API) is caught by reconcile', () => {
  const w = world();
  w.main.put(5, K, 'Y');
  assert.equal(w.records().length, 0);
  w.run('reconcile()');
  assert.equal(w.records().length, 1);
});

test('Feature 2 API: auth, work selection, results, errors, tracking, cancellation', () => {
  const w = world();
  w.setY(2, 'Y'); w.setY(5, 'Y');
  assert.equal(JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify({ action: 'getWork', token: 'wrong' }) } }).text).error, 'UNAUTHORIZED');
  assert.equal(w.run('doPost')({ postData: { contents: 'not json' } }).text.includes('BAD_JSON'), true);

  let work = w.post({ action: 'getWork' });
  assert.equal(work.items.length, 2);
  const pid1 = `${ID1}-1`, pid3 = `${ID3}-1`;

  // Order Details found but no tracking yet
  w.post({ action: 'submitFbResult', purchaseId: pid1, result: { ok: true, fbStatusRaw: 'Order placed', trackingNumber: '' } });
  let r1 = w.records().find((x) => x['Purchase ID'] === pid1);
  assert.equal(r1['FB Status (raw)'], 'Order placed'); assert.equal(r1['Purchase Status'], 'Purchased'); assert.ok(r1['Last FB Check']);
  // not due again for ~2.5h
  assert.equal(w.post({ action: 'getWork' }).items.some((i) => i.purchaseId === pid1), false);
  w.advance(3 * 3600 * 1000);
  assert.equal(w.post({ action: 'getWork' }).items.some((i) => i.purchaseId === pid1), true);

  // Page failed to load: error logged, other data preserved
  w.post({ action: 'submitFbResult', purchaseId: pid1, result: { ok: false, error: 'PAGE_LOAD_TIMEOUT' } });
  r1 = w.records().find((x) => x['Purchase ID'] === pid1);
  assert.equal(r1['FB Error Count'], 1); assert.match(r1['Notes'], /PAGE_LOAD_TIMEOUT/); assert.equal(r1['FB Status (raw)'], 'Order placed');

  // Login wall is systemic: NOT counted against the listing
  w.post({ action: 'submitFbResult', purchaseId: pid1, result: { ok: false, error: 'LOGIN_REQUIRED' } });
  assert.equal(w.records().find((x) => x['Purchase ID'] === pid1)['FB Error Count'], 1);

  // Tracking found => Tracking Available, long number stays a string, FB no longer checked
  w.post({ action: 'submitFbResult', purchaseId: pid1, result: { ok: true, fbStatusRaw: 'Shipped', trackingNumber: TN1, carrier: 'USPS', orderId: '123456789012345' } });
  r1 = w.records().find((x) => x['Purchase ID'] === pid1);
  assert.equal(r1['Tracking Number'], TN1); assert.equal(typeof r1['Tracking Number'], 'string');
  assert.equal(r1['Purchase Status'], 'Tracking Available'); assert.equal(r1['Carrier'], 'USPS');
  assert.equal(r1['FB Order ID'], '123456789012345'); assert.equal(r1['FB Error Count'], 0);
  w.advance(10 * 3600 * 1000);
  assert.equal(w.post({ action: 'getWork' }).items.some((i) => i.purchaseId === pid1), false);

  // A later empty/failed result can never erase the tracking number
  w.post({ action: 'submitFbResult', purchaseId: pid1, result: { ok: true, fbStatusRaw: '', trackingNumber: '' } });
  assert.equal(w.records().find((x) => x['Purchase ID'] === pid1)['Tracking Number'], TN1);

  // Cancellation: status set, checks stop, never transferred, not recreated by reconcile
  w.post({ action: 'submitFbResult', purchaseId: pid3, result: { ok: true, fbStatusRaw: 'Order canceled', canceled: true } });
  assert.equal(w.records().find((x) => x['Purchase ID'] === pid3)['Purchase Status'], 'Canceled');
  assert.equal(w.post({ action: 'getWork', force: true }).items.some((i) => i.purchaseId === pid3), false);
  w.run('reconcile()'); w.run('reconcile()');
  assert.equal(w.records().filter((x) => x['Listing ID'] === ID3).length, 1);
  assert.equal(w.invRows().length, 1);                      // only the pre-existing Old Lens row
});

test('Feature 2: canceled listing can be re-bought: clear then re-enter Y => attempt 2', () => {
  const w = world();
  w.setY(5, 'Y');
  w.post({ action: 'submitFbResult', purchaseId: `${ID3}-1`, result: { ok: true, canceled: true, fbStatusRaw: 'Order canceled' } });
  w.setY(5, '', 'Y');                                       // clear
  w.setY(5, 'Y', '');                                       // re-enter
  const recs = w.records().filter((x) => x['Listing ID'] === ID3);
  assert.equal(recs.length, 2);
  assert.equal(recs[0]['Purchase Status'], 'Canceled'); assert.equal(recs[1]['Purchase ID'], `${ID3}-2`); assert.equal(recs[1]['Purchase Status'], 'Purchased');
});

function shipped(w, row, id, tn, cost) {
  w.main.put(row, COST, cost);
  w.setY(row, 'Y');
  w.post({ action: 'submitFbResult', purchaseId: `${id}-1`, result: { ok: true, fbStatusRaw: 'Shipped', trackingNumber: tn, carrier: 'USPS' } });
}

test('USPS work list: only trackable USPS items, throttled, never after delivery', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.setY(5, 'Y');                                            // no tracking yet => not listed
  assert.equal(JSON.stringify(w.post({ action: 'getUspsWork' }).items), JSON.stringify([{ purchaseId: P1, trackingNumber: TN1 }]));
  w.usps(P1, pg('Shipping Label Created, USPS Awaiting Item'));
  assert.equal(w.post({ action: 'getUspsWork' }).items.length, 0);               // just checked
  assert.equal(w.post({ action: 'getUspsWork', force: true }).items.length, 1);   // force ignores throttle
  w.advance(3 * 3600 * 1000);
  assert.equal(w.post({ action: 'getUspsWork' }).items.length, 1);
});

test('Features 3+4: label-only is NOT transferred; acceptance transfers once; later checks update the same row', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);

  // 1) Label created / awaiting item => no eBay row
  w.usps(P1, pg('Shipping Label Created, USPS Awaiting Item'));
  let r = w.records()[0];
  assert.equal(r['USPS Stage'], 'Awaiting Item'); assert.equal(r['Purchase Status'], 'Tracking Available');
  assert.equal(w.invRows().length, 1);

  // 2) USPS accepted => exactly one new inventory row, linked, real cost (not ask price)
  w.usps(P1, pg('USPS in possession of item', { expectedDelivery: 'Saturday, October 24, 2026 by 8:00pm' }));
  r = w.records()[0];
  assert.equal(r['Purchase Status'], 'Shipped'); assert.equal(r['Transferred to eBay?'], 'Y'); assert.equal(r['Estimated Delivery'], '2026-10-24');
  let inv = w.invRows();
  assert.equal(inv.length, 2);
  const row = inv[1];
  assert.equal(row['Purchase ID'], P1); assert.equal(row['Item Key'], P1 + '#1'); assert.equal(row['Listing Item'], '1 of 1');
  assert.equal(row['Product'], 'Canon R6 Body'); assert.equal(row['Item Cost'], 1650); assert.equal(row['Estimated Resale'], 2200);
  assert.equal(row['Status'], 'In Transit');
  assert.equal(row['Tracking Number'], undefined); assert.equal(row['USPS Status'], undefined); assert.equal(row['Estimated Delivery'], undefined);   // removed columns
  assert.equal(inv[0]['Product'], 'Old Lens'); assert.equal(inv[0]['Status'], 'Sold'); assert.equal(inv[0]['eBay Sold Price'], 250);

  // 3) Repeated checks / reconciles never duplicate
  w.usps(P1, pg('USPS in possession of item')); w.run('reconcile()'); w.run('reconcile()'); w.usps(P1, pg('USPS in possession of item'));
  assert.equal(w.invRows().length, 2);

  // 4) Page failed to load / USPS bot check: nothing valid is overwritten
  w.usps(P1, { ok: false, error: 'PAGE_LOAD_TIMEOUT' });
  r = w.records()[0];
  assert.equal(r['USPS Stage'], 'Accepted'); assert.equal(r['Estimated Delivery'], '2026-10-24'); assert.equal(r['Tracking Number'], TN1);
  assert.match(r['Notes'], /USPS check failed/);
  w.usps(P1, { ok: false, error: 'USPS_BLOCKED' });                      // systemic: ignored entirely
  assert.equal(w.records()[0]['Last USPS Check'] instanceof Date, true);

  // 5) USPS omits the ETA later => previous ETA preserved
  w.usps(P1, pg('Moving Through Network'));
  assert.equal(w.records()[0]['USPS Stage'], 'In Transit'); assert.equal(w.records()[0]['Estimated Delivery'], '2026-10-24');
  assert.equal(w.invRows()[1]['Status'], 'In Transit');

  // 6) Delivered => SAME inventory row updated; USPS checks stop
  w.usps(P1, pg('Delivered, Front Door/Porch'));
  r = w.records()[0];
  assert.equal(r['Purchase Status'], 'Delivered'); assert.ok(r['Delivered At']);
  assert.equal(w.invRows().length, 2); assert.equal(w.invRows()[1]['Status'], 'Delivered');
  assert.equal(w.post({ action: 'getUspsWork', force: true }).items.length, 0);
  assert.equal(w.records().length, 1);                                    // Purchased record kept for history
});

test('USPS page for a different package is rejected, not written', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  const res = w.usps(P1, pg('Delivered', { trackingNumber: TN2 }));
  assert.equal(res.error, 'TRACKING_MISMATCH');
  assert.equal(w.records()[0]['USPS Stage'], '');
});

test('USPS "not found yet" is logged but changes nothing', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, { notFound: true });
  const r = w.records()[0];
  assert.equal(r['USPS Stage'], ''); assert.match(r['Notes'], /not found/);
});

test('Feature 4: rows the user has moved on from (Listed/Sold) are never overwritten by shipping updates', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, pg('Accepted at USPS Origin Facility'));
  const row = 3;
  w.inv.put(row, w.invCol('Status'), 'Listed'); w.inv.put(row, w.invCol('Total Sale Price'), 199);
  w.usps(P1, pg('Delivered, In/At Mailbox'));
  assert.equal(w.inv.rowObj(row)['Status'], 'Listed');
  assert.equal(w.inv.rowObj(row)['Total Sale Price'], 199);
});

test('Feature 4: crash between writing the inventory row and marking the record heals without a duplicate', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.inv.put(3, w.invCol('Product'), 'Canon R6 Body'); w.inv.put(3, w.invCol('Purchase ID'), P1); w.inv.put(3, w.invCol('Item Key'), P1 + '#1');   // simulated crash leftovers
  w.usps(P1, pg('USPS in possession of item'));
  assert.equal(w.invRows().length, 2);
  assert.equal(w.records()[0]['Transferred to eBay?'], 'Y');
  assert.equal(w.records()[0]['Inventory Row'], 3);
});

test('Feature 4: canceled or voided purchases never transfer, even with a tracking number', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, pg('Shipping Label Created, USPS Awaiting Item'));
  w.post({ action: 'submitFbResult', purchaseId: P1, result: { ok: true, canceled: true } });
  w.usps(P1, pg('USPS in possession of item'));                            // ignored: not trackable any more
  w.run('reconcile()');
  assert.equal(w.invRows().length, 1);
  assert.equal(w.records()[0]['Purchase Status'], 'Canceled');
});

test('Un-marking after an eBay transfer is flagged, not voided (inventory is never corrupted)', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, pg('USPS in possession of item'));
  w.setY(2, '', 'Y');
  const r = w.records()[0];
  assert.equal(r['Purchase Status'], 'Shipped'); assert.match(r['Notes'], /Un-marked in scanner AFTER eBay transfer/);
  assert.equal(w.invRows().length, 2);
});

test('Non-USPS carrier: recorded, never in the USPS work list or auto-transferred', () => {
  const w = world();
  w.setY(2, 'Y');
  w.post({ action: 'submitFbResult', purchaseId: P1, result: { ok: true, trackingNumber: '1Z999AA10123456784', carrier: 'UPS' } });
  assert.equal(w.post({ action: 'getUspsWork', force: true }).items.length, 0);
  w.run('reconcile()');
  assert.equal(w.invRows().length, 1);
  assert.match(w.records()[0]['Notes'], /Carrier is UPS/);
});

test('Misconfigured inventory blocks transfers loudly instead of writing somewhere wrong', () => {
  const w = world();
  w.ctx.CONFIG.INVENTORY.anchorHeader = 'No Such Header';
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, pg('USPS in possession of item'));
  assert.equal(w.invRows().length, 1);
  assert.equal(w.records()[0]['Transferred to eBay?'], '');
  const logTexts = []; for (let r = 2; r <= w.logSheet.getLastRow(); r++) logTexts.push(w.logSheet.rowObj(r)['Event'] + ' ' + w.logSheet.rowObj(r)['Detail']);
  assert.ok(logTexts.some((t) => /TRANSFER_BLOCKED/.test(t)));
});

test('No outbound network calls exist anywhere in the Apps Script (no APIs)', () => {
  const w = world();
  shipped(w, 2, ID1, TN1, 1650);
  w.usps(P1, pg('USPS in possession of item')); w.run('reconcile()');
  assert.equal(w.fetchLog.length, 0);
  assert.equal(require('fs').readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8').includes('UrlFetchApp'), false);
});
