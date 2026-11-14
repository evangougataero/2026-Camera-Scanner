/**
 * Purchase Tracker — MV3 service worker.
 *
 * Job: every 180 minutes, ask the Apps Script web app what is due, then (in this order):
 *   1. Facebook "Purchased orders" page (https://www.facebook.com/marketplace/you/orders/) — ONE visit per run replaces
 *      the old per-listing checks: read every order card (status, title, date), open the "Order status" dialog of each
 *      card that could belong to a tracked purchase (status, estimated arrival, carrier + tracking, timeline, seller,
 *      price, IDs), match orders to Purchased rows (ID > seller+price > title+date; ties change nothing) and post one
 *      result per matched row through the existing submitFbResult endpoint.
 *      A purchase NOT FOUND on the page is never canceled: it is logged and (unless switched off on the Options page)
 *      its listing page is read the old way as a fallback, which itself never cancels without explicit evidence.
 *   2. USPS checks: https://tools.usps.com/tracking/<number> in a background tab (including numbers the orders page just found).
 *   3. Secondary confirmation signals (only while the backend has active purchases): Meta Pay wallet + Marketplace notifications.
 * Every page is opened in a BACKGROUND tab (active:false); each result is posted back and the tab closed. All spreadsheet logic lives in Apps Script.
 * No Facebook/USPS APIs, no credentials. Bot checks / login walls / password prompts are reported, never bypassed.
 *
 * MV3 service workers die after ~30 s without extension activity, so:
 *   - a run is a persisted queue processed ONE item per "step", with a 30 s alarm between steps (also the rate limit);
 *   - while a page is being read, a keep-alive pings an extension API every 20 s (a long executeScript await alone
 *     does not keep the worker alive, which used to kill checks mid-way and stall the queue);
 *   - each step first arms a watchdog alarm, so a worker killed mid-step resumes the same item (max 3 tries).
 * A heartbeat + storage lock prevents duplicate concurrent runs.
 */
importScripts('login-guard.js', 'parse-order.js', 'parse-orders.js', 'orders-extractor.js', 'fb-extractor.js', 'parse-usps.js', 'usps-extractor.js',
  'parse-signals.js', 'signals-extractor.js');

const ALARM_RUN = 'pt-run';
const ALARM_STEP = 'pt-step';
const RUN_PERIOD_MIN = 180;
const STEP_DELAY_MIN = 0.5;                 // Chrome's minimum alarm granularity; also our pacing
const WATCHDOG_MIN = 5;                     // re-fire a step if the worker died mid-step
const MAX_STEP_TRIES = 3;
const STALE_MS = 15 * 60 * 1000;            // a queue with no heartbeat for this long is "interrupted"
const STEP_LOCK_MS = 4 * 60 * 1000;
const PAGE_TIMEOUT_MS = 45000;
const SCRIPT_TIMEOUT_MS = 90000;
const BATCH_LIMIT = 15;
const OUTBOX_MAX = 50;

const META_PAY_URL = 'https://accountscenter.facebook.com/meta_pay_wallet/?referrer=accounts_center_home';
const ORDERS_URL = 'https://www.facebook.com/marketplace/you/orders/';
const ORDERS_SCRIPT_TIMEOUT_MS = 270000;    // cards + up to ~25 dialogs
const ORDERS_DEFAULT_LOOKBACK_DAYS = 60;    // how far back to scroll when no purchase date is known (probe without backend)
const NOTIFICATION_URLS =['https://www.facebook.com/marketplace/notifications/', 'https://www.facebook.com/notifications/'];

const K = { settings: 'pt_settings', queue: 'pt_queue', state: 'pt_state', outbox: 'pt_outbox', stepLock: 'pt_stepLock', openTab: 'pt_openTab' };
let stepping = false;                       // in-memory guard on top of the storage lock

// ---------------------------------------------------------------- storage helpers
const getLocal = async (key) => (await chrome.storage.local.get(key))[key];
const setLocal = (obj) => chrome.storage.local.set(obj);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'TIMEOUT')), ms))]);

async function log(msg) {
  const state = (await getLocal(K.state)) || {};
  const lines = state.log || [];
  lines.push(new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + msg);
  state.log = lines.slice(-80);
  await setLocal({ [K.state]: state });
  console.log('[PT]', msg);
}
async function patchState(p) {
  const state = (await getLocal(K.state)) || {};
  await setLocal({ [K.state]: Object.assign(state, p) });
}
async function settings() { return (await getLocal(K.settings)) || {}; }

/** Keeps the service worker alive while a long page read is in progress (extension API calls reset the idle timer). */
async function withKeepAlive(fn) {
  const t = setInterval(() => { try { chrome.runtime.getPlatformInfo(() => {}); } catch (e) { /* ignore */ } }, 20000);
  try { return await fn(); } finally { clearInterval(t); }
}

// ---------------------------------------------------------------- Apps Script API
async function api(action, payload) {
  const s = await settings();
  if (!s.apiUrl || !s.apiToken) throw new Error('NOT_CONFIGURED (open the extension options)');
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(s.apiUrl)) throw new Error('BAD_API_URL');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(s.apiUrl, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },          // simple request: no CORS preflight
      body: JSON.stringify(Object.assign({}, payload, { action, token: s.apiToken }))
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('NON_JSON_RESPONSE — is the Web App deployed with access "Anyone" (and redeployed as a New version)? ' + txt.slice(0, 60)); }
    if (!j.ok) throw new Error(j.error + (j.detail ? ': ' + j.detail : ''));
    return j;
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- outbox (never lose a result)
async function flushOutbox() {
  const box = (await getLocal(K.outbox)) || [];
  if (!box.length) return;
  const keep = [];
  for (const e of box) {
    if (Date.now() - e.at > 3 * 24 * 3600 * 1000) continue;             // drop very old
    try { await api(e.action || 'submitFbResult', Object.assign({ purchaseId: e.purchaseId, result: e.result }, e.extra || {})); }
    catch (err) {
      if (/UNKNOWN_ACTION/.test(err.message)) { await log('outbox: backend does not know ' + e.action + ' — update/redeploy the Apps Script (dropped)'); continue; }
      keep.push(e); await log('outbox: send failed for ' + (e.purchaseId || e.action) + ' — ' + err.message);
    }
  }
  await setLocal({ [K.outbox]: keep.slice(-OUTBOX_MAX) });
}
async function queueResult(action, purchaseId, result, extra) {
  const box = (await getLocal(K.outbox)) || [];
  box.push({ action, purchaseId, result, extra, at: Date.now() });
  await setLocal({ [K.outbox]: box.slice(-OUTBOX_MAX) });
  await flushOutbox();
}

// ---------------------------------------------------------------- tab handling
/**
 * Never navigate to an arbitrary URL taken from a sheet cell. Always the canonical desktop listing URL
 * (an m./mbasic./web. host or tracking query string in the sheet used to load a different UI without "View Order").
 */
function safeFacebookUrl(item) {
  let id = /^\d{6,25}$/.test(String(item.listingId || '')) ? String(item.listingId) : '';
  if (!id) {
    try {
      const u = new URL(item.url);
      const m = u.pathname.match(/\/marketplace\/item\/(\d{6,25})/);
      if (u.protocol === 'https:' && /(^|\.)facebook\.com$/.test(u.hostname) && m) id = m[1];
    } catch (e) { /* no usable URL */ }
  }
  return id ? 'https://www.facebook.com/marketplace/item/' + id + '/' : '';
}

function waitForComplete(tabId, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); clearTimeout(t); fn(v); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(resolve); };
    const t = setTimeout(() => finish(reject, new Error('PAGE_LOAD_TIMEOUT')), ms);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') finish(resolve); }).catch(() => {});
  });
}

function isContextLost(e) {
  return /Frame with ID|was removed|context (was )?(invalidated|destroyed)|No frame|Cannot access|Receiving end|closed before/i.test(String(e && e.message || e));
}

/** Waits until the tab reports "complete" on two consecutive checks (navigations can start late). */
async function waitForStable(tabId, ms) {
  const end = Date.now() + ms;
  let ok = 0;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error('TAB_CLOSED');
    if (t.status === 'complete') { if (++ok >= 2) return; } else ok = 0;
    await sleep(700);
  }
  throw new Error('PAGE_LOAD_TIMEOUT');
}

/**
 * Runs `run(tabId, firstOpts)`. A click that loads a new page destroys the injected script: executeScript then either
 * throws "Frame ... was removed" or returns nothing. In that case wait for the new page to settle and run the READ
 * phase there (up to 3 hops).
 */
async function runPhase(tabId, run, firstOpts, readOpts) {
  try {
    const r = await run(tabId, firstOpts);
    if (r !== undefined && r !== null) return r;
  } catch (e) { if (!isContextLost(e)) throw e; }
  for (let i = 0; i < 3; i++) {
    await sleep(1500);
    await waitForStable(tabId, PAGE_TIMEOUT_MS);
    await sleep(2000);
    try {
      const r = await run(tabId, readOpts);
      if (r !== undefined && r !== null) return r;
    } catch (e) { if (!isContextLost(e)) throw e; }
  }
  return { ok: false, error: 'CONTEXT_LOST', detail: 'page kept navigating / no script result' };
}

async function closeOrphanTab() {
  const id = await getLocal(K.openTab);
  if (id) { try { await chrome.tabs.remove(id); } catch (e) { /* already gone */ } await chrome.storage.local.remove(K.openTab); }
}

/** Opens url in a background tab, runs body(tabId), always closes the tab. Maps common failures to error codes. */
async function inTab(url, body) {
  await closeOrphanTab();
  let tabId = null;
  return withKeepAlive(async () => {
    try {
      const tab = await chrome.tabs.create({ url, active: false });                       // never steals focus
      await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});     // keep Memory Saver from discarding it
      tabId = tab.id;
      await setLocal({ [K.openTab]: tabId });
      try { await waitForComplete(tabId, PAGE_TIMEOUT_MS); } catch (e) { return { ok: false, error: 'PAGE_LOAD_TIMEOUT' }; }
      await sleep(2500);                                                                 // let the React app hydrate
      return await body(tabId);
    } catch (e) {
      if (String(e && e.message) === 'PAGE_LOAD_TIMEOUT') return { ok: false, error: 'PAGE_LOAD_TIMEOUT' };
      if (String(e && e.message) === 'TAB_CLOSED') return { ok: false, error: 'TAB_CLOSED', detail: 'tab disappeared mid-check (closed manually, or replaced/discarded by Chrome)' };
      return { ok: false, error: 'EXTENSION_ERROR', detail: String(e && e.message || e).slice(0, 200) };
    } finally {
      if (tabId !== null) { try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ } }
      await chrome.storage.local.remove(K.openTab);
    }
  });
}

const isWall = (r) => !!r && !r.ok && (r.error === 'LOGIN_REQUIRED' || r.error === 'CHECKPOINT');
const WALL_RECHECK_MS = 5000;

/** Login wall / checkpoint from the tab's URL (PATHNAME only — "login" inside a query string does not count). */
async function tabWall(tabId) {
  const cur = await chrome.tabs.get(tabId);
  const code = PTGuard.pathBlocker(cur.url || '');
  return code ? { ok: false, error: code, url: cur.url, detail: PTGuard.describe(cur.url, cur.title || '', 'url') } : null;
}

/**
 * A LOGIN_REQUIRED / CHECKPOINT is re-verified ONCE (fresh tab after a few seconds) before it is reported: a page that
 * was still hydrating, or a transient redirect, must not stop a run. A wall seen twice is real and is reported (never bypassed).
 */
async function reverifyWall(check) {
  const first = await check();
  if (!isWall(first)) return first;
  await sleep(WALL_RECHECK_MS);
  const second = await check();
  if (isWall(second)) return Object.assign(second, { reverified: true, firstDetail: first.detail || '' });
  return Object.assign(second || { ok: false, error: 'NO_RESULT' }, { recoveredFrom: first.error + (first.detail ? ' (' + String(first.detail).slice(0, 200) + ')' : '') });
}

async function runExtractor(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['login-guard.js', 'parse-order.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: PT_extractInPage, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

async function checkListing(item, opts) {
  opts = opts || {};
  const url = safeFacebookUrl(item);
  if (!url) return { ok: false, error: 'BAD_URL', detail: 'no usable Facebook listing URL' };
  const mode = item.mode === 'seller' ? 'seller' : 'order';
  const probe = !!opts.probe;
  return reverifyWall(() => inTab(url, async (tabId) => {
    const wall = await tabWall(tabId);
    if (wall) return wall;
    let res = await runPhase(tabId, runExtractor, { phase: 'click', mode, probe }, { phase: 'read', mode, probe });
    if (res && res.nav) {
      const fromListing = { seller: res.seller, itemTitle: res.itemTitle };
      await chrome.tabs.update(tabId, { url: res.nav });                                 // stays a background tab
      try { await waitForComplete(tabId, PAGE_TIMEOUT_MS); } catch (e) { return { ok: false, error: 'PAGE_LOAD_TIMEOUT', detail: 'order page', seller: fromListing.seller }; }
      await sleep(2500);
      res = await runPhase(tabId, runExtractor, { phase: 'read', mode, probe }, { phase: 'read', mode, probe });
      if (res) { if (!res.seller) res.seller = fromListing.seller; if (!res.itemTitle) res.itemTitle = fromListing.itemTitle; }
    }
    return res || { ok: false, error: 'NO_RESULT' };
  }));
}

// ---------------------------------------------------------------- Facebook "Purchased orders" page
/** Work items from getWork -> the fields the matcher needs (older backends send fewer fields: matching then relies on IDs/titles). */
function matchItem(w) {
  return { purchaseId: String(w.purchaseId), listingId: String(w.listingId || ''), orderId: String(w.orderId || ''), seller: w.seller || '',
           cost: w.cost === undefined ? '' : w.cost, ask: w.ask === undefined ? '' : w.ask, purchasedAt: w.purchasedAt || '',
           fbTitle: w.fbTitle || '', product: w.product || '', trackingNumber: w.trackingNumber || '', mode: w.mode === 'seller' ? 'seller' : 'order' };
}

function isoDaysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }

async function runOrders(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['login-guard.js', 'parse-order.js', 'parse-orders.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: PT_ordersInPage, args: [opts] }), ORDERS_SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

/**
 * One visit to the orders page (same code for scheduled runs and the "Probe orders page" button; only `probe` differs).
 * If opening a card navigates the tab away (the injected script dies), the tab is sent back to the list and the read
 * RESUMES (the page function keeps its progress in sessionStorage), max 3 attempts. Login walls are re-verified once
 * (reverifyWall) and never bypassed.
 */
async function checkOrdersPage(work, opts) {
  opts = opts || {};
  const items = (work || []).map(matchItem);
  const earliest = PTOrders.earliestNeeded(items) || isoDaysAgo(ORDERS_DEFAULT_LOOKBACK_DAYS);
  const pageOpts = Object.assign({ items, earliest, probe: !!opts.probe, openAll: !!opts.probe }, opts.pageOpts || {});
  return reverifyWall(() => inTab(ORDERS_URL, async (tabId) => {
    const wall = await tabWall(tabId);
    if (wall) return wall;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await runOrders(tabId, Object.assign({}, pageOpts, { resume: attempt > 0 }));
        if (r) return Object.assign(r, attempt ? { resumed: attempt } : {});
      } catch (e) { if (!isContextLost(e)) throw e; }
      await chrome.tabs.update(tabId, { url: ORDERS_URL });                             // back to the list, still a background tab
      await sleep(1500);
      await waitForStable(tabId, PAGE_TIMEOUT_MS);
      const again = await tabWall(tabId);
      if (again) return again;
      await sleep(2500);
    }
    return { ok: false, error: 'CONTEXT_LOST', detail: 'the orders page kept navigating away' };
  }));
}

async function runUsps(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['parse-usps.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: PT_uspsInPage, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

const USPS_BASE = 'https://tools.usps.com/tracking/';      // /tracking/<number> shows the result directly (verified)

async function checkUsps(item, opts) {
  opts = opts || {};
  const number = String(item.trackingNumber || '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9]{10,34}$/.test(number)) return { ok: false, error: 'BAD_TRACKING_NUMBER' };
  return inTab(USPS_BASE + encodeURIComponent(number), (tabId) =>
    runPhase(tabId, runUsps, { phase: 'auto', number, probe: !!opts.probe }, { phase: 'read', number, probe: !!opts.probe }).then((r) => r || { ok: false, error: 'NO_RESULT' }));
}

async function runSignalsFn(tabId, func, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['login-guard.js', 'parse-signals.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

const META_PAY_RETRY_WAIT_MS = 5000;

/**
 * Meta Pay wallet — the SAME path for scheduled runs and the "Probe Meta Pay" button (only `probe` differs).
 * The transaction list is client-rendered; in a run the background tab can be slower/throttled, so the page function
 * polls for rows, and if it still sees none the tab is reloaded ONCE and read again before META_PAY_NO_TRANSACTIONS
 * is reported (the detail then says "retried"). Login / re-auth results are never retried here (reverifyWall handles walls).
 */
async function checkMetaPay(opts) {
  const probe = !!(opts && opts.probe);
  const read = (tabId) => runPhase(tabId, (t, o) => runSignalsFn(t, PT_metaPayInPage, o), { probe }, { probe });
  return reverifyWall(() => inTab(META_PAY_URL, async (tabId) => {
    const wall = await tabWall(tabId);
    if (wall) return wall;
    const first = (await read(tabId)) || { ok: false, error: 'NO_RESULT' };
    if (first.ok || first.error !== 'META_PAY_NO_TRANSACTIONS') return first;
    let second;
    try {
      await chrome.tabs.reload(tabId);
      await sleep(1000);
      await waitForStable(tabId, PAGE_TIMEOUT_MS);
      const again = await tabWall(tabId);
      if (again) return again;
      await sleep(META_PAY_RETRY_WAIT_MS);                                              // let the list render
      second = (await read(tabId)) || { ok: false, error: 'NO_RESULT' };
    } catch (e) {
      second = { ok: false, error: 'META_PAY_NO_TRANSACTIONS', detail: 'reload failed: ' + String(e && e.message || e).slice(0, 100) };
    }
    if (second.ok) return Object.assign(second, { retried: true });
    if (second.error !== 'META_PAY_NO_TRANSACTIONS') return Object.assign(second, { retried: true });
    return Object.assign(second, { retried: true, detail: 'retried once after reload — ' + (second.detail || first.detail || '') });
  }));
}

async function checkNotifications(opts) {
  const probe = !!(opts && opts.probe);
  let last = null;
  for (const url of NOTIFICATION_URLS) {                    // Marketplace notifications first, then all notifications
    last = await reverifyWall(() => inTab(url, async (tabId) => {
      const wall = await tabWall(tabId);
      if (wall) return wall;
      return (await runPhase(tabId, (t, o) => runSignalsFn(t, PT_notificationsInPage, o), { probe }, { probe })) || { ok: false, error: 'NO_RESULT' };
    }));
    if (last && (last.ok || isWall(last))) return Object.assign(last, { source: url });       // a CONFIRMED wall: no point trying the next page
  }
  return last || { ok: false, error: 'NO_RESULT' };
}

// ---------------------------------------------------------------- run / step machinery
async function scheduleStep(minutes) { await chrome.alarms.create(ALARM_STEP, { delayInMinutes: minutes }); }

async function finishRun(q, outcome) {
  const stats = q.stats || {};
  await chrome.storage.local.remove(K.queue);
  await chrome.alarms.clear(ALARM_STEP);
  await patchState({ lastRunFinishedAt: Date.now(), lastRunOutcome: outcome, lastRunStats: stats });
  await log('run ' + outcome + ' — ok:' + (stats.ok || 0) + ' errors:' + (stats.errors || 0) + ' canceled:' + (stats.canceled || 0) + ' tracking:' + (stats.tracking || 0) +
    ' sellers:' + (stats.sellers || 0) + ' usps:' + (stats.usps || 0) + ' signals:' + (stats.signals || 0) + ' not-on-orders-page:' + (stats.notFound || 0));
  const kinds = issueKindsOf(q);
  await patchState({ badgeIssues: kinds });
  await setBadge(kinds);
}

/** Kinds ('fb' | 'usps' | 'metapay' | 'notifications') that raised an issue in this run (older queues only had a boolean). */
function issueKindsOf(q) { return (q.issueKinds && q.issueKinds.length) ? q.issueKinds.slice() : (q.issue ? ['unknown'] : []); }
function flagIssue(q, kind) { q.issue = true; q.issueKinds = q.issueKinds || []; if (q.issueKinds.indexOf(kind) === -1) q.issueKinds.push(kind); }
async function setBadge(kinds) {
  await chrome.action.setBadgeText({ text: kinds.length ? '!' : '' });
  if (kinds.length) await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}
/** A manual probe of one kind succeeded: that kind's issue is resolved — clear the red badge if nothing else is outstanding. */
async function clearIssueAfterProbe(kind) {
  const st = (await getLocal(K.state)) || {};
  const before = st.badgeIssues || [];
  const after = before.filter((k) => k !== kind && k !== 'unknown');
  if (after.length !== before.length) await log('probe ' + kind + ' succeeded — issue cleared' + (after.length ? ' (still open: ' + after.join(', ') + ')' : ''));
  await patchState({ badgeIssues: after });
  await setBadge(after);
}

async function startRun(reason, force) {
  const q = await getLocal(K.queue);
  if (q && Date.now() - q.heartbeat < STALE_MS) { await log('start skipped (' + reason + '): a run is already in progress'); return { skipped: 'in-progress' }; }
  if (q) { await log('resuming interrupted run (' + reason + ')'); await chrome.storage.local.remove(K.stepLock); await processStep(); return { resumed: true }; }

  const items = [];
  const s = await settings();
  try {
    await flushOutbox();
    // Order of work: the Facebook orders page FIRST (the data that matters most; one visit covers every due purchase,
    // order checks and seller backfill alike), then USPS, then the Meta Pay / notifications signal pages LAST — a problem
    // on a signal page can never cost the order checks of a run.
    const fb = await api('getWork', { limit: BATCH_LIMIT, force: !!force });
    const work = (fb.items || []).map((i) => Object.assign({}, i, { mode: 'order' }))
      .concat((fb.sellerItems || []).map((i) => Object.assign({}, i, { mode: 'seller' })));
    if (work.length) items.push({ kind: 'orders', purchaseId: 'ORDERS_PAGE', work });
    const us = await api('getUspsWork', { limit: BATCH_LIMIT, force: !!force });
    (us.items || []).forEach((i) => items.push(Object.assign({ kind: 'usps' }, i)));
    if (fb.signals) {                                        // backend has purchases a cancellation could still affect
      if (s.scanMetaPay !== false) items.push({ kind: 'metapay', purchaseId: 'META_PAY' });
      if (s.scanNotifications !== false) items.push({ kind: 'notifications', purchaseId: 'NOTIFICATIONS' });
    }
  } catch (e) {
    await patchState({ lastError: e.message, lastErrorAt: Date.now() });
    await log('getWork failed: ' + e.message);
    return { error: e.message };
  }
  await patchState({ lastRunStartedAt: Date.now(), lastError: '' });
  if (!items.length) {
    await patchState({ lastRunFinishedAt: Date.now(), lastRunOutcome: 'nothing due', lastRunStats: {} });
    await log('nothing due (' + reason + ')');
    await chrome.action.setBadgeText({ text: '' });
    return { items: 0 };
  }
  await setLocal({ [K.queue]: { runId: String(Date.now()), reason, startedAt: Date.now(), heartbeat: Date.now(), index: 0, tries: 0, items, issue: false, issueKinds: [],
    stats: { ok: 0, errors: 0, canceled: 0, tracking: 0, sellers: 0, usps: 0, signals: 0, notFound: 0 } } });
  const n = (k) => items.filter((i) => i.kind === k).length;
  const ow = (items.find((i) => i.kind === 'orders') || {}).work || [];
  await log('run started (' + reason + '): orders page for ' + ow.length + ' purchase(s) (' + ow.filter((w) => w.mode === 'seller').length + ' seller-only), ' +
    n('usps') + ' USPS, ' + (n('metapay') + n('notifications')) + ' signal page(s)');
  await processStep();
  return { items: items.length };
}

/** Remove not-yet-processed items of the given kinds (e.g. after a login wall / bot check). */
function dropRemaining(q, kinds) {
  q.items = q.items.filter((it, i) => i <= q.index || kinds.indexOf(it.kind) === -1);
}

/** Dropped after a wall on a Facebook ORDER page (orders page or listing fallback). A wall on a signal page never drops order checks. */
const FB_KINDS = ['orders', 'fb', 'notifications'];

/** Inserts items right after the current one (fallback listing checks) or before the signal pages (new USPS checks). */
function insertNext(q, list) { q.items.splice(q.index + 1, 0, ...list); }
function insertBeforeSignals(q, list) {
  let at = q.items.findIndex((it, i) => i > q.index && (it.kind === 'metapay' || it.kind === 'notifications'));
  if (at === -1) at = q.items.length;
  q.items.splice(at, 0, ...list);
}

/**
 * Orders-page result -> one submitFbResult per matched purchase (existing endpoint and payload shape, plus a few extra
 * fields old backends ignore). Not-found and ambiguous purchases are only LOGGED (never canceled, nothing sent for them);
 * they get the old listing-page check as a fallback unless the user switched it off.
 */
async function handleOrders(q, item, res) {
  const work = item.work || [];
  const s = await settings();
  const fallbackOn = s.fallbackListing !== false;
  let fallback = [];
  if (!res.ok) {
    q.stats.errors++;
    await log('Orders page: error ' + res.error + (res.detail ? ' (' + String(res.detail).slice(0, 240) + ')' : '') +
      (fallbackOn && work.length ? ' — checking ' + work.length + ' listing page(s) instead' : ''));
    fallback = work;
  } else {
    const plan = PTOrders.planOrderResults(res.orders || [], work.map(matchItem));
    await log('Orders page: ' + (res.cardsSeen || 0) + ' order card(s), ' + (res.dialogsOpened || 0) + ' dialog(s) read, ' + (res.scrolls || 0) + ' scroll(s) (' +
      (res.stopReason || '') + '); matched ' + plan.submissions.length + ', ambiguous ' + plan.ambiguous.length + ', not found ' + plan.notFound.length);
    for (const sub of plan.submissions) {
      await queueResult('submitFbResult', sub.purchaseId, sub.result);                    // saved before moving on
      q.stats.ok++;
      if (sub.result.canceled) q.stats.canceled++;
      if (sub.result.trackingNumber) q.stats.tracking++;
      if (sub.result.seller) q.stats.sellers++;
      await log(sub.purchaseId + ' FB orders page' + (sub.mode === 'seller' ? ' (seller)' : '') + ' [' + sub.via + ']: ' + PTOrders.describeOrder(sub.order));
    }
    for (const a of plan.ambiguous) {
      await log('Orders page: AMBIGUOUS "' + String(a.title).slice(0, 60) + '" ' + (a.orderDate || '') + ' fits ' + a.purchaseIds.join(' / ') + ' (' + a.via + ') — nothing changed');
    }
    const amb = {};
    plan.ambiguous.forEach((a) => a.purchaseIds.forEach((id) => { amb[id] = true; }));
    q.stats.notFound = (q.stats.notFound || 0) + plan.notFound.length;
    for (const id of plan.notFound) await log(id + ' not found on orders page — unchanged' + (fallbackOn ? '; checking its listing page instead' : ''));
    fallback = work.filter((w) => plan.notFound.indexOf(String(w.purchaseId)) !== -1 || amb[String(w.purchaseId)]);
    const newUsps = plan.newUspsTracking.filter((t) => !q.items.some((it) => it.kind === 'usps' && it.purchaseId === t.purchaseId))
      .map((t) => ({ kind: 'usps', purchaseId: t.purchaseId, trackingNumber: t.trackingNumber }));
    if (newUsps.length) insertBeforeSignals(q, newUsps);
  }
  if (fallbackOn && fallback.length) insertNext(q, fallback.map((w) => Object.assign({ kind: 'fb' }, w)));
}

/** " — <how · path · snippet>" suffix for LOGIN_REQUIRED / CHECKPOINT / REAUTH reports, so false alarms are diagnosable. */
function wallDetail(res) {
  if (!res) return '';
  const d = res.detail ? String(res.detail).slice(0, 260) : (res.url ? PTGuard.describe(res.url, '', '') : '');
  return (d ? ' — ' + d : '') + (res.reverified ? ' (seen twice)' : '');
}

async function handleSignals(q, item, res) {
  const label = item.kind === 'metapay' ? 'Meta Pay' : 'Notifications';
  if (!res.ok) {
    if (res.error === 'LOGIN_REQUIRED' || res.error === 'CHECKPOINT' || res.error === 'REAUTH_REQUIRED') {
      // Reported and flagged, never bypassed — but the run goes on: signal pages run last and never stop order checks.
      const why = wallDetail(res);
      try { await api('reportIssue', { code: res.error, message: label + ' ' + res.error + (res.error === 'REAUTH_REQUIRED' ? ' — Meta asked for your password; open the wallet page once by hand' : '') + why }); } catch (e) { /* offline */ }
      flagIssue(q, item.kind);
      await log('STOPPED ' + label + ': ' + res.error + why + ' — resolve it manually in Chrome (never bypassed)');
    } else {
      await log(label + ': error ' + res.error + (res.detail ? ' (' + String(res.detail).slice(0, 240) + ')' : '') + (res.retried && !/retried/.test(res.detail || '') ? ' (retried once)' : ''));
    }
    q.stats.errors++;
    return;
  }
  const payload = item.kind === 'metapay' ? { source: 'metapay', ok: true, transactions: res.transactions || [] }
                                          : { source: 'notifications', ok: true, notifications: res.notifications || [] };
  await queueResult('submitSignals', '', payload);
  q.stats.signals++;
  await log(label + ': ' + (item.kind === 'metapay' ? (res.transactions || []).length + ' transaction(s)' : (res.notifications || []).length + ' order notification(s) of ' + (res.scanned || 0) + ' scanned') + ' sent' + (res.retried ? ' (after one reload retry)' : ''));
}

async function processStep() {
  if (stepping) return;
  const lockAt = await getLocal(K.stepLock);
  if (lockAt && Date.now() - lockAt < STEP_LOCK_MS) return;
  stepping = true;
  await setLocal({ [K.stepLock]: Date.now() });
  try {
    const q = await getLocal(K.queue);
    if (!q) return;
    if (q.index >= q.items.length) { await finishRun(q, 'completed'); return; }
    const item = q.items[q.index];
    const kind = item.kind || 'fb';
    q.tries = (q.tries || 0) + 1;
    q.heartbeat = Date.now();
    await setLocal({ [K.queue]: q });
    await scheduleStep(WATCHDOG_MIN);                       // if this worker dies mid-step, the alarm resumes the queue

    let res;
    if (q.tries > MAX_STEP_TRIES) res = { ok: false, error: 'STEP_ABORTED', detail: 'the extension worker restarted ' + (q.tries - 1) + ' times on this item' };
    else {
      try {
        res = kind === 'usps' ? await checkUsps(item)
          : kind === 'metapay' ? await checkMetaPay()
          : kind === 'notifications' ? await checkNotifications()
          : kind === 'orders' ? await checkOrdersPage(item.work)
          : await checkListing(item);
      } catch (e) { res = { ok: false, error: 'EXTENSION_ERROR', detail: String(e.message || e) }; }
    }
    res = res || { ok: false, error: 'NO_RESULT' };

    const fbKind = kind === 'fb' || kind === 'orders';
    const systemic = !res.ok && ((fbKind && (res.error === 'LOGIN_REQUIRED' || res.error === 'CHECKPOINT')) || (kind === 'usps' && res.error === 'USPS_BLOCKED'));
    if (kind === 'metapay' || kind === 'notifications') {
      await handleSignals(q, item, res);
    } else if (systemic) {
      // Never try to get past it: skip the rest of THIS kind, tell the user and the sheet (not counted against the item).
      const why = fbKind ? wallDetail(res) : '';
      const where = kind === 'orders' ? ' on the orders page' : ' on ' + item.purchaseId;
      try { await api('reportIssue', { code: res.error, message: (kind === 'usps' ? 'USPS' : 'Facebook') + ' ' + res.error + where + why }); } catch (e) { /* offline */ }
      await log('STOPPED ' + (fbKind ? 'FB' : kind.toUpperCase()) + ': ' + res.error + why + (kind === 'usps' ? ' — USPS served a bot check; open tools.usps.com manually and retry later' : ' — open facebook.com and resolve it manually'));
      dropRemaining(q, kind === 'usps' ? ['usps'] : FB_KINDS);
      flagIssue(q, fbKind ? 'fb' : kind);
    } else if (kind === 'orders') {
      await handleOrders(q, item, res);
    } else if (kind === 'usps') {
      await queueResult('submitUspsResult', item.purchaseId, { ok: !!res.ok, error: res.error, detail: res.detail, notFound: !!res.notFound,
        trackingNumber: res.trackingNumber || item.trackingNumber, status: res.status, summary: res.summary, history: res.history, expectedDelivery: res.expectedDelivery });
      if (res.ok) q.stats.usps++; else q.stats.errors++;
      await log(item.purchaseId + ' USPS: ' + (res.ok ? (res.notFound ? 'not found yet' : (res.status || 'ok')) : ('error ' + res.error)));
    } else {
      const clean = { ok: !!res.ok, mode: item.mode === 'seller' ? 'seller' : 'order', error: res.error, detail: res.detail, fbStatusRaw: res.fbStatusRaw,
                      canceled: !!res.canceled, outcome: res.outcome || '', trackingNumber: res.trackingNumber, carrier: res.carrier,
                      orderId: res.orderId, orderTotal: res.orderTotal, pageHealthy: !!res.pageHealthy, listingState: res.listingState || '',
                      seller: res.seller || '', itemTitle: res.itemTitle || '', orderView: !!res.orderView };
      await queueResult('submitFbResult', item.purchaseId, clean);          // saved before moving on
      if (res.ok) { q.stats.ok++; if (res.canceled) q.stats.canceled++; if (res.trackingNumber) q.stats.tracking++; } else q.stats.errors++;
      if (res.seller) q.stats.sellers++;
      await log(item.purchaseId + ' FB' + (clean.mode === 'seller' ? ' (seller)' : '') + ': ' +
        (res.ok ? ('ok' + (res.outcome ? ' ' + res.outcome.toUpperCase() : res.canceled ? ' CANCELED' : '') + (res.trackingNumber ? ' tracking' : '') + (res.seller ? ' seller' : '')) : ('error ' + res.error + (res.listingState ? ' (listing ' + res.listingState + ' — order active)' : '') + (res.seller ? ' (seller captured)' : ''))));
    }

    q.index++;
    q.tries = 0;
    q.heartbeat = Date.now();
    await setLocal({ [K.queue]: q });
    if (q.index < q.items.length) await scheduleStep(STEP_DELAY_MIN);
    else await finishRun(q, 'completed');
  } finally {
    stepping = false;
    await chrome.storage.local.remove(K.stepLock);
  }
}

// ---------------------------------------------------------------- scheduling & lifecycle
async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM_RUN);
  if (!a) await chrome.alarms.create(ALARM_RUN, { delayInMinutes: 1, periodInMinutes: RUN_PERIOD_MIN });
}

/** Missed checks while Chrome was closed: run now if the last run is older than one period. */
async function catchUp(reason) {
  const st = (await getLocal(K.state)) || {};
  const q = await getLocal(K.queue);
  if (q) { await startRun(reason + ' (resume)'); return; }
  if (!st.lastRunStartedAt || Date.now() - st.lastRunStartedAt > RUN_PERIOD_MIN * 60000) await startRun(reason + ' (catch-up)');
}

chrome.runtime.onInstalled.addListener(async () => { await ensureAlarm(); });
chrome.runtime.onStartup.addListener(async () => { await ensureAlarm(); await closeOrphanTab(); await chrome.storage.local.remove(K.stepLock); setTimeout(() => catchUp('startup').catch(() => {}), 20000); });
ensureAlarm().catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RUN) startRun('alarm').catch((e) => log('run error: ' + e.message));
  else if (alarm.name === ALARM_STEP) processStep().catch((e) => log('step error: ' + e.message));
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------- options page messages
/** Read-only server preview of what a signal scan WOULD change (nothing is written). Never fails the probe. */
async function preview(source, payload) {
  try { return await api('previewSignals', { result: Object.assign({ source, ok: true }, payload) }); }
  catch (e) { return { error: 'preview unavailable: ' + e.message }; }
}

/**
 * "Probe orders page": the SAME page read as a run (every card's dialog is opened), matched against the purchases the
 * backend would hand out right now (getWork force — read-only), plus the backend's read-only preview of the patches.
 * Nothing is submitted. Without a backend connection it still shows the cards and dialogs.
 */
async function probeOrders() {
  let work = [], workNote = '';
  try {
    const fb = await api('getWork', { limit: BATCH_LIMIT, force: true });
    work = (fb.items || []).map((i) => Object.assign({}, i, { mode: 'order' })).concat((fb.sellerItems || []).map((i) => Object.assign({}, i, { mode: 'seller' })));
  } catch (e) { workNote = 'backend not reachable (' + e.message + ') — showing the page only, no matching'; }
  const r = await checkOrdersPage(work, { probe: true });
  if (!r || !r.ok) return r || { ok: false, error: 'NO_RESULT' };
  await clearIssueAfterProbe('fb');
  const items = work.map(matchItem);
  const plan = PTOrders.planOrderResults(r.orders || [], items);
  const product = (id) => (work.find((w) => String(w.purchaseId) === String(id)) || {}).product || '';
  let wouldChange;
  if (plan.submissions.length) {
    try { wouldChange = await api('previewFbResults', { results: plan.submissions.map((s) => ({ purchaseId: s.purchaseId, result: s.result })) }); }
    catch (e) { wouldChange = { error: 'preview unavailable: ' + e.message + (/UNKNOWN_ACTION/.test(e.message) ? ' (update/redeploy the Apps Script)' : '') }; }
  }
  return {
    ok: true, url: r.url, cardsSeen: r.cardsSeen, dialogsOpened: r.dialogsOpened, scrolls: r.scrolls, stopReason: r.stopReason, earliest: r.earliest,
    workNote: workNote || (work.length + ' tracked purchase(s) from the backend'),
    orders: (r.orders || []).map((o) => Object.assign({ summary: PTOrders.describeOrder(o) }, o)),
    matches: plan.submissions.map((s) => ({ purchaseId: s.purchaseId, product: product(s.purchaseId), via: s.via, mode: s.mode, order: PTOrders.describeOrder(s.order),
      wouldSend: { fbStatusRaw: s.result.fbStatusRaw, purchaseStatus: s.result.purchaseStatus, canceled: s.result.canceled, outcome: s.result.outcome,
        trackingNumber: s.result.trackingNumber, carrier: s.result.carrier, seller: s.result.seller, orderId: s.result.orderId, estimatedDelivery: s.result.estimatedDelivery } })),
    ambiguous: plan.ambiguous,
    notFound: plan.notFound.map((id) => ({ purchaseId: id, product: product(id), note: 'not found on orders page — unchanged (never canceled)' })),
    wouldChange,
    probe: r.probe
  };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    if (sender.id !== chrome.runtime.id) return { error: 'FOREIGN_SENDER' };
    switch (msg && msg.type) {
      case 'pt:ping': return await api('ping', {});
      case 'pt:runNow': return await startRun('manual', !!msg.force);
      case 'pt:probe':
      case 'pt:probeSeller': {
        const id = (String(msg.input || '').match(/(\d{6,25})/) || [])[1];
        if (!id) return { error: 'Enter a listing URL or ID' };
        const r = await checkListing({ url: '', listingId: id, mode: msg.type === 'pt:probeSeller' ? 'seller' : 'order' }, { probe: true });
        if (r && (r.ok || r.pageHealthy)) await clearIssueAfterProbe('fb');          // signed in and the page is readable
        return r;
      }
      case 'pt:probeOrders': return await probeOrders();
      case 'pt:probeUsps': {
        const n = String(msg.input || '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9]{10,34}$/.test(n)) return { error: 'Enter a tracking number' };
        const r = await checkUsps({ trackingNumber: n }, { probe: true });
        if (r && r.ok) await clearIssueAfterProbe('usps');
        return r;
      }
      case 'pt:probeMetaPay': {
        const r = await checkMetaPay({ probe: true });
        if (r && r.ok) { await clearIssueAfterProbe('metapay'); r.wouldChange = await preview('metapay', { transactions: r.transactions }); }
        return r;
      }
      case 'pt:probeNotifications': {
        const r = await checkNotifications({ probe: true });
        if (r && r.ok) { await clearIssueAfterProbe('notifications'); r.wouldChange = await preview('notifications', { notifications: r.notifications }); }
        return r;
      }
      case 'pt:saveSignalPrefs': {
        const s = await settings();
        await setLocal({ [K.settings]: Object.assign(s, { scanMetaPay: !!msg.scanMetaPay, scanNotifications: !!msg.scanNotifications },
          msg.fallbackListing === undefined ? {} : { fallbackListing: !!msg.fallbackListing }) });
        return { ok: true };
      }
      case 'pt:status': return { state: (await getLocal(K.state)) || {}, queue: await getLocal(K.queue), outbox: ((await getLocal(K.outbox)) || []).length, settings: await settings() };
      default: return { error: 'UNKNOWN_MESSAGE' };
    }
  })().then(send).catch((e) => send({ error: String(e.message || e) }));
  return true;                                                          // async response
});
