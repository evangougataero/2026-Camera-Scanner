'use strict';
/**
 * Runs the REAL in-page extractors (fb-extractor.js, signals-extractor.js) against a tiny fake DOM shaped like the
 * pages Evan sees (see the "Order status" and Meta Pay screenshots). Covers the bugs that broke tracking retrieval:
 *   - the listing rendered inside its own (longer) [role="dialog"] used to be read instead of the Order status dialog;
 *   - reading before the dialog finished rendering;
 *   - the seller name was never captured.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { h, pageContext } = require('./fake-dom');

const ORDER_LINES = ['Order status', 'Canon EOS 760D (Rebel T6s) with the Lens', '$225.00 · Quantity: 1', 'Delivered', 'Your order was delivered.', 'Nov 9, 2026',
  'USPS TRACKING NUMBER: 9334610579700004096766', 'Order Confirmed', 'Nov 3 at 12:43 PM', 'Shipped', 'Nov 3 at 11:24 PM', 'Out for delivery', 'Nov 9 at 2:10 PM',
  'Delivered', 'Nov 9 at 5:34 PM', 'Seller information', 'Olga Serdinskaya', 'Item is sold and shipped by Olga Serdinskaya', 'Order information',
  'View order details', 'Order help', 'Open claim with Facebook', 'Available until January 2, 2027'];

const LONG_DESCRIPTION = 'Canon EOS 760D (Rebel T6s) – Ready to Shoot. Canon EF-S 18–55mm IS Lens – Excellent Condition. Selling my Canon EF-S 18–55mm ' +
  'Image Stabilizer lens in excellent condition. Clean glass, no scratches. Autofocus works perfectly. Image Stabilization (IS). Smooth zoom and focus rings. ' +
  'Well cared for. Item ships in original box. '.repeat(6);

/** Facebook listing page: top nav, left Marketplace nav, the LISTING itself inside a [role=dialog] (overlay layout). */
function listingPage(opts) {
  opts = opts || {};
  const banner = h('div', { role: 'banner' }, '', [h('div', { role: 'button', 'aria-label': 'Messenger, 1 unread' }), h('div', { role: 'button', 'aria-label': 'Notifications' }), h('div', { role: 'button', 'aria-label': 'Your profile' })]);
  const nav = h('div', { role: 'navigation' }, 'Marketplace\nBrowse all\nNotifications\nInbox\nMarketplace status\nBuying\nSelling', [h('a', { href: '/marketplace/you/' }, 'Buying')]);
  const viewOrder = h('div', { role: 'button', tabindex: '0' }, '', [h('span', {}, 'View Order')]);
  const listing = h('div', { role: 'dialog' }, '', [
    h('h1', {}, 'Canon EOS 760D (Rebel T6s) with the Lens'),
    h('div', {}, '$225 $240 · Out of Stock\nShips for $13.40\nEstimated arrival Nov 23 - Nov 26'),
    h('div', { role: 'button' }, 'Save'), h('div', { role: 'button' }, 'Share'),
    h('div', {}, 'Details\nCondition Used - Good\nBrand Canon\n' + LONG_DESCRIPTION),
    opts.sellerSection === false ? h('div', {}, '') : h('div', {}, 'Seller information\nSeller details', [h('a', { href: '/marketplace/profile/100004/' }, 'Olga Serdinskaya'), h('span', {}, 'Joined Facebook in 2014')]),
    opts.noButton ? h('div', {}, '') : viewOrder
  ]);
  const body = h('body', {}, '', [banner, h('div', { role: 'main' }, 'Today\'s picks\nNikon D3300 kit $240\nSony A6000 $310', [nav]), listing]);
  if (opts.onClick) viewOrder.onclick = () => opts.onClick(body);
  return body;
}

function orderDialog(lines) { return h('div', { role: 'dialog' }, lines.join('\n')); }

const run = (body, opts) => {
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-order.js', 'fb-extractor.js'] });
  return ctx.PT_extractInPage(Object.assign({ phase: 'click' }, opts || {}));
};

test('REAL shape: View Order -> Order status dialog (listing itself in a longer dialog) => tracking, Delivered, seller, title', async () => {
  const body = listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(ORDER_LINES)), 150) });
  const r = await run(body);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.orderView, true);
  assert.equal(r.trackingNumber, '9334610579700004096766');
  assert.equal(r.carrier, 'USPS');
  assert.equal(r.fbStatusRaw, 'Delivered | Your order was delivered. | Order Confirmed');
  assert.equal(r.seller, 'Olga Serdinskaya');
  assert.equal(r.itemTitle, 'Canon EOS 760D (Rebel T6s) with the Lens');
  assert.equal(r.canceled, false);
});

test('the dialog is read only after it finished rendering (tracking arrives late)', async () => {
  const early = ORDER_LINES.filter((l) => !/TRACKING/.test(l));
  const body = listingPage({ onClick: (b) => {
    setTimeout(() => {
      const d = b.append(orderDialog(early));
      setTimeout(() => d.append(h('div', {}, 'USPS TRACKING NUMBER: 9334610579700004096766')), 650);
    }, 100);
  } });
  const r = await run(body);
  assert.equal(r.ok, true);
  assert.equal(r.trackingNumber, '9334610579700004096766');
});

test('seller-only mode returns the listing page seller without opening the order', async () => {
  let clicked = false;
  const body = listingPage({ onClick: () => { clicked = true; } });
  const r = await run(body, { mode: 'seller' });
  assert.equal(r.ok, true); assert.equal(r.mode, 'seller');
  assert.equal(r.seller, 'Olga Serdinskaya'); assert.equal(r.itemTitle, 'Canon EOS 760D (Rebel T6s) with the Lens');
  assert.equal(clicked, false);
});

test('seller comes from the Order status dialog when the listing page has no seller section', async () => {
  const body = listingPage({ sellerSection: false, onClick: (b) => setTimeout(() => b.append(orderDialog(ORDER_LINES)), 100) });
  const r = await run(body);
  assert.equal(r.seller, 'Olga Serdinskaya');
});

test('canceled / expired orders are reported with their outcome', async () => {
  const lines = ['Order status', 'Nikon D7100', '$290.40 · Quantity: 1', 'Canceled', 'Your order was canceled.', 'Nov 4, 2026', 'Order Confirmed',
    'Seller information', 'Nathan Stickler', 'Item is sold and shipped by Nathan Stickler', 'Order help'];
  const body = listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(lines)), 100) });
  const r = await run(body);
  assert.equal(r.canceled, true); assert.equal(r.outcome, 'canceled'); assert.equal(r.seller, 'Nathan Stickler');
  const exp = lines.slice(); exp[3] = 'Expired'; exp[4] = 'Your order expired because the seller did not ship it in time.';
  const r2 = await run(listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(exp)), 100) }));
  assert.equal(r2.outcome, 'expired'); assert.equal(r2.canceled, true);
});

test('read phase on an order page (no dialog) parses the page body', async () => {
  const body = h('body', {}, '', [h('div', { role: 'main' }, ORDER_LINES.join('\n'))]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-order.js', 'fb-extractor.js'], url: 'https://www.facebook.com/marketplace/buyer_order_status/?id=123456789012' });
  const r = await ctx.PT_extractInPage({ phase: 'read' });
  assert.equal(r.ok, true); assert.equal(r.trackingNumber, '9334610579700004096766'); assert.equal(r.orderId, '123456789012');
});

test('login wall is reported, never bypassed', async () => {
  const body = h('body', {}, 'Log in to Facebook '.repeat(20), [h('form', { action: '/login/device-based/' }, '', [h('input', { name: 'pass' })])]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-order.js', 'fb-extractor.js'], url: 'https://www.facebook.com/login/?next=x' });
  const r = await ctx.PT_extractInPage({ phase: 'click' });
  assert.equal(r.ok, false); assert.equal(r.error, 'LOGIN_REQUIRED');
});

// ---------------------------------------------------------------- login false positives (FIX A)
const FB_FILES = ['login-guard.js', 'parse-order.js', 'fb-extractor.js'];
const hiddenLogin = () => { const f = h('form', { action: '/login/device-based/regular/login/' }, '', [h('input', { name: 'pass', type: 'password' })]); f.hidden = true; return f; };

test('signed-in listing page with a HIDDEN login form / password field in the DOM is NOT a login wall', async () => {
  const body = listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(ORDER_LINES)), 100) });
  body.append(hiddenLogin());
  const r = await run(body);
  assert.equal(r.ok, true, r.error); assert.equal(r.trackingNumber, '9334610579700004096766');
});

test('a VISIBLE password field on a page that still shows signed-in nav (Messenger / Your profile) is NOT a login wall', async () => {
  const body = listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(ORDER_LINES)), 100) });
  body.append(h('div', {}, 'Confirm', [h('input', { type: 'password' })]));
  const r = await run(body);
  assert.equal(r.ok, true, r.error);
});

test('"login" only in the query string is not a login wall; a visible login form with no signed-in UI is (with path + snippet)', async () => {
  const body = listingPage({ onClick: (b) => setTimeout(() => b.append(orderDialog(ORDER_LINES)), 100) });
  const ctx = pageContext(body, { files: FB_FILES, url: 'https://www.facebook.com/marketplace/item/1288988733112094/?next=%2Flogin%2F&ref=login' });
  const ok = await ctx.PT_extractInPage({ phase: 'click' });
  assert.equal(ok.ok, true, ok.error);

  const wall = h('body', {}, 'See more on Facebook '.repeat(15), [h('form', { action: '/login/device-based/regular/login/' }, 'Log in to Facebook\nEmail or phone number\nPassword\nLog in',
    [h('input', { name: 'email' }), h('input', { name: 'pass', type: 'password' })])]);
  const ctx2 = pageContext(wall, { files: FB_FILES, url: 'https://www.facebook.com/marketplace/item/1288988733112094/', title: 'Facebook' });
  const r = await ctx2.PT_extractInPage({ phase: 'click' });
  assert.equal(r.ok, false); assert.equal(r.error, 'LOGIN_REQUIRED');
  assert.match(r.detail, /^via visible-password · path=\/marketplace\/item\/1288988733112094\/ · "Facebook \| Log in to Facebook/);
  assert.ok(r.detail.length <= 220);
});

test('PTGuard: pathname-only URL rule, checkpoint paths, privacy-trimmed snippets', () => {
  const ctx = pageContext(h('body', {}, 'x'), { files: ['login-guard.js'] });
  const G = ctx.PTGuard;
  assert.equal(G.pathBlocker('https://www.facebook.com/login/?next=x'), 'LOGIN_REQUIRED');
  assert.equal(G.pathBlocker('https://www.facebook.com/login.php'), 'LOGIN_REQUIRED');
  assert.equal(G.pathBlocker('https://www.facebook.com/checkpoint/1501092823525282/'), 'CHECKPOINT');
  assert.equal(G.pathBlocker('https://www.facebook.com/marketplace/notifications/?ref=login'), null);
  assert.equal(G.pathBlocker('https://www.facebook.com/marketplace/item/1/?next=/checkpoint/'), null);
  assert.equal(G.pathBlocker('https://www.facebook.com/marketplace/item/loginhelper/'), null);
  assert.equal(G.snippet('mail me at a.b@example.com, id 100004123456789 ' + 'x'.repeat(300)).length, 150);
  assert.match(G.snippet('mail me at a.b@example.com, id 100004123456789'), /\[email\].*\[#\]/);
});

test('notifications page with hidden login nodes (signed in) is read normally', async () => {
  const body = h('body', {}, '', [
    h('div', { role: 'banner' }, '', [h('div', { role: 'button', 'aria-label': 'Account controls and settings' })]),
    h('div', { role: 'main' }, 'Marketplace notifications\n' + 'Older\n'.repeat(40), [
      h('a', { href: '/marketplace/item/7777777777777777/', role: 'row' }, 'Kelsey canceled your order for Fuji X-T3. 3h')]),
    hiddenLogin()]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: 'https://www.facebook.com/marketplace/notifications/' });
  const r = await ctx.PT_notificationsInPage({ maxRounds: 1 });
  assert.equal(r.ok, true, r.error + ' ' + r.detail);
});

// ---------------------------------------------------------------- View Order missing (FIX B)
const SOLD_LINE = (state) => h('div', {}, state);
test('no View Order button: the extractor reports what the listing shows (Sold / Pending / nothing) — never a cancel by itself', async () => {
  for (const [line, want] of [['Sold', 'sold'], ['Pending', 'pending'], ['', '']]) {
    const body = listingPage({ noButton: true });
    if (line) body.children[2].children.splice(1, 0, Object.assign(SOLD_LINE(line), { parent: body.children[2] }));
    const r = await run(body, { buttonWaitMs: 300 });
    assert.equal(r.ok, false); assert.equal(r.error, 'ORDER_DETAILS_NOT_FOUND');
    assert.equal(r.listingState, want, line);
    assert.equal(r.seller, 'Olga Serdinskaya');
    assert.equal(r.canceled, undefined);
    if (want) assert.match(r.detail, new RegExp('^listing shows ' + want));
  }
});

test('page functions are self-contained (serializable): without the parser they fail cleanly', async () => {
  const ctx = pageContext(h('body', {}, 'x'), { files: ['fb-extractor.js', 'signals-extractor.js', 'usps-extractor.js'] });
  for (const fn of ['PT_extractInPage', 'PT_metaPayInPage', 'PT_notificationsInPage', 'PT_uspsInPage']) {
    const isolated = pageContext(h('body', {}, 'x'));
    require('vm').runInContext('var f = ' + ctx[fn].toString(), isolated);
    const r = await isolated.f({ number: '9400111899223033005282' });
    assert.equal(r.error, 'PARSER_NOT_INJECTED', fn);
  }
});

// ---------------------------------------------------------------- Meta Pay + notifications page functions
const WALLET = ['All', 'Money transfer', 'Orders', 'Donations', 'Games', 'Others',
  'Olga Serdinskaya', 'Delivered', 'Nov 3, 2026', '$262.84', 'Nathan Stickler', 'Canceled', 'Nov 3, 2026', '$290.40'];

test('Meta Pay page function reads wallet rows', async () => {
  const body = h('body', {}, '', [h('div', { role: 'main' }, '', WALLET.map((l) => h('div', {}, l)))]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: 'https://accountscenter.facebook.com/meta_pay_wallet/' });
  const r = await ctx.PT_metaPayInPage({ maxRounds: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.transactions, (t) => t.seller + '|' + t.status + '|' + t.date + '|' + t.amount),
    ['Olga Serdinskaya|Delivered|2026-11-03|262.84', 'Nathan Stickler|Canceled|2026-11-03|290.4']);
});

const WALLET_URL = 'https://accountscenter.facebook.com/meta_pay_wallet/';
const WALLET_SHELL = ['Accounts Center', 'Meta Pay', 'Payment methods', 'Manage your payment methods, see your transactions and change settings.', 'Transactions'];

test('Meta Pay page function: transaction rows rendered LATE (client-side, after the heading) are still captured', async () => {
  const list = h('div', { role: 'main' }, '', WALLET_SHELL.map((l) => h('div', {}, l)));
  const body = h('body', {}, '', [list]);
  setTimeout(() => WALLET.forEach((l) => list.append(h('div', {}, l))), 1200);                    // rows arrive ~1.2 s after "complete"
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: WALLET_URL });
  const r = await ctx.PT_metaPayInPage({ maxRounds: 1 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.transactions.length, 2);
  assert.equal(r.transactions[1].status, 'Canceled');
});

test('Meta Pay page function: rows that never appear => META_PAY_NO_TRANSACTIONS with diagnostics (after waiting)', async () => {
  const body = h('body', {}, '', [h('div', { role: 'main' }, '', WALLET_SHELL.map((l) => h('div', {}, l)))]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: WALLET_URL });
  const t0 = Date.now();
  const r = await ctx.PT_metaPayInPage({ maxRounds: 1, rowWaitMs: 600, afterHeadingMs: 600 });
  assert.equal(r.ok, false); assert.equal(r.error, 'META_PAY_NO_TRANSACTIONS');
  assert.ok(Date.now() - t0 >= 1100, 'waited for the rows (and longer once the Transactions heading was seen)');
  assert.match(r.detail, /heading seen/); assert.match(r.detail, /visibility=hidden/);
});

test('Meta Pay password prompt => REAUTH_REQUIRED (never bypassed)', async () => {
  const body = h('body', {}, 'Re-enter your password to continue. For your security, please confirm it is you. '.repeat(3), [h('input', { type: 'password' })]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: 'https://accountscenter.facebook.com/meta_pay_wallet/' });
  const r = await ctx.PT_metaPayInPage({});
  assert.equal(r.ok, false); assert.equal(r.error, 'REAUTH_REQUIRED');
});

test('notifications page function returns order events with linked listing IDs', async () => {
  const body = h('body', {}, '', [h('div', { role: 'main' }, ['Marketplace notifications', 'Earlier', 'Mark all as read',
    'Notification settings for Marketplace buying and selling activity'].join('\n'), [
    h('a', { href: '/marketplace/item/5555555555555555/', role: 'row' }, 'Nathan Stickler canceled your order for Nikon D7100 with 18-140mm lens. 1w'),
    h('a', { href: '/marketplace/item/6666666666666666/', role: 'row' }, 'Price drop: Sony A7 III is now $900 · 2d'),
    h('a', { href: '/marketplace/item/7777777777777777/', role: 'row' }, 'Kelsey wants to cancel your order for Fuji X-T3. 3h')
  ])]);
  const ctx = pageContext(body, { files: ['login-guard.js', 'parse-signals.js', 'signals-extractor.js'], url: 'https://www.facebook.com/marketplace/notifications/' });
  const r = await ctx.PT_notificationsInPage({ maxRounds: 1 });
  assert.equal(r.ok, true);
  const canc = r.notifications.filter((n) => n.kind === 'canceled');
  assert.equal(canc.length, 1); assert.deepEqual(Array.from(canc[0].listingIds), ['5555555555555555']);
  assert.ok(r.notifications.some((n) => n.kind === 'cancel_requested'));
  assert.ok(!r.notifications.some((n) => /Price drop/.test(n.text)));
});
