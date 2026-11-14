'use strict';
/**
 * Loads the REAL extension/background.js into a vm with a fake `chrome` + fetch (shared by background.test.js and
 * orders-run.test.js). Page functions are answered from `pageResults[<function name>]` (value, function(opts) or Error);
 * Apps Script actions from `backend[<action>](body)`.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'extension');

function worker(pageResults, backend) {
  const store = {}, alarms = {}, calls = [], listeners = {}, badge = { text: '' };
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
    action: { setBadgeText: async (o) => { badge.text = o.text; }, setBadgeBackgroundColor: async () => {}, onClicked: ev('click') },
    tabs: {
      create: async (o) => { calls.push({ tab: o.url }); return { id: 7, url: o.url }; },
      update: async () => ({}), remove: async () => {}, reload: async (id) => { calls.push({ reload: id }); },
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
  const message = (msg) => new Promise((resolve) => listeners.message[0](msg, { id: 'me' }, resolve));
  return { ctx, store, alarms, calls, badge, message, run: (code) => vm.runInContext(code, ctx) };
}

async function drain(w, max) {
  for (let i = 0; i < (max || 20) && w.store.pt_queue; i++) await w.run('processStep()');
}

/** An orders-page read (PT_ordersInPage result) with one Delivered order whose card links listing 1288988733112094. */
const ORDER_C1 = { key: 'Delivered|Canon EOS 760D|Nov 3, 2026#1', status: 'delivered', statusRaw: 'Delivered', title: 'Canon EOS 760D (Rebel T6s) with the Lens',
  cardTitle: 'Canon EOS 760D (Rebel T6s) with...', orderDate: '2026-11-03', orderDateRaw: 'Nov 3, 2026', price: 225, quantity: 1,
  trackingNumber: '9334610579700004096766', carrier: 'USPS', estimatedArrival: '', estimatedDelivery: '', seller: 'Olga Serdinskaya',
  timeline: [{ step: 'Order Confirmed', at: 'Nov 3 at 12:43 PM', done: true }, { step: 'Delivered', at: 'Nov 9 at 5:34 PM', done: true }],
  orderId: '', listingId: '1288988733112094', dialogOpened: true, dialogError: '' };
const ORDERS_C1 = { ok: true, orders: [ORDER_C1], cardsSeen: 1, dialogsOpened: 1, scrolls: 1, stopReason: 'no more orders loaded' };

module.exports = { worker, drain, ORDER_C1, ORDERS_C1 };
