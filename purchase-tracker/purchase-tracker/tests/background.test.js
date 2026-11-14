'use strict';
/**
 * Loads the REAL extension/background.js into a vm with a fake `chrome` + fetch, and checks the run/step machinery:
 * watchdog alarm before each step, retry cap after worker restarts, seller-only items, signal steps, outbox actions,
 * and that a Meta Pay password prompt is reported (never bypassed) without stopping the Facebook checks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { worker, drain, ORDERS_C1 } = require('./fake-worker');

const ORDER_OK = { ok: true, orderView: true, fbStatusRaw: 'Delivered | Your order was delivered.', trackingNumber: '9334610579700004096766', carrier: 'USPS', seller: 'Olga Serdinskaya', itemTitle: 'Canon EOS 760D' };


test('orders page unreadable: listing-page fallback for every due purchase (orders, then seller-only), then USPS, then the signal pages', async () => {
  // The orders page could not be read at all (layout not recognised): every due purchase falls back to its listing page.
  const w = worker({ PT_ordersInPage: { ok: false, error: 'ORDERS_NOT_FOUND', detail: 'no order cards' },
                     PT_extractInPage: (o) => (o.mode === 'seller' ? { ok: true, mode: 'seller', seller: 'Nathan Stickler' } : ORDER_OK),
                     PT_metaPayInPage: { ok: true, transactions: [{ seller: 'Olga Serdinskaya', status: 'Delivered', date: '2026-11-03', amount: 262.84 }] },
                     PT_notificationsInPage: { ok: true, notifications: [], scanned: 4 } }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094', url: '', mode: 'order' }],
                      sellerItems: [{ purchaseId: 'N-1', listingId: '5555555555555555', url: '' }] }),
    getUspsWork: () => ({ ok: true, items: [{ purchaseId: 'C-1', trackingNumber: '9334610579700004096766' }] })
  });
  await w.run("startRun('test')");
  await drain(w);
  const order = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.deepEqual(order, ['https://www.facebook.com/marketplace/you/orders/',
    'https://www.facebook.com/marketplace/item/1288988733112094/', 'https://www.facebook.com/marketplace/item/5555555555555555/',
    'https://tools.usps.com/tracking/9334610579700004096766',
    'https://accountscenter.facebook.com/meta_pay_wallet/?referrer=accounts_center_home', 'https://www.facebook.com/marketplace/notifications/']);
  const posts = w.calls.filter((c) => c.api && /^submit/.test(c.api));
  assert.deepEqual(posts.map((p) => p.body.action + ':' + (p.body.result.source || p.body.result.mode || 'usps')),
    ['submitFbResult:order', 'submitFbResult:seller', 'submitUspsResult:usps', 'submitSignals:metapay', 'submitSignals:notifications']);
  const fb = posts[0].body.result;
  assert.equal(fb.trackingNumber, '9334610579700004096766'); assert.equal(fb.seller, 'Olga Serdinskaya'); assert.equal(fb.itemTitle, 'Canon EOS 760D');
  assert.equal(posts[1].body.result.seller, 'Nathan Stickler');
  assert.equal(w.store.pt_queue, undefined);                                                    // run finished
  assert.match(w.store.pt_state.log.join('\n'), /sellers:2/);
});

test('each step arms a watchdog alarm first; after 3 worker restarts on one item it is reported as STEP_ABORTED and skipped', async () => {
  const w = worker({ PT_extractInPage: ORDER_OK }, {
    getWork: () => ({ ok: true, signals: false, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }, { purchaseId: 'D-1', listingId: '2288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  w.store.pt_queue = { runId: '1', heartbeat: Date.now(), index: 0, tries: 3, issue: false, items: [{ kind: 'fb', purchaseId: 'C-1', listingId: '1288988733112094' }, { kind: 'fb', purchaseId: 'D-1', listingId: '2288988733112094' }],
    stats: { ok: 0, errors: 0, canceled: 0, tracking: 0, sellers: 0, usps: 0, signals: 0 } };      // the worker died 3 times on C-1
  await w.run('processStep()');
  const sent = w.calls.filter((c) => c.api === 'submitFbResult');
  assert.equal(sent[0].body.purchaseId, 'C-1'); assert.equal(sent[0].body.result.error, 'STEP_ABORTED');
  assert.equal(w.store.pt_queue.index, 1); assert.equal(w.store.pt_queue.tries, 0);
  assert.equal(w.alarms['pt-step'].delayInMinutes, 0.5);                                        // next item paced normally
  // the watchdog: while an item is being processed, a 5-minute pt-step alarm is already armed
  let armed = null;
  w.ctx.chrome.scripting.executeScript = async (o) => { if (!o.files) armed = w.alarms['pt-step'] && w.alarms['pt-step'].delayInMinutes; return o.files ? [] : [{ result: ORDER_OK }]; };
  await w.run('processStep()');
  assert.equal(armed, 5);
});

test('Meta Pay password prompt: reported to the sheet, badge raised, Facebook order checks still run', async () => {
  const w = worker({ PT_metaPayInPage: { ok: false, error: 'REAUTH_REQUIRED' }, PT_notificationsInPage: { ok: true, notifications: [] }, PT_ordersInPage: ORDERS_C1 }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  await w.run("startRun('test')");
  await drain(w);
  const issue = w.calls.find((c) => c.api === 'reportIssue');
  assert.equal(issue.body.code, 'REAUTH_REQUIRED');
  assert.ok(w.calls.some((c) => c.api === 'submitFbResult' && c.body.purchaseId === 'C-1'));
  assert.ok(!w.calls.some((c) => c.api === 'submitSignals' && c.body.result.source === 'metapay'));
});

test('a (confirmed) login wall on the notifications page is reported but never costs the order checks (never bypassed)', async () => {
  const w = worker({ PT_notificationsInPage: { ok: false, error: 'LOGIN_REQUIRED', detail: 'via visible-password · path=/marketplace/notifications/ · "Log in"' }, PT_ordersInPage: ORDERS_C1 }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [{ purchaseId: 'C-1', trackingNumber: '9334610579700004096766' }] })
  });
  w.store.pt_settings.scanMetaPay = false;                                                       // option honoured
  await w.run("startRun('test')");
  await drain(w);
  assert.ok(!w.calls.some((c) => c.tab && /accountscenter/.test(c.tab)));
  assert.ok(w.calls.some((c) => c.api === 'submitFbResult' && c.body.purchaseId === 'C-1'));      // order checks ran (first)
  assert.ok(w.calls.some((c) => c.tab && /tools\.usps\.com/.test(c.tab)));                       // USPS is unaffected
  const notifTabs = w.calls.filter((c) => c.tab && /notifications/.test(c.tab)).map((c) => c.tab);
  assert.deepEqual(notifTabs, ['https://www.facebook.com/marketplace/notifications/', 'https://www.facebook.com/marketplace/notifications/']);  // re-verified once, then stopped
  const issue = w.calls.find((c) => c.api === 'reportIssue');
  assert.equal(issue.body.code, 'LOGIN_REQUIRED');
  assert.equal(issue.body.message, 'Notifications LOGIN_REQUIRED — via visible-password · path=/marketplace/notifications/ · "Log in" (seen twice)');
  assert.equal(w.badge.text, '!');
});

test('a LOGIN_REQUIRED that does not survive the re-check is not reported; the run continues normally', async () => {
  let n = 0;
  const w = worker({ PT_notificationsInPage: () => (++n === 1 ? { ok: false, error: 'LOGIN_REQUIRED', detail: 'path=/marketplace/notifications/' } : { ok: true, notifications: [], scanned: 3 }),
                     PT_ordersInPage: ORDERS_C1 }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  w.store.pt_settings.scanMetaPay = false;
  await w.run("startRun('test')");
  await drain(w);
  assert.equal(n, 2);
  assert.ok(!w.calls.some((c) => c.api === 'reportIssue'));
  assert.ok(w.calls.some((c) => c.api === 'submitSignals' && c.body.result.source === 'notifications'));
  assert.equal(w.badge.text, '');
});

test('a confirmed login wall on a LISTING (fallback) page stops the remaining Facebook checks (never bypassed); USPS + Meta Pay still run', async () => {
  const w = worker({ PT_ordersInPage: { ok: false, error: 'ORDERS_NOT_FOUND' }, PT_extractInPage: { ok: false, error: 'LOGIN_REQUIRED', detail: 'via login-form · path=/marketplace/item/1288988733112094/ · "Log in to Facebook"' },
                     PT_metaPayInPage: { ok: true, transactions: [] }, PT_notificationsInPage: { ok: true, notifications: [] } }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }, { purchaseId: 'D-1', listingId: '2288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [{ purchaseId: 'C-1', trackingNumber: '9334610579700004096766' }] })
  });
  await w.run("startRun('test')");
  await drain(w);
  const tabs = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.equal(tabs.filter((t) => /1288988733112094/.test(t)).length, 2);                         // checked, re-checked
  assert.ok(!tabs.some((t) => /2288988733112094/.test(t)));                                       // the rest of the Facebook checks skipped
  assert.ok(!tabs.some((t) => /notifications/.test(t)));
  assert.ok(tabs.some((t) => /tools\.usps\.com/.test(t)) && tabs.some((t) => /accountscenter/.test(t)));
  assert.ok(!w.calls.some((c) => c.api === 'submitFbResult'));
  const issue = w.calls.find((c) => c.api === 'reportIssue');
  assert.match(issue.body.message, /^Facebook LOGIN_REQUIRED on C-1 — via login-form · path=\/marketplace\/item\/1288988733112094\/ · "Log in to Facebook" \(seen twice\)$/);
  assert.match(w.store.pt_state.log.join('\n'), /STOPPED FB: LOGIN_REQUIRED — via login-form · path=/);
  assert.equal(w.badge.text, '!');
});

test('a tab URL with "login" only in its query string is not a login wall', async () => {
  const w = worker({ PT_ordersInPage: ORDERS_C1 }, {
    getWork: () => ({ ok: true, signals: false, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  w.ctx.chrome.tabs.get = async () => ({ id: 7, status: 'complete', url: 'https://www.facebook.com/marketplace/item/1288988733112094/?next=%2Flogin%2F&ref=login_redirect' });
  await w.run("startRun('test')");
  await drain(w);
  const sent = w.calls.find((c) => c.api === 'submitFbResult');
  assert.equal(sent.body.result.ok, true);
  assert.ok(!w.calls.some((c) => c.api === 'reportIssue'));
  // ...while a real login URL is still reported (pathname check), with the path in the detail
  const w2 = worker({ PT_ordersInPage: ORDERS_C1 }, {
    getWork: () => ({ ok: true, signals: false, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  w2.ctx.chrome.tabs.get = async () => ({ id: 7, status: 'complete', url: 'https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fmarketplace%2F', title: 'Log in to Facebook' });
  await w2.run("startRun('test')");
  await drain(w2);
  const issue = w2.calls.find((c) => c.api === 'reportIssue');
  assert.equal(issue.body.code, 'LOGIN_REQUIRED');
  assert.match(issue.body.message, /via url · path=\/login\/ · "Log in to Facebook" \(seen twice\)$/);
});

test('the red badge is cleared when a manual probe of the same kind succeeds (and only then)', async () => {
  let notif = { ok: false, error: 'LOGIN_REQUIRED', detail: 'path=/marketplace/notifications/' };
  const w = worker({ PT_notificationsInPage: () => notif, PT_metaPayInPage: { ok: false, error: 'REAUTH_REQUIRED' }, PT_extractInPage: ORDER_OK }, {
    getWork: () => ({ ok: true, signals: true, items: [] }), getUspsWork: () => ({ ok: true, items: [] })
  });
  await w.run("startRun('test')");
  await drain(w);
  assert.equal(w.badge.text, '!');
  assert.deepEqual(Array.from(w.store.pt_state.badgeIssues).sort(), ['metapay', 'notifications']);
  await w.message({ type: 'pt:probe', input: '1288988733112094' });                               // an unrelated kind: badge stays
  assert.equal(w.badge.text, '!');
  notif = { ok: true, notifications: [], scanned: 2 };
  await w.message({ type: 'pt:probeNotifications' });
  assert.equal(w.badge.text, '!');                                                                // Meta Pay is still open
  w.ctx.chrome.scripting.executeScript = async (o) => (o.files ? [] : [{ result: { ok: true, transactions: [] } }]);
  await w.message({ type: 'pt:probeMetaPay' });
  assert.equal(w.badge.text, '');
  assert.deepEqual(Array.from(w.store.pt_state.badgeIssues), []);
});

test('an old backend that does not know submitSignals does not clog the outbox', async () => {
  const w = worker({ PT_metaPayInPage: { ok: true, transactions: [] }, PT_notificationsInPage: { ok: true, notifications: [] } }, {
    getWork: () => ({ ok: true, signals: true, items: [] }), getUspsWork: () => ({ ok: true, items: [] }),
    submitSignals: () => ({ ok: false, error: 'UNKNOWN_ACTION' })
  });
  await w.run("startRun('test')");
  await drain(w);
  assert.equal((w.store.pt_outbox || []).length, 0);
  assert.match(w.store.pt_state.log.join('\n'), /update\/redeploy the Apps Script/);
});

// ---------------------------------------------------------------- Meta Pay: one reload retry when no rows were read
const NO_ROWS = { ok: false, error: 'META_PAY_NO_TRANSACTIONS', detail: 'no "name / status / date / amount" rows found after 15s (heading not seen)' };
const WALLET_ROW = { seller: 'Olga Serdinskaya', status: 'Delivered', date: '2026-11-03', amount: 262.84 };
const signalsOnly = () => ({ getWork: () => ({ ok: true, signals: true, items: [] }), getUspsWork: () => ({ ok: true, items: [] }) });

test('Meta Pay in a run: no rows on the first read -> tab reloaded once, second read is submitted', async () => {
  let n = 0;
  const w = worker({ PT_metaPayInPage: () => (++n === 1 ? NO_ROWS : { ok: true, transactions: [WALLET_ROW] }), PT_notificationsInPage: { ok: true, notifications: [] } }, signalsOnly());
  await w.run("startRun('test')");
  await drain(w);
  assert.equal(n, 2);
  assert.equal(w.calls.filter((c) => c.reload).length, 1);
  const sent = w.calls.find((c) => c.api === 'submitSignals' && c.body.result.source === 'metapay');
  assert.equal(sent.body.result.transactions.length, 1);
  assert.match(w.store.pt_state.log.join('\n'), /Meta Pay: 1 transaction\(s\) sent \(after one reload retry\)/);
});

test('Meta Pay in a run: still no rows after the retry -> META_PAY_NO_TRANSACTIONS with "retried", retried exactly once', async () => {
  let n = 0;
  const w = worker({ PT_metaPayInPage: () => { n++; return Object.assign({}, NO_ROWS); }, PT_notificationsInPage: { ok: true, notifications: [] } }, signalsOnly());
  await w.run("startRun('test')");
  await drain(w);
  assert.equal(n, 2);                                                                             // first read + exactly one retry
  assert.equal(w.calls.filter((c) => c.reload).length, 1);
  assert.ok(!w.calls.some((c) => c.api === 'submitSignals' && c.body.result.source === 'metapay'));
  assert.ok(!w.calls.some((c) => c.api === 'reportIssue'));                                      // not a login problem: no issue raised
  assert.match(w.store.pt_state.log.join('\n'), /Meta Pay: error META_PAY_NO_TRANSACTIONS \(retried once after reload — no "name/);
});

test('Meta Pay: a password prompt is NOT retried (login/re-auth handling unchanged); the probe uses the same retry path', async () => {
  let n = 0;
  const w = worker({ PT_metaPayInPage: () => { n++; return { ok: false, error: 'REAUTH_REQUIRED' }; } }, signalsOnly());
  const r = await w.run('checkMetaPay()');
  assert.equal(r.error, 'REAUTH_REQUIRED'); assert.equal(n, 1); assert.equal(w.calls.filter((c) => c.reload).length, 0);
  let m = 0;
  w.ctx.chrome.scripting.executeScript = async (o) => (o.files ? [] : [{ result: ++m === 1 ? Object.assign({}, NO_ROWS) : { ok: true, transactions: [WALLET_ROW] } }]);
  const p = await w.message({ type: 'pt:probeMetaPay' });
  assert.equal(p.ok, true); assert.equal(p.retried, true); assert.equal(m, 2);
});
