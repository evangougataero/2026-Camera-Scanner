'use strict';
/** Pure Logic.gs / Dashboard.gs functions for seller capture, cancellation signals and Meta Pay / notification matching. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext } = require('./harness');
const g = buildContext().ctx;

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 13, 18);
const at = (y, m, d, hh) => new Date(Date.UTC(y, m - 1, d, (hh || 12) + 8));   // ~local PT time -> UTC
const rec = (o) => Object.assign({ 'Purchase ID': '1-1', 'Listing ID': '1288988733112094', 'Purchase Status': 'Purchased', 'Purchased At': at(2026, 11, 3),
  Product: 'Canon EOS 760D + Canon EF-S 18-55mm lens', 'Purchase Cost': 262.84, 'Tracking Number': '', Notes: '', Seller: 'Olga Serdinskaya' }, o);
const tx = (o) => Object.assign({ seller: 'Olga Serdinskaya', status: 'Delivered', date: '2026-11-03', amount: 262.84 }, o);
const plan = (txs, recs) => g.planMetaPayUpdates_(txs, recs, '2026-11-13 10:00', { daysBefore: 6, daysAfter: 2 });
const SELLER_CFG = { FB_RECHECK_MINUTES: 150, FB_TRACKING_RECHECK_MINUTES: 1440, FB_SELLER_RECHECK_MINUTES: 360, SELLER_MAX_ATTEMPTS: 3 };

// ---------------------------------------------------------------- seller capture
test('seller + FB listing title fill blanks from ANY Facebook result (even a failed one), never overwrite', () => {
  const p = g.applyFbResult_(rec({ Seller: '' }), { ok: true, fbStatusRaw: 'Order Confirmed', seller: 'Olga Serdinskaya', itemTitle: 'Canon EOS 760D (Rebel T6s) with the Lens' }, 'ts');
  assert.equal(p.Seller, 'Olga Serdinskaya'); assert.equal(p['FB Listing Title'], 'Canon EOS 760D (Rebel T6s) with the Lens');
  const fail = g.applyFbResult_(rec({ Seller: '' }), { ok: false, error: 'ORDER_DETAILS_DID_NOT_OPEN', seller: 'Olga Serdinskaya' }, 'ts');
  assert.equal(fail.Seller, 'Olga Serdinskaya'); assert.equal(fail['FB Error Count'], 1);
  assert.equal(g.applyFbResult_(rec({ Seller: 'Someone Else' }), { ok: true, seller: 'Olga Serdinskaya' }, 'ts').Seller, undefined);
});

test('seller-only result: fills seller, never touches status / tracking / error count; counts misses', () => {
  const p = g.applySellerResult_(rec({ Seller: '', 'Purchase Status': 'Delivered', 'FB Error Count': 2 }), { ok: true, mode: 'seller', seller: 'Olga Serdinskaya' }, 'ts');
  assert.equal(p.Seller, 'Olga Serdinskaya'); assert.equal(p['Purchase Status'], undefined); assert.equal(p['FB Error Count'], undefined);
  assert.equal(p['Last FB Check'], 'ts'); assert.equal(p['Seller Attempts'], undefined);
  const miss = g.applySellerResult_(rec({ Seller: '', 'Seller Attempts': 1 }), { ok: false, error: 'SELLER_NOT_FOUND' }, 'ts');
  assert.equal(miss['Seller Attempts'], 2); assert.equal(miss.Seller, undefined);
});

test('seller backfill is due for rows the order checks no longer visit (shipped/delivered/canceled), capped and throttled', () => {
  const due = (o) => g.isSellerBackfillDue_(rec(Object.assign({ Seller: '' }, o)), NOW, SELLER_CFG);
  assert.equal(due({ 'Purchase Status': 'Delivered' }), true);
  assert.equal(due({ 'Purchase Status': 'Shipped', 'USPS Accepted At': 'x' }), true);
  assert.equal(due({ 'Purchase Status': 'Canceled' }), true);                                   // needed to match Meta Pay refunds
  assert.equal(due({ 'Purchase Status': 'Tracking Available', 'USPS Accepted At': 'x' }), true);
  assert.equal(due({ 'Purchase Status': 'Purchased' }), false);                                  // regular order checks capture it
  assert.equal(due({ 'Purchase Status': 'Tracking Available' }), false);
  assert.equal(due({ 'Purchase Status': 'Voided' }), false);
  assert.equal(due({ 'Purchase Status': 'Delivered', Seller: 'Olga' }), false);
  assert.equal(due({ 'Purchase Status': 'Delivered', 'Seller Attempts': 3 }), false);
  assert.equal(due({ 'Purchase Status': 'Delivered', 'Last FB Check': new Date(NOW - 2 * 3600000) }), false);
  assert.equal(due({ 'Purchase Status': 'Delivered', 'Last FB Check': new Date(NOW - 7 * 3600000) }), true);
  assert.equal(due({ 'Purchase Status': 'Delivered', 'Purchase ID': 'TEST-1' }), false);
});

// ---------------------------------------------------------------- Facebook order outcomes
test('Facebook order page: expired / refunded / canceled outcomes => Canceled + Cancel Signal (+ Refund Received)', () => {
  const e = g.applyFbResult_(rec(), { ok: true, canceled: true, outcome: 'expired', fbStatusRaw: 'Expired | Your order expired' }, 'ts');
  assert.equal(e['Purchase Status'], 'Canceled'); assert.equal(e['Cancel Signal'], 'Expired — Facebook order status (Expired)');
  const r = g.applyFbResult_(rec(), { ok: true, canceled: true, outcome: 'refunded' }, 'ts');
  assert.equal(r['Purchase Status'], 'Canceled'); assert.equal(r['Refund Received'], 'Y');
  const c = g.applyFbResult_(rec(), { ok: true, canceled: true }, 'ts');                       // older extension: no outcome field
  assert.equal(c['Purchase Status'], 'Canceled'); assert.match(c['Cancel Signal'], /^Canceled — Facebook order status/);
  const healthy = g.applyFbResult_(rec(), { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true }, 'ts');
  assert.equal(healthy['Cancel Signal'], 'Canceled — Facebook listing: View Order button missing');
});

test('Meta Pay "Delivered" counts as Facebook-confirmed delivery (status + transfer eligibility)', () => {
  assert.equal(g.fbSaysDelivered_({ 'Meta Pay Status': 'Delivered · 2026-11-03 · $262.84' }), true);
  assert.equal(g.fbSaysDelivered_({ 'Meta Pay Status': 'Confirmed · 2026-11-11 · $193.26' }), false);
  assert.equal(g.isTransferEligible_(rec({ 'Meta Pay Status': 'Delivered · 2026-11-03 · $262.84', 'Purchase Status': 'Delivered' })), true);
});

// ---------------------------------------------------------------- cancelPatch_
test('cancelPatch_: strict sources never cancel shipped/delivered/transferred rows — they ask for a review instead', () => {
  const ok = g.cancelPatch_(rec(), 'canceled', 'Meta Pay', 'x', 'ts', true);
  assert.equal(ok['Purchase Status'], 'Canceled'); assert.equal(ok['Cancel Signal'], 'Canceled — Meta Pay (x)');
  [{ 'USPS Accepted At': 'x' }, { 'USPS Stage': 'Delivered' }, { 'FB Status (raw)': 'Delivered' }, { 'Transferred to eBay?': 'Y' }].forEach((o) => {
    const p = g.cancelPatch_(rec(o), 'canceled', 'Meta Pay', 'x', 'ts', true);
    assert.equal(p['Purchase Status'], undefined, JSON.stringify(o)); assert.match(p['Cancel Signal'], /^Review: Canceled — Meta Pay/); assert.match(p.Notes, /review manually/);
  });
  assert.equal(JSON.stringify(g.cancelPatch_(rec({ 'Purchase Status': 'Voided' }), 'canceled', 'Meta Pay', 'x', 'ts', true)), '{}');
  // already canceled: a refund confirmation enriches it; a repeated cancel changes nothing
  const ref = g.cancelPatch_(rec({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Canceled — Facebook listing: View Order button missing' }), 'refunded', 'Meta Pay', 'x', 'ts', true);
  assert.equal(ref['Refund Received'], 'Y'); assert.equal(ref['Cancel Signal'], 'Refunded — Meta Pay (x)'); assert.equal(ref['Purchase Status'], undefined);
  assert.equal(JSON.stringify(g.cancelPatch_(rec({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Canceled — x' }), 'canceled', 'Meta Pay', 'x', 'ts', true)), '{}');
});

// ---------------------------------------------------------------- Meta Pay matching
test('names: exact (accents/case/spacing ignored), partial (middle initial), different', () => {
  assert.equal(g.sellerMatchLevel_('Olga Serdinskaya', ' olga  SERDÍNSKAYA '), 2);
  assert.equal(g.sellerMatchLevel_('Tysha A Rodriguez', 'Tysha Rodriguez'), 1);
  assert.equal(g.sellerMatchLevel_('Kelsey Bob Ramage', 'Kelsey Ramage'), 1);
  assert.equal(g.sellerMatchLevel_('Mark Afanasyev', 'Mark Stevens'), 0);
  assert.equal(g.sellerMatchLevel_('Olga', 'Olga Serdinskaya'), 0);                             // one word is never enough
  assert.equal(g.sellerMatchLevel_('', 'Olga'), 0);
});

test('screenshot rows: Delivered -> Delivered; Canceled -> Canceled; Refunded -> Canceled + refund; Expired (partial name) -> Canceled', () => {
  const recs = [
    rec({ 'Purchase ID': 'A-1', Seller: 'Olga Serdinskaya', 'Purchased At': at(2026, 11, 3), 'Purchase Cost': 262.84 }),
    rec({ 'Purchase ID': 'B-1', Seller: 'Nathan Stickler', 'Purchased At': at(2026, 11, 3), 'Purchase Cost': 290.40 }),
    rec({ 'Purchase ID': 'C-1', Seller: 'Mark Afanasyev', 'Purchased At': at(2026, 10, 27), 'Purchase Cost': 267.60 }),
    rec({ 'Purchase ID': 'D-1', Seller: 'Tysha Rodriguez', 'Purchased At': at(2026, 10, 30), 'Purchase Cost': 240.04 }),
    rec({ 'Purchase ID': 'E-1', Seller: 'Tabitha Shippee', 'Purchased At': at(2026, 11, 8), 'Purchase Cost': '' })
  ];
  const r = plan([tx(), tx({ seller: 'Nathan Stickler', status: 'Canceled', amount: 290.40 }), tx({ seller: 'Mark Afanasyev', status: 'Refunded', date: '2026-10-26', amount: 267.60 }),
    tx({ seller: 'Tysha A Rodriguez', status: 'Expired', date: '2026-10-30', amount: 240.04 }), tx({ seller: 'Tabitha Shippee', status: 'May be delayed', date: '2026-11-08', amount: 240.04 }),
    tx({ seller: 'Kelsey Bob Ramage', status: 'Confirmed', date: '2026-11-11', amount: 193.26 })], recs);
  const by = {}; r.updates.forEach((u) => { by[u.purchaseId] = u.patch; });
  assert.equal(by['A-1']['Meta Pay Status'], 'Delivered · 2026-11-03 · $262.84'); assert.equal(by['A-1']['Purchase Status'], 'Delivered');
  assert.equal(by['B-1']['Purchase Status'], 'Canceled'); assert.match(by['B-1']['Cancel Signal'], /^Canceled — Meta Pay \(Canceled · 2026-11-03 · \$290\.40, seller Nathan Stickler\)$/);
  assert.equal(by['C-1']['Purchase Status'], 'Canceled'); assert.equal(by['C-1']['Refund Received'], 'Y'); assert.match(by['C-1']['Cancel Signal'], /^Refunded — Meta Pay/);
  assert.equal(by['D-1']['Purchase Status'], 'Canceled'); assert.match(by['D-1']['Cancel Signal'], /^Expired — Meta Pay/);
  assert.equal(by['E-1']['Meta Pay Status'], 'May be delayed · 2026-11-08 · $240.04'); assert.equal(by['E-1']['Purchase Status'], undefined);
  assert.equal(r.unmatched.length, 1); assert.equal(r.unmatched[0].seller, 'Kelsey Bob Ramage');      // no purchase with that seller
});

test('repeat seller: two purchases from the same seller are told apart by date and amount', () => {
  const recs = [rec({ 'Purchase ID': 'OLD-1', 'Purchased At': at(2026, 10, 20), 'Purchase Cost': 100 }), rec({ 'Purchase ID': 'NEW-1', 'Purchased At': at(2026, 11, 3), 'Purchase Cost': 262.84 })];
  const r = plan([tx({ status: 'Canceled', date: '2026-11-03', amount: 262.84 }), tx({ status: 'Delivered', date: '2026-10-20', amount: 100 })], recs);
  const by = {}; r.updates.forEach((u) => { by[u.purchaseId] = u.patch; });
  assert.equal(by['NEW-1']['Purchase Status'], 'Canceled');
  assert.equal(by['OLD-1']['Purchase Status'], 'Delivered');
  // same day, different amounts: the amount decides
  const same = [rec({ 'Purchase ID': 'X-1', 'Purchase Cost': 50 }), rec({ 'Purchase ID': 'Y-1', 'Purchase Cost': 262.84 })];
  const r2 = plan([tx({ status: 'Canceled' })], same);
  assert.equal(r2.updates.length, 1); assert.equal(r2.updates[0].purchaseId, 'Y-1');
});

test('ambiguous ties change NOTHING; out-of-window dates and weak partial names do not match', () => {
  const twins = [rec({ 'Purchase ID': 'X-1', 'Purchase Cost': '' }), rec({ 'Purchase ID': 'Y-1', 'Purchase Cost': '' })];
  const r = plan([tx({ status: 'Canceled' })], twins);
  assert.equal(r.updates.length, 0); assert.equal(r.ambiguous.length, 1); assert.deepEqual(Array.from(r.ambiguous[0].purchaseIds).sort(), ['X-1', 'Y-1']);
  assert.equal(plan([tx({ status: 'Canceled', date: '2026-10-01' })], [rec()]).updates.length, 0);            // a month earlier
  assert.equal(plan([tx({ status: 'Canceled', date: '2026-11-10' })], [rec()]).updates.length, 0);            // a week after
  assert.equal(plan([tx({ status: 'Canceled', date: '2026-10-30' })], [rec()]).updates.length, 1);            // paid 4 days before marking Y
  // partial name + different day + different amount => no match
  assert.equal(plan([tx({ seller: 'Olga P Serdinskaya', status: 'Canceled', date: '2026-10-31', amount: 10 })], [rec()]).updates.length, 0);
  assert.equal(plan([tx({ seller: 'Olga P Serdinskaya', status: 'Canceled', date: '2026-10-31' })], [rec()]).updates.length, 1);   // exact amount verifies it
});

test('rows without a Seller, test rows, voided rows and out-of-scope rows are never matched; unchanged rows produce no update', () => {
  assert.equal(plan([tx({ status: 'Canceled' })], [rec({ Seller: '' })]).updates.length, 0);
  assert.equal(plan([tx({ status: 'Canceled' })], [rec({ 'Purchase ID': 'TEST-1' })]).updates.length, 0);
  assert.equal(plan([tx({ status: 'Canceled' })], [rec({ 'Purchase Status': 'Voided' })]).updates.length, 0);
  assert.equal(plan([tx()], [rec({ 'Meta Pay Status': 'Delivered · 2026-11-03 · $262.84', 'Purchase Status': 'Delivered' })]).updates.length, 0);
});

test('a Meta Pay cancellation after USPS acceptance is flagged for review, not applied', () => {
  const r = plan([tx({ status: 'Refunded' })], [rec({ 'Purchase Status': 'Shipped', 'USPS Accepted At': '2026-11-05 10:00', 'Tracking Number': '9400' })]);
  const p = r.updates[0].patch;
  assert.equal(p['Purchase Status'], undefined); assert.match(p['Cancel Signal'], /^Review: Refunded — Meta Pay/); assert.equal(p['Refund Received'], 'Y');
});

test('wantsSignals_: only while some in-scope purchase could still be canceled', () => {
  assert.equal(g.wantsSignals_([rec()]), true);
  assert.equal(g.wantsSignals_([rec({ 'Purchase Status': 'Delivered' }), rec({ 'Purchase Status': 'Canceled' }), rec({ 'Purchase ID': 'TEST-1' })]), false);
  assert.equal(g.wantsSignals_([rec({ 'Purchase Status': 'Tracking Available', 'FB Status (raw)': 'Delivered | Your order was delivered.' })]), false);
});

// ---------------------------------------------------------------- notifications
const note = (o) => Object.assign({ text: 'Nathan Stickler canceled your order for Nikon D7100 with 18-140mm lens. 1w', kind: 'canceled', listingIds: [], atMs: NOW - 7 * DAY }, o);
const nplan = (ns, recs) => g.planNotificationUpdates_(ns, recs, '2026-11-13 10:00');
const nikon = (o) => rec(Object.assign({ 'Purchase ID': '5555555555555555-1', 'Listing ID': '5555555555555555', Product: 'Nikon D7100 + 18-140mm', Seller: 'Nathan Stickler',
  'FB Listing Title': 'Nikon D7100 with 18-140mm lens', 'Purchased At': at(2026, 11, 3) }, o));

test('notification naming the listing (linked ID or full Facebook title) cancels exactly that purchase', () => {
  const byId = nplan([note({ listingIds: ['5555555555555555'], text: 'Your order was canceled. 1w' })], [nikon(), rec()]);
  assert.equal(byId.updates.length, 1); assert.equal(byId.updates[0].purchaseId, '5555555555555555-1'); assert.equal(byId.updates[0].patch['Purchase Status'], 'Canceled');
  assert.match(byId.updates[0].patch['Cancel Signal'], /^Canceled — Marketplace notification/);
  const byTitle = nplan([note()], [nikon(), rec()]);
  assert.equal(byTitle.updates[0].patch['Purchase Status'], 'Canceled');
  const exp = nplan([note({ kind: 'expired', text: 'Your order for Nikon D7100 with 18-140mm lens expired. 2d', atMs: NOW - 2 * DAY })], [nikon()]);
  assert.match(exp.updates[0].patch['Cancel Signal'], /^Expired — /);
});

test('a loose word match only asks for a review; ambiguity, older notices and cancel REQUESTS change nothing', () => {
  const loose = nplan([note({ text: 'Your order for the Nikon D7100 DSLR kit was canceled. 1w' })], [nikon({ 'FB Listing Title': '', Product: 'Nikon D7100 DSLR + 18-140mm' })]);
  assert.equal(loose.updates[0].patch['Purchase Status'], undefined); assert.match(loose.updates[0].patch['Cancel Signal'], /^Review: possibly Canceled/);
  const two = nplan([note()], [nikon(), nikon({ 'Purchase ID': '9-1', 'Listing ID': '9' })]);
  assert.equal(two.updates.length, 0); assert.equal(two.ambiguous.length, 1);
  assert.equal(nplan([note({ atMs: at(2026, 10, 20).getTime() })], [nikon()]).updates.length, 0);              // before this purchase
  assert.equal(nplan([note({ kind: 'cancel_requested' })], [nikon()]).updates.length, 0);
  assert.equal(nplan([note({ kind: 'delivered' })], [nikon()]).updates.length, 0);
  // re-bought listing (attempt 2) + unknown notice time => might be about attempt 1 => ignored
  assert.equal(nplan([note({ atMs: '' })], [nikon({ 'Purchase ID': '5555555555555555-2' })]).updates.length, 0);
  assert.equal(nplan([note()], [nikon({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Canceled — x' })]).updates.length, 0);
});

// ---------------------------------------------------------------- dashboard surfacing
test('dashboard: seller named in "Contact Seller"; cancellation reason shown; review signals and delays are alerts', () => {
  const NOWD = Date.UTC(2026, 10, 13, 18);
  const d = (o) => g.dashRow_(rec(o), NOWD, { overdueDays: 7 });
  assert.match(d({ 'Purchased At': at(2026, 11, 3) }).attention, /^OVERDUE — Contact Seller \(Olga Serdinskaya\) · 9 days/);
  assert.match(d({ 'Purchased At': at(2026, 11, 3), Seller: '' }).attention, /^OVERDUE — Contact Seller · 9 days/);
  assert.equal(d({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Refunded — Meta Pay (Refunded · 2026-10-26 · $267.60, seller Mark Afanasyev)', 'Refund Received': 'Y' }).attention,
    'Refunded (Meta Pay) — no action needed');
  assert.equal(d({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Canceled — Facebook listing: View Order button missing', 'Refund Received': 'Y' }).attention,
    'Canceled (Facebook listing: View Order button missing, refund received) — no action needed');
  assert.equal(d({ 'Purchase Status': 'Canceled', 'Cancel Signal': 'Expired — Meta Pay (x)' }).orderStatus, 'Canceled');
  const review = d({ 'Purchased At': at(2026, 11, 12), 'Cancel Signal': 'Review: Refunded — Meta Pay (x)' });
  assert.match(review.attention, /^Check Order — Refunded — Meta Pay/); assert.equal(review.needsAttention, true);
  assert.match(d({ 'Purchased At': at(2026, 11, 12), 'Meta Pay Status': 'May be delayed · 2026-11-08 · $240.04' }).attention, /^Check Order — Meta Pay: May be delayed/);
  assert.equal(d({ 'Purchased At': at(2026, 11, 12), 'Cancel Signal': 'Possible: x' }).attention, 'No Action Needed');   // old-version leftovers ignored
});
