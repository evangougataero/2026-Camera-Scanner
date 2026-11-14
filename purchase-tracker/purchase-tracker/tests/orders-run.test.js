'use strict';
/**
 * Service-worker run flow with the Facebook "Purchased orders" page (marketplace/you/orders), using the REAL
 * background.js + parse-orders.js in a fake chrome (tests/fake-worker.js):
 *   - ONE orders-page visit per run replaces the per-listing checks; matched rows go through submitFbResult;
 *   - tracking found this run is checked on USPS in the same run; signals (Meta Pay, notifications) still run last;
 *   - a purchase NOT FOUND on the page is never canceled (nothing sent; optional listing-page fallback only);
 *   - ambiguous matches change nothing; login walls are re-verified and reported, never bypassed;
 *   - an unexpected navigation resumes the read; the probe submits nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, drain, ORDER_C1 } = require('./fake-worker');

const ORDERS_URL = 'https://www.facebook.com/marketplace/you/orders/';

const D80 = { key: 'Shipped|Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...|Nov 8, 2026#1', status: 'shipped', statusRaw: 'Shipped',
  title: 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more', cardTitle: 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...',
  orderDate: '2026-11-08', orderDateRaw: 'Nov 8, 2026', price: 200, quantity: 1, trackingNumber: '9334610579400004369609', carrier: 'USPS',
  estimatedArrival: 'Nov 19', estimatedDelivery: '2026-11-19', seller: 'Tabitha Shippee',
  timeline: [{ step: 'Order Confirmed', at: 'Nov 8 at 9:41 PM', done: true }, { step: 'Shipped', at: 'Nov 9 at 7:08 PM', done: true },
             { step: 'Out for delivery', at: '', done: false }, { step: 'Delivered', at: '', done: false }],
  orderId: '', listingId: '', dialogOpened: true, dialogError: '' };

const CANCELED_D7100 = { key: 'Canceled|Nikon D7100 with 18-140mm|Nov 4, 2026#1', status: 'canceled', statusRaw: 'Canceled', title: 'Nikon D7100 with 18-140mm',
  cardTitle: 'Nikon D7100 with 18-140mm', orderDate: '2026-11-04', orderDateRaw: 'Nov 4, 2026', price: 290.4, quantity: 1, trackingNumber: '', carrier: '',
  estimatedArrival: '', estimatedDelivery: '', seller: 'Nathan Stickler', timeline: [{ step: 'Order Confirmed', at: 'Nov 4 at 10:02 AM', done: true }],
  orderId: '', listingId: '', dialogOpened: true, dialogError: '' };

const ordersWork = () => ({
  ok: true, signals: true,
  items: [
    { purchaseId: 'D80-1', listingId: '1111111111111111', mode: 'order', seller: 'Tabitha Shippee', cost: 200, ask: 220, purchasedAt: '2026-11-08', product: 'Nikon D80 + Nikon 18-55mm', trackingNumber: '' },
    { purchaseId: 'D71-1', listingId: '2222222222222222', mode: 'order', seller: '', cost: 290.4, ask: 300, purchasedAt: '2026-11-04', product: 'Nikon D7100 + Nikon 18-140mm', fbTitle: 'Nikon D7100 with 18-140mm' },
    { purchaseId: 'GONE-1', listingId: '3333333333333333', mode: 'order', seller: 'Kim Vo', cost: 410, purchasedAt: '2026-11-10', product: 'Sony A6400' }
  ],
  sellerItems: [{ purchaseId: 'C-1', listingId: '1288988733112094', purchasedAt: '2026-11-03', product: 'Canon EOS 760D' }]
});

test('run flow: ONE orders-page visit replaces the per-listing checks; matched rows are submitted, new USPS tracking is checked, then signals', async () => {
  const seen = [];
  const w = worker({
    PT_ordersInPage: (o) => { seen.push(o); return { ok: true, orders: [D80, CANCELED_D7100, ORDER_C1], cardsSeen: 3, dialogsOpened: 3, scrolls: 1, stopReason: 'reached orders older than 2026-10-28' }; },
    PT_extractInPage: () => { throw new Error('listing fallback must not run for found rows'); },
    PT_uspsInPage: { ok: true, trackingNumber: '9334610579400004369609', status: 'In Transit', history: [] },
    PT_metaPayInPage: { ok: true, transactions: [] }, PT_notificationsInPage: { ok: true, notifications: [], scanned: 1 }
  }, { getWork: ordersWork, getUspsWork: () => ({ ok: true, items: [] }) });
  w.store.pt_settings.fallbackListing = false;                                                   // GONE-1 is not on the page
  await w.run("startRun('test')");
  await drain(w, 30);
  const tabs = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.deepEqual(tabs, [ORDERS_URL, 'https://tools.usps.com/tracking/9334610579400004369609',
    'https://accountscenter.facebook.com/meta_pay_wallet/?referrer=accounts_center_home', 'https://www.facebook.com/marketplace/notifications/']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].earliest, '2026-10-28');                                                  // oldest Purchased At (C-1, Nov 3) minus 6 days
  assert.equal(seen[0].items.length, 4);
  assert.equal(seen[0].probe, false);

  const fb = w.calls.filter((c) => c.api === 'submitFbResult');
  assert.deepEqual(fb.map((c) => c.body.purchaseId + ':' + c.body.result.mode).sort(), ['C-1:seller', 'D71-1:order', 'D80-1:order']);
  const d80 = fb.find((c) => c.body.purchaseId === 'D80-1').body.result;
  assert.equal(d80.source, 'orders-page'); assert.equal(d80.matchedVia, 'seller+price');
  assert.equal(d80.trackingNumber, '9334610579400004369609'); assert.equal(d80.carrier, 'USPS'); assert.equal(d80.seller, 'Tabitha Shippee');
  assert.equal(d80.canceled, false); assert.equal(d80.purchaseStatus, 'Shipped'); assert.equal(d80.estimatedDelivery, '2026-11-19');
  assert.equal(d80.fbStatusRaw, 'Shipped | Estimated Arrival: Nov 19 | Order Confirmed: Nov 8 at 9:41 PM | Shipped: Nov 9 at 7:08 PM');
  assert.equal(d80.timeline.length, 4);
  const d71 = fb.find((c) => c.body.purchaseId === 'D71-1').body.result;
  assert.equal(d71.canceled, true); assert.equal(d71.outcome, 'canceled'); assert.match(d71.matchedVia, /^title\+date/); assert.match(d71.fbStatusRaw, /^Canceled\b/);
  assert.equal(fb.find((c) => c.body.purchaseId === 'C-1').body.result.seller, 'Olga Serdinskaya');
  assert.ok(!fb.some((c) => c.body.purchaseId === 'GONE-1'));                                   // not found: NOTHING is sent (never canceled)

  const log = w.store.pt_state.log.join('\n');
  assert.match(log, /run started \(test\): orders page for 4 purchase\(s\) \(1 seller-only\), 0 USPS, 2 signal page\(s\)/);
  assert.match(log, /GONE-1 not found on orders page — unchanged$/m);
  assert.match(log, /Orders page: 3 order card\(s\), 3 dialog\(s\) read, 1 scroll\(s\).*matched 3, ambiguous 0, not found 1/);
  assert.match(log, /D80-1 FB orders page \[seller\+price\]: Shipped · "Nikon D80/);
  assert.match(log, /not-on-orders-page:1/);
  const usps = w.calls.filter((c) => c.api === 'submitUspsResult');
  assert.deepEqual(usps.map((c) => c.body.purchaseId), ['D80-1']);                              // tracking found this run is checked this run
});

test('a purchase not found on the orders page is never canceled: only its listing page is read as a fallback (which reports, never cancels)', async () => {
  const w = worker({ PT_ordersInPage: { ok: true, orders: [D80], cardsSeen: 1, dialogsOpened: 1, scrolls: 0, stopReason: 'no more orders loaded' },
                     PT_extractInPage: { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', listingState: 'sold', pageHealthy: true } },
    { getWork: () => ({ ok: true, signals: false, items: [ordersWork().items[0], ordersWork().items[2]] }), getUspsWork: () => ({ ok: true, items: [] }) });
  await w.run("startRun('test')");
  await drain(w, 30);
  const tabs = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.deepEqual(tabs.slice(0, 2), [ORDERS_URL, 'https://www.facebook.com/marketplace/item/3333333333333333/']);
  const gone = w.calls.filter((c) => c.api === 'submitFbResult' && c.body.purchaseId === 'GONE-1');
  assert.equal(gone.length, 1);
  assert.equal(gone[0].body.result.ok, false); assert.equal(gone[0].body.result.canceled, false);
  assert.match(w.store.pt_state.log.join('\n'), /GONE-1 not found on orders page — unchanged; checking its listing page instead/);
});

test('an order that fits two purchases equally well changes nothing (ambiguous, logged)', async () => {
  const twin = (id, lid) => ({ purchaseId: id, listingId: lid, mode: 'order', seller: 'Tabitha Shippee', cost: 200, purchasedAt: '2026-11-08', product: 'Nikon D80' });
  const w = worker({ PT_ordersInPage: { ok: true, orders: [D80], cardsSeen: 1, dialogsOpened: 1, scrolls: 0 } },
    { getWork: () => ({ ok: true, signals: false, items: [twin('A-1', '4444444444444444'), twin('B-2', '5555555555555555')] }), getUspsWork: () => ({ ok: true, items: [] }) });
  w.store.pt_settings.fallbackListing = false;
  await w.run("startRun('test')");
  await drain(w, 30);
  assert.ok(!w.calls.some((c) => c.api === 'submitFbResult'));
  assert.match(w.store.pt_state.log.join('\n'), /Orders page: AMBIGUOUS "Nikon D80 DSLR Camera Bundle.*fits A-1 \/ B-2 \(seller\+price\) — nothing changed/);
});

test('a confirmed login wall on the ORDERS page is reported once re-verified (never bypassed); no listing fallback, USPS + Meta Pay still run', async () => {
  let n = 0;
  const w = worker({
    PT_ordersInPage: () => { n++; return { ok: false, error: 'LOGIN_REQUIRED', detail: 'via login-form · path=/marketplace/you/orders/ · "Log in to Facebook"' }; },
    PT_extractInPage: () => { throw new Error('no fallback after a login wall'); },
    PT_uspsInPage: { ok: true, trackingNumber: '9334610579700004096766', status: 'Delivered', history: [] },
    PT_metaPayInPage: { ok: true, transactions: [] }, PT_notificationsInPage: { ok: true, notifications: [] }
  }, { getWork: ordersWork, getUspsWork: () => ({ ok: true, items: [{ purchaseId: 'C-1', trackingNumber: '9334610579700004096766' }] }) });
  await w.run("startRun('test')");
  await drain(w, 30);
  assert.equal(n, 2);                                                                            // re-checked once
  const tabs = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.ok(!tabs.some((t) => /marketplace\/item\//.test(t)));
  assert.ok(!tabs.some((t) => /notifications/.test(t)));
  assert.ok(tabs.some((t) => /tools\.usps\.com/.test(t)) && tabs.some((t) => /accountscenter/.test(t)));
  assert.ok(!w.calls.some((c) => c.api === 'submitFbResult'));
  const issue = w.calls.find((c) => c.api === 'reportIssue');
  assert.equal(issue.body.message, 'Facebook LOGIN_REQUIRED on the orders page — via login-form · path=/marketplace/you/orders/ · "Log in to Facebook" (seen twice)');
  assert.match(w.store.pt_state.log.join('\n'), /STOPPED FB: LOGIN_REQUIRED/);
  assert.equal(w.badge.text, '!');
});

test('a login wall on the orders page seen only once (page was hydrating) is not reported; the read continues', async () => {
  let n = 0;
  const w = worker({ PT_ordersInPage: () => (++n === 1 ? { ok: false, error: 'LOGIN_REQUIRED', detail: 'path=/marketplace/you/orders/' } : { ok: true, orders: [D80], cardsSeen: 1, dialogsOpened: 1 }) },
    { getWork: () => ({ ok: true, signals: false, items: [ordersWork().items[0]] }), getUspsWork: () => ({ ok: true, items: [] }) });
  await w.run("startRun('test')");
  await drain(w, 30);
  assert.ok(!w.calls.some((c) => c.api === 'reportIssue'));
  assert.ok(w.calls.some((c) => c.api === 'submitFbResult' && c.body.purchaseId === 'D80-1'));
});

test('orders page: when opening a card navigates the tab away, the list is reloaded and the read RESUMES', async () => {
  let n = 0;
  const w = worker({}, { getWork: ordersWork, getUspsWork: () => ({ ok: true, items: [] }) });
  const opts = [];
  w.ctx.chrome.scripting.executeScript = async (o) => {
    if (o.files) return [];
    opts.push(o.args[0]);
    if (++n === 1) throw new Error('Frame with ID 0 was removed.');
    return [{ result: { ok: true, orders: [D80], cardsSeen: 1, dialogsOpened: 1, scrolls: 0 } }];
  };
  const updates = [];
  w.ctx.chrome.tabs.update = async (id, u) => { updates.push(u); return {}; };
  const r = await w.run('checkOrdersPage(' + JSON.stringify(ordersWork().items) + ')');
  assert.equal(r.ok, true); assert.equal(r.resumed, 1);
  assert.equal(opts[0].resume, false); assert.equal(opts[1].resume, true);
  assert.ok(updates.some((u) => u.url === ORDERS_URL));
});

test('orders page read failed (not a wall): every due purchase falls back to its listing page; switched off => nothing is sent', async () => {
  const w = worker({ PT_ordersInPage: { ok: false, error: 'ORDERS_NOT_FOUND', detail: 'no order cards' } },
    { getWork: () => ({ ok: true, signals: false, items: [ordersWork().items[0]] }), getUspsWork: () => ({ ok: true, items: [] }) });
  w.store.pt_settings.fallbackListing = false;
  await w.run("startRun('test')");
  await drain(w, 30);
  assert.deepEqual(w.calls.filter((c) => c.tab).map((c) => c.tab), [ORDERS_URL]);
  assert.ok(!w.calls.some((c) => c.api === 'submitFbResult'));
  assert.match(w.store.pt_state.log.join('\n'), /Orders page: error ORDERS_NOT_FOUND \(no order cards\)/);
});

test('"Probe orders page" shows cards, dialog data, matches, not-found rows and the backend preview — and submits nothing', async () => {
  let preview = null;
  const w = worker({
    PT_ordersInPage: (o) => ({ ok: true, orders: [D80, CANCELED_D7100], cardsSeen: 2, dialogsOpened: 2, scrolls: 2, stopReason: 'no more orders loaded', earliest: o.earliest,
      probe: { textPreview: 'Purchased orders…', openAll: o.openAll } })
  }, {
    getWork: (b) => { assert.equal(b.force, true); return ordersWork(); }, getUspsWork: () => ({ ok: true, items: [] }),
    previewFbResults: (b) => { preview = b.results; return { ok: true, updates: b.results.map((x) => ({ purchaseId: x.purchaseId, changes: { 'Purchase Status': x.result.canceled ? 'Canceled' : 'Tracking Available' } })) }; }
  });
  const r = JSON.parse(JSON.stringify(await w.message({ type: 'pt:probeOrders' })));
  assert.equal(r.ok, true); assert.equal(r.cardsSeen, 2); assert.equal(r.orders.length, 2);
  assert.equal(r.probe.openAll, true);                                                           // the probe opens every card's dialog
  assert.equal(r.orders[0].summary, 'Shipped · "Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more" · 2026-11-08 · $200.00 · seller Tabitha Shippee · USPS 9334610579400004369609');
  assert.deepEqual(r.matches.map((m) => m.purchaseId + ':' + m.via.split(' ')[0]).sort(), ['D71-1:title+date', 'D80-1:seller+price']);
  assert.deepEqual(r.notFound.map((x) => x.purchaseId).sort(), ['C-1', 'GONE-1']);
  assert.match(r.notFound[0].note, /never canceled/);
  assert.equal(preview.length, 2);
  assert.equal(r.wouldChange.updates.find((u) => u.purchaseId === 'D71-1').changes['Purchase Status'], 'Canceled');
  assert.ok(!w.calls.some((c) => c.api && /^submit/.test(c.api)));
  assert.equal(r.probe.textPreview, 'Purchased orders…');
});

test('"Probe orders page" without a backend connection still shows the page (no matching)', async () => {
  const w = worker({ PT_ordersInPage: (o) => ({ ok: true, orders: [D80], cardsSeen: 1, dialogsOpened: 1, earliest: o.earliest }) }, {});
  w.store.pt_settings = {};
  const r = JSON.parse(JSON.stringify(await w.message({ type: 'pt:probeOrders' })));
  assert.equal(r.ok, true); assert.equal(r.orders.length, 1); assert.equal(r.matches.length, 0);
  assert.match(r.workNote, /backend not reachable/);
  assert.match(r.earliest, /^\d{4}-\d{2}-\d{2}$/);
});
