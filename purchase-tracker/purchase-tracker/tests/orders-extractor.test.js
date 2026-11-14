'use strict';
/**
 * Runs the REAL in-page orders-page reader (orders-extractor.js + parse-orders.js + parse-order.js + login-guard.js)
 * against a tiny fake DOM shaped like facebook.com/marketplace/you/orders (Nov 2026 screenshots): order cards
 * (thumbnail, status, truncated title, date) that open an "Order status" dialog with a Close button; older cards load
 * on scroll.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { h, pageContext } = require('./fake-dom');

const FILES = ['login-guard.js', 'parse-order.js', 'parse-orders.js', 'orders-extractor.js'];
const URL_ORDERS = 'https://www.facebook.com/marketplace/you/orders/';
const FAST = { pollMs: 40, readyWaitMs: 1500, scrollWaitMs: 250, dialogWaitMs: 800, settleMs: 500, betweenMs: 0 };

const ORDERS = [
  { status: 'Shipped', title: 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...', date: 'Nov 8, 2026',
    dialog: ['Order status', 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more', '$200.00 · Quantity: 1', 'Shipped', 'Estimated Arrival: Nov 19',
      'USPS TRACKING NUMBER: 9334610579400004369609', 'Order Confirmed', 'Nov 8 at 9:41 PM', 'Shipped', 'Nov 9 at 7:08 PM', 'Out for delivery', 'Delivered',
      'Seller information', 'Tabitha Shippee', 'View order details'] },
  { status: 'Canceled', title: 'Nikon D7100 with 18-140mm', date: 'Nov 4, 2026',
    dialog: ['Order status', 'Nikon D7100 with 18-140mm', '$290.40 · Quantity: 1', 'Canceled', 'Your order was canceled.', 'Order Confirmed', 'Nov 4 at 10:02 AM',
      'Seller information', 'Nathan Stickler', 'View order details'] },
  { status: 'Delivered', title: 'Canon EOS 760D (Rebel T6s) with the Lens', date: 'Nov 3, 2026', listing: '1288988733112094',
    dialog: ['Order status', 'Canon EOS 760D (Rebel T6s) with the Lens', '$225.00 · Quantity: 1', 'Delivered', 'Your order was delivered.',
      'UPS TRACKING NUMBER: 1Z999AA10123456784', 'Order Confirmed', 'Nov 3 at 12:43 PM', 'Shipped', 'Nov 3 at 11:24 PM', 'Delivered', 'Nov 9 at 5:34 PM',
      'Seller information', 'Olga Serdinskaya', 'View order details'] },
  { status: 'Refunded', title: 'Fujifilm X-T3 Body', date: 'Sep 20, 2026',
    dialog: ['Order status', 'Fujifilm X-T3 Body', '$610.00 · Quantity: 1', 'Refunded', 'Seller information', 'Kelsey M', 'View order details'] }
];

/** Builds the page. `initial` cards are rendered at once; the rest load one per scroll. Records which dialogs were opened. */
function ordersPage(opts) {
  opts = opts || {};
  const opened = [];
  const banner = h('div', { role: 'banner' }, '', [h('div', { role: 'button', 'aria-label': 'Your profile' }), h('div', { role: 'button', 'aria-label': 'Notifications' })]);
  const list = h('div', { role: 'list' });
  const main = h('div', { role: 'main' }, '', [h('div', {}, 'Purchased orders'), h('div', { role: 'button' }, 'Date Range: Select'), list]);
  const body = h('body', {}, '', [banner, main]);
  const card = (o) => {
    const attrs = o.listing ? { href: '/marketplace/item/' + o.listing + '/', role: 'link' } : { role: 'link', tabindex: '0' };
    const c = h(o.listing ? 'a' : 'div', attrs, '', [h('img', { alt: '' }), h('div', {}, '', [h('span', {}, o.status), h('span', {}, o.title), h('span', {}, o.date)])]);
    c.onclick = () => {
      opened.push(o.title);
      if (opts.noDialog) return;
      setTimeout(() => {
        const close = h('div', { role: 'button', 'aria-label': 'Close' });
        const d = h('div', { role: 'dialog' }, o.dialog.join('\n'), [close]);
        close.onclick = () => d.remove();
        body.append(d);
      }, 60);
    };
    return h('div', { role: 'listitem' }, '', [c]);
  };
  const initial = opts.initial == null ? ORDERS.length : opts.initial;
  ORDERS.slice(0, initial).forEach((o) => list.append(card(o)));
  let next = initial;
  const ctx = pageContext(body, { files: FILES, url: opts.url || URL_ORDERS });
  let scrolls = 0;
  ctx.window.scrollTo = () => { scrolls++; if (next < ORDERS.length) setTimeout(() => list.append(card(ORDERS[next++])), 50); };
  return { ctx, body, opened, scrolls: () => scrolls };
}

const ITEMS = [
  { purchaseId: 'D80-1', purchasedAt: '2026-11-08', seller: 'Tabitha Shippee', cost: 200, product: 'Nikon D80' },
  { purchaseId: 'D71-1', purchasedAt: '2026-11-04', product: 'Nikon D7100' },
  { purchaseId: 'C-1', listingId: '1288988733112094', purchasedAt: '2026-11-03' }
];

test('reads every card and the Order status dialog of each card that could match (status, ETA, tracking, timeline, seller, IDs)', async () => {
  const p = ordersPage({});
  const r = await p.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28' }, FAST));
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.cardsSeen, 4);
  assert.deepEqual(Array.from(r.orders, (o) => o.status), ['shipped', 'canceled', 'delivered', 'refunded']);
  // the Sep 20 order is older than every purchase window: its dialog is not opened
  assert.deepEqual(p.opened, [ORDERS[0].title, ORDERS[1].title, ORDERS[2].title]);
  assert.equal(r.dialogsOpened, 3);
  const d80 = r.orders[0];
  assert.equal(d80.title, 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard Case and more');
  assert.equal(d80.cardTitle, 'Nikon D80 DSLR Camera Bundle – 4 Lenses, Hard C...');
  assert.equal(d80.orderDate, '2026-11-08'); assert.equal(d80.price, 200);
  assert.equal(d80.trackingNumber, '9334610579400004369609'); assert.equal(d80.carrier, 'USPS');
  assert.equal(d80.estimatedArrival, 'Nov 19'); assert.equal(d80.estimatedDelivery, '2026-11-19');
  assert.equal(d80.seller, 'Tabitha Shippee');
  assert.deepEqual(Array.from(d80.timeline, (s) => s.step + ':' + s.done), ['Order Confirmed:true', 'Shipped:true', 'Out for delivery:false', 'Delivered:false']);
  assert.equal(r.orders[1].seller, 'Nathan Stickler');
  const c1 = r.orders[2];
  assert.equal(c1.listingId, '1288988733112094'); assert.equal(c1.carrier, 'UPS'); assert.equal(c1.trackingNumber, '1Z999AA10123456784');
  assert.equal(r.orders[3].dialogOpened, false); assert.equal(r.orders[3].status, 'refunded');           // card status is still reported
  assert.equal(p.body.querySelectorAll('[role="dialog"]').length, 0);                                   // every dialog was closed again
});

test('scrolls to load older orders until one is older than the earliest needed date (cap respected)', async () => {
  const p = ordersPage({ initial: 1 });
  const r = await p.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28' }, FAST));
  assert.equal(r.ok, true);
  assert.equal(r.cardsSeen, 4);
  assert.match(r.stopReason, /reached orders older than 2026-10-28/);
  assert.equal(r.scrolls, 3);
  const capped = ordersPage({ initial: 1 });
  const r2 = await capped.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28', maxScrolls: 1 }, FAST));
  assert.equal(r2.cardsSeen, 2); assert.equal(r2.stopReason, 'scroll cap reached');
});

test('probe mode (openAll) opens every card in range; a dialog that never opens is reported per card, not as a failure', async () => {
  const p = ordersPage({ noDialog: true });
  const r = await p.ctx.PT_ordersInPage(Object.assign({ items: [], earliest: '2026-10-01', openAll: true, probe: true }, FAST));
  assert.equal(r.ok, true);
  assert.equal(new Set(p.opened).size, 3);                                                        // Sep 20 is before "earliest" (each card clicked, then re-clicked once)
  assert.equal(r.orders[0].dialogOpened, false);
  assert.match(r.orders[0].dialogError, /^DIALOG_DID_NOT_OPEN/);
  assert.equal(r.orders[0].status, 'shipped');
  assert.ok(r.probe.textPreview.includes('Purchased orders'));
});

test('empty orders page => ok with no orders; unrecognised page => ORDERS_NOT_FOUND with diagnostics', async () => {
  const empty = h('body', {}, '', [h('div', { role: 'main' }, 'Purchased orders\nYou haven\'t purchased anything yet.\n' + 'Browse Marketplace\n'.repeat(8))]);
  const r = await pageContext(empty, { files: FILES, url: URL_ORDERS }).PT_ordersInPage(Object.assign({}, FAST));
  assert.equal(r.ok, true); assert.equal(r.orders.length, 0);
  const odd = h('body', {}, '', [h('div', { role: 'main' }, 'Something went wrong. '.repeat(10))]);
  const r2 = await pageContext(odd, { files: FILES, url: URL_ORDERS }).PT_ordersInPage(Object.assign({}, FAST, { readyWaitMs: 300 }));
  assert.equal(r2.ok, false); assert.equal(r2.error, 'ORDERS_NOT_FOUND'); assert.match(r2.detail, /no order cards/);
});

test('login wall on the orders page is reported, never bypassed; a hidden login form on a signed-in page is not a wall', async () => {
  const wall = h('body', {}, 'See more on Facebook '.repeat(15), [h('form', { action: '/login/device-based/regular/login/' }, 'Log in to Facebook\nEmail or phone number\nPassword\nLog in',
    [h('input', { name: 'email' }), h('input', { name: 'pass', type: 'password' })])]);
  const r = await pageContext(wall, { files: FILES, url: URL_ORDERS }).PT_ordersInPage(Object.assign({}, FAST));
  assert.equal(r.ok, false); assert.equal(r.error, 'LOGIN_REQUIRED');
  assert.match(r.detail, /path=\/marketplace\/you\/orders\//);
  const p = ordersPage({});
  const f = h('form', { action: '/login/' }, '', [h('input', { name: 'pass', type: 'password' })]); f.hidden = true; p.body.append(f);
  const ok = await p.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28' }, FAST));
  assert.equal(ok.ok, true, ok.error);
});

test('resume: cards already read before an unexpected navigation are not opened again', async () => {
  const p = ordersPage({});
  const first = await p.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28' }, FAST));
  assert.equal(first.dialogsOpened, 3);
  p.opened.length = 0;
  const again = await p.ctx.PT_ordersInPage(Object.assign({ items: ITEMS, earliest: '2026-10-28', resume: true }, FAST));
  assert.equal(p.opened.length, 0);
  assert.equal(again.orders[0].trackingNumber, '9334610579400004369609');                       // data kept from the first pass
});

test('the page function is self-contained (serializable): without the parsers it fails cleanly', async () => {
  const ctx = pageContext(h('body', {}, 'x'), { files: ['orders-extractor.js'] });
  const isolated = pageContext(h('body', {}, 'x'));
  require('vm').runInContext('var f = ' + ctx.PT_ordersInPage.toString(), isolated);
  assert.equal((await isolated.f({})).error, 'PARSER_NOT_INJECTED');
});
