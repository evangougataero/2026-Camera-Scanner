'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');
const g = buildContext().ctx;

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 28, 18, 0, 0);
const CFG = { overdueDays: 7 };
const ago = (d, extraMs) => new Date(NOW - d * DAY - (extraMs || 0));
const rec = (o) => Object.assign({
  'Purchase ID': '1-1', 'Listing ID': '1', 'Purchase Status': 'Purchased', 'Purchased At': ago(2), 'Product': 'Canon R6 Body',
  'Purchase Cost': 1650, 'Estimated Resale': 2200, 'Tracking Number': '', Notes: '', _row: 2
}, o);
const dr = (o) => g.dashRow_(rec(o), NOW, CFG);
const label = { 'Purchase Status': 'Tracking Available', 'Tracking Number': '9400111899223033005282', Carrier: 'USPS', 'USPS Stage': 'Awaiting Item' };

// ---------------------------------------------------------------- overdue (unchanged rules)
test('Example A: label created, USPS still "Awaiting Item" at 7 days => OVERDUE — Contact Seller', () => {
  const r = dr(Object.assign({ 'Purchased At': ago(7), 'USPS Status (raw)': 'Shipping Label Created, USPS Awaiting Item' }, label));
  assert.equal(r.orderStatus, 'Overdue'); assert.match(r.attention, /^OVERDUE — Contact Seller · 7 days/);
  assert.equal(r.days, 7); assert.equal(r.needsAttention, true); assert.equal(r.group, 1);
});

test('exactly 7 FULL days: 6d23h is not overdue, 7d0h is', () => {
  assert.equal(dr(Object.assign({ 'Purchased At': ago(6, 23 * 3600000) }, label)).orderStatus, 'Label Created');
  assert.equal(dr(Object.assign({ 'Purchased At': ago(7) }, label)).orderStatus, 'Overdue');
});

test('Example B: USPS accepted on day 4 => never overdue, even 12 days after purchase', () => {
  const r = dr({ 'Purchased At': ago(12), 'Purchase Status': 'Shipped', 'Tracking Number': '940', Carrier: 'USPS', 'USPS Stage': 'In Transit', 'USPS Accepted At': '2026-10-05 10:00' });
  assert.equal(r.orderStatus, 'Shipped / In Transit'); assert.equal(r.attention, 'No Action Needed'); assert.equal(r.needsAttention, false);
});

test('Example C: no tracking at 8 days => OVERDUE with an honest "no tracking" explanation', () => {
  const r = dr({ 'Purchased At': ago(8), 'FB Status (raw)': 'Order Confirmed' });
  assert.equal(r.orderStatus, 'Overdue'); assert.match(r.attention, /no tracking number yet/); assert.doesNotMatch(r.attention, /not shipped/i);
});

test('timer is anchored to the ORIGINAL purchase time; a label or tracking never counts as shipped', () => {
  const r = dr(Object.assign({ 'Purchased At': ago(8), 'USPS Stage': 'Label Created', 'Last FB Check': ago(0, 3600000), 'Last USPS Check': ago(0, 600000) }, label));
  assert.equal(r.orderStatus, 'Overdue'); assert.equal(r.days, 8);
  assert.equal(dr(Object.assign({ 'Purchased At': ago(3) }, label, { 'USPS Stage': 'Label Created' })).orderStatus, 'Label Created');
});

test('overdue clears once carrier possession is verified', () => {
  const base = Object.assign({ 'Purchased At': ago(9) }, label);
  assert.equal(dr(base).orderStatus, 'Overdue');
  assert.equal(dr(Object.assign({}, base, { 'USPS Stage': 'Accepted', 'USPS Accepted At': 'x', 'Purchase Status': 'Shipped' })).orderStatus, 'Shipped / In Transit');
});

test('delivered and canceled orders are never flagged overdue', () => {
  assert.equal(dr({ 'Purchased At': ago(30), 'Purchase Status': 'Delivered', 'USPS Stage': 'Delivered', 'USPS Accepted At': 'x' }).orderStatus, 'Delivered');
  const c = dr({ 'Purchased At': ago(30), 'Purchase Status': 'Canceled' });
  assert.equal(c.orderStatus, 'Canceled'); assert.equal(c.needsAttention, false);
});

// ---------------------------------------------------------------- statuses
test('base statuses', () => {
  assert.equal(dr({}).orderStatus, 'Purchased');
  assert.equal(dr({ 'FB Status (raw)': 'Order Confirmed' }).orderStatus, 'Awaiting Shipment');
  assert.equal(dr({ 'Tracking Number': '940', Carrier: 'USPS', 'Purchase Status': 'Tracking Available' }).orderStatus, 'Label Created');
  assert.equal(dr({ 'USPS Accepted At': 'x', 'USPS Stage': 'Accepted', 'Purchase Status': 'Shipped' }).orderStatus, 'Shipped / In Transit');
  assert.equal(dr({ 'USPS Accepted At': 'x', 'USPS Stage': 'Out for Delivery', 'Purchase Status': 'Shipped' }).orderStatus, 'Out for Delivery');
  assert.equal(dr({ 'USPS Accepted At': 'x', 'USPS Stage': 'Delivered', 'Purchase Status': 'Delivered' }).orderStatus, 'Delivered');
  assert.equal(g.dashRow_(rec({ 'Purchase Status': 'Voided' }), NOW, CFG), null);
});

test('there is no Possible Cancellation or Refunded state any more', () => {
  const all = Object.keys(g.DASH_STATUS).map((k) => g.DASH_STATUS[k]);
  assert.ok(!all.includes('Possible Cancellation') && !all.includes('Refunded'));
  assert.equal(g.DASH_RULES.filter((r) => /possible|refund/i.test(r.name)).length, 0);
  // leftover columns/values from the previous version are ignored
  assert.equal(dr({ 'Cancel Signal': 'Possible: x', 'Refund Received': 'Y' }).orderStatus, 'Purchased');
  assert.equal(dr({ 'Purchase Status': 'Canceled', 'Refund Received': 'Y' }).orderStatus, 'Canceled');
});

test('Canceled is one status regardless of refund; excluded from active work, data kept', () => {
  const r = dr({ 'Purchase Status': 'Canceled', 'Purchased At': ago(20), 'Tracking Number': '940' });
  assert.equal(r.orderStatus, 'Canceled'); assert.equal(r.attention, 'Canceled — no action needed'); assert.equal(r.bucket, 'none');
  assert.equal(r.cost, 1650); assert.equal(r.tracking, '940');
});

test('non-USPS carrier => Status Unknown + "Check Tracking"', () => {
  const r = dr({ 'Tracking Number': '1Z999AA1', Carrier: 'UPS', 'Purchase Status': 'Tracking Available' });
  assert.equal(r.orderStatus, 'Status Unknown'); assert.match(r.attention, /^Check Tracking — UPS/);
});

// ---------------------------------------------------------------- Facebook delivered
test('Facebook saying "delivered" => Delivered, no USPS verification needed, no warning', () => {
  const r = dr({ 'FB Status (raw)': 'Delivered | Your order was delivered. | Order Confirmed', 'Purchase Status': 'Tracking Available', 'Tracking Number': '940', 'Purchased At': ago(12) });
  assert.equal(r.orderStatus, 'Delivered'); assert.equal(r.attention, 'No Action Needed'); assert.equal(r.needsAttention, false);
  assert.equal(dr({ 'FB Status (raw)': 'Your order was delivered.' }).orderStatus, 'Delivered');
  assert.equal(dr({ 'FB Status (raw)': 'Delivered' }).orderStatus, 'Delivered');
});

test('a "Delivered" timeline step on an in-progress order is NOT a delivery', () => {
  assert.equal(dr({ 'FB Status (raw)': 'Order Confirmed | Shipped | Delivered' }).orderStatus, 'Awaiting Shipment');
  assert.equal(g.fbSaysDelivered_({ 'FB Status (raw)': 'Shipped | Out for delivery | Delivered' }), false);
  assert.equal(g.fbSaysDelivered_({ 'FB Status (raw)': 'Out for delivery' }), false);
});

test('Facebook delivery also sets the stored Purchase Status (monitoring stops) and makes the purchase transfer-eligible', () => {
  const p = g.applyFbResult_(rec({ 'Purchase Status': 'Tracking Available', 'Tracking Number': '940' }), { ok: true, fbStatusRaw: 'Delivered | Your order was delivered.' }, 'ts');
  assert.equal(p['Purchase Status'], 'Delivered');
  const after = rec({ 'Purchase Status': 'Delivered', 'FB Status (raw)': 'Delivered | Your order was delivered.', 'Tracking Number': '940', Carrier: 'USPS' });
  assert.equal(g.isTransferEligible_(after), true);
  assert.equal(g.isUspsCheckDue_(after), false);
  assert.equal(g.isFbCheckDue_(after, NOW, { FB_RECHECK_MINUTES: 150, FB_ERROR_BACKOFF_AFTER: 3, FB_ERROR_BACKOFF_MINUTES: 720 }), false);
});

// ---------------------------------------------------------------- cancellation rule (backend)
const miss = { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true };

test('View Order missing on a HEALTHY page => Canceled (no "possible" step, no earlier-sighting requirement)', () => {
  const p = g.applyFbResult_(rec({}), miss, '2026-10-28 11:00');
  assert.equal(p['Purchase Status'], 'Canceled'); assert.match(p['Notes'], /Canceled: View Order button missing/); assert.equal(p['FB Error Count'], 0);
  assert.equal(g.applyFbResult_(rec({ 'Purchase Status': 'Tracking Available', 'Tracking Number': '940' }), miss, 'ts')['Purchase Status'], 'Canceled');
});

test('NOT canceled when the page did not load properly: timeouts, login wall, CAPTCHA, removed listing, extraction failure', () => {
  [{ ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: false }, { ok: false, error: 'ORDER_DETAILS_NOT_FOUND' },
   { ok: false, error: 'PAGE_LOAD_TIMEOUT' }, { ok: false, error: 'LOGIN_REQUIRED' }, { ok: false, error: 'CHECKPOINT' },
   { ok: false, error: 'LISTING_UNAVAILABLE', pageHealthy: true }, { ok: false, error: 'EXTENSION_ERROR' }, { ok: false, error: 'ORDER_TEXT_NOT_FOUND', pageHealthy: true }
  ].forEach((res) => {
    const p = g.applyFbResult_(rec({}), res, 'ts');
    assert.equal(p['Purchase Status'], undefined, JSON.stringify(res));
    assert.equal(p['FB Error Count'], 1);
  });
});

test('a missing button never cancels an order USPS accepted/delivered or Facebook says was delivered', () => {
  [{ 'USPS Accepted At': 'x' }, { 'USPS Stage': 'Delivered' }, { 'FB Status (raw)': 'Delivered | Your order was delivered.' }, { 'Purchase Status': 'Canceled' }].forEach((o) => {
    assert.equal(g.applyFbResult_(rec(o), miss, 'ts')['Purchase Status'], undefined, JSON.stringify(o));
  });
});

test('explicit "Canceled" text from Facebook still cancels (already in inventory: flagged instead)', () => {
  assert.equal(g.applyFbResult_(rec({}), { ok: true, canceled: true }, 'ts')['Purchase Status'], 'Canceled');
  const p = g.applyFbResult_(rec({ 'Transferred to eBay?': 'Y', 'Purchase Status': 'Shipped' }), { ok: true, canceled: true }, 'ts');
  assert.equal(p['Purchase Status'], undefined); assert.match(p['Notes'], /review inventory/);
});

// ---------------------------------------------------------------- cutoff (scope)
test('purchases before the cutoff are excluded everywhere: dashboard, monitoring, transfer (but never modified)', () => {
  const cutoff = Date.UTC(2026, 9, 25, 7, 0, 0);                                           // 2026-10-25 00:00 PDT
  g.SCOPE_START_MS = cutoff;
  try {
    const mk = (at) => rec({ 'Purchased At': new Date(at), 'USPS Accepted At': 'x', 'Tracking Number': '940', Carrier: 'USPS', 'Purchase Status': 'Tracking Available' });
    const cfg = { FB_RECHECK_MINUTES: 0, FB_TRACKING_RECHECK_MINUTES: 0, FB_ERROR_BACKOFF_AFTER: 3, FB_ERROR_BACKOFF_MINUTES: 0 };
    assert.equal(g.dashRow_(mk(cutoff - 1), NOW, CFG), null); assert.notEqual(g.dashRow_(mk(cutoff), NOW, CFG), null);
    assert.equal(g.isTransferEligible_(mk(cutoff - 1)), false); assert.equal(g.isTransferEligible_(mk(cutoff)), true);
    assert.equal(g.isUspsCheckDue_(mk(cutoff - 1)), false); assert.equal(g.isUspsCheckDue_(mk(cutoff)), true);
    assert.equal(g.isFbCheckDue_(rec({ 'Purchased At': new Date(cutoff - 1) }), NOW, cfg), false);
    assert.equal(g.isFbCheckDue_(rec({ 'Purchased At': new Date(cutoff) }), NOW, cfg), true);
    assert.equal(g.isInScope_(rec({ 'Purchase ID': 'TEST-1', 'Purchased At': new Date(cutoff - DAY) })), true);   // test rows exempt
    assert.equal(g.isInScope_(rec({ 'Purchased At': '' })), true);                           // unreadable date never silently dropped
  } finally { g.SCOPE_START_MS = 0; }
});

// ---------------------------------------------------------------- attention
test('missing cost: flagged, hints the Facebook total, delivered row stays Delivered', () => {
  const r = dr({ 'Purchase Cost': '', 'FB Order Total (raw)': '$462.50', 'Purchase Status': 'Delivered', 'USPS Stage': 'Delivered', 'USPS Accepted At': 'x' });
  assert.equal(r.orderStatus, 'Delivered'); assert.equal(r.attention, 'Enter Purchase Cost (Facebook order total: $462.50)');
  assert.equal(r.profit, ''); assert.equal(r.cost, '');
});

test('priority: overdue > missing cost', () => {
  assert.match(dr({ 'Purchased At': ago(9), 'Purchase Cost': '' }).attention, /^OVERDUE.*\(\+1 more\)$/);
});

test('historical test errors are NOT alerts; a CURRENT failure streak is', () => {
  const old = dr({ 'FB Error Count': 6, 'Last FB Check': ago(30), Notes: 'FB check failed: EXTENSION_ERROR (Frame with ID 0 was removed)' });
  assert.equal(old.attention, 'No Action Needed'); assert.equal(old.needsAttention, false);
  assert.match(dr({ 'FB Error Count': 4, 'Last FB Check': ago(0, 3600000) }).attention, /^Check Order — Facebook checks keep failing/);
});

test('USPS exception after acceptance is a real "Check Tracking" item; routine updates are not', () => {
  assert.match(dr({ 'USPS Accepted At': 'x', 'USPS Stage': 'Exception', 'USPS Status (raw)': 'Delivery Attempted', 'Purchase Status': 'Shipped' }).attention, /^Check Tracking — USPS: Delivery Attempted/);
  assert.equal(dr({ 'USPS Accepted At': 'x', 'USPS Stage': 'In Transit', 'Purchase Status': 'Shipped' }).attention, 'No Action Needed');
});

test('estimated profit = resale − cost, blank (not 0) when either is unknown', () => {
  assert.equal(dr({}).profit, 550); assert.equal(dr({ 'Estimated Resale': '' }).profit, ''); assert.equal(dr({ 'Purchase Cost': '' }).profit, '');
});

// ---------------------------------------------------------------- sort + summary
test('sort: overdue (oldest first), other attention, then by progress, delivered, canceled last', () => {
  const rows = [
    dr({ 'Purchase ID': 'cx', 'Purchase Status': 'Canceled' }),
    dr({ 'Purchase ID': 'del', 'Purchase Status': 'Delivered', 'USPS Stage': 'Delivered', 'USPS Accepted At': 'x' }),
    dr({ 'Purchase ID': 'tr', 'USPS Accepted At': 'x', 'USPS Stage': 'In Transit', 'Purchase Status': 'Shipped' }),
    dr({ 'Purchase ID': 'od9', 'Purchased At': ago(9) }), dr({ 'Purchase ID': 'od20', 'Purchased At': ago(20) }),
    dr({ 'Purchase ID': 'nocost', 'Purchase Cost': '' })
  ];
  assert.equal(g.dashSort_(rows).map((r) => r.purchaseId).join(','), 'od20,od9,nocost,tr,del,cx');
});

test('summary: capital = actual cost of ACTIVE purchases only; missing cost excluded (not $0); canceled just counted', () => {
  const rows = [
    dr({ 'Purchase ID': 'a', 'Purchase Cost': 100 }),
    dr({ 'Purchase ID': 'b', 'Purchase Cost': 200, 'USPS Accepted At': 'x', 'USPS Stage': 'In Transit', 'Purchase Status': 'Shipped' }),
    dr({ 'Purchase ID': 'c', 'Purchase Cost': '' }),
    dr({ 'Purchase ID': 'd', 'Purchase Cost': 400, 'Purchased At': ago(9) }),
    dr({ 'Purchase ID': 'f', 'Purchase Cost': 600, 'Purchase Status': 'Delivered', 'USPS Stage': 'Delivered', 'USPS Accepted At': 'x' }),
    dr({ 'Purchase ID': 'g', 'Purchase Cost': 700, 'Purchase Status': 'Canceled' }),
    dr({ 'Purchase ID': 'i', 'Purchase Cost': '', 'Purchase Status': 'Canceled' })
  ];
  const s = g.dashSummary_(rows);
  assert.equal(s.active, 4); assert.equal(s.capital, 100 + 200 + 400); assert.equal(s.capitalMissing, 1);
  assert.equal(s.awaiting + s.transit + s.overdue, s.active);
  assert.equal(s.awaiting, 2); assert.equal(s.transit, 1); assert.equal(s.overdue, 1); assert.equal(s.delivered, 1); assert.equal(s.canceled, 2);
  assert.equal(s.attention, 2); assert.equal(s.missingCost, 1);
  assert.equal(Object.keys(s).sort().join(), 'active,attention,awaiting,canceled,capital,capitalMissing,delivered,missingCost,overdue,transit');
});

// ---------------------------------------------------------------- formatting
test('formatting precedence: canceled beats overdue; delivered stays green while only its Cost cell is yellow', () => {
  const eff = (o, col) => g.dashEffectiveBg_(o, col);
  assert.equal(eff({ A: 'x', B: 'Canceled', F: '' }, 'F'), 'canceled row');
  assert.equal(eff({ A: 'x', B: 'Canceled', F: 5 }, 'A'), 'canceled row');
  assert.equal(eff({ A: 'x', B: 'Delivered', F: '' }, 'F'), 'missing cost');
  assert.equal(eff({ A: 'x', B: 'Delivered', F: '' }, 'B'), 'delivered');
  assert.equal(eff({ A: 'x', B: 'Overdue', F: 5 }, 'A'), 'overdue row');
  assert.equal(eff({ A: 'x', B: 'Overdue', F: '' }, 'F'), 'missing cost');
  assert.equal(eff({ A: 'x', B: 'Shipped / In Transit', F: 5, O: 'Y' }, 'C'), 'attention cell');
  assert.equal(eff({ A: 'x', B: 'Shipped / In Transit', F: 5, L: '✓ In Inventory' }, 'L'), 'in inventory');
  assert.equal(eff({ A: '', B: '', F: '' }, 'F'), '');
});

test('conditional-format formulas are well formed and the layout constants match the trimmed sheet', () => {
  assert.equal(g.condFormula_(g.DASH_RULES[0].cond, 4), '=AND($A4<>"",$F4="",$B4<>"Canceled")');
  assert.equal(g.condFormula_(g.DASH_RULES[1].cond, 4), '=$B4="Canceled"');
  assert.equal(g.condFormula_({ all: [{ col: 'L', op: 'startsWith', v: '✓' }] }, 4), '=LEFT($L4,1)="✓"');
  g.DASH_RULES.forEach((r) => assert.match(g.condFormula_(r.cond, 4), /^=/));
  assert.equal(g.DASH.LABEL_ROW, 1); assert.equal(g.DASH.VALUE_ROW, 2); assert.equal(g.DASH.HEADER_ROW, 3); assert.equal(g.DASH.FIRST_ROW, 4);
});

test('tracking links go to the right carrier; quotes in text are escaped', () => {
  assert.equal(g.trackingUrl_('USPS', '9400111899223033005282'), 'https://tools.usps.com/tracking/9400111899223033005282');
  assert.match(g.trackingUrl_('UPS', '1Z999'), /ups\.com/); assert.match(g.trackingUrl_('Mystery', 'ABC123'), /google\.com\/search/);
  assert.equal(g.hyperlink_('http://x', 'say "hi"'), '=HYPERLINK("http://x","say ""hi""")');
});

test('Facebook due logic: slow daily recheck while a label exists but USPS has not accepted; none once accepted', () => {
  const cfg = { FB_RECHECK_MINUTES: 150, FB_TRACKING_RECHECK_MINUTES: 1440, FB_ERROR_BACKOFF_AFTER: 3, FB_ERROR_BACKOFF_MINUTES: 720 };
  const t = (o) => Object.assign({ 'Purchase Status': 'Tracking Available', 'Tracking Number': '940', 'Last FB Check': new Date(NOW - 10 * 3600000), 'FB Error Count': 0 }, o);
  assert.equal(g.isFbCheckDue_(t(), NOW, cfg), false);
  assert.equal(g.isFbCheckDue_(t({ 'Last FB Check': new Date(NOW - 25 * 3600000) }), NOW, cfg), true);
  assert.equal(g.isFbCheckDue_(t({ 'Last FB Check': new Date(NOW - 25 * 3600000), 'USPS Accepted At': 'x' }), NOW, cfg), false);
  assert.equal(g.isFbCheckDue_(t({ 'Purchase Status': 'Shipped', 'Last FB Check': new Date(NOW - 99 * 3600000) }), NOW, cfg), false);
});
