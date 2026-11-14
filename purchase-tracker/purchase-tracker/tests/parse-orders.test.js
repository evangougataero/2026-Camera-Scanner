'use strict';
/**
 * parse-orders.js: card list + "Order status" dialog parsing for facebook.com/marketplace/you/orders, status mapping and
 * order -> Purchased-row matching. Fixtures mirror the Nov 2026 screenshots (Nikon D80 bundle, Tabitha Shippee, USPS 9334…).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../extension/parse-order.js');                  // PTParse (seller / USPS helpers) on globalThis
const O = require('../extension/parse-orders.js');

const NOW = Date.UTC(2026, 10, 13, 18);                  // Nov 13, 2026

// ---------------------------------------------------------------- fixtures
const CARDS = [
  ['Shipped', 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...', 'Nov 8, 2026'],
  ['Confirmed', 'Sony A6400 Mirrorless Camera Body Only, Low Shu...', 'Nov 10, 2026'],
  ['Delivered', 'Canon EOS 760D (Rebel T6s) with the Lens', 'Nov 3, 2026'],
  ['Canceled', 'Nikon D7100 with 18-140mm', 'Nov 4, 2026'],
  ['Refunded', 'Fujifilm X-T3 Body', 'Oct 30, 2026']
];
const LIST_TEXT = ['Purchased orders', 'Date Range: Select'].concat(...CARDS).join('\n');

const DIALOG_D80 = ['Order status', 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more', '$200.00 · Quantity: 1', 'Shipped',
  'Estimated Arrival: Nov 19', 'USPS TRACKING NUMBER: 9334610579400004369609', 'Order Confirmed', 'Nov 8 at 9:41 PM', 'Shipped', 'Nov 9 at 7:08 PM',
  'Out for delivery', 'Delivered', 'Seller information', 'Tabitha Shippee', 'View order details'].join('\n');

// ---------------------------------------------------------------- cards
test('card text: status, (truncated) title and order date', () => {
  const c = O.parseCardText(CARDS[0].join('\n'), NOW);
  assert.equal(c.status, 'shipped'); assert.equal(c.statusRaw, 'Shipped');
  assert.equal(c.title, 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...');
  assert.equal(c.orderDate, '2026-11-08');
  assert.deepEqual(CARDS.map((x) => O.parseCardText(x.join('\n'), NOW).status), ['shipped', 'confirmed', 'delivered', 'canceled', 'refunded']);
  // the "?" the screenshots show instead of the dash, and the date on the status line's neighbour, are fine
  assert.equal(O.parseCardText('Shipped\nNikon D80 DSLR Camera Bundle ? 4 Lenses, Hard C...\nNov 8, 2026', NOW).title, 'Nikon D80 DSLR Camera Bundle ? 4 Lenses, Hard C...');
});

test('card text: a list container (several statuses / dates) is not a card; a status alone is not a card', () => {
  assert.equal(O.parseCardText(CARDS[0].concat(CARDS[1]).join('\n'), NOW), null);
  assert.equal(O.parseCardText('Shipped\nNov 8, 2026', NOW), null);
  assert.equal(O.parseCardText(LIST_TEXT, NOW), null);
});

test('card list text fallback: one order per status line, in page order', () => {
  const cards = O.parseOrdersListText(LIST_TEXT, NOW);
  assert.deepEqual(cards.map((c) => c.status + '|' + c.orderDate), ['shipped|2026-11-08', 'confirmed|2026-11-10', 'delivered|2026-11-03', 'canceled|2026-11-04', 'refunded|2026-10-30']);
  assert.equal(cards[2].title, 'Canon EOS 760D (Rebel T6s) with the Lens');
});

test('order dates: with year, without year (most recent past date), ISO day offsets', () => {
  assert.equal(O.parseOrderDate('Nov 8, 2026', NOW), '2026-11-08');
  assert.equal(O.parseOrderDate('Ordered on November 8', NOW), '2026-11-08');
  assert.equal(O.parseOrderDate('Dec 28', NOW), '2025-12-28');                // a future month/day is last year's
  assert.equal(O.parseOrderDate('no date here', NOW), '');
  assert.equal(O.dayOffset('2026-11-08', '2026-11-10 14:03'), -2);
  assert.equal(O.dayOffset('', '2026-11-10'), null);
});

// ---------------------------------------------------------------- status mapping
test('status wording -> normalized status -> effect on the Purchased tab', () => {
  const cases = [['Confirmed', 'confirmed', 'Purchased', false], ['Order confirmed', 'confirmed', 'Purchased', false], ['Shipped', 'shipped', 'Shipped', false],
    ['In transit', 'shipped', 'Shipped', false], ['Out for delivery', 'out_for_delivery', 'Shipped', false], ['Delivered', 'delivered', 'Delivered', false],
    ['Canceled', 'canceled', 'Canceled', true], ['Cancelled', 'canceled', 'Canceled', true], ['Refunded', 'refunded', 'Canceled', true], ['Expired', 'expired', 'Canceled', true]];
  for (const [raw, key, purchase, canceled] of cases) {
    assert.equal(O.normalizeOrderStatus(raw), key, raw);
    const e = O.statusEffect(key);
    assert.equal(e.purchaseStatus, purchase, raw); assert.equal(e.canceled, canceled, raw);
    if (canceled) assert.equal(e.outcome, key);
  }
  for (const raw of ['Partially refunded', 'Cancellation requested', 'Refund requested', 'Message seller', 'Nikon D80 body']) assert.equal(O.normalizeOrderStatus(raw), '', raw);
});

// ---------------------------------------------------------------- dialog
test('Order status dialog: title, price, status, estimated arrival, USPS tracking, timeline, seller', () => {
  const d = O.parseOrderDialogText(DIALOG_D80, [], { orderDate: '2026-11-08' });
  assert.equal(d.title, 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more');
  assert.equal(d.price, 200); assert.equal(d.quantity, 1);
  assert.equal(d.status, 'shipped');
  assert.equal(d.estimatedArrival, 'Nov 19'); assert.equal(d.estimatedDelivery, '2026-11-19');
  assert.equal(d.trackingNumber, '9334610579400004369609'); assert.equal(d.carrier, 'USPS');
  assert.equal(d.seller, 'Tabitha Shippee');
  assert.deepEqual(d.timeline.map((s) => s.step + '|' + s.at + '|' + s.done),
    ['Order Confirmed|Nov 8 at 9:41 PM|true', 'Shipped|Nov 9 at 7:08 PM|true', 'Out for delivery||false', 'Delivered||false']);
});

test('dialog: the price separator may render as "?" (as in the screenshots); a Delivered headline wins over timeline steps', () => {
  const t = DIALOG_D80.replace('$200.00 · Quantity: 1', '$200.00 ? Quantity: 1').replace(/\nShipped\nEstimated/, '\nDelivered\nEstimated');
  const d = O.parseOrderDialogText(t, [], { orderDate: '2026-11-08' });
  assert.equal(d.price, 200); assert.equal(d.title, 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more');
  assert.equal(d.status, 'delivered');
});

test('tracking numbers with USPS / UPS / FedEx / DHL prefixes (same line or next line; trailing button text ignored)', () => {
  const tr = (s) => { const r = O.parseCarrierTracking(s); return r ? r.carrier + ' ' + r.trackingNumber : null; };
  assert.equal(tr('USPS TRACKING NUMBER: 9334610579400004369609'), 'USPS 9334610579400004369609');
  assert.equal(tr('USPS TRACKING NUMBER: 9334 6105 7940 0004 3696 09 Copy'), 'USPS 9334610579400004369609');
  assert.equal(tr('UPS TRACKING NUMBER: 1Z999AA10123456784'), 'UPS 1Z999AA10123456784');
  assert.equal(tr('UPS TRACKING NUMBER: 1Z999AA10123456784 Copy'), 'UPS 1Z999AA10123456784');
  assert.equal(tr('FedEx TRACKING NUMBER:\n771234567890'), 'FedEx 771234567890');
  assert.equal(tr('FEDEX TRACKING NUMBER: 7712 3456 7890'), 'FedEx 771234567890');
  assert.equal(tr('DHL tracking number 1234567890'), 'DHL 1234567890');
  assert.equal(tr('USPS TRACKING NUMBER: 12345'), null);                                       // not a valid USPS number
  for (const [label, num, carrier] of [['UPS', '1Z999AA10123456784', 'UPS'], ['FedEx', '771234567890', 'FedEx']]) {
    const d = O.parseOrderDialogText(DIALOG_D80.replace('USPS TRACKING NUMBER: 9334610579400004369609', label + ' TRACKING NUMBER: ' + num), []);
    assert.equal(d.trackingNumber, num); assert.equal(d.carrier, carrier);
  }
});

test('dialog: canceled / refunded / expired headlines; IDs from links and the page URL; no tracking when none is shown', () => {
  const canc = ['Order status', 'Nikon D7100 with 18-140mm', '$290.40 · Quantity: 1', 'Canceled', 'Your order was canceled.', 'Order Confirmed', 'Nov 4 at 10:02 AM',
    'Seller information', 'Nathan Stickler', 'View order details'].join('\n');
  const d = O.parseOrderDialogText(canc, ['https://www.facebook.com/marketplace/item/5555555555555555/?ref=orders'], { url: 'https://www.facebook.com/marketplace/you/orders/?order_id=987654321012345' });
  assert.equal(d.status, 'canceled'); assert.equal(d.trackingNumber, ''); assert.equal(d.seller, 'Nathan Stickler'); assert.equal(d.price, 290.4);
  assert.equal(d.listingId, '5555555555555555'); assert.equal(d.orderId, '987654321012345');
  assert.equal(O.parseOrderDialogText(canc.replace('\nCanceled\n', '\nRefunded\n')).status, 'refunded');
  assert.equal(O.parseOrderDialogText(canc.replace('\nCanceled\n', '\nExpired\n')).status, 'expired');
  assert.deepEqual(O.idsFromHrefs(['https://www.facebook.com/marketplace/you/orders/123456789012/']), { listingId: '', orderId: '123456789012' });
});

test('estimated arrival across the year boundary and as a range', () => {
  assert.equal(O.parseEstimatedArrival('Estimated Arrival: Jan 3', '2026-12-28').date, '2027-01-03');
  const r = O.parseEstimatedArrival('Estimated arrival Nov 19 - Nov 21', '2026-11-08');
  assert.equal(r.raw, 'Nov 19 - Nov 21'); assert.equal(r.date, '2026-11-19');
  assert.equal(O.parseEstimatedArrival('nothing', '2026-11-08').date, '');
});

// ---------------------------------------------------------------- matching
const order = (o) => O.mergeOrder(Object.assign({ key: 'k', status: 'shipped', statusRaw: 'Shipped', title: 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...',
  orderDate: '2026-11-08' }, o.card || {}), o.dialog === null ? null : Object.assign({ status: 'shipped', statusRaw: 'Shipped', title: 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more',
  price: 200, quantity: 1, trackingNumber: '9334610579400004369609', carrier: 'USPS', seller: 'Tabitha Shippee', timeline: [] }, o.dialog || {}));
const item = (o) => Object.assign({ purchaseId: 'P-1', listingId: '1111111111111111', orderId: '', seller: '', cost: '', ask: '', purchasedAt: '2026-11-08', fbTitle: '', product: '', mode: 'order' }, o);

test('match by listing ID / order ID (strongest, no date window needed)', () => {
  const m = O.matchOrders([order({ card: { listingId: '1111111111111111', orderDate: '2026-09-01' } })], [item({}), item({ purchaseId: 'P-2', listingId: '2222' })]);
  assert.equal(m.matches.length, 1); assert.equal(m.matches[0].purchaseId, 'P-1'); assert.equal(m.matches[0].via, 'listing ID');
  const m2 = O.matchOrders([order({ dialog: { orderId: '987654321012' } })], [item({ orderId: '987654321012', listingId: '' })]);
  assert.equal(m2.matches[0].via, 'order ID');
});

test('match by seller + price (Purchase Cost or Ask Price, to the cent), inside the date window', () => {
  const o = order({});
  assert.equal(O.matchOrders([o], [item({ seller: 'Tabitha Shippee', cost: 200 })]).matches[0].via, 'seller+price');
  assert.equal(O.matchOrders([o], [item({ seller: 'tabitha  shippee', cost: '', ask: '$200' })]).matches[0].via, 'seller+price');
  assert.equal(O.matchOrders([o], [item({ seller: 'Tabitha Shippee', cost: 205 })]).matches.length, 0);       // wrong price, no title words
  assert.equal(O.matchOrders([o], [item({ seller: 'Tabitha Shippee', cost: 200, purchasedAt: '2026-10-01' })]).matches.length, 0);   // outside window
});

test('match by normalized title similarity + order date within a few days of Purchased At', () => {
  const o = order({ dialog: { seller: '', price: '' } });
  const viaTitle = O.matchOrders([o], [item({ purchasedAt: '2026-11-09 08:00', fbTitle: 'Nikon D80 DSLR Camera Bundle - 4 Lenses, Hard Case and more' })]);
  assert.match(viaTitle.matches[0].via, /^title\+date/);
  assert.match(O.matchOrders([o], [item({ product: 'Nikon D80 + Nikon 18-55mm' })]).matches[0].via, /^title\+date/);   // scanner product name
  assert.equal(O.matchOrders([o], [item({ product: 'Nikon D80', purchasedAt: '2026-11-20' })]).matches.length, 0);        // date too far
  assert.equal(O.matchOrders([o], [item({ product: 'Nikon D7100 + Nikon 18-140mm' })]).matches.length, 0);               // different model
  // card-only (dialog never opened): the truncated card title still matches
  assert.equal(O.matchOrders([order({ dialog: null })], [item({ product: 'Nikon D80' })]).matches.length, 1);
});

test('ambiguous matches change nothing: two purchases fitting one order equally well (or one purchase fitting two orders)', () => {
  const twin = [item({ purchaseId: 'A-1', listingId: '1', seller: 'Tabitha Shippee', cost: 200 }), item({ purchaseId: 'B-2', listingId: '2', seller: 'Tabitha Shippee', cost: 200 })];
  const m = O.matchOrders([order({})], twin);
  assert.equal(m.matches.length, 0);
  assert.deepEqual(m.ambiguous[0].purchaseIds, ['A-1', 'B-2']);
  assert.deepEqual(m.notFound, []);                                                               // ambiguous, not "not found"
  const two = [order({ card: { key: 'x' } }), order({ card: { key: 'y' } })];
  const m2 = O.matchOrders(two, [item({ product: 'Nikon D80' })]);
  assert.equal(m2.matches.length, 0); assert.equal(m2.ambiguous.length, 1);
  // ...but a stronger tier still wins over a weaker tie
  const m3 = O.matchOrders([order({})], [item({ purchaseId: 'A-1', listingId: '1', seller: 'Tabitha Shippee', cost: 200 }), item({ purchaseId: 'B-2', listingId: '2', product: 'Nikon D80' })]);
  assert.equal(m3.matches.length, 1); assert.equal(m3.matches[0].purchaseId, 'A-1');
});

test('one-to-one: the same seller with two orders is split by price', () => {
  const o1 = order({ card: { key: '1' }, dialog: { price: 200 } }), o2 = order({ card: { key: '2' }, dialog: { price: 85, title: 'Nikon 50mm f/1.8D' } });
  const m = O.matchOrders([o1, o2], [item({ purchaseId: 'A-1', seller: 'Tabitha Shippee', cost: 85 }), item({ purchaseId: 'B-1', listingId: '2', seller: 'Tabitha Shippee', cost: 200 })]);
  assert.deepEqual(m.matches.map((x) => x.purchaseId + '=' + x.order.price).sort(), ['A-1=85', 'B-1=200']);
});

test('not found NEVER cancels: planOrderResults sends nothing for purchases missing from the page', () => {
  const canceledOrder = order({ card: { status: 'canceled', statusRaw: 'Canceled', title: 'Fujifilm X-T3 Body', orderDate: '2026-10-30' }, dialog: null });
  const plan = O.planOrderResults([canceledOrder], [item({ purchaseId: 'GONE-1', product: 'Sony A6400', purchasedAt: '2026-11-10' })]);
  assert.equal(plan.submissions.length, 0);
  assert.deepEqual(plan.notFound, ['GONE-1']);
  assert.equal(O.planOrderResults([], [item({ purchaseId: 'GONE-2' })]).submissions.length, 0);
});

test('results use the existing submitFbResult shape: headline first, explicit cancel evidence, seller-only rows carry only seller/title', () => {
  const plan = O.planOrderResults([order({}), order({ card: { key: 'c', status: 'canceled', statusRaw: 'Canceled', title: 'Nikon D7100 with 18-140mm', orderDate: '2026-11-04' },
    dialog: { status: 'canceled', statusRaw: 'Canceled', title: 'Nikon D7100 with 18-140mm', price: 290.4, trackingNumber: '', carrier: '', seller: 'Nathan Stickler' } })],
  [item({ seller: 'Tabitha Shippee', cost: 200, trackingNumber: '' }), item({ purchaseId: 'S-1', listingId: '9', mode: 'seller', product: 'Nikon D7100', purchasedAt: '2026-11-04' })]);
  const byId = {}; plan.submissions.forEach((s) => { byId[s.purchaseId] = s.result; });
  assert.equal(byId['P-1'].fbStatusRaw, 'Shipped'); assert.equal(byId['P-1'].canceled, false); assert.equal(byId['P-1'].orderTotal, '$200.00');
  assert.equal(byId['P-1'].source, 'orders-page'); assert.equal(byId['P-1'].ok, true); assert.equal(byId['P-1'].mode, 'order');
  assert.deepEqual(Object.keys(byId['S-1']).sort(), ['itemTitle', 'mode', 'ok', 'orderView', 'seller', 'source']);
  assert.equal(byId['S-1'].seller, 'Nathan Stickler');
  assert.deepEqual(plan.newUspsTracking, [{ purchaseId: 'P-1', trackingNumber: '9334610579400004369609' }]);
  const del = O.toFbResult(order({ dialog: { status: 'delivered', statusRaw: 'Delivered' } }), item({}));
  assert.match(del.fbStatusRaw, /^Delivered( \||$)/);                                           // the backend reads "Delivered" from the first segment
  const canc = O.toFbResult(order({ dialog: { status: 'refunded', statusRaw: 'Refunded' } }), item({}));
  assert.equal(canc.canceled, true); assert.equal(canc.outcome, 'refunded'); assert.equal(canc.purchaseStatus, 'Canceled');
});

test('which cards get their dialog opened, and how far back to scroll', () => {
  const items = [item({ purchasedAt: '2026-11-08' }), item({ purchaseId: 'P-2', purchasedAt: '2026-11-03 10:00' })];
  assert.equal(O.earliestNeeded(items), '2026-10-28');
  assert.equal(O.earliestNeeded([item({ purchasedAt: '' })]), '');
  assert.equal(O.cardMayMatch({ orderDate: '2026-11-07' }, items), true);
  assert.equal(O.cardMayMatch({ orderDate: '2026-10-01' }, items), false);
  assert.equal(O.cardMayMatch({ orderDate: '2026-10-01', listingId: '1111111111111111' }, items), true);
  assert.equal(O.cardMayMatch({ orderDate: '' }, items), true);                                   // unknown date: look
});
