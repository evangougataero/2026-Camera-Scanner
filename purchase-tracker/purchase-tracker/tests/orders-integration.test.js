'use strict';
/**
 * End-to-end (fake Sheets + REAL Code.gs/Logic.gs + REAL parse-orders.js): getWork items carry the matching fields,
 * orders-page results go through the EXISTING submitFbResult endpoint and produce the right Purchased-tab changes
 * (Delivered -> inventory transfer, Canceled with explicit evidence, Shipped -> tracking + estimated delivery), the
 * read-only previewFbResults writes nothing, and a purchase that is not on the page stays untouched and monitored.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');
require('../extension/parse-order.js');
const O = require('../extension/parse-orders.js');

const SCANNER_ID = 'scanner-ss', INV_ID = 'inventory-ss';
const CANON = '1288988733112094', NIKON = '5555555555555555', SONY = '7777777777777777', FUJI = '8888888888888888';
const SCAN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy',
  'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'O', 'P', 'Relisted', 'Purchase Price'];
const K = 11, COST = 18;

function world() {
  const w = buildContext();
  w.clock.now = Date.UTC(2026, 10, 3, 20, 43);
  const scan = w.addSpreadsheet(SCANNER_ID);
  const main = scan.insertSheet('Main');
  SCAN_HEADERS.forEach((h, i) => main.put(1, i + 1, h));
  const put = (r, o) => Object.keys(o).forEach((c) => main.put(r, +c, o[c]));
  put(2, { 1: 'Canon EOS 760D', 2: `https://www.facebook.com/marketplace/item/${CANON}/`, 4: 225, 5: 330 });
  put(3, { 1: 'Nikon D7100 DSLR', 2: `https://www.facebook.com/marketplace/item/${NIKON}/`, 4: 300, 5: 420 });
  put(4, { 1: 'Sony 85mm f/1.8', 2: `https://www.facebook.com/marketplace/item/${SONY}/`, 4: 250, 5: 400 });
  put(5, { 1: 'Fujifilm X100V', 2: `https://www.facebook.com/marketplace/item/${FUJI}/`, 4: 900, 5: 1300 });
  const inv = w.addSpreadsheet(INV_ID);
  inv.insertSheet('Inventory');
  ['Product', 'Status'].forEach((h, i) => inv.getSheetByName('Inventory').put(1, i + 1, h));
  w.ctx.CONFIG.SCANNER.spreadsheetId = SCANNER_ID;
  w.ctx.CONFIG.INVENTORY.spreadsheetId = INV_ID;
  w.ctx.CONFIG.INVENTORY.tab = 'Inventory';
  w.run('setup()');
  w.run('setupInventoryV2()');
  w.run('setupPurchaseDashboard()');
  const pur = scan.getSheetByName('Purchased');
  Object.assign(w, {
    pur,
    buy: (row, cost) => { main.put(row, COST, cost); main.put(row, K, 'Y'); w.ctx.__e = { range: main.getRange(row, K), value: 'Y', oldValue: '' }; w.run('onScannerEdit(__e)'); },
    post: (body) => JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify(Object.assign({ token: w.props.API_TOKEN }, body)) } }).text),
    rec: (pid) => { for (let r = 2; r <= pur.getLastRow(); r++) { const o = pur.rowObj(r); if (String(o['Purchase ID']) === pid) return o; } return null; }
  });
  return w;
}

const order = (o) => O.mergeOrder(o.card, o.dialog);
const ORDERS = () => [
  order({ card: { key: 'canon', status: 'delivered', statusRaw: 'Delivered', title: 'Canon EOS 760D (Rebel T6s) with the Lens', orderDate: '2026-11-03', listingId: CANON },
          dialog: O.parseOrderDialogText(['Order status', 'Canon EOS 760D (Rebel T6s) with the Lens', '$225.00 · Quantity: 1', 'Delivered', 'Your order was delivered.',
            'USPS TRACKING NUMBER: 9334610579700004096766', 'Order Confirmed', 'Nov 3 at 12:43 PM', 'Delivered', 'Nov 9 at 5:34 PM', 'Seller information', 'Olga Serdinskaya'].join('\n'), [], { orderDate: '2026-11-03' }) }),
  order({ card: { key: 'nikon', status: 'canceled', statusRaw: 'Canceled', title: 'Nikon D7100 with 18-140mm', orderDate: '2026-11-04' },
          dialog: O.parseOrderDialogText(['Order status', 'Nikon D7100 with 18-140mm', '$290.40 · Quantity: 1', 'Canceled', 'Order Confirmed', 'Nov 4 at 10:02 AM',
            'Seller information', 'Nathan Stickler'].join('\n'), [], { orderDate: '2026-11-04' }) }),
  order({ card: { key: 'sony', status: 'shipped', statusRaw: 'Shipped', title: 'Sony 85mm f/1.8 FE Lens', orderDate: '2026-11-03' },
          dialog: O.parseOrderDialogText(['Order status', 'Sony 85mm f/1.8 FE Lens', '$250.00 · Quantity: 1', 'Shipped', 'Estimated Arrival: Nov 12',
            'USPS TRACKING NUMBER: 9400111899223033005282', 'Order Confirmed', 'Nov 3 at 1:10 PM', 'Shipped', 'Nov 4 at 9:00 AM', 'Out for delivery', 'Delivered',
            'Seller information', 'Kim Vo'].join('\n'), [], { orderDate: '2026-11-03' }) })
];

test('getWork items carry the fields the orders-page matcher needs (seller, cost, ask, purchase day, titles, tracking)', () => {
  const w = world();
  w.buy(2, 225);
  const it = w.post({ action: 'getWork' }).items[0];
  assert.equal(it.purchaseId, `${CANON}-1`); assert.equal(it.listingId, CANON); assert.equal(it.mode, 'order');
  assert.equal(it.cost, 225); assert.equal(it.ask, 225); assert.equal(it.purchasedAt, '2026-11-03');
  assert.equal(it.product, 'Canon EOS 760D'); assert.equal(it.seller, ''); assert.equal(it.trackingNumber, '');
});

test('orders page -> submitFbResult: Delivered transfers to inventory, Canceled is explicit evidence, Shipped stores tracking + ETA; not-found is untouched', () => {
  const w = world();
  w.buy(2, 225); w.buy(3, 290.40); w.buy(4, 250); w.buy(5, 870);
  const work = w.post({ action: 'getWork' }).items;
  assert.equal(work.length, 4);
  const plan = O.planOrderResults(ORDERS(), work);
  assert.deepEqual(plan.submissions.map((s) => s.purchaseId + ':' + s.via.split(' ')[0]).sort(),
    [`${CANON}-1:listing`, `${NIKON}-1:title+date`, `${SONY}-1:title+date`]);
  assert.deepEqual(plan.notFound, [`${FUJI}-1`]);

  // Read-only preview first: lists the changes, writes nothing.
  const before = JSON.stringify(w.rec(`${NIKON}-1`));
  const pv = w.post({ action: 'previewFbResults', results: plan.submissions.map((s) => ({ purchaseId: s.purchaseId, result: s.result })) });
  assert.equal(pv.ok, true);
  assert.equal(pv.updates.find((u) => u.purchaseId === `${NIKON}-1`).changes['Purchase Status'], 'Canceled');
  assert.equal(pv.updates.find((u) => u.purchaseId === `${CANON}-1`).changes['Purchase Status'], 'Delivered');
  assert.equal(JSON.stringify(w.rec(`${NIKON}-1`)), before);

  plan.submissions.forEach((s) => assert.equal(w.post({ action: 'submitFbResult', purchaseId: s.purchaseId, result: s.result }).ok, true));
  const canon = w.rec(`${CANON}-1`), nikon = w.rec(`${NIKON}-1`), sony = w.rec(`${SONY}-1`), fuji = w.rec(`${FUJI}-1`);
  assert.equal(canon['Purchase Status'], 'Delivered'); assert.equal(canon['Transferred to eBay?'], 'Y');
  assert.equal(canon['Seller'], 'Olga Serdinskaya'); assert.equal(canon['FB Status (raw)'], 'Delivered | Order Confirmed: Nov 3 at 12:43 PM | Delivered: Nov 9 at 5:34 PM');
  assert.equal(nikon['Purchase Status'], 'Canceled'); assert.equal(nikon['Cancel Signal'], 'Canceled — Facebook orders page (Canceled)');
  assert.equal(nikon['Seller'], 'Nathan Stickler'); assert.equal(nikon['FB Order Total (raw)'], '$290.40');
  assert.equal(sony['Purchase Status'], 'Tracking Available');              // Shipped on Facebook; "Shipped" once USPS confirms acceptance
  assert.equal(String(sony['Tracking Number']), '9400111899223033005282'); assert.equal(sony['Carrier'], 'USPS');
  assert.equal(sony['Estimated Delivery'], '2026-11-12');
  assert.equal(fuji['Purchase Status'], 'Purchased'); assert.equal(fuji['Cancel Signal'], '');   // NOT FOUND: never canceled, nothing written
  assert.equal(fuji['Last FB Check'], '');
  assert.ok(w.post({ action: 'getWork' }).items.some((i) => i.purchaseId === `${FUJI}-1`));   // still monitored
  const dash = w.run('dashRow_')(w.rec(`${NIKON}-1`), w.clock.now, {});
  assert.equal(dash.attention, 'Canceled (Facebook orders page) — no action needed');
});

test('an orders-page Estimated Arrival never overwrites a USPS expected delivery; old results without the new fields still work', () => {
  const w = world();
  w.buy(4, 250);
  const pid = `${SONY}-1`;
  w.post({ action: 'submitFbResult', purchaseId: pid, result: { ok: true, fbStatusRaw: 'Shipped', trackingNumber: '9400111899223033005282', carrier: 'USPS' } });
  assert.equal(w.rec(pid)['Estimated Delivery'], '');                                          // old-style result: no ETA field
  w.post({ action: 'submitUspsResult', purchaseId: pid, result: { ok: true, trackingNumber: '9400111899223033005282', status: 'In Transit to Next Facility', expectedDelivery: 'Tuesday, November 10, 2026' } });
  assert.equal(w.rec(pid)['Estimated Delivery'], '2026-11-10');
  w.post({ action: 'submitFbResult', purchaseId: pid, result: { ok: true, source: 'orders-page', fbStatusRaw: 'Shipped', estimatedDelivery: '2026-11-12', trackingNumber: '9400111899223033005282', carrier: 'USPS' } });
  assert.equal(w.rec(pid)['Estimated Delivery'], '2026-11-10');
});
