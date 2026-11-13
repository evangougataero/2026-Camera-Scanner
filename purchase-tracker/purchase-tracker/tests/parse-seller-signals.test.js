'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../extension/parse-order.js');
const S = require('../extension/parse-signals.js');

// The exact text of the "Order status" dialog in fb-order-status.png (incl. the icon glyph after the title).
const SCREENSHOT = ['Order status', 'Canon EOS 760D (Rebel T6s) with the Lens', '$225.00 · Quantity: 1', 'Delivered', 'Your order was delivered.', 'Nov 9, 2026',
  'USPS TRACKING NUMBER: 9334610579700004096766', 'Order Confirmed', 'Nov 3 at 12:43 PM', 'Shipped', 'Nov 3 at 11:24 PM', 'Out for delivery', 'Nov 9 at 2:10 PM',
  'Delivered', 'Nov 9 at 5:34 PM', 'Seller information', 'Olga Serdinskaya', 'Item is sold and shipped by Olga Serdinskaya', 'Order information',
  'View order details', 'Order help', 'Open claim with Facebook', 'Available until January 2, 2027'].join('\n');

// ---------------------------------------------------------------- order dialog
test('screenshot dialog: tracking, carrier, Delivered headline, seller and item title', () => {
  const r = P.parseOrderText(SCREENSHOT, []);
  assert.equal(r.trackingNumber, '9334610579700004096766');
  assert.equal(r.carrier, 'USPS');
  assert.equal(r.fbStatusRaw, 'Delivered | Your order was delivered. | Order Confirmed');
  assert.equal(r.seller, 'Olga Serdinskaya');
  assert.equal(r.itemTitle, 'Canon EOS 760D (Rebel T6s) with the Lens');
  assert.equal(r.canceled, false); assert.equal(r.outcome, '');
  assert.equal(P.looksLikeOrderView(SCREENSHOT), true);
});

test('a listing page (with "View Order", seller section, shipping line) is NOT an order view', () => {
  const listing = ['Canon EOS 760D (Rebel T6s) with the Lens', '$225 $240 · Out of Stock', 'Ships for $13.40', 'Estimated arrival Nov 23 - Nov 26',
    'Save', 'Share', 'Details', 'Condition Used - Good', 'Seller information', 'Seller details', 'Olga Serdinskaya', 'Joined Facebook in 2014', 'View Order'].join('\n');
  assert.equal(P.looksLikeOrderView(listing), false);
  assert.equal(P.parseSeller(listing), 'Olga Serdinskaya');
});

test('carrier-labelled tracking lines (spaced, UPS, FedEx) are read with the right carrier', () => {
  assert.deepEqual(pick(P.parseOrderText('Shipped\nUSPS TRACKING NUMBER: 9400 1118 9922 3033 0052 82', [])), ['9400111899223033005282', 'USPS']);
  assert.deepEqual(pick(P.parseOrderText('Shipped\nUPS TRACKING NUMBER: 1Z999AA10123456784', [])), ['1Z999AA10123456784', 'UPS']);
  assert.deepEqual(pick(P.parseOrderText('Shipped\nFEDEX TRACKING NUMBER: 123456789012', [])), ['123456789012', 'FedEx']);
  assert.deepEqual(pick(P.parseOrderText('Shipped\nView tracking', ['https://tools.usps.com/tracking/9334610579700004096766'])), ['9334610579700004096766', 'USPS']);
});
function pick(r) { return [r.trackingNumber, r.carrier]; }

test('outcomes: expired and refunded headlines cancel; a delivered order mentioning a refund claim does not', () => {
  const exp = P.parseOrderText('Order status\nX\n$5.00 · Quantity: 1\nExpired\nYour order expired because the seller did not ship in time\nOrder Confirmed', []);
  assert.equal(exp.outcome, 'expired'); assert.equal(exp.canceled, true);
  const ref = P.parseOrderText('Order status\nX\n$5.00 · Quantity: 1\nRefunded\nYour order was refunded.\nOrder Confirmed', []);
  assert.equal(ref.outcome, 'refunded'); assert.equal(ref.canceled, true);
  const can = P.parseOrderText('Order status\nCanceled\nYour order was canceled.\nOrder Confirmed', []);
  assert.equal(can.outcome, 'canceled');
  const claim = P.parseOrderText('Order status\nDelivered\nYour order was delivered.\nOrder help\nRefunds are issued after a claim is approved', []);
  assert.equal(claim.outcome, ''); assert.equal(claim.canceled, false);
  ['You can request a refund', 'If your order expired you will be refunded', 'Refund policy'].forEach((l) => assert.equal(P.outcomeOfLine(l), '', l));
});

test('"Item is sold and shipped by <seller>" is not a status line (it never leaks into FB Status)', () => {
  assert.equal(P.isStatusLine('Item is sold and shipped by Olga Serdinskaya'), false);
  const r = P.parseOrderText('Seller information\nOlga Serdinskaya\nItem is sold and shipped by Olga Serdinskaya\nOrder Confirmed', []);
  assert.doesNotMatch(r.fbStatusRaw, /Olga/);
});

// ---------------------------------------------------------------- seller
test('seller: strongest phrase wins; heading formats; UI labels and sentences are never names', () => {
  assert.equal(P.parseSeller('Sold by Jean-Luc Picard'), 'Jean-Luc Picard');
  assert.equal(P.parseSeller('Seller information\nSeller details\nNathan Stickler\n(12)\nJoined Facebook in 2012'), 'Nathan Stickler');
  assert.equal(P.parseSeller('About the seller\nTysha A. Rodriguez\nHighly rated'), 'Tysha A. Rodriguez');
  assert.equal(P.parseSeller('Seller information\nSeller details\nMessage\nSee more'), '');
  assert.equal(P.parseSeller('Seller information\nThis seller usually responds within an hour and ships fast.'), '');
  assert.equal(P.parseSeller('Item is sold and shipped by $5.00'), '');
  assert.equal(P.parseSeller(''), '');
  ['Message seller', 'Seller details', 'Joined Facebook in 2014', 'Delivered', '$225.00', 'See more', '(4)'].forEach((s) => assert.equal(P.isNameLike(s), false, s));
  ['Olga Serdinskaya', 'Paulina Oax', 'Mark Afanasyev', 'Ольга Сердинская'].forEach((s) => assert.equal(P.isNameLike(s), true, s));
});

// ---------------------------------------------------------------- Meta Pay wallet
const WALLET = ['All', 'Money transfer', 'Orders', 'Donations', 'Games', 'Others',
  'Kelsey Bob Ramage', 'Confirmed', 'Nov 11, 2026', '$193.26', 'Rameek Zaimire Wylie', 'Confirmed', 'Nov 11, 2026', '$180.15',
  'Tabitha Shippee', 'May be delayed', 'Nov 8, 2026', '$240.04', 'Olga Serdinskaya', 'Delivered', 'Nov 3, 2026', '$262.84',
  'Nathan Stickler', 'Canceled', 'Nov 3, 2026', '$290.40', 'Tysha A Rodriguez', 'Expired', 'Oct 30, 2026', '$240.04',
  'Mark Afanasyev', 'Refunded', 'Oct 26, 2026', '$267.60', 'Eric Angeles', 'Canceled', 'Oct 8, 2026', '$207.47',
  'Paulina Oax', 'Delivered', 'Oct 8, 2026', '$143.12'].join('\n');
const NOW = Date.UTC(2026, 10, 13, 18);

test('Meta Pay screenshot: every row read (seller, status, date, amount); filter tabs ignored', () => {
  const t = S.parseMetaPayText(WALLET, NOW);
  assert.equal(t.length, 9);
  assert.equal(JSON.stringify(t.map((x) => [x.seller, x.status, x.date, x.amount])), JSON.stringify([
    ['Kelsey Bob Ramage', 'Confirmed', '2026-11-11', 193.26], ['Rameek Zaimire Wylie', 'Confirmed', '2026-11-11', 180.15],
    ['Tabitha Shippee', 'May be delayed', '2026-11-08', 240.04], ['Olga Serdinskaya', 'Delivered', '2026-11-03', 262.84],
    ['Nathan Stickler', 'Canceled', '2026-11-03', 290.4], ['Tysha A Rodriguez', 'Expired', '2026-10-30', 240.04],
    ['Mark Afanasyev', 'Refunded', '2026-10-26', 267.6], ['Eric Angeles', 'Canceled', '2026-10-08', 207.47], ['Paulina Oax', 'Delivered', '2026-10-08', 143.12]]));
});

test('Meta Pay: amount-before-name layout never takes the NEXT row amount; "Cancelled"; no-year/relative dates; repeats collapsed', () => {
  const t = S.parseMetaPayText(['$1,050.00', 'Big Seller', 'Cancelled', 'Today', '-$45.00', 'Jo Doe', 'Refunded', 'Nov 2'].join('\n'), NOW);
  assert.equal(t.length, 2);
  assert.equal(t[0].seller, 'Big Seller'); assert.equal(t[0].status, 'Canceled'); assert.equal(t[0].amount, 1050); assert.equal(t[0].date, '2026-11-13');
  assert.equal(t[1].seller, 'Jo Doe'); assert.equal(t[1].date, '2026-11-02'); assert.equal(t[1].amount, 45);
  const noAmount = S.parseMetaPayText(['Ann Lee', 'Confirmed', 'Nov 10, 2026', 'Bo Kim', 'Delivered', 'Nov 9, 2026', '$20.00'].join('\n'), NOW);
  assert.equal(noAmount[0].amount, '');                                                        // the next row's $20 is not Ann's
  assert.equal(noAmount[1].amount, 20);
  const block = ['Olga Serdinskaya', 'Delivered', 'Nov 3, 2026', '$262.84'];
  assert.equal(S.parseMetaPayText(block.concat(block).join('\n'), NOW).length, 1);             // a re-rendered duplicate row
  assert.equal(S.parseWalletDate('Dec 30', Date.UTC(2027, 0, 3)), '2026-12-30');            // no year => most recent past date
  assert.equal(S.parseWalletDate('Feb 30, 2026', NOW), '');
  assert.equal(S.parseMetaPayText('Settings\nHelp\nNo activity yet', NOW).length, 0);
});

// ---------------------------------------------------------------- notifications
test('notification classification: real cancellations vs. requests, instructions and other events', () => {
  const c = (t) => S.classifyNotification(t);
  assert.equal(c('Nathan Stickler canceled your order for Nikon D7100'), 'canceled');
  assert.equal(c('Your order for Fuji X-T3 has been cancelled.'), 'canceled');
  assert.equal(c('Your order for Fuji X-T3 expired because it was not shipped in time'), 'expired');
  assert.equal(c('You have been refunded $267.60 for Sony 85mm'), 'refunded');
  assert.equal(c('Your order for Canon 760D was delivered'), 'delivered');
  assert.equal(c('Kelsey wants to cancel your order for Sony A7 III'), 'cancel_requested');
  assert.equal(c('Seller requested to cancel the order'), 'cancel_requested');
  assert.equal(c('You can cancel your order before it ships'), '');
  assert.equal(c('Price drop: Sony A7 III is now $900'), '');
  assert.equal(c('Your offer on Nikon Z6 expired'), 'expired');
});

test('notification relative ages and listing ids; duplicates removed; non-events dropped', () => {
  assert.equal(S.parseRelativeAge('… · 3d'), 3 * 86400000);
  assert.equal(S.parseRelativeAge('… 1w'), 7 * 86400000);
  assert.equal(S.parseRelativeAge('5 hours ago'), 5 * 3600000);
  assert.equal(S.parseRelativeAge('an hour ago'), 3600000);
  assert.equal(S.parseRelativeAge('Yesterday'), 86400000);
  assert.equal(S.parseRelativeAge('no time here'), '');
  const n = S.parseNotifications([
    { text: 'Nathan canceled your order for Nikon D7100. 1w', hrefs: ['https://www.facebook.com/marketplace/item/5555555555555555/?ref=notif'] },
    { text: 'Nathan canceled your order for Nikon D7100. 1w', hrefs: [] },
    'Price drop on something you saved · 2d'
  ], NOW);
  assert.equal(n.length, 1);
  assert.equal(JSON.stringify(n[0].listingIds), JSON.stringify(['5555555555555555']));
  assert.equal(n[0].atMs, NOW - 7 * 86400000);
});
