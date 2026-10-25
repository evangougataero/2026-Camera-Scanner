'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');
const g = buildContext().ctx;   // Logic.gs functions live on the vm global

const stage = (t) => g.classifyUspsText_(t);

test('USPS classification: the distinctions the spec requires', () => {
  assert.equal(stage('Shipping Label Created, USPS Awaiting Item'), 'Awaiting Item');
  assert.equal(stage('Pre-Shipment'), 'Label Created');
  assert.equal(stage('Label Created'), 'Label Created');
  assert.equal(stage('USPS in possession of item'), 'Accepted');
  assert.equal(stage('Accepted at USPS Origin Facility'), 'Accepted');
  assert.equal(stage('Departed USPS Regional Facility'), 'In Transit');
  assert.equal(stage('In Transit, Arriving Late'), 'In Transit');
  assert.equal(stage('Arrived at USPS Regional Facility'), 'In Transit');
  assert.equal(stage('Out for Delivery'), 'Out for Delivery');
  assert.equal(stage('Delivered, Front Door/Porch'), 'Delivered');
  assert.equal(stage('Delivered, Individual Picked Up at Post Office'), 'Delivered');
  assert.equal(stage('Alert'), 'Exception');
  assert.equal(stage('Delivery Attempted - No Access to Delivery Location'), 'Exception');
  assert.equal(stage('Return to Sender'), 'Exception');
  assert.equal(stage('Something brand new'), 'Unknown');
  assert.equal(stage(''), 'Unknown');
});

test('USPS classification: cautious on ambiguous statuses', () => {
  // Acceptance is only PENDING => must NOT count as accepted
  assert.equal(stage('Shipment Received, Package Acceptance Pending'), 'Awaiting Item');
  // Future-tense delivery text is not delivered
  assert.equal(stage('Your item will be delivered by Friday'), 'Unknown');
});

const NOW = Date.UTC(2026, 9, 19, 18, 0, 0);
const pg = (status, extra) => g.parseUspsPage_(Object.assign({ ok: true, status, history: [status] }, extra), NOW);
const sample = { status: 'USPS in possession of item', history: ['USPS in possession of item', 'Shipping Label Created, USPS Awaiting Item'], expectedDelivery: 'Saturday, October 24, 2026 by 8:00pm' };

test('parseUspsPage_: accepted package with a delivery estimate', () => {
  const r = g.parseUspsPage_(Object.assign({ ok: true }, sample), NOW);
  assert.equal(r.ok, true); assert.equal(r.stage, 'Accepted'); assert.equal(r.accepted, true); assert.equal(r.expectedDelivery, '2026-10-24');
});

test('parseUspsPage_: label-only package is NOT accepted, even though a tracking number exists', () => {
  const r = pg('Shipping Label Created, USPS Awaiting Item');
  assert.equal(r.stage, 'Awaiting Item'); assert.equal(r.accepted, false); assert.equal(r.expectedDelivery, '');
});

test('parseUspsPage_: page noise in history cannot cause a false acceptance when status is pre-shipment', () => {
  const r = pg('Label Created, not yet in system', { history: ['Label Created, not yet in system', 'USPS Regional Facility Hours', 'Arrived at hub promo'] });
  assert.equal(r.accepted, false);
});

test('parseUspsPage_: unknown/exception status falls back to history for acceptance evidence', () => {
  assert.equal(pg('Alert', { history: ['Alert', 'Departed USPS Regional Facility'] }).accepted, true);
  assert.equal(pg('Alert', { history: ['Alert'] }).accepted, false);
});

test('parseUspsPage_: failures and not-found never look like data', () => {
  assert.equal(g.parseUspsPage_(null, NOW).ok, false);
  assert.equal(g.parseUspsPage_({ ok: false, error: 'USPS_BLOCKED' }, NOW).ok, false);
  const nf = g.parseUspsPage_({ ok: true, notFound: true }, NOW);
  assert.equal(nf.ok, false); assert.equal(nf.notFound, true);
  assert.equal(g.parseUspsPage_({ ok: true, status: '', history: [] }, NOW).ok, false);   // nothing parsed => failure, not data
});

test('classification: customer pickup at a post office is DELIVERED; USPS picking up from sender is not', () => {
  assert.equal(stage('Your item was picked up at the post office at 10:50 am on October 12, 2026 in LOS ANGELES, CA 90049.'), 'Delivered');
  assert.equal(stage('Delivered, Individual Picked Up at Post Office'), 'Delivered');
  assert.equal(stage('Picked Up at USPS Facility'), 'Accepted');
  assert.equal(stage('USPS picked up item'), 'Accepted');
});

test('parseUspsPage_: sentence-only status is classified from the summary', () => {
  const r = g.parseUspsPage_({ ok: true, status: 'Your item was picked up at the post office at 10:50 am on October 12, 2026.', history: [] }, NOW);
  assert.equal(r.stage, 'Delivered'); assert.equal(r.accepted, true);
});

test('classification: new usps.com wording "Moving Through Network" is in transit', () => {
  assert.equal(stage('Moving Through Network'), 'In Transit');
});

test('inferDate_: never guesses', () => {
  assert.equal(g.inferDate_('Saturday, October 24, 2026 by 8:00pm', NOW), '2026-10-24');
  assert.equal(g.inferDate_('MONDAY 26 October 2026', NOW), '2026-10-26');
  assert.equal(g.inferDate_('Saturday, October 24 by 8:00pm', NOW), '2026-10-24');      // weekday verifies the year
  assert.equal(g.inferDate_('Sunday, October 24', NOW), '');                              // weekday contradicts every year => blank
  assert.equal(g.inferDate_('October 24', NOW), '');                                      // no year, no weekday => blank
  assert.equal(g.inferDate_('Feb 30, 2026', NOW), '');
  assert.equal(g.inferDate_('', NOW), '');
  assert.equal(g.inferDate_('soon', NOW), '');
});

test('normalizeDate_: refuses to invent dates', () => {
  assert.equal(g.normalizeDate_('2026-10-23T00:00:00Z'), '2026-10-23');
  assert.equal(g.normalizeDate_('October 23, 2026'), '2026-10-23');
  assert.equal(g.normalizeDate_('October 23'), '');
  assert.equal(g.normalizeDate_(''), '');
  assert.equal(g.normalizeDate_('soon'), '');
});

const base = (o) => Object.assign({ 'Purchase ID': '1-1', 'Listing ID': '1', 'Purchase Status': 'Tracking Available', 'Tracking Number': '9400111899223033005282', Carrier: 'USPS', Notes: '' }, o || {});

test('applyUspsResult_: acceptance sets Shipped + eligibility; label-created does not', () => {
  const a = g.applyUspsResult_(base(), g.parseUspsPage_(Object.assign({ ok: true }, sample), NOW), '2026-10-19 11:00');
  assert.equal(a['Purchase Status'], 'Shipped'); assert.ok(a['USPS Accepted At']); assert.equal(a['Estimated Delivery'], '2026-10-24');
  const b = g.applyUspsResult_(base(), pg('Shipping Label Created, USPS Awaiting Item'), 'ts');
  assert.equal(b['Purchase Status'], undefined); assert.equal(b['USPS Accepted At'], undefined);
  assert.equal(g.isTransferEligible_(Object.assign(base(), b)), false);
});

test('applyUspsResult_: failure never overwrites good data; ETA preserved when USPS omits it', () => {
  const rec = base({ 'USPS Stage': 'In Transit', 'USPS Status (raw)': 'Departed', 'USPS Accepted At': 'x', 'Estimated Delivery': '2026-10-25', 'Purchase Status': 'Shipped' });
  const f = g.applyUspsResult_(rec, { ok: false, error: 'PAGE_LOAD_TIMEOUT' }, 't');
  assert.deepEqual(Object.keys(f).sort(), ['Last USPS Check', 'Notes']);
  const noEta = g.applyUspsResult_(rec, pg('Arrived at Hub'), 't');
  assert.equal(noEta['Estimated Delivery'], undefined);       // untouched => preserved
});

test('applyUspsResult_: regression to pre-shipment after acceptance is ignored and flagged', () => {
  const rec = base({ 'USPS Stage': 'In Transit', 'USPS Status (raw)': 'Departed', 'USPS Accepted At': 'x', 'Purchase Status': 'Shipped' });
  const p = g.applyUspsResult_(rec, pg('Shipping Label Created, USPS Awaiting Item'), 't');
  assert.equal(p['USPS Stage'], undefined); assert.equal(p['USPS Status (raw)'], undefined);
  assert.match(p['Notes'], /went backwards/);
  assert.equal(p['Purchase Status'], undefined);             // stays Shipped
});

test('applyUspsResult_: delivered is terminal for polling', () => {
  const p = g.applyUspsResult_(base({ 'USPS Accepted At': 'x', 'Purchase Status': 'Shipped' }), pg('Delivered, Front Door/Porch'), 't');
  assert.equal(p['USPS Stage'], 'Delivered'); assert.equal(p['Purchase Status'], 'Delivered');
  assert.equal(g.isUspsCheckDue_(Object.assign(base({ 'USPS Accepted At': 'x' }), p)), false);
});

test('applyFbResult_: never blanks data, ignores empty tracking, keeps original on mismatch', () => {
  const rec = base({ 'Purchase Status': 'Purchased', 'Tracking Number': '', 'FB Status (raw)': 'Order placed' });
  const none = g.applyFbResult_(rec, { ok: true, fbStatusRaw: '', trackingNumber: '' }, 't');
  assert.equal(none['FB Status (raw)'], undefined); assert.equal(none['Tracking Number'], undefined);
  const withT = g.applyFbResult_(rec, { ok: true, fbStatusRaw: 'Shipped', trackingNumber: '9400111899223033005282', carrier: 'USPS' }, 't');
  assert.equal(withT['Purchase Status'], 'Tracking Available'); assert.equal(withT['Carrier'], 'USPS');
  const changed = g.applyFbResult_(base({ 'Purchase Status': 'Tracking Available' }), { ok: true, trackingNumber: '9205590164917312751089', carrier: 'USPS' }, 't');
  assert.equal(changed['Tracking Number'], undefined); assert.match(changed['Notes'], /DIFFERENT/);
});

test('applyFbResult_: cancel after eBay transfer is flagged, not applied', () => {
  const p = g.applyFbResult_(base({ 'Transferred to eBay?': 'Y', 'Purchase Status': 'Shipped' }), { ok: true, canceled: true }, 't');
  assert.equal(p['Purchase Status'], undefined); assert.match(p['Notes'], /review inventory/);
});

test('isUspsWorkDue_: respects interval, delivered, non-USPS carriers', () => {
  const now = NOW;
  const rec = (o) => Object.assign(base({ 'Purchase Status': 'Tracking Available' }), o);
  assert.equal(g.isUspsWorkDue_(rec(), now, 150), true);
  assert.equal(g.isUspsWorkDue_(rec({ 'Last USPS Check': new Date(now - 60 * 60000) }), now, 150), false);
  assert.equal(g.isUspsWorkDue_(rec({ 'Last USPS Check': new Date(now - 60 * 60000) }), now, 0), true);
  assert.equal(g.isUspsWorkDue_(rec({ Carrier: 'UPS' }), now, 0), false);
  assert.equal(g.isUspsWorkDue_(rec({ 'USPS Stage': 'Delivered' }), now, 0), false);
  assert.equal(g.isUspsWorkDue_(rec({ 'Tracking Number': '' }), now, 0), false);
});

test('isFbCheckDue_: honours interval, backoff, tracking and terminal statuses', () => {
  const cfg = { FB_RECHECK_MINUTES: 150, FB_ERROR_BACKOFF_AFTER: 3, FB_ERROR_BACKOFF_MINUTES: 720 };
  const now = Date.UTC(2026, 9, 19, 18, 0, 0);
  const rec = (o) => Object.assign({ 'Purchase Status': 'Purchased', 'Tracking Number': '', 'Last FB Check': '', 'FB Error Count': 0 }, o);
  assert.equal(g.isFbCheckDue_(rec(), now, cfg), true);
  assert.equal(g.isFbCheckDue_(rec({ 'Last FB Check': new Date(now - 60 * 60000) }), now, cfg), false);
  assert.equal(g.isFbCheckDue_(rec({ 'Last FB Check': new Date(now - 170 * 60000) }), now, cfg), true);
  assert.equal(g.isFbCheckDue_(rec({ 'Last FB Check': new Date(now - 170 * 60000), 'FB Error Count': 3 }), now, cfg), false);
  assert.equal(g.isFbCheckDue_(rec({ 'Tracking Number': '940' }), now, cfg), false);
  assert.equal(g.isFbCheckDue_(rec({ 'Purchase Status': 'Canceled' }), now, cfg), false);
});

const L = (id, y, row) => ({ listingId: id, url: 'u', row: row || 2, rowEnd: row || 2, names: ['x'], ask: 1, resale: 2, hasResale: true, purchased: y, cost: '' });
const R = (id, st, n) => ({ 'Purchase ID': id + '-' + (n || 1), 'Listing ID': id, 'Purchase Status': st });

test('planSync_: creates once, never twice', () => {
  assert.equal(g.planSync_([L('1', true)], [], {}).creates.length, 1);
  assert.equal(g.planSync_([L('1', true)], [R('1', 'Purchased')], {}).creates.length, 0);
  assert.equal(g.planSync_([L('1', true), L('1', true, 9)], [], {}).creates.length, 1);   // same listing twice in scanner
});

test('planSync_: mistaken Y is voided; deleted scanner row is NOT voided', () => {
  assert.equal(g.planSync_([L('1', false)], [R('1', 'Purchased')], {}).voids.length, 1);
  assert.equal(g.planSync_([], [R('1', 'Purchased')], {}).voids.length, 0);
  assert.equal(g.planSync_([L('1', false)], [R('1', 'Canceled')], {}).voids.length, 0);
});

test('planSync_: canceled listing is only re-purchased on a fresh edit, with a new attempt number', () => {
  assert.equal(g.planSync_([L('1', true)], [R('1', 'Canceled')], {}).creates.length, 0);
  const p = g.planSync_([L('1', true)], [R('1', 'Canceled')], { '1': true });
  assert.equal(p.creates.length, 1); assert.equal(p.creates[0].attempt, 2);
});

test('groupScannerListings_: merged multi-item listings are one purchase; resale is summed', () => {
  const cols = { name: 0, url: 1, ask: 3, resale: 4, purchased: 10, cost: -1 };
  const row = (a, b, d, e, k) => { const r = new Array(17).fill(''); r[0] = a; r[1] = b; r[3] = d; r[4] = e; r[10] = k; return r; };
  const vals = [
    row('Sigma 35', 'https://www.facebook.com/marketplace/item/2222222222222222/', 800, 400, 'Y'),
    row('Sigma 50', '', '', 450, ''),
    row('', '', '', '', ''),
    row('Canon R6', 'https://www.facebook.com/marketplace/item/1111111111111111/?ref=x', 1800, 2200, '')
  ];
  const out = g.groupScannerListings_(vals, 2, cols);
  assert.equal(out.length, 2);
  assert.equal(out[0].listingId, '2222222222222222'); assert.equal(out[0].resale, 850); assert.equal(out[0].ask, 800);
  assert.equal(out[0].purchased, true); assert.equal(JSON.stringify(out[0].names), JSON.stringify(['Sigma 35', 'Sigma 50']));
  assert.equal(out[1].purchased, false);
});

test('buildPurchaseRecord_: ask price is never used as cost', () => {
  const r = g.buildPurchaseRecord_({ listingId: '9', url: 'u', row: 5, names: ['a'], ask: 500, resale: 700, hasResale: true }, 1, 'ts', '');
  assert.equal(r['Ask Price (FB)'], 500); assert.equal(r['Purchase Cost'], ''); assert.match(r['Notes'], /NOT used as cost/);
});

test('allocateCost_: even split in whole cents that ALWAYS sums to the listing cost; blank (never $0) when cost is unknown', () => {
  assert.equal(JSON.stringify(g.allocateCost_(120, 3)), JSON.stringify([40, 40, 40]));
  assert.equal(JSON.stringify(g.allocateCost_(100, 3)), JSON.stringify([33.34, 33.33, 33.33]));
  assert.equal(JSON.stringify(g.allocateCost_(0.05, 3)), JSON.stringify([0.02, 0.02, 0.01]));
  assert.equal(JSON.stringify(g.allocateCost_(99.99, 1)), JSON.stringify([99.99]));
  assert.equal(JSON.stringify(g.allocateCost_('$1,234.56', 4)), JSON.stringify([308.64, 308.64, 308.64, 308.64]));
  assert.equal(JSON.stringify(g.allocateCost_('', 3)), JSON.stringify(['', '', '']));
  assert.equal(JSON.stringify(g.allocateCost_('abc', 2)), JSON.stringify(['', '']));
  assert.equal(JSON.stringify(g.allocateCost_(120, 0)), JSON.stringify([]));
  for (let n = 1; n <= 9; n++) for (const t of [0.01, 1, 19.99, 120, 333.33, 1650.07, 99999.99]) {
    const sum = g.allocateCost_(t, n).reduce((a, x) => a + Math.round(x * 100), 0);
    assert.equal(sum, Math.round(t * 100), `n=${n} total=${t}`);
  }
});

test('buildInventoryItems_: one item per scanner PRODUCT ROW (units are not counted), with each row\'s own resale', () => {
  const cols = { name: 0, url: 1, ask: 3, resale: 4, purchased: 10, cost: -1 };
  const row = (a, b, d, e, k) => { const r = new Array(17).fill(''); r[0] = a; r[1] = b; r[3] = d; r[4] = e; r[10] = k; return r; };
  const vals = [
    row('Monitors (x2)', 'https://www.facebook.com/marketplace/item/5555555555555555/', 300, 250, 'Y'),
    row('Keyboard', '', '', 40, ''), row('Mice (x3)', '', '', 30, '')
  ];
  const listing = g.groupScannerListings_(vals, 2, cols)[0];
  const items = g.buildInventoryItems_(listing, { Product: 'x' });
  assert.equal(items.length, 3);
  assert.equal(JSON.stringify(items.map((i) => [i.name, i.resale])), JSON.stringify([['Monitors (x2)', 250], ['Keyboard', 40], ['Mice (x3)', 30]]));
  assert.equal(listing.ask, 300);                                                          // asking price is NOT used for items
  // fallbacks: listing missing => a single row from the purchase record
  assert.equal(JSON.stringify(g.buildInventoryItems_(null, { Product: 'Lot A', 'Estimated Resale': 99 })), JSON.stringify([{ name: 'Lot A', resale: 99 }]));
  // an item without a resale estimate keeps a blank estimate
  const blank = g.groupScannerListings_([row('Cable', 'https://www.facebook.com/marketplace/item/6666666666666666/', 5, '', '')], 2, cols)[0];
  assert.equal(g.buildInventoryItems_(blank, {})[0].resale, '');
});

test('itemKey_ / inventorySig_ / colToLetter_', () => {
  assert.equal(g.itemKey_('111-1', 2), '111-1#2');
  assert.equal(g.inventorySig_({ 'USPS Stage': 'In Transit', 'Purchase Cost': 120 }), 'v2|In Transit|120');
  assert.equal(g.inventorySig_({ 'USPS Stage': 'Accepted', 'Purchase Cost': '' }), 'v2|Accepted|');
  assert.equal(g.inventorySig_({ 'FB Status (raw)': 'Your order was delivered.', 'Purchase Cost': 5 }), 'v2|Delivered|5');
  assert.equal(JSON.stringify(g.inventorySigParts_('v2|Delivered|5')), JSON.stringify({ stage: 'Delivered', cost: '5' }));
  assert.equal(g.inventorySigParts_('In Transit|raw|2026-10-24|940'), null);               // old-format signature
  assert.equal([1, 26, 27, 52, 53].map(g.colToLetter_).join(), 'A,Z,AA,AZ,BA');
});

test('transfer eligibility: USPS acceptance OR Facebook-confirmed delivery; never a bare tracking number/label; never canceled', () => {
  const r = (o) => Object.assign({ 'Purchase ID': '1-1', 'Purchase Status': 'Tracking Available', 'Tracking Number': '940' }, o);
  assert.equal(g.isTransferEligible_(r({})), false);
  assert.equal(g.isTransferEligible_(r({ 'USPS Stage': 'Awaiting Item' })), false);
  assert.equal(g.isTransferEligible_(r({ 'USPS Accepted At': 'x' })), true);
  assert.equal(g.isTransferEligible_(r({ 'FB Status (raw)': 'Delivered | Your order was delivered.' })), true);
  assert.equal(g.isTransferEligible_(r({ 'USPS Accepted At': 'x', 'Purchase Status': 'Canceled' })), false);
  assert.equal(g.isTransferEligible_(r({ 'USPS Accepted At': 'x', 'Transferred to eBay?': 'Y' })), false);
});
