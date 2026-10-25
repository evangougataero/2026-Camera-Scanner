/**
 * Purchase Tracker — MV3 service worker.
 *
 * Job: every 180 minutes, ask the Apps Script web app what is due:
 *   - Facebook order checks: open the listing in a BACKGROUND tab (active:false), read Order Details.
 *   - USPS checks: open https://tools.usps.com/tracking/ in a background tab, type the tracking
 *     number into the page, submit, read the result.
 * Each result is posted back and the tab closed. All spreadsheet logic lives in Apps Script.
 * No Facebook/USPS APIs, no credentials. Bot checks / login walls are reported, never bypassed.
 *
 * MV3 service workers die after ~30 s idle, so a run is a persisted queue processed ONE listing
 * per "step", with a 30 s alarm between steps (this is also the rate limit). Any restart simply
 * resumes from storage. A heartbeat + storage lock prevents duplicate concurrent runs.
 */
importScripts('parse-order.js', 'fb-extractor.js', 'parse-usps.js', 'usps-extractor.js');

const ALARM_RUN = 'pt-run';
const ALARM_STEP = 'pt-step';
const RUN_PERIOD_MIN = 180;
const STEP_DELAY_MIN = 0.5;                 // Chrome's minimum alarm granularity; also our pacing
const STALE_MS = 15 * 60 * 1000;            // a queue with no heartbeat for this long is "interrupted"
const STEP_LOCK_MS = 4 * 60 * 1000;
const PAGE_TIMEOUT_MS = 45000;
const SCRIPT_TIMEOUT_MS = 75000;
const BATCH_LIMIT = 15;
const OUTBOX_MAX = 50;

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
  state.log = lines.slice(-60);
  await setLocal({ [K.state]: state });
  console.log('[PT]', msg);
}
async function patchState(p) {
  const state = (await getLocal(K.state)) || {};
  await setLocal({ [K.state]: Object.assign(state, p) });
}

// ---------------------------------------------------------------- Apps Script API
async function api(action, payload) {
  const s = (await getLocal(K.settings)) || {};
  if (!s.apiUrl || !s.apiToken) throw new Error('NOT_CONFIGURED (open the extension options)');
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(s.apiUrl)) throw new Error('BAD_API_URL');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(s.apiUrl, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },          // simple request: no CORS preflight
      body: JSON.stringify(Object.assign({}, payload, { action, token: s.apiToken }))
    });
    const txt = await r.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) { throw new Error('NON_JSON_RESPONSE — is the Web App deployed with access "Anyone"? ' + txt.slice(0, 60)); }
    if (!j.ok) throw new Error(j.error + (j.detail ? ': ' + j.detail : ''));
    return j;
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- outbox (never lose a result)
async function flushOutbox() {
  let box = (await getLocal(K.outbox)) || [];
  if (!box.length) return;
  const keep = [];
  for (const e of box) {
    if (Date.now() - e.at > 3 * 24 * 3600 * 1000) continue;             // drop very old
    try { await api(e.action || 'submitFbResult', { purchaseId: e.purchaseId, result: e.result }); }
    catch (err) { keep.push(e); await log('outbox: send failed for ' + e.purchaseId + ' — ' + err.message); }
  }
  await setLocal({ [K.outbox]: keep.slice(-OUTBOX_MAX) });
}
async function queueResult(action, purchaseId, result) {
  const box = (await getLocal(K.outbox)) || [];
  box.push({ action, purchaseId, result, at: Date.now() });
  await setLocal({ [K.outbox]: box.slice(-OUTBOX_MAX) });
  await flushOutbox();
}

// ---------------------------------------------------------------- tab handling
function safeFacebookUrl(item) {
  // Never navigate to an arbitrary URL taken from a sheet cell.
  const id = String(item.listingId || '').match(/^\d{6,25}$/) ? item.listingId : '';
  try {
    const u = new URL(item.url);
    if (/(^|\.)facebook\.com$/.test(u.hostname) && /\/marketplace\/item\/\d+/.test(u.pathname) && u.protocol === 'https:') return u.origin + u.pathname;
  } catch (e) { /* fall back */ }
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

async function runExtractor(tabId, opts) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['parse-order.js'] });
  const [r] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: PT_extractInPage, args: [opts] }), SCRIPT_TIMEOUT_MS, 'SCRIPT_TIMEOUT');
  return r && r.result;
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
 * Runs `run(tabId, firstOpts)`. Clicking Order details / Track loads a new page, which destroys the
 * injected script: executeScript then either throws "Frame ... was removed" or returns nothing.
 * In that case wait for the new page to settle and run the READ phase there (up to 3 hops).
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

async function checkListing(item, opts) {
  opts = opts || {};
  const url = safeFacebookUrl(item);
  if (!url) return { ok: false, error: 'BAD_URL', detail: 'no usable Facebook listing URL' };
  await closeOrphanTab();
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });       // never steals focus
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});   // keep Memory Saver from discarding it
    tabId = tab.id;
    await setLocal({ [K.openTab]: tabId });
    try { await waitForComplete(tabId, PAGE_TIMEOUT_MS); } catch (e) { return { ok: false, error: 'PAGE_LOAD_TIMEOUT' }; }
    await sleep(2500);                                                   // let the React app hydrate

    const cur = await chrome.tabs.get(tabId);
    if (/\/login|\/checkpoint/i.test(cur.url || '')) return { ok: false, error: /checkpoint/i.test(cur.url) ? 'CHECKPOINT' : 'LOGIN_REQUIRED' };

    let res = await runPhase(tabId, runExtractor, { phase: 'click', probe: !!opts.probe }, { phase: 'read', probe: !!opts.probe });
    if (res && res.nav) {
      await chrome.tabs.update(tabId, { url: res.nav });                // stays a background tab
      try { await waitForComplete(tabId, PAGE_TIMEOUT_MS); } catch (e) { return { ok: false, error: 'PAGE_LOAD_TIMEOUT', detail: 'order page' }; }
      await sleep(2500);
      res = await runPhase(tabId, runExtractor, { phase: 'read', probe: !!opts.probe }, { phase: 'read', probe: !!opts.probe });
    }
    return res || { ok: false, error: 'NO_RESULT' };
  } catch (e) {
    if (String(e && e.message) === 'PAGE_LOAD_TIMEOUT') return { ok: false, error: 'PAGE_LOAD_TIMEOUT' };
    if (String(e && e.message) === 'TAB_CLOSED') return { ok: false, error: 'TAB_CLOSED', detail: 'tab disappeared mid-check (closed manually, or replaced/discarded by Chrome)' };
    return { ok: false, error: 'EXTENSION_ERROR', detail: String(e && e.message || e).slice(0, 200) };
  } finally {
    if (tabId !== null) { try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ } }
    await chrome.storage.local.remove(K.openTab);
  }
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
  await closeOrphanTab();
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: USPS_BASE + encodeURIComponent(number), active: false });   // never steals focus
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});                       // keep Memory Saver from discarding it
    tabId = tab.id;
    await setLocal({ [K.openTab]: tabId });
    try { await waitForComplete(tabId, PAGE_TIMEOUT_MS); } catch (e) { return { ok: false, error: 'PAGE_LOAD_TIMEOUT' }; }
    await sleep(2500);

    const res = await runPhase(tabId, runUsps, { phase: 'auto', number, probe: !!opts.probe }, { phase: 'read', number, probe: !!opts.probe });
    return res || { ok: false, error: 'NO_RESULT' };
  } catch (e) {
    if (String(e && e.message) === 'PAGE_LOAD_TIMEOUT') return { ok: false, error: 'PAGE_LOAD_TIMEOUT' };
    if (String(e && e.message) === 'TAB_CLOSED') return { ok: false, error: 'TAB_CLOSED', detail: 'tab disappeared mid-check (closed manually, or replaced/discarded by Chrome)' };
    return { ok: false, error: 'EXTENSION_ERROR', detail: String(e && e.message || e).slice(0, 200) };
  } finally {
    if (tabId !== null) { try { await chrome.tabs.remove(tabId); } catch (e) { /* ignore */ } }
    await chrome.storage.local.remove(K.openTab);
  }
}

// ---------------------------------------------------------------- run / step machinery
async function scheduleStep(minutes) { await chrome.alarms.create(ALARM_STEP, { delayInMinutes: minutes }); }

async function finishRun(q, outcome) {
  const stats = q.stats || {};
  await chrome.storage.local.remove(K.queue);
  await chrome.alarms.clear(ALARM_STEP);
  await patchState({ lastRunFinishedAt: Date.now(), lastRunOutcome: outcome, lastRunStats: stats });
  await log('run ' + outcome + ' — ok:' + (stats.ok || 0) + ' errors:' + (stats.errors || 0) + ' canceled:' + (stats.canceled || 0) + ' tracking:' + (stats.tracking || 0) + ' usps:' + (stats.usps || 0));
  await chrome.action.setBadgeText({ text: q.issue ? '!' : '' });
  if (q.issue) await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
}

async function startRun(reason, force) {
  const q = await getLocal(K.queue);
  if (q && Date.now() - q.heartbeat < STALE_MS) { await log('start skipped (' + reason + '): a run is already in progress'); return { skipped: 'in-progress' }; }
  if (q) { await log('resuming interrupted run (' + reason + ')'); await processStep(); return { resumed: true }; }

  const items = [];
  try {
    await flushOutbox();
    const fb = await api('getWork', { limit: BATCH_LIMIT, force: !!force });
    (fb.items || []).forEach((i) => items.push(Object.assign({ kind: 'fb' }, i)));
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
  await setLocal({ [K.queue]: { runId: String(Date.now()), reason, startedAt: Date.now(), heartbeat: Date.now(), index: 0, items, issue: false,
    stats: { ok: 0, errors: 0, canceled: 0, tracking: 0, usps: 0 } } });
  await log('run started (' + reason + '): ' + items.filter((i) => i.kind === 'fb').length + ' Facebook, ' + items.filter((i) => i.kind === 'usps').length + ' USPS');
  await processStep();
  return { items: items.length };
}

/** Remove not-yet-processed items of one kind (e.g. after a login wall / bot check). */
function dropRemaining(q, kind) {
  q.items = q.items.filter((it, i) => i <= q.index || it.kind !== kind);
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
    q.heartbeat = Date.now();
    await setLocal({ [K.queue]: q });

    const item = q.items[q.index];
    const kind = item.kind || 'fb';
    let res;
    try { res = kind === 'usps' ? await checkUsps(item) : await checkListing(item); }
    catch (e) { res = { ok: false, error: 'EXTENSION_ERROR', detail: String(e.message || e) }; }

    const systemic = !res.ok && ((kind === 'fb' && (res.error === 'LOGIN_REQUIRED' || res.error === 'CHECKPOINT')) || (kind === 'usps' && res.error === 'USPS_BLOCKED'));
    if (systemic) {
      // Never try to get past it: skip the rest of THIS kind, tell the user and the sheet (not counted against the item).
      try { await api('reportIssue', { code: res.error, message: (kind === 'usps' ? 'USPS' : 'Facebook') + ' ' + res.error + ' on ' + item.purchaseId }); } catch (e) { /* offline */ }
      await log('STOPPED ' + kind.toUpperCase() + ': ' + res.error + (kind === 'usps' ? ' — USPS served a bot check; open tools.usps.com manually and retry later' : ' — open facebook.com and resolve it manually'));
      dropRemaining(q, kind);
      q.issue = true;
    } else if (kind === 'usps') {
      await queueResult('submitUspsResult', item.purchaseId, { ok: !!res.ok, error: res.error, detail: res.detail, notFound: !!res.notFound,
        trackingNumber: res.trackingNumber || item.trackingNumber, status: res.status, summary: res.summary, history: res.history, expectedDelivery: res.expectedDelivery });
      if (res.ok) q.stats.usps++; else q.stats.errors++;
      await log(item.purchaseId + ' USPS: ' + (res.ok ? (res.notFound ? 'not found yet' : (res.status || 'ok')) : ('error ' + res.error)));
    } else {
      const clean = { ok: !!res.ok, error: res.error, detail: res.detail, fbStatusRaw: res.fbStatusRaw, canceled: !!res.canceled,
                      trackingNumber: res.trackingNumber, carrier: res.carrier, orderId: res.orderId, orderTotal: res.orderTotal,
                      pageHealthy: !!res.pageHealthy };
      await queueResult('submitFbResult', item.purchaseId, clean);          // saved before moving on
      if (res.ok) { q.stats.ok++; if (res.canceled) q.stats.canceled++; if (res.trackingNumber) q.stats.tracking++; } else q.stats.errors++;
      await log(item.purchaseId + ' FB: ' + (res.ok ? ('ok' + (res.canceled ? ' CANCELED' : '') + (res.trackingNumber ? ' tracking' : '')) : ('error ' + res.error)));
    }

    q.index++;
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
chrome.runtime.onStartup.addListener(async () => { await ensureAlarm(); await closeOrphanTab(); setTimeout(() => catchUp('startup').catch(() => {}), 20000); });
ensureAlarm().catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RUN) startRun('alarm').catch((e) => log('run error: ' + e.message));
  else if (alarm.name === ALARM_STEP) processStep().catch((e) => log('step error: ' + e.message));
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// ---------------------------------------------------------------- options page messages
chrome.runtime.onMessage.addListener((msg, sender, send) => {
  (async () => {
    if (sender.id !== chrome.runtime.id) return { error: 'FOREIGN_SENDER' };
    switch (msg && msg.type) {
      case 'pt:ping': return await api('ping', {});
      case 'pt:runNow': return await startRun('manual', !!msg.force);
      case 'pt:probe': {
        const id = (String(msg.input || '').match(/(\d{6,25})/) || [])[1];
        if (!id) return { error: 'Enter a listing URL or ID' };
        return await checkListing({ url: '', listingId: id }, { probe: true });
      }
      case 'pt:probeUsps': {
        const n = String(msg.input || '').replace(/\s/g, '');
        if (!/^[A-Za-z0-9]{10,34}$/.test(n)) return { error: 'Enter a tracking number' };
        return await checkUsps({ trackingNumber: n }, { probe: true });
      }
      case 'pt:status': return { state: (await getLocal(K.state)) || {}, queue: await getLocal(K.queue), outbox: ((await getLocal(K.outbox)) || []).length };
      default: return { error: 'UNKNOWN_MESSAGE' };
    }
  })().then(send).catch((e) => send({ error: String(e.message || e) }));
  return true;                                                          // async response
});
