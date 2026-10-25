/**
 * fb-extractor.js — PT_extractInPage(opts) is serialized by chrome.scripting.executeScript({func}),
 * so it MUST be fully self-contained (no closures). It relies on globalThis.PTParse, which
 * background.js injects first via executeScript({files:['parse-order.js']}).
 *
 * UNVERIFIED ASSUMPTION: the buyer's listing page has a visible control whose text is
 * "Order details" (or similar). Selectors are text/role based because Facebook's class names are
 * obfuscated and rotate. Use the extension's Probe button to confirm against a real purchase.
 *
 * It never attempts to get past a login wall, checkpoint or CAPTCHA: it reports and stops.
 *
 * opts.phase: 'click' (listing page: find + open order details, then read)
 *             'read'  (we already navigated to the order page: just read)
 * opts.probe: include diagnostics (control labels + a text preview) for the Probe tool
 */
async function PT_extractInPage(opts) {
  opts = opts || {};
  const P = globalThis.PTParse;
  if (!P) return { ok: false, error: 'PARSER_NOT_INJECTED' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    try {
      const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    } catch (e) { return false; }
  };
  const bodyText = () => (document.body && document.body.innerText) || '';
  const waitFor = async (fn, ms, step) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step || 400);
    }
  };

  const RE_ORDER = /^(view )?(my )?order(s)? details?$|^view order$/i;
  const RE_TRACK = /^(view |see )?(package |shipment |order )?tracking( info(rmation)?| details?)?$|^track (package|order|shipment|my order)$/i;
  const NODES = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [tabindex="0"]';

  const findControl = (re) => {
    for (const n of document.querySelectorAll(NODES)) {
      const t = norm(n.innerText || n.getAttribute('aria-label') || '');
      if (t && t.length <= 40 && re.test(t) && visible(n)) return n;
    }
    return null;
  };
  const controlLabels = () => {
    const seen = [];
    for (const n of document.querySelectorAll(NODES)) {
      const t = norm(n.innerText || n.getAttribute('aria-label') || '');
      if (t && t.length <= 40 && visible(n) && seen.indexOf(t) === -1) seen.push(t);
      if (seen.length >= 40) break;
    }
    return seen;
  };
  const activeDialog = () => {
    let best = null;
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (!visible(d)) continue;
      if (!best || (d.innerText || '').length > (best.innerText || '').length) best = d;
    }
    return best;
  };
  const trackHrefs = () =>
    Array.from(document.querySelectorAll('a[href]')).map((a) => a.href)
      .filter((h) => /usps\.com|ups\.com|fedex\.com|l\.facebook\.com\/l\.php/i.test(h)).slice(0, 40);

  const blocker = () => {
    const u = location.href;
    if (/\/checkpoint|two_step_verification|\/recover/i.test(u)) return 'CHECKPOINT';
    if (/\/login/i.test(u) || document.querySelector('input[name="pass"], form[action*="/login"]')) return 'LOGIN_REQUIRED';
    const t = bodyText().slice(0, 3000).toLowerCase();
    if (/confirm you.?re human|security check|captcha|suspicious activity|temporarily blocked|we suspect automated/.test(t)) return 'CHECKPOINT';
    return null;
  };
  const fail = (error, detail, extra) => Object.assign({ ok: false, error: error, detail: detail || '', url: location.href }, extra || {});
  const savedTrace = () => { try { return JSON.parse(sessionStorage.getItem('pt_trace') || 'null'); } catch (e) { return null; } };
  const diag = () => opts.probe ? { probe: { controls: controlLabels(), textPreview: bodyText().slice(0, 2500), url: location.href, trace: savedTrace() } } : {};

  async function readAndParse() {
    const b = blocker();
    if (b) return fail(b);
    const el0 = await waitFor(() => {
      const d = activeDialog(), el = d || document.body;
      const t = norm(el && el.innerText);
      return t.length > 60 && /(order|deliver|ship|track|cancel)/i.test(t) ? el : null;
    }, 12000);
    if (!el0) return fail('ORDER_TEXT_NOT_FOUND', 'controls: ' + controlLabels().slice(0, 25).join(' / ').slice(0, 300), diag());
    await sleep(1500);                                         // let async sections finish rendering

    let el = activeDialog() || document.body;
    let text = el.innerText || '';
    let res = P.parseOrderText(text, trackHrefs());

    if (!res.trackingNumber && !res.canceled) {                // tracking may sit behind a second control
      const tc = findControl(RE_TRACK);
      if (tc) {
        const a = tc.closest('a[href]');
        let external = false;
        try { external = !!a && !/(^|\.)facebook\.com$/.test(new URL(a.href).hostname); } catch (e) { external = false; }
        if (!external) {
          tc.click();
          await sleep(3000);
          el = activeDialog() || document.body;
          text += '\n' + (el.innerText || '');
          res = P.parseOrderText(text, trackHrefs());
          res.openedTracking = true;
        }
      }
    }
    if (!res.orderId) { const m = location.href.match(/[?&]id=(\d{8,25})/); if (m) res.orderId = m[1]; }   // order page URL: /buyer_order_status/?id=<orderId>
    const out = Object.assign({ ok: true, url: location.href }, res);
    if (opts.probe) out.probe = { controls: controlLabels(), textPreview: text.slice(0, 2500), hrefs: trackHrefs(), url: location.href, trace: savedTrace() };
    return out;
  }

  if (opts.phase === 'read') return await readAndParse();

  // ----- phase 'click': listing page -----
  await waitFor(() => bodyText().length > 200, 15000);
  const b = blocker();
  if (b) return fail(b);

  const ctrl = await waitFor(() => findControl(RE_ORDER), 25000);   // generous: a late-rendering button must not be mistaken for a cancellation
  if (!ctrl) {
    if (/(this (listing|content) (isn.t|is not) available|content isn.t available)/i.test(bodyText().slice(0, 4000))) {
      return fail('LISTING_UNAVAILABLE', 'page says listing/content unavailable', diag());
    }
    // Is the page genuinely healthy (logged in, a real fully-loaded listing page, no login/checkpoint)? Only then does a
    // missing View Order button mean the order is gone; the backend then marks the purchase Canceled.
    const labels = controlLabels();
    const loggedInUi = labels.some((t) => /^(account|notifications|messenger|your profile)/i.test(t) || /unread/i.test(t));
    const pageHealthy = !blocker() && document.readyState === 'complete' && bodyText().length >= 500 &&
      /\/marketplace\/item\//.test(location.pathname) && loggedInUi;
    return fail('ORDER_DETAILS_NOT_FOUND', 'controls: ' + labels.slice(0, 25).join(' / ').slice(0, 300), Object.assign({ pageHealthy: pageHealthy }, diag()));
  }

  // Real link to another page => let the background tab navigate there, then run phase 'read'.
  const a = ctrl.closest('a[href]');
  if (a) {
    try {
      const target = new URL(a.href, location.href);
      if (/(^|\.)facebook\.com$/.test(target.hostname) && target.pathname !== location.pathname) {
        return { ok: false, nav: target.href };
      }
    } catch (e) { /* fall through to click */ }
  }

  const startUrl = location.href;
  try { sessionStorage.setItem('pt_trace', JSON.stringify({ clicked: norm(ctrl.innerText || ctrl.getAttribute('aria-label')), tag: ctrl.tagName, from: startUrl })); } catch (e) { /* ignore */ }
  ctrl.click();
  const opened = await waitFor(() => {
    const d = activeDialog();
    if (d && /(order|deliver|ship|track|cancel)/i.test(d.innerText || '')) return true;
    return location.href !== startUrl && /(order|deliver|ship|track|cancel)/i.test(bodyText()) ? true : false;
  }, 12000);
  if (!opened) return fail('ORDER_DETAILS_DID_NOT_OPEN', 'clicked "' + norm(ctrl.innerText) + '" but nothing opened', diag());
  return await readAndParse();
}
