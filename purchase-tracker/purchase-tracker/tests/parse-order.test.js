'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../extension/parse-order.js');

test('USPS tracking: plain, spaced, 420-prefixed and S10 numbers', () => {
  assert.deepEqual(P.findUspsNumbers('Tracking number\n9400111899223033005282'), ['9400111899223033005282']);
  assert.deepEqual(P.findUspsNumbers('9400 1118 9922 3033 0052 82'), ['9400111899223033005282']);
  assert.deepEqual(P.findUspsNumbers('420941079400111899223033005282'), ['9400111899223033005282']);
  assert.deepEqual(P.findUspsNumbers('EA123456789US'), ['EA123456789US']);
});

test('USPS tracking: does not mistake order ids, phone numbers or zips for tracking', () => {
  assert.deepEqual(P.findUspsNumbers('Order #1234567890123456\nCall 800-555-0199\nZIP 94105'), []);
  assert.deepEqual(P.findUspsNumbers('Listing 1111111111111111'), []);          // 16 digits, wrong prefix
});

test('tracking from carrier links, including Facebook link-shim wrappers', () => {
  const direct = 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223033005282';
  assert.deepEqual(P.trackingFromHref(direct), { number: '9400111899223033005282', carrier: 'USPS' });
  const wrapped = 'https://l.facebook.com/l.php?u=' + encodeURIComponent(direct) + '&h=abc';
  assert.deepEqual(P.trackingFromHref(wrapped), { number: '9400111899223033005282', carrier: 'USPS' });
  assert.equal(P.trackingFromHref('https://www.facebook.com/marketplace/item/123/'), null);
  assert.deepEqual(P.trackingFromHref('https://www.ups.com/track?tracknum=1Z999AA10123456784'), { number: '1Z999AA10123456784', carrier: 'UPS' });
});

test('cancellation: real statements are detected', () => {
  ['Order canceled', 'Order cancelled', 'Canceled', 'Your order was canceled', 'This order has been canceled',
   'The seller canceled your order', 'Seller has cancelled this order'].forEach((l) => assert.equal(P.isCanceledLine(l), true, l));
});

test('cancellation: buttons, instructions and policy text are NOT cancellations', () => {
  ['Cancel order', 'Cancel purchase', 'You can cancel this order before it ships', 'To cancel your order, tap Cancel',
   'If the seller canceled your order, you will be refunded', 'Cancellation policy', 'Request cancellation',
   'Orders can be canceled within 24 hours'].forEach((l) => assert.equal(P.isCanceledLine(l), false, l));
});

test('parseOrderText: shipped order with tracking', () => {
  const text = ['Order details', 'Order #123456789012', 'Shipped', 'Package is on its way', 'Carrier: USPS',
    'Tracking number', '9400111899223033005282', 'Ship to', '1 Main St, Springfield', 'Item total  $450.00', 'Total $462.50'].join('\n');
  const r = P.parseOrderText(text, []);
  assert.equal(r.trackingNumber, '9400111899223033005282');
  assert.equal(r.carrier, 'USPS');
  assert.equal(r.canceled, false);
  assert.equal(r.orderId, '123456789012');
  assert.equal(r.orderTotal, '$462.50');
  assert.match(r.fbStatusRaw, /Shipped/);
  assert.doesNotMatch(r.fbStatusRaw, /Main St/);                // addresses never leak into status text
});

test('parseOrderText: awaiting shipment has no tracking and is not canceled', () => {
  const r = P.parseOrderText('Order details\nOrder placed Oct 15\nWaiting for the seller to ship\nCancel order\nYou can cancel this order before it ships', []);
  assert.equal(r.trackingNumber, '');
  assert.equal(r.canceled, false);
  assert.match(r.fbStatusRaw, /Order placed/);
});

test('parseOrderText: canceled order', () => {
  const r = P.parseOrderText('Order details\nOrder canceled\nThe seller canceled your order\nRefund issued', []);
  assert.equal(r.canceled, true);
});

test('parseOrderText: non-USPS carriers are labelled, never reported as USPS', () => {
  const r = P.parseOrderText('Shipped\nUPS\nTracking number: 1Z999AA10123456784', []);
  assert.equal(r.carrier, 'UPS');
  assert.equal(r.trackingNumber, '1Z999AA10123456784');
});

test('parseOrderText: tracking taken from a carrier link when not in the text', () => {
  const r = P.parseOrderText('Shipped\nView tracking', ['https://l.facebook.com/l.php?u=' + encodeURIComponent('https://tools.usps.com/go/TrackConfirmAction?tLabels=9205590164917312751089')]);
  assert.equal(r.trackingNumber, '9205590164917312751089');
  assert.equal(r.carrier, 'USPS');
});

test('REAL Facebook buyer_order_status page (delivered order) parses correctly', () => {
  const text = ['Order status', 'Nikon AF-P NIKKOR 70-300mm 1:4.5-6.3G ED DX Lens', '$120.00 · Quantity: 1', 'Delivered', 'Your order was delivered.', 'Oct 12, 2026',
    'USPS TRACKING NUMBER: 9334610579600003295125', 'Order Confirmed', 'Oct 8 at 9:31 AM', 'Shipped', 'Oct 8 at 8:22 PM', 'Out for delivery', 'Delivered', 'Oct 12 at 5:50 PM',
    'Seller information', 'Paulina Oax', 'Item is sold and shipped by Paulina Oax', 'Order information', 'View order details', 'Order help', 'Contact seller for help',
    'Open claim with Facebook', 'Available until December 7, 2026'].join('\n');
  const r = P.parseOrderText(text, []);
  assert.equal(r.trackingNumber, '9334610579600003295125');
  assert.equal(r.carrier, 'USPS');
  assert.equal(r.canceled, false);
  assert.equal(r.fbStatusRaw, 'Delivered | Your order was delivered. | Order Confirmed');
  assert.doesNotMatch(r.fbStatusRaw, /Paulina/);
});
