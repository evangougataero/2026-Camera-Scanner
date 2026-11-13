'use strict';
/**
 * End-to-end (fake Sheets): Facebook "Order status" result -> Purchased (seller, tracking, Delivered) -> Inventory / Dashboard;
 * seller backfill work list; Meta Pay + notification signals; backward compatibility with an existing sheet and an old Config.gs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildContext } = require('./harness');
const P = require('../extension/parse-order.js');
const S = require('../extension/parse-signals.js');

const SCANNER_ID = 'scanner-ss', INV_ID = 'inventory-ss';
const CANON = '1288988733112094', NIKON = '5555555555555555', SONY = '7777777777777777';
const SCAN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy',
  'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'O', 'P', 'Relisted', 'Purchase Price'];
const K = 11, COST = 18, DAY = 86400000;
const PC = `${CANON}-1`, PN = `${NIKON}-1`, PS = `${SONY}-1`;

const SCREENSHOT = ['Order status', 'Canon EOS 760D (Rebel T6s) with the Lens', '$225.00 · Quantity: 1', 'Delivered', 'Your order was delivered.', 'Nov 9, 2026',
  'USPS TRACKING NUMBER: 9334610579700004096766', 'Order Confirmed', 'Nov 3 at 12:43 PM', 'Shipped', 'Nov 3 at 11:24 PM', 'Out for delivery', 'Nov 9 at 2:10 PM',
  'Delivered', 'Nov 9 at 5:34 PM', 'Seller information', 'Olga Serdinskaya', 'Item is sold and shipped by Olga Serdinskaya', 'Order information',
  'View order details', 'Order help', 'Open claim with Facebook', 'Available until January 2, 2027'].join('\n');

/** What background.js sends for a parsed Facebook order view (same field list as processStep's `clean`). */
const fbResult = (text, extra) => {
  const r = P.parseOrderText(text, []);
  return Object.assign({ ok: true, mode: 'order', fbStatusRaw: r.fbStatusRaw, canceled: r.canceled, outcome: r.outcome, trackingNumber: r.trackingNumber,
    carrier: r.carrier, orderId: r.orderId, orderTotal: r.orderTotal, pageHealthy: false, seller: r.seller, itemTitle: r.itemTitle, orderView: true }, extra || {});
};

function world(opts) {
  opts = opts || {};
  const w = buildContext();
  w.clock.now = Date.UTC(2026, 10, 3, 20, 43);                       // Nov 3 2026, 12:43 PM PT — when Evan bought the Canon
  const scan = w.addSpreadsheet(SCANNER_ID);
  const main = scan.insertSheet('Main');
  SCAN_HEADERS.forEach((h, i) => main.put(1, i + 1, h));
  const put = (r, o) => Object.keys(o).forEach((c) => main.put(r, +c, o[c]));
  put(2, { 1: 'Canon EOS 760D', 2: `https://www.facebook.com/marketplace/item/${CANON}/?ref=search`, 4: 225, 5: 330 });
  put(3, { 1: 'Canon EF-S 18-55mm lens', 5: 60 });
  put(4, { 1: 'Nikon D7100 DSLR', 2: `https://www.facebook.com/marketplace/item/${NIKON}/`, 4: 280, 5: 420 });
  put(5, { 1: 'Sony 85mm f/1.8', 2: `https://m.facebook.com/marketplace/item/${SONY}/`, 4: 250, 5: 400 });
  const inv = w.addSpreadsheet(INV_ID);
  const sh = inv.insertSheet('Inventory');
  ['Product', 'Status'].forEach((h, i) => sh.put(1, i + 1, h));
  if (opts.oldPurchasedSheet) {                                       // a sheet set up by an OLDER version (unused columns in the middle)
    const pur = scan.insertSheet('Purchased');
    ['Purchase ID', 'Listing ID', 'Purchased At', 'Product', 'Facebook URL', 'Ask Price (FB)', 'Purchase Cost', 'Estimated Resale', 'Scanner Row',
     'Purchase Status', 'FB Order Button Seen', 'Cancel Signal', 'Refund Received', 'FB Status (raw)'].forEach((h, i) => pur.put(1, i + 1, h));
  }
  w.ctx.CONFIG.SCANNER.spreadsheetId = SCANNER_ID;
  w.ctx.CONFIG.INVENTORY.spreadsheetId = INV_ID;
  w.ctx.CONFIG.INVENTORY.tab = 'Inventory';
  w.run('setup()');
  w.run('setupInventoryV2()');
  w.run('setupPurchaseDashboard()');
  Object.assign(w, {
    ss: scan, main, inv: sh, pur: scan.getSheetByName('Purchased'), logSheet: scan.getSheetByName('Purchase Log'),
    setY: (row, v) => { main.put(row, K, v); w.ctx.__e = { range: main.getRange(row, K), value: v, oldValue: '' }; w.run('onScannerEdit(__e)'); },
    buy: (row, cost) => { main.put(row, COST, cost); w.setY(row, 'Y'); },
    post: (body) => JSON.parse(w.run('doPost')({ postData: { contents: JSON.stringify(Object.assign({ token: w.props.API_TOKEN }, body)) } }).text),
    rec: (pid) => { for (let r = 2; r <= w.pur.getLastRow(); r++) { const o = w.pur.rowObj(r); if (String(o['Purchase ID']) === pid) return o; } return null; },
    headers: () => { const out = []; for (let c = 1; c <= w.pur.getLastColumn(); c++) out.push(w.pur._get(1, c)); return out; },
    logs: () => { const o = []; for (let r = 2; r <= w.logSheet.getLastRow(); r++) o.push(w.logSheet.rowObj(r)['Event'] + ' ' + w.logSheet.rowObj(r)['Detail']); return o; },
    dash: () => {
      const s = scan.getSheetByName('Purchase Dashboard'), out = [], heads = [];
      for (let c = 1; c <= 15; c++) heads.push(s._get(3, c));
      for (let r = 4; r <= s.getLastRow(); r++) { if (s._get(r, 14) === '') continue; const o = {}; heads.forEach((h, i) => { o[h] = s._get(r, i + 1); }); out.push(o); }
      return out;
    }
  });
  return w;
}

// ---------------------------------------------------------------- upgrade safety
test('new columns are appended at the END; an older sheet keeps its existing Cancel Signal / Refund Received columns in place', () => {
  const w = world({ oldPurchasedSheet: true });
  const h = w.headers();
  assert.equal(h[11], 'Cancel Signal'); assert.equal(h[12], 'Refund Received');                  // untouched positions
  ['Seller', 'FB Listing Title', 'Meta Pay Status', 'Seller Attempts'].forEach((x) => assert.ok(h.indexOf(x) > 13, x));
  assert.equal(h.filter((x) => x === 'Cancel Signal').length, 1);
  // a sheet whose code was updated WITHOUT re-running setup: reconcile adds the columns itself
  const w2 = world();
  const sc = w2.headers().indexOf('Seller') + 1;
  w2.pur.put(1, sc, ''); w2.pur.put(1, sc + 1, '');                                                  // pretend they are missing
  w2.run('reconcile()');
  assert.ok(w2.headers().includes('Seller') && w2.headers().includes('FB Listing Title'));
  assert.ok(w2.logs().some((l) => /^COLUMNS_ADDED/.test(l)));
});

test('the shipped Config.gs needs NO new keys (defaults live in Code.gs)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Config.gs'), 'utf8');
  ['FB_SELLER_RECHECK_MINUTES', 'SELLER_MAX_ATTEMPTS', 'META_PAY_DAYS_BEFORE', 'META_PAY_DAYS_AFTER'].forEach((k) => assert.ok(!src.includes(k), k));
  const w = world();
  assert.equal(w.run("cfgVal_('SELLER_MAX_ATTEMPTS')"), 3);
  w.ctx.CONFIG.SELLER_MAX_ATTEMPTS = 5;                                                               // optional override still honoured
  assert.equal(w.run("cfgVal_('SELLER_MAX_ATTEMPTS')"), 5);
});

// ---------------------------------------------------------------- Evan's case
test('Canon 760D: the "Order status" result fills Seller, title and USPS tracking, marks Delivered and transfers — no more "Overdue, no tracking"', () => {
  const w = world();
  w.buy(2, 262.84);
  w.advance(10 * DAY);                                                                                // Nov 13: would be OVERDUE without data
  w.run('refreshPurchaseDashboard()');
  assert.equal(w.dash()[0]['Order Status'], 'Overdue');
  assert.match(w.dash()[0]['Attention / Action Needed'], /no tracking number yet/);

  const work = w.post({ action: 'getWork' });
  assert.equal(work.items[0].purchaseId, PC); assert.equal(work.items[0].mode, 'order'); assert.equal(work.signals, true);
  w.post({ action: 'submitFbResult', purchaseId: PC, result: fbResult(SCREENSHOT) });
  const r = w.rec(PC);
  assert.equal(r['Seller'], 'Olga Serdinskaya');
  assert.equal(r['FB Listing Title'], 'Canon EOS 760D (Rebel T6s) with the Lens');
  assert.equal(r['Tracking Number'], '9334610579700004096766');                                       // stored as TEXT, all 22 digits
  assert.equal(r['Carrier'], 'USPS');
  assert.equal(r['Purchase Status'], 'Delivered');
  assert.equal(r['Transferred to eBay?'], 'Y');                                                       // FB-delivered => inventory right away
  w.run('refreshPurchaseDashboard()');
  const d = w.dash()[0];
  assert.equal(d['Order Status'], 'Delivered'); assert.equal(d['Attention / Action Needed'], 'No Action Needed');
  assert.match(String(d['Tracking']), /9334610579700004096766/);
  assert.ok(w.logs().some((l) => /^FB_CHECKED Delivered .*tracking 9334610579700004096766 \| seller Olga Serdinskaya/.test(l)));
  assert.equal(w.post({ action: 'getWork', force: true }).items.length, 0);                           // monitoring stops
});

test('an overdue purchase names the seller to contact', () => {
  const w = world();
  w.buy(4, 290.40);
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: true, fbStatusRaw: 'Order Confirmed', seller: 'Nathan Stickler', itemTitle: 'Nikon D7100 with 18-140mm lens' } });
  w.advance(8 * DAY);
  w.run('refreshPurchaseDashboard()');
  assert.match(w.dash()[0]['Attention / Action Needed'], /^OVERDUE — Contact Seller \(Nathan Stickler\) · 8 days/);
});

// ---------------------------------------------------------------- seller backfill
test('seller backfill: delivered/canceled rows without a seller are listed separately, filled once, and retried at most 3 times', () => {
  const w = world();
  w.buy(2, 262.84); w.buy(4, 290.40);
  w.post({ action: 'submitFbResult', purchaseId: PC, result: { ok: true, fbStatusRaw: 'Delivered | Your order was delivered.', trackingNumber: '9334610579700004096766', carrier: 'USPS' } });
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: true, canceled: true, fbStatusRaw: 'Canceled' } });
  let work = w.post({ action: 'getWork', force: true });
  assert.equal(work.items.length, 0);                                                                  // no order monitoring for these
  assert.deepEqual(work.sellerItems.map((i) => i.purchaseId + ':' + i.mode).sort(), [PC + ':seller', PN + ':seller']);
  w.post({ action: 'submitFbResult', purchaseId: PC, result: { ok: true, mode: 'seller', seller: 'Olga Serdinskaya', itemTitle: 'Canon EOS 760D (Rebel T6s) with the Lens' } });
  assert.equal(w.rec(PC)['Seller'], 'Olga Serdinskaya'); assert.equal(w.rec(PC)['Purchase Status'], 'Delivered');
  for (let i = 1; i <= 3; i++) {
    w.advance(7 * 3600000);                                                                            // past the 6 h seller recheck interval
    assert.deepEqual(w.post({ action: 'getWork' }).sellerItems.map((x) => x.purchaseId), [PN], 'attempt ' + i);
    w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: false, mode: 'seller', error: 'SELLER_NOT_FOUND' } });
    assert.equal(w.rec(PN)['Seller Attempts'], i);
  }
  w.advance(7 * 3600000);
  assert.equal(w.post({ action: 'getWork' }).sellerItems.length, 0);                                   // capped after 3 misses; PC filled
  assert.equal(w.post({ action: 'getWork', force: true }).sellerItems.length, 0);                      // even when forced
  assert.equal(w.rec(PN)['Purchase Status'], 'Canceled');                                              // seller checks never touch status
  assert.ok(w.logs().some((l) => /^SELLER_FOUND Olga Serdinskaya/.test(l)));
});

test('the canonical desktop listing URL is used even when the scanner stored an m.facebook.com link', () => {
  const bg = fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8');
  const fn = new Function(bg.match(/function safeFacebookUrl\(item\) \{[\s\S]*?\n\}/)[0] + '; return safeFacebookUrl;')();
  assert.equal(fn({ url: `https://m.facebook.com/marketplace/item/${SONY}/?ref=x` }), `https://www.facebook.com/marketplace/item/${SONY}/`);
  assert.equal(fn({ listingId: CANON, url: 'https://evil.example/marketplace/item/1/' }), `https://www.facebook.com/marketplace/item/${CANON}/`);
  assert.equal(fn({ url: 'https://evil.example/marketplace/item/123456789/' }), '');
  assert.equal(fn({ url: 'http://www.facebook.com/marketplace/item/123456789/' }), '');
});

// ---------------------------------------------------------------- Meta Pay + notifications
const WALLET = ['All', 'Money transfer', 'Orders', 'Olga Serdinskaya', 'Delivered', 'Nov 3, 2026', '$262.84', 'Nathan Stickler', 'Canceled', 'Nov 3, 2026', '$290.40',
  'Mark Afanasyev', 'Refunded', 'Oct 26, 2026', '$267.60'].join('\n');

test('Meta Pay scan: cancels the matching purchase, confirms delivery, preview never writes, repeats are idempotent', () => {
  const w = world();
  w.buy(2, 262.84); w.buy(4, 290.40);
  w.post({ action: 'submitFbResult', purchaseId: PC, result: { ok: true, fbStatusRaw: 'Order Confirmed', seller: 'Olga Serdinskaya' } });
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: true, fbStatusRaw: 'Order Confirmed', seller: 'Nathan Stickler' } });
  const transactions = S.parseMetaPayText(WALLET, w.clock.now);

  const before = JSON.stringify(w.pur._data);
  const pv = w.post({ action: 'previewSignals', result: { source: 'metapay', ok: true, transactions } });
  assert.equal(JSON.stringify(w.pur._data), before);                                                   // read-only
  assert.deepEqual(pv.updates.map((u) => u.purchaseId).sort(), [PC, PN].sort());
  assert.equal(pv.updates.find((u) => u.purchaseId === PN).changes['Purchase Status'], 'Canceled');

  const res = w.post({ action: 'submitSignals', purchaseId: '', result: { source: 'metapay', ok: true, transactions } });
  assert.equal(res.ok, true); assert.equal(res.updated, 2);
  assert.equal(w.rec(PN)['Purchase Status'], 'Canceled'); assert.match(w.rec(PN)['Cancel Signal'], /^Canceled — Meta Pay/);
  assert.equal(w.rec(PC)['Purchase Status'], 'Delivered'); assert.equal(w.rec(PC)['Meta Pay Status'], 'Delivered · 2026-11-03 · $262.84');
  assert.equal(w.rec(PC)['Transferred to eBay?'], 'Y');
  assert.ok(w.logs().some((l) => /^META_PAY_SCAN 3 read, 2 row\(s\) updated \| unmatched cancellations: Refunded Mark Afanasyev 2026-10-26 \$267\.60/.test(l)));

  const again = w.post({ action: 'submitSignals', purchaseId: '', result: { source: 'metapay', ok: true, transactions } });
  assert.equal(again.updated, 0);
  w.run('refreshPurchaseDashboard()');
  const nikon = w.dash().find((x) => x['Purchase ID'] === PN);
  assert.equal(nikon['Order Status'], 'Canceled'); assert.equal(nikon['Attention / Action Needed'], 'Canceled (Meta Pay) — no action needed');
  assert.equal(w.post({ action: 'getWork', force: true }).signals, false);                             // nothing left to watch
});

test('notification scan: a cancellation naming the listing cancels it; unknown sources are rejected', () => {
  const w = world();
  w.buy(4, 290.40);
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: true, fbStatusRaw: 'Order Confirmed', seller: 'Nathan Stickler', itemTitle: 'Nikon D7100 with 18-140mm lens' } });
  w.advance(2 * DAY);
  const notifications = S.parseNotifications([{ text: 'Nathan Stickler canceled your order for Nikon D7100 with 18-140mm lens. 1d', hrefs: [] }], w.clock.now);
  const res = w.post({ action: 'submitSignals', purchaseId: '', result: { source: 'notifications', ok: true, notifications } });
  assert.equal(res.updated, 1);
  assert.equal(w.rec(PN)['Purchase Status'], 'Canceled'); assert.match(w.rec(PN)['Cancel Signal'], /^Canceled — Marketplace notification/);
  assert.equal(w.post({ action: 'submitSignals', result: { source: 'nope' } }).error, 'UNKNOWN_SIGNAL_SOURCE');
  assert.equal(w.post({ action: 'submitSignals', token: 'wrong', result: { source: 'metapay' } }).error, 'UNAUTHORIZED');
});

test('a canceled row still receives its seller from an order-mode check (needed to match a later Meta Pay refund)', () => {
  const w = world();
  w.buy(4, 290.40);
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: true, canceled: true, outcome: 'canceled', fbStatusRaw: 'Canceled' } });
  assert.equal(w.rec(PN)['Purchase Status'], 'Canceled');
  w.post({ action: 'submitFbResult', purchaseId: PN, result: { ok: false, error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true, seller: 'Nathan Stickler' } });
  assert.equal(w.rec(PN)['Seller'], 'Nathan Stickler');
  const t = S.parseMetaPayText('Nathan Stickler\nRefunded\nNov 3, 2026\n$290.40', w.clock.now);
  w.post({ action: 'submitSignals', result: { source: 'metapay', ok: true, transactions: t } });
  assert.equal(w.rec(PN)['Refund Received'], 'Y'); assert.match(w.rec(PN)['Cancel Signal'], /^Refunded — Meta Pay/);
});

test('FIX B end-to-end: "Sold" D80 (Meta Pay May be delayed) and "Pending" D5300 (Meta Pay Confirmed) stay active; no View Order button never cancels', () => {
  const w = world();
  w.buy(4, 290.40); w.buy(5, 250);
  const miss = (seller, listingState) => ({ ok: false, mode: 'order', error: 'ORDER_DETAILS_NOT_FOUND', pageHealthy: true, listingState, seller });
  w.post({ action: 'submitFbResult', purchaseId: PN, result: miss('Nathan Stickler', 'sold') });
  w.post({ action: 'submitFbResult', purchaseId: PS, result: miss('Kim Vo', 'pending') });
  w.post({ action: 'submitFbResult', purchaseId: PS, result: miss('Kim Vo', '') });                    // even with no Sold/Pending marker
  const t = S.parseMetaPayText('Nathan Stickler\nMay be delayed\nNov 3, 2026\n$290.40\nKim Vo\nConfirmed\nNov 3, 2026\n$250.00', w.clock.now);
  w.post({ action: 'submitSignals', result: { source: 'metapay', ok: true, transactions: t } });
  for (const pid of [PN, PS]) {
    assert.equal(w.rec(pid)['Purchase Status'], 'Purchased', pid);
    assert.equal(w.rec(pid)['Cancel Signal'], '', pid);
  }
  assert.match(w.rec(PN)['Meta Pay Status'], /^May be delayed/); assert.match(w.rec(PS)['Meta Pay Status'], /^Confirmed/);
  assert.match(w.rec(PN)['Notes'], /listing shows Sold — order still active/);
  assert.equal(Number(w.rec(PN)['FB Error Count'] || 0), 0);
  assert.equal(w.post({ action: 'getWork', force: true }).items.filter((i) => i.purchaseId === PN || i.purchaseId === PS).length, 2);   // still monitored
});

test('Meta Pay refund matches a row with a BLANK Seller by exact amount + date (one candidate only)', () => {
  const w = world();
  w.buy(2, 262.84); w.buy(4, 290.40);                                                                 // no Facebook check yet: Seller blank on both
  const t = S.parseMetaPayText('Olga Serdinskaya\nRefunded\nNov 3, 2026\n$262.84', w.clock.now);
  w.post({ action: 'submitSignals', result: { source: 'metapay', ok: true, transactions: t } });
  assert.equal(w.rec(PC)['Purchase Status'], 'Canceled'); assert.equal(w.rec(PC)['Refund Received'], 'Y');
  assert.match(w.rec(PC)['Cancel Signal'], /^Refunded — Meta Pay .*matched by amount\+date/);
  assert.equal(w.rec(PC)['Seller'], '');
  assert.equal(w.rec(PN)['Purchase Status'], 'Purchased');
});

// ---------------------------------------------------------------- extension wiring
test('manifest grants accountscenter.facebook.com and every new probe button is wired', () => {
  const ext = path.join(__dirname, '..', 'extension');
  const m = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  assert.ok(m.host_permissions.includes('https://accountscenter.facebook.com/*'));
  assert.ok(m.host_permissions.includes('https://www.facebook.com/*'));
  const html = fs.readFileSync(path.join(ext, 'options.html'), 'utf8'), js = fs.readFileSync(path.join(ext, 'options.js'), 'utf8');
  const bg = fs.readFileSync(path.join(ext, 'background.js'), 'utf8');
  ['probe', 'probeSeller', 'probeUsps', 'probeMetaPay', 'probeNotifications', 'scanMetaPay', 'scanNotifications', 'saveSignals'].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), 'html ' + id); assert.ok(js.includes("'" + id + "'"), 'js ' + id);
  });
  ['pt:probeSeller', 'pt:probeMetaPay', 'pt:probeNotifications', 'pt:saveSignalPrefs'].forEach((t) => assert.ok(bg.includes("'" + t + "'"), t));
  ['parse-signals.js', 'signals-extractor.js'].forEach((f) => { assert.ok(bg.includes("'" + f + "'")); assert.ok(fs.existsSync(path.join(ext, f))); });
});
