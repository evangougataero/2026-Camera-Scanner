/**
 * fb-extractor.js — PT_extractInPage(opts) is serialized by chrome.scripting.executeScript({func}),
 * so it MUST be fully self-contained (no closures). It relies on globalThis.PTParse, which
 * background.js injects first via executeScript({files:['parse-order.js']}).
 *
 * VERIFIED UI SHAPE (buyer's listing page, Nov 2026): a "View Order" button opens an "Order status" DIALOG containing
 *   <item title> / $225.00 · Quantity: 1 / Delivered / Your order was delivered. / Nov 9, 2026 /
 *   USPS TRACKING NUMBER: 9334… / timeline / Seller information / <seller> / Item is sold and shipped by <seller> /
 *   Order information / View order details / Order help …
 * Selectors are text/role based because Facebook's class names are obfuscated and rotate.
 *
 * Robustness rules (each one fixes an observed failure):
 *   - The listing itself can be rendered inside a [role="dialog"], so "the longest dialog" is NOT the order dialog.
 *     We pick the dialog whose text looks like an ORDER view (parse-order.js looksLikeOrderView), preferring one that
 *     appeared after the click.
 *   - We wait for the order view to appear AND for its text to stop changing before reading (no race with rendering).
 *   - Clicks fall back to a full pointer/mouse event sequence when a plain .click() opens nothing.
 *
 * It never attempts to get past a login wall, checkpoint or CAPTCHA: it reports and stops.
 *
 * opts.phase: 'click' (listing page: find + open the order view, then read)
 *             'read'  (we already navigated to an order page: just read)
 * opts.mode:  'order' (default: status, tracking, seller) | 'seller' (seller/title backfill only; no status changes)
 * opts.probe: include diagnostics (control labels + a text preview) for the Probe tool
 */
async function PT_extractInPage(opts) {
  opts = opts || {};
  const P = globalThis.PTParse;
  if (!P) return { ok: false, error: 'PARSER_NOT_INJECTED' };
  const mode = opts.mode === 'seller' ? 'seller' : 'order';

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

  // "View Order" (verified), plus the wording variants Facebook has used for the same entry point.
  const RE_ORDER = /^(view|see|open)( your| my)? (order|purchase)( details?| status| info(rmation)?)?$|^(my )?(order|purchase)s? (details?|status)$|^track (your |my )?(order|package)$/i;
  const RE_TRACK = /^(view |see )?(package |shipment |order )?tracking( info(rmation)?| details?)?$|^track (package|order|shipment|my order)$/i;
  const NODES = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [tabindex="0"]';

  const labelOf = (n) => norm(n.innerText || n.getAttribute('aria-label') || '');
  const inChrome = (n) => !!n.closest('[role="banner"], [role="navigation"], [role="complementary"][aria-label*="Messenger" i]');

  /** Deepest visible matching control (clicking the innermost element bubbles to whichever ancestor owns the handler). */
  const findControl = (re, scope) => {
    const all = Array.from((scope || document).querySelectorAll(NODES)).filter((n) => {
      const t = labelOf(n);
      return t && t.length <= 40 && re.test(t) && visible(n) && !inChrome(n);
    });
    if (!all.length) return null;
    const deepest = all.filter((n) => !all.some((m) => m !== n && n.contains(m)));
    return deepest[0] || all[0];
  };
  const controlLabels = () => {
    const seen = [];
    for (const n of document.querySelectorAll(NODES)) {
      const t = labelOf(n);
      if (t && t.length <= 40 && visible(n) && seen.indexOf(t) === -1) seen.push(t);
      if (seen.length >= 60) break;
    }
    return seen;
  };
  const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
  /** The ORDER dialog (not the listing dialog): looks like an order view; newest/topmost wins; `before` = dialogs present pre-click. */
  const orderDialog = (before) => {
    const cands = dialogs().filter((d) => P.looksLikeOrderView(d.innerText || ''));
    if (!cands.length) return null;
    const fresh = before ? cands.filter((d) => before.indexOf(d) === -1) : [];
    const pool = fresh.length ? fresh : cands;
    // innermost order-looking dialog (a listing dialog may CONTAIN the order dialog)
    const inner = pool.filter((d) => !pool.some((o) => o !== d && d.contains(o)));
    return inner[inner.length - 1] || pool[pool.length - 1];
  };
  const mainRoot = () => document.querySelector('[role="main"]') || document.body;
  /** Where the LISTING is rendered: a (non-order) listing dialog when Facebook opened it as an overlay, else the main area. */
  const listingRoot = () => {
    const ds = dialogs().filter((d) => (d.innerText || '').length > 300 && !P.looksLikeOrderView(d.innerText || ''));
    return ds.length ? ds[ds.length - 1] : mainRoot();
  };
  const hrefsIn = (root) => Array.from((root || document).querySelectorAll('a[href]')).map((a) => a.href).slice(0, 300);
  const trackHrefs = (root) => hrefsIn(root).filter((h) => /usps\.com|ups\.com|fedex\.com|l\.facebook\.com\/l\.php/i.test(h)).slice(0, 40);

  /** Seller on the LISTING page: text heading "Seller information/details" or a /marketplace/profile/ link in the main area. */
  const listingSeller = () => {
    const root = listingRoot();
    const viaText = P.parseSeller(root.innerText || '');
    if (viaText) return viaText;
    for (const a of root.querySelectorAll('a[href*="/marketplace/profile/"]')) {
      if (!visible(a) || inChrome(a)) continue;
      const t = P.cleanName(a.innerText || a.getAttribute('aria-label') || '');
      if (P.isNameLike(t)) return t;
    }
    return '';
  };
  const listingTitle = () => {
    const h = listingRoot().querySelector('h1');
    const t = h ? P.cleanTitle(h.innerText) : '';
    if (t && t.length <= 200 && !/^(marketplace|notifications|facebook)$/i.test(t)) return t;
    const m = String(document.title || '').replace(/^\(\d+\)\s*/, '').match(/^(?:marketplace\s*[-–—|]\s*)?(.+?)\s*[|\-–—]\s*facebook\s*$/i);
    return m && !/^marketplace$/i.test(m[1]) ? P.cleanTitle(m[1]).slice(0, 200) : '';
  };

  const blocker = () => {
    const u = location.href;
    if (/\/checkpoint|two_step_verification|\/recover/i.test(u)) return 'CHECKPOINT';
    if (/\/login/i.test(u) || document.querySelector('input[name="pass"], form[action*="/login"]')) return 'LOGIN_REQUIRED';
    const t = bodyText().slice(0, 3000).toLowerCase();
    if (/confirm you.?re human|security check|captcha|suspicious activity|temporarily blocked|we suspect automated/.test(t)) return 'CHECKPOINT';
    return null;
  };
  const env = () => ({ visibility: document.visibilityState, bodyLength: bodyText().length, dialogs: dialogs().length });
  const fail = (error, detail, extra) => Object.assign({ ok: false, error: error, detail: detail || '', url: location.href }, extra || {});
  const savedTrace = () => { try { return JSON.parse(sessionStorage.getItem('pt_trace') || 'null'); } catch (e) { return null; } };
  const diag = () => opts.probe ? { probe: { controls: controlLabels(), textPreview: bodyText().slice(0, 3000), url: location.href, env: env(), trace: savedTrace() } } : {};

  /** Waits until el's text stops changing (two equal reads in a row), max ms. */
  const settle = async (getEl, ms) => {
    const end = Date.now() + ms;
    let prev = -1, same = 0;
    while (Date.now() < end) {
      const el = getEl();
      const len = el ? (el.innerText || '').length : 0;
      if (len === prev && len > 0) { if (++same >= 2) return; } else same = 0;
      prev = len;
      await sleep(500);
    }
  };

  const robustClick = (el) => {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { /* ignore */ }
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerType: 'mouse', isPrimary: true }, o)));
      el.dispatchEvent(new MouseEvent('mouseup', o));
    } catch (e) { /* ignore */ }
    el.click();
  };

  /** Parses an order view. ctx: {container, seller, title} (seller/title from the listing page, used as fallbacks). */
  async function readOrderView(container, ctx) {
    ctx = ctx || {};
    const getEl = () => (container && container.isConnected ? container : (orderDialog(null) || document.body));
    await settle(getEl, 6000);                                  // let async sections (tracking, seller) finish rendering
    let el = getEl();
    let text = el.innerText || '';
    const hrefs = () => (el === document.body ? trackHrefs(document) : trackHrefs(el));
    let res = P.parseOrderText(text, hrefs());

    if (mode === 'order' && !res.trackingNumber && !res.canceled) {   // tracking may sit behind a second (internal) control
      const tc = findControl(RE_TRACK, el);
      if (tc) {
        const a = tc.closest('a[href]');
        let external = false;
        try { external = !!a && !/(^|\.)facebook\.com$/.test(new URL(a.href).hostname); } catch (e) { external = false; }
        if (!external) {
          robustClick(tc);
          await sleep(3000);
          el = getEl();
          text += '\n' + (el.innerText || '');
          res = P.parseOrderText(text, hrefs());
          res.openedTracking = true;
        }
      }
    }
    if (!res.orderId) { const m = location.href.match(/[?&](?:id|order_id)=(\d{8,25})/); if (m) res.orderId = m[1]; }   // /buyer_order_status/?id=<orderId>
    if (!res.seller && ctx.seller) res.seller = ctx.seller;
    if (!res.itemTitle && ctx.title) res.itemTitle = ctx.title;
    const out = Object.assign({ ok: true, mode: mode, url: location.href, orderView: true }, res);
    if (opts.probe) out.probe = { controls: controlLabels(), textPreview: text.slice(0, 3000), hrefs: hrefs(), url: location.href, env: env(), trace: savedTrace() };
    return out;
  }

  // ----- phase 'read': an order page (or an order dialog) is already there -----
  if (opts.phase === 'read') {
    const b = blocker();
    if (b) return fail(b);
    const found = await waitFor(() => orderDialog(null) || (P.looksLikeOrderView(bodyText()) ? document.body : null), 15000);
    if (!found) return fail('ORDER_TEXT_NOT_FOUND', 'controls: ' + controlLabels().slice(0, 25).join(' / ').slice(0, 300), Object.assign({ env: env() }, diag()));
    return await readOrderView(found, {});
  }

  // ----- phase 'click': listing page -----
  await waitFor(() => bodyText().length > 200, 15000);
  const b0 = blocker();
  if (b0) return fail(b0);

  // Seller + title from the listing page itself (also works when the order is gone).
  await waitFor(() => listingSeller(), 5000);
  const ctx = { seller: listingSeller(), title: listingTitle() };
  if (mode === 'seller' && ctx.seller) {
    const out = { ok: true, mode: 'seller', seller: ctx.seller, itemTitle: ctx.title, url: location.href, source: 'listing page' };
    if (opts.probe) Object.assign(out, diag());
    return out;
  }

  const already = orderDialog(null);
  if (already) return await readOrderView(already, ctx);

  const ctrl = await waitFor(() => findControl(RE_ORDER), 25000);   // generous: a late-rendering button must not be mistaken for a cancellation
  if (!ctrl) {
    const extra = { seller: ctx.seller, itemTitle: ctx.title, env: env() };
    if (/(this (listing|content) (isn.t|is not) available|content isn.t available)/i.test(bodyText().slice(0, 4000))) {
      return fail('LISTING_UNAVAILABLE', 'page says listing/content unavailable', Object.assign(extra, diag()));
    }
    if (mode === 'seller') return fail('SELLER_NOT_FOUND', 'no seller section and no View Order button', Object.assign(extra, diag()));
    // Is the page genuinely healthy (logged in, a real fully-loaded listing page, no login/checkpoint)? Only then does a
    // missing View Order button mean the order is gone; the backend then marks the purchase Canceled.
    const labels = controlLabels();
    const loggedInUi = labels.some((t) => /^(account|notifications|messenger|your profile|menu)/i.test(t) || /unread/i.test(t));
    const pageHealthy = !blocker() && document.readyState === 'complete' && bodyText().length >= 500 &&
      /\/marketplace\/item\//.test(location.pathname) && loggedInUi && !!(ctx.title || ctx.seller);
    return fail('ORDER_DETAILS_NOT_FOUND', 'controls: ' + labels.slice(0, 25).join(' / ').slice(0, 300) + ' | ' + JSON.stringify(env()),
      Object.assign({ pageHealthy: pageHealthy }, extra, diag()));
  }

  // Real link to another Facebook page => let the background tab navigate there, then run phase 'read'.
  const a = ctrl.closest('a[href]');
  if (a) {
    try {
      const target = new URL(a.href, location.href);
      if (/(^|\.)facebook\.com$/.test(target.hostname) && target.pathname !== location.pathname) {
        return { ok: false, nav: target.href, seller: ctx.seller, itemTitle: ctx.title };
      }
      if (!/(^|\.)facebook\.com$/.test(target.hostname)) {       // external carrier link: the tracking number is in the URL
        const tr = P.trackingFromHref(target.href);
        if (tr) return { ok: true, mode: mode, trackingNumber: tr.number, carrier: tr.carrier, fbStatusRaw: '', seller: ctx.seller, itemTitle: ctx.title, url: location.href, source: 'carrier link' };
      }
    } catch (e) { /* fall through to click */ }
  }

  const startUrl = location.href;
  const before = dialogs();
  const bodyWasOrder = P.looksLikeOrderView(bodyText());
  try { sessionStorage.setItem('pt_trace', JSON.stringify({ clicked: labelOf(ctrl), tag: ctrl.tagName, from: startUrl, seller: ctx.seller })); } catch (e) { /* ignore */ }
  const opened = () => orderDialog(before) ||
    ((location.href !== startUrl || !bodyWasOrder) && P.looksLikeOrderView(bodyText()) && !orderDialog(null) ? document.body : null);

  ctrl.click();
  let view = await waitFor(opened, 6000);
  if (!view) {                                                  // some builds only react to a real pointer sequence
    const again = findControl(RE_ORDER) || ctrl;
    robustClick(again);
    view = await waitFor(opened, 12000);
  }
  if (!view) return fail('ORDER_DETAILS_DID_NOT_OPEN', 'clicked "' + labelOf(ctrl) + '" but no order view appeared | ' + JSON.stringify(env()),
    Object.assign({ seller: ctx.seller, itemTitle: ctx.title }, diag()));
  return await readOrderView(view, ctx);
}
