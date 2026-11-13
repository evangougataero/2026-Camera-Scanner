'use strict';
/**
 * Loads the REAL extension/background.js into a vm with a fake `chrome` + fetch, and checks the run/step machinery:
 * watchdog alarm before each step, retry cap after worker restarts, seller-only items, signal steps, outbox actions,
 * and that a Meta Pay password prompt is reported (never bypassed) without stopping the Facebook checks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');

function worker(pageResults, backend) {
  const store = {}, alarms = {}, calls = [], listeners = {};
  const ev = (name) => ({ addListener: (fn) => { (listeners[name] = listeners[name] || []).push(fn); }, removeListener: () => {} });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const chrome = {
    runtime: { id: 'me', onInstalled: ev('installed'), onStartup: ev('startup'), onMessage: ev('message'), getPlatformInfo: (cb) => cb && cb({}), openOptionsPage() {} },
    storage: { local: {
      get: async (k) => ({ [k]: clone(store[k]) }),
      set: async (o) => { Object.keys(o).forEach((k) => { store[k] = clone(o[k]); }); },
      remove: async (k) => { delete store[k]; }
    } },
    alarms: { create: async (n, o) => { alarms[n] = o; }, get: async (n) => alarms[n], clear: async (n) => { delete alarms[n]; }, onAlarm: ev('alarm') },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, onClicked: ev('click') },
    tabs: {
      create: async (o) => { calls.push({ tab: o.url }); return { id: 7, url: o.url }; },
      update: async () => ({}), remove: async () => {},
      get: async () => ({ id: 7, status: 'complete', url: 'https://www.facebook.com/marketplace/item/1/' }),
      onUpdated: ev('updated')
    },
    scripting: {
      executeScript: async (o) => {
        if (o.files) return [];
        const r = pageResults[o.func.name];
        if (r instanceof Error) throw r;
        return [{ result: typeof r === 'function' ? r(o.args[0]) : r }];
      }
    }
  };
  const fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    calls.push({ api: body.action, body });
    const out = (backend[body.action] || (() => ({ ok: true })))(body);
    return { text: async () => JSON.stringify(out) };
  };
  const ctx = {
    chrome, fetch, console: { log() {} }, URL, JSON, Math, Date, Object, Array, String, RegExp, Number, Promise, Error, AbortController,
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout, setInterval: () => 0, clearInterval: () => {}
  };
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), ctx, { filename: f }));
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  store.pt_settings = { apiUrl: 'https://script.google.com/macros/s/abc/exec', apiToken: 't' };
  return { ctx, store, alarms, calls, run: (code) => vm.runInContext(code, ctx) };
}

const ORDER_OK = { ok: true, orderView: true, fbStatusRaw: 'Delivered | Your order was delivered.', trackingNumber: '9334610579700004096766', carrier: 'USPS', seller: 'Olga Serdinskaya', itemTitle: 'Canon EOS 760D' };

async function drain(w, max) {
  for (let i = 0; i < (max || 20) && w.store.pt_queue; i++) await w.run('processStep()');
}

test('a run processes signals first, then order checks, then seller-only checks; every result reaches the right backend action', async () => {
  const w = worker({ PT_extractInPage: (o) => (o.mode === 'seller' ? { ok: true, mode: 'seller', seller: 'Nathan Stickler' } : ORDER_OK),
                     PT_metaPayInPage: { ok: true, transactions: [{ seller: 'Olga Serdinskaya', status: 'Delivered', date: '2026-11-03', amount: 262.84 }] },
                     PT_notificationsInPage: { ok: true, notifications: [], scanned: 4 } }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094', url: '', mode: 'order' }],
                      sellerItems: [{ purchaseId: 'N-1', listingId: '5555555555555555', url: '' }] }),
    getUspsWork: () => ({ ok: true, items: [] })
  });
  await w.run("startRun('test')");
  await drain(w);
  const order = w.calls.filter((c) => c.tab).map((c) => c.tab);
  assert.deepEqual(order, ['https://accountscenter.facebook.com/meta_pay_wallet/?referrer=accounts_center_home', 'https://www.facebook.com/marketplace/notifications/',
    'https://www.facebook.com/marketplace/item/1288988733112094/', 'https://www.facebook.com/marketplace/item/5555555555555555/']);
  const posts = w.calls.filter((c) => c.api && /^submit/.test(c.api));
  assert.deepEqual(posts.map((p) => p.body.action + ':' + (p.body.result.source || p.body.result.mode)),
    ['submitSignals:metapay', 'submitSignals:notifications', 'submitFbResult:order', 'submitFbResult:seller']);
  const fb = posts[2].body.result;
  assert.equal(fb.trackingNumber, '9334610579700004096766'); assert.equal(fb.seller, 'Olga Serdinskaya'); assert.equal(fb.itemTitle, 'Canon EOS 760D');
  assert.equal(posts[3].body.result.seller, 'Nathan Stickler');
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
  const w = worker({ PT_metaPayInPage: { ok: false, error: 'REAUTH_REQUIRED' }, PT_notificationsInPage: { ok: true, notifications: [] }, PT_extractInPage: ORDER_OK }, {
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

test('Facebook login wall on the notifications page stops the remaining Facebook checks (never bypassed)', async () => {
  const w = worker({ PT_notificationsInPage: { ok: false, error: 'LOGIN_REQUIRED' }, PT_extractInPage: ORDER_OK }, {
    getWork: () => ({ ok: true, signals: true, items: [{ purchaseId: 'C-1', listingId: '1288988733112094' }] }),
    getUspsWork: () => ({ ok: true, items: [{ purchaseId: 'C-1', trackingNumber: '9334610579700004096766' }] })
  });
  w.store.pt_settings.scanMetaPay = false;                                                       // option honoured
  await w.run("startRun('test')");
  await drain(w);
  assert.ok(!w.calls.some((c) => c.tab && /accountscenter/.test(c.tab)));
  assert.ok(!w.calls.some((c) => c.api === 'submitFbResult'));
  assert.ok(w.calls.some((c) => c.tab && /tools\.usps\.com/.test(c.tab)));                       // USPS is unaffected
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
