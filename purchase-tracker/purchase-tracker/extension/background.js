/**
 * Purchase Tracker — MV3 service worker.
 *
 * Job: every 180 minutes, ask the Apps Script web app what is due:
 *   - Cancellation/status signals (once per run, if the backend has active purchases):
 *       Meta Pay wallet (accountscenter.facebook.com/meta_pay_wallet/) and Facebook Marketplace notifications.
 *   - Facebook order checks: open the listing in a BACKGROUND tab (active:false), open "View Order" -> "Order status",
 *     read status / tracking / seller. "Seller" checks only backfill the seller name (no status changes).
 *   - USPS checks: open https://tools.usps.com/tracking/<number> in a background tab and read the result.
 * Each result is posted back and the tab closed. All spreadsheet logic lives in Apps Script.
 * No Facebook/USPS APIs, no credentials. Bot checks / login walls / password prompts are reported, never bypassed.
 *
 * MV3 service workers die after ~30 s without extension activity, so:
 *   - a run is a persisted queue processed ONE item per "step", with a 30 s alarm between steps (also the rate limit);
 *   - while a page is being read, a keep-alive pings an extension API every 20 s (a long executeScript await alone
 *     does not keep the worker alive, which used to kill checks mid-way and stall the queue);
 *   - each step first arms a watchdog alarm, so a worker killed mid-step resumes the same item (max 3 tries).
 * A heartbeat + storage lock prevents duplicate concurrent runs.
 */
importScripts('parse-order.js', 'fb-extractor.js', 'parse-usps.js', 'usps-extractor.js', 'parse-signals.js', 'signals-extractor.js');

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
const NOTIFICATION_URLS = ['https://www.facebook.com/marketplace/notifications/', 'https://www.facebook.com/notifications/'];

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

async function runExtractor(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['parse-order.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: PT_extractInPage, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

async function checkListing(item, opts) {
  opts = opts || {};
  const url = safeFacebookUrl(item);
  if (!url) return { ok: false, error: 'BAD_URL', detail: 'no usable Facebook listing URL' };
  const mode = item.mode === 'seller' ? 'seller' : 'order';
  const probe = !!opts.probe;
  return inTab(url, async (tabId) => {
    const cur = await chrome.tabs.get(tabId);
    if (/\/login|\/checkpoint/i.test(cur.url || '')) return { ok: false, error: /checkpoint/i.test(cur.url) ? 'CHECKPOINT' : 'LOGIN_REQUIRED' };
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
  });
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
  await chrome.scripting.executeScript({ target: { tabId }, files: ['parse-signals.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
}

async function checkMetaPay(opts) {
  const probe = !!(opts && opts.probe);
  return inTab(META_PAY_URL, async (tabId) => {
    const cur = await chrome.tabs.get(tabId);
    if (/\/login|\/checkpoint/i.test(cur.url || '')) return { ok: false, error: /checkpoint/i.test(cur.url) ? 'CHECKPOINT' : 'LOGIN_REQUIRED', url: cur.url };
    return (await runPhase(tabId, (t, o) => runSignalsFn(t, PT_metaPayInPage, o), { probe }, { probe })) || { ok: false, error: 'NO_RESULT' };
  });
}

async function checkNotifications(opts) {
  const probe = !!(opts && opts.probe);
  let last = null;
  for (const url of NOTIFICATION_URLS) {                    // Marketplace notifications first, then all notifications
    last = await inTab(url, async (tabId) => {
      const cur = await chrome.tabs.get(tabId);
      if (/\/login|\/checkpoint/i.test(cur.url || '')) return { ok: false, error: /checkpoint/i.test(cur.url) ? 'CHECKPOINT' : 'LOGIN_REQUIRED' };
      return (await runPhase(tabId, (t, o) => runSignalsFn(t, PT_notificationsInPage, o), { probe }, { probe })) || { ok: false, error: 'NO_RESULT' };
    });
    if (last && (last.ok || last.error === 'LOGIN_REQUIRED' || last.error === 'CHECKPOINT')) return Object.assign(last, { source: url });
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
    ' sellers:' + (stats.sellers || 0) + ' usps:' + (stats.usps || 0) + ' signals:' + (stats.signals || 0));
  await chrome.action.setBadgeText({ text: q.issue ? '!' : '' });
  if (q.issue) await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}

async function startRun(reason, force) {
  const q = await getLocal(K.queue);
  if (q && Date.now() - q.heartbeat < STALE_MS) { await log('start skipped (' + reason + '): a run is already in progress'); return { skipped: 'in-progress' }; }
  if (q) { await log('resuming interrupted run (' + reason + ')'); await chrome.storage.local.remove(K.stepLock); await processStep(); return { resumed: true }; }

  const items = [];
  const s = await settings();
  try {
    await flushOutbox();
    const fb = await api('getWork', { limit: BATCH_LIMIT, force: !!force });
    if (fb.signals) {                                        // backend has purchases a cancellation could still affect
      if (s.scanMetaPay !== false) items.push({ kind: 'metapay', purchaseId: 'META_PAY' });
      if (s.scanNotifications !== false) items.push({ kind: 'notifications', purchaseId: 'NOTIFICATIONS' });
    }
    (fb.items || []).forEach((i) => items.push(Object.assign({ kind: 'fb' }, i)));
    (fb.sellerItems || []).forEach((i) => items.push(Object.assign({ kind: 'fb', mode: 'seller' }, i)));
    const us = await api('getUspsWork', { limit: BATCH_LIMIT, force: !!force });
    (us.items || []).forEach((i) => items.push(Object.assign({ kind: 'usps' }, i)));
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
  await setLocal({ [K.queue]: { runId: String(Date.now()), reason, startedAt: Date.now(), heartbeat: Date.now(), index: 0, tries: 0, items, issue: false,
    stats: { ok: 0, errors: 0, canceled: 0, tracking: 0, sellers: 0, usps: 0, signals: 0 } } });
  const n = (k) => items.filter((i) => i.kind === k).length;
  await log('run started (' + reason + '): ' + n('fb') + ' Facebook (' + items.filter((i) => i.kind === 'fb' && i.mode === 'seller').length + ' seller-only), ' +
    n('usps') + ' USPS, ' + (n('metapay') + n('notifications')) + ' signal page(s)');
  await processStep();
  return { items: items.length };
}

/** Remove not-yet-processed items of the given kinds (e.g. after a login wall / bot check). */
function dropRemaining(q, kinds) {
  q.items = q.items.filter((it, i) => i <= q.index || kinds.indexOf(it.kind) === -1);
}

const FB_KINDS = ['fb', 'notifications'];

async function handleSignals(q, item, res) {
  const label = item.kind === 'metapay' ? 'Meta Pay' : 'Notifications';
  if (!res.ok) {
    if (res.error === 'LOGIN_REQUIRED' || res.error === 'CHECKPOINT' || res.error === 'REAUTH_REQUIRED') {
      try { await api('reportIssue', { code: res.error, message: label + ' ' + res.error + (res.error === 'REAUTH_REQUIRED' ? ' — Meta asked for your password; open the wallet page once by hand' : '') }); } catch (e) { /* offline */ }
      q.issue = true;
      await log('STOPPED ' + label + ': ' + res.error + ' — resolve it manually in Chrome (never bypassed)');
      if (item.kind === 'notifications' && res.error !== 'REAUTH_REQUIRED') dropRemaining(q, FB_KINDS);
    } else {
      await log(label + ': error ' + res.error + (res.detail ? ' (' + String(res.detail).slice(0, 120) + ')' : ''));
    }
    q.stats.errors++;
    return;
  }
  const payload = item.kind === 'metapay' ? { source: 'metapay', ok: true, transactions: res.transactions || [] }
                                          : { source: 'notifications', ok: true, notifications: res.notifications || [] };
  await queueResult('submitSignals', '', payload);
  q.stats.signals++;
  await log(label + ': ' + (item.kind === 'metapay' ? (res.transactions || []).length + ' transaction(s)' : (res.notifications || []).length + ' order notification(s) of ' + (res.scanned || 0) + ' scanned') + ' sent');
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
          : await checkListing(item);
      } catch (e) { res = { ok: false, error: 'EXTENSION_ERROR', detail: String(e.message || e) }; }
    }
    res = res || { ok: false, error: 'NO_RESULT' };

    const systemic = !res.ok && ((kind === 'fb' && (res.error === 'LOGIN_REQUIRED' || res.error === 'CHECKPOINT')) || (kind === 'usps' && res.error === 'USPS_BLOCKED'));
    if (kind === 'metapay' || kind === 'notifications') {
      await handleSignals(q, item, res);
    } else if (systemic) {
      // Never try to get past it: skip the rest of THIS kind, tell the user and the sheet (not counted against the item).
      try { await api('reportIssue', { code: res.error, message: (kind === 'usps' ? 'USPS' : 'Facebook') + ' ' + res.error + ' on ' + item.purchaseId }); } catch (e) { /* offline */ }
      await log('STOPPED ' + kind.toUpperCase() + ': ' + res.error + (kind === 'usps' ? ' — USPS served a bot check; open tools.usps.com manually and retry later' : ' — open facebook.com and resolve it manually'));
      dropRemaining(q, kind === 'usps' ? ['usps'] : FB_KINDS);
      q.issue = true;
    } else if (kind === 'usps') {
      await queueResult('submitUspsResult', item.purchaseId, { ok: !!res.ok, error: res.error, detail: res.detail, notFound: !!res.notFound,
        trackingNumber: res.trackingNumber || item.trackingNumber, status: res.status, summary: res.summary, history: res.history, expectedDelivery: res.expectedDelivery });
      if (res.ok) q.stats.usps++; else q.stats.errors++;
      await log(item.purchaseId + ' USPS: ' + (res.ok ? (res.notFound ? 'not found yet' : (res.status || 'ok')) : ('error ' + res.error)));
    } else {
      const clean = { ok: !!res.ok, mode: item.mode === 'seller' ? 'seller' : 'order', error: res.error, detail: res.detail, fbStatusRaw: res.fbStatusRaw,
                      canceled: !!res.canceled, outcome: res.outcome || '', trackingNumber: res.trackingNumber, carrier: res.carrier,
                      orderId: res.orderId, orderTotal: res.orderTotal, pageHealthy: !!res.pageHealthy,
                      seller: res.seller || '', itemTitle: res.itemTitle || '', orderView: !!res.orderView };
      await queueResult('submitFbResult', item.purchaseId, clean);          // saved before moving on
      if (res.ok) { q.stats.ok++; if (res.canceled) q.stats.canceled++; if (res.trackingNumber) q.stats.tracking++; } else q.stats.errors++;
      if (res.seller) q.stats.sellers++;
      await log(item.purchaseId + ' FB' + (clean.mode === 'seller' ? ' (seller)' : '') + ': ' +
        (res.ok ? ('ok' + (res.outcome ? ' ' + res.outcome.toUpperCase() : res.canceled ? ' CANCELED' : '') + (res.trackingNumber ? ' tracking' : '') + (res.seller ? ' seller' : '')) : ('error ' + res.error + (res.seller ? ' (seller captured)' : ''))));
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
        return await checkListing({ url: '', listingId: id, mode: msg.type === 'pt:probeSeller' ? 'seller' : 'order' }, { probe: true });
      }
      case 'pt:probeUsps': {
        const n = String(msg.input || '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9]{10,34}$/.test(n)) return { error: 'Enter a tracking number' };
        return await checkUsps({ trackingNumber: n }, { probe: true });
      }
      case 'pt:probeMetaPay': {
        const r = await checkMetaPay({ probe: true });
        if (r && r.ok) r.wouldChange = await preview('metapay', { transactions: r.transactions });
        return r;
      }
      case 'pt:probeNotifications': {
        const r = await checkNotifications({ probe: true });
        if (r && r.ok) r.wouldChange = await preview('notifications', { notifications: r.notifications });
        return r;
      }
      case 'pt:saveSignalPrefs': {
        const s = await settings();
        await setLocal({ [K.settings]: Object.assign(s, { scanMetaPay: !!msg.scanMetaPay, scanNotifications: !!msg.scanNotifications }) });
        return { ok: true };
      }
      case 'pt:status': return { state: (await getLocal(K.state)) || {}, queue: await getLocal(K.queue), outbox: ((await getLocal(K.outbox)) || []).length, settings: await settings() };
      default: return { error: 'UNKNOWN_MESSAGE' };
    }
  })().then(send).catch((e) => send({ error: String(e.message || e) }));
  return true;                                                          // async response
});
