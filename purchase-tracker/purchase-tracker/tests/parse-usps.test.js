'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const U = require('../extension/parse-usps.js');
const N = '9400111899223033005282';

test('result page: status, history and delivery window are read as seen', () => {
  const text = ['Tracking', N, 'Latest Update', 'In Transit, Arriving Late', 'Expected Delivery by', 'SATURDAY', '24 October 2026', 'Tracking History',
    'October 20, 2026, 7:31 am', 'Departed USPS Regional Facility', 'RICHMOND VA DISTRIBUTION CENTER', 'October 19, 2026, 3:00 pm', 'USPS in possession of item', 'Product Information', 'Postal Product: Priority Mail'].join('\n');
  const r = U.parseUspsText(text, N);
  assert.equal(r.numberSeen, true);
  assert.equal(r.status, 'In Transit, Arriving Late');
  assert.ok(r.history.includes('USPS in possession of item')); assert.ok(!r.history.includes('Postal Product: Priority Mail'));
  assert.match(r.expectedDelivery, /SATURDAY 24 October 2026/);
});

test('result page for a DIFFERENT number is flagged (never write another package\'s data)', () => {
  assert.equal(U.parseUspsText('Latest Update\nDelivered\n9205590164917312751089', N).numberSeen, false);
});

test('spaced tracking number on the page still counts as seen', () => {
  assert.equal(U.parseUspsText('9400 1118 9922 3033 0052 82\nLatest Update\nOut for Delivery', N).numberSeen, true);
});

test('fallback: status found without a "Latest Update" label', () => {
  assert.equal(U.parseUspsText('Tracking ' + N + '\nLabel Created, not yet in system\nmore', N).status, 'Label Created, not yet in system');
});

test('not-found page', () => {
  const r = U.parseUspsText('Status Not Available\nThe tracking number you entered could not be found', N);
  assert.equal(r.notFound, true); assert.equal(r.status, '');
});

test('no delivery date shown => blank, not invented', () => {
  assert.equal(U.parseUspsText('Latest Update\nLabel Created\n' + N, N).expectedDelivery, '');
});

test('REAL page shape: banner status wins over the "Latest Update" sentence', () => {
  const text = ['Tracking', N, 'Delivered, Individual Picked Up at Post Office', 'LOS ANGELES, CA 90049', 'Latest Update',
    'Your item was picked up at the post office at 10:50 am on October 12, 2026 in LOS ANGELES, CA 90049.', 'Get More Out of USPS Tracking:'].join('\n');
  const r = U.parseUspsText(text, N);
  assert.equal(r.status, 'Delivered, Individual Picked Up at Post Office');
  assert.match(r.summary, /picked up at the post office/);
});

test('when only the sentence is present it is still captured (and classified downstream)', () => {
  const r = U.parseUspsText(['Tracking', N, 'Latest Update', 'Your item was picked up at the post office at 10:50 am on October 12, 2026 in LOS ANGELES, CA 90049.'].join('\n'), N);
  assert.match(r.status, /picked up at the post office/);
});
