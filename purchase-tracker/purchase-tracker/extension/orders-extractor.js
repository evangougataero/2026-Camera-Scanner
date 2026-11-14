/**
 * orders-extractor.js — PT_ordersInPage(opts) reads Facebook's "Purchased orders" page
 *   https://www.facebook.com/marketplace/you/orders
 * It is serialized by chrome.scripting.executeScript({func}), so it MUST be self-contained (no closures). It relies on
 * globalThis.PTGuard (login-guard.js), globalThis.PTParse (parse-order.js) and globalThis.PTOrders (parse-orders.js),
 * which background.js injects first.
 *
 * Steps:
 *   1. wait (up to opts.readyWaitMs, ~15 s) for order cards (status + title + date) or an empty-state message;
 *   2. scroll (max opts.maxScrolls, ~10) until the oldest card is older than opts.earliest or nothing more loads;
 *   3. for each card that could belong to a tracked purchase (PTOrders.cardMayMatch; every card in probe mode), click it,
 *      read the "Order status" dialog (status, estimated arrival, carrier + tracking, timeline, seller, price, IDs from
 *      links / the URL), close it and go on. "View order details" is NOT opened (it shows your address and contact
 *      info, which are never read or stored).
 * Matching to Purchased rows happens in the service worker (PTOrders.planOrderResults), not here.
 *
 * Cards are found by VISIBLE TEXT (the smallest element with exactly one status line, a title and at most one date),
 * never by Facebook's obfuscated class names. Progress is kept in sessionStorage so a re-run after an unexpected
 * navigation (opts.resume) does not open the same dialogs again.
 * Login walls / checkpoints are reported (LOGIN_REQUIRED / CHECKPOINT) and never bypassed.
 */
async function PT_ordersInPage(opts) {
  opts = opts || {};
  const O = globalThis.PTOrders, P = globalThis.PTParse, G = globalThis.PTGuard;
  if (!O || !P || !G) return { ok: false, error: 'PARSER_NOT_INJECTED' };
  const items = opts.items || [];
  const earliest = opts.earliest || '';
  const maxScrolls = opts.maxScrolls == null ? 10 : opts.maxScrolls;
  const maxDialogs = opts.maxDialogs == null ? 25 : opts.maxDialogs;
  const pollMs = opts.pollMs || 500;
  const now = Date.now();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const bodyText = () => (document.body && document.body.innerText) || '';
  const visible = (el) => {
    try { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; }
    catch (e) { return false; }
  };
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(pollMs); } };
  const root = () => document.querySelector('[role="main"]') || document.body;
  const store = {
    get: () => { try { return JSON.parse(sessionStorage.getItem('pt_orders_progress') || 'null'); } catch (e) { return null; } },
    set: (v) => { try { sessionStorage.setItem('pt_orders_progress', JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };

  const blocker = () => {
    const g = G.inspect(document, location);
    if (g.code) return { code: g.code, detail: g.detail };
    const t = bodyText().slice(0, 3000);
    if (/confirm you.?re human|security check|captcha|suspicious activity|temporarily blocked|we suspect automated/i.test(t)) return { code: 'CHECKPOINT', detail: G.describe(location.href, document.title + ' | ' + t.slice(0, 300), 'text') };
    return null;
  };
  const env = () => ({ visibility: document.visibilityState, bodyLength: bodyText().length, url: location.href });
  const preview = () => (opts.probe ? { probe: { textPreview: (root().innerText || '').slice(0, 3000), env: env() } } : {});
  const fail = (error, detail, extra) => Object.assign({ ok: false, error, detail: detail || '', url: location.href }, extra || {}, preview());
  const emptyState = () => /you (haven.t|have not) (bought|purchased|ordered) anything|no (orders|purchases)( yet| to show)?\b|nothing to show/i.test(bodyText().slice(0, 4000));

  // ---------------------------------------------------------------- cards
  const CARD_SEL = 'a[href], [role="link"], [role="button"], [role="listitem"], [role="row"], [role="article"], [role="gridcell"], li, div';
  const textLen = (el) => { const t = el.textContent; return typeof t === 'string' ? t.length : (el.innerText || '').length; };
  const hrefsOf = (el) => {
    const out = [];
    const up = el.closest && el.closest('a[href]');
    if (up && up.href) out.push(up.href);
    if (el.href) out.push(el.href);
    el.querySelectorAll('a[href]').forEach((a) => { if (out.length < 8 && a.href) out.push(a.href); });
    return out;
  };
  /** Visible cards in DOM order: [{key, el, card}]. */
  const findCards = () => {
    const cand = [];
    for (const el of root().querySelectorAll(CARD_SEL)) {
      const n = textLen(el);
      if (n < 10 || n > 700 || el.closest('[role="dialog"]') || el.closest('[role="navigation"], [role="banner"]')) continue;
      const card = O.parseCardText(el.innerText || '', now);
      if (card) cand.push({ el, card });
    }
    // Smallest element per card. Prefer elements that carry the date too: a status+title sub-block of a dated card must
    // not win over the card itself.
    const vis = cand.filter((c) => visible(c.el));
    const dated = vis.filter((c) => c.card.orderDate);
    const deepDated = dated.filter((c) => !dated.some((o) => o !== c && c.el.contains(o.el)));
    const undated = vis.filter((c) => !c.card.orderDate && !dated.some((o) => o.el.contains(c.el) || c.el.contains(o.el)));
    const deepUndated = undated.filter((c) => !undated.some((o) => o !== c && c.el.contains(o.el)));
    const all = root().querySelectorAll(CARD_SEL);
    const pos = (c) => Array.prototype.indexOf.call(all, c.el);
    const deepest = deepDated.concat(deepUndated).sort((a, b2) => pos(a) - pos(b2));
    const seen = {};
    return deepest.map((c) => {
      const base = [c.card.statusRaw, c.card.title, c.card.orderDateRaw].join('|');
      seen[base] = (seen[base] || 0) + 1;
      const ids = O.idsFromHrefs(hrefsOf(c.el));
      return { key: base + '#' + seen[base], el: c.el, card: Object.assign({ key: base + '#' + seen[base] }, c.card, ids) };
    });
  };

  // ---------------------------------------------------------------- 1. wait for the list
  await waitFor(() => bodyText().length > 100, opts.readyWaitMs || 15000);
  let b = blocker();
  if (b) return fail(b.code, b.detail);
  await waitFor(() => blocker() || findCards().length || emptyState(), opts.readyWaitMs || 15000);
  b = blocker();
  if (b) return fail(b.code, b.detail);
  if (!findCards().length) {
    if (emptyState()) return Object.assign({ ok: true, orders: [], cardsSeen: 0, dialogsOpened: 0, scrolls: 0, stopReason: 'no orders on the page', url: location.href }, preview());
    const fromText = O.parseOrdersListText(root().innerText || '', now);
    if (fromText.length) {
      // Cards readable as text only (no clickable elements recognised): statuses/dates without dialogs.
      return Object.assign({ ok: true, orders: fromText.map((c, i) => O.mergeOrder(Object.assign({ key: 'text#' + i }, c), null)), cardsSeen: fromText.length,
        dialogsOpened: 0, scrolls: 0, stopReason: 'text fallback (card elements not recognised)', url: location.href }, preview());
    }
    return fail('ORDERS_NOT_FOUND', 'no order cards (status / title / date) after ' + Math.round((opts.readyWaitMs || 15000) / 1000) + 's | ' + JSON.stringify(env()) +
      ' | text: ' + norm(bodyText()).slice(0, 160));
  }

  // ---------------------------------------------------------------- 2. scroll back to the earliest needed date
  const oldest = () => findCards().map((c) => c.card.orderDate).filter(Boolean).sort()[0] || '';
  let scrolls = 0, stopReason = 'scroll cap reached';
  for (; scrolls < maxScrolls; scrolls++) {
    if (earliest && oldest() && oldest() < earliest) { stopReason = 'reached orders older than ' + earliest; break; }
    const before = findCards().length;
    try { window.scrollTo(0, (document.body && document.body.scrollHeight) || 100000); } catch (e) { /* ignore */ }
    try {
      Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(d).overflowY))
        .slice(0, 3).forEach((d) => { d.scrollTop = d.scrollHeight; });
    } catch (e) { /* ignore */ }
    const more = Array.from(document.querySelectorAll('[role="button"], button')).find((n) => visible(n) && /^(see|show|load) (more|older)( orders| purchases)?$/i.test(norm(n.innerText || n.getAttribute('aria-label') || '')));
    if (more) more.click();
    const grew = await waitFor(() => findCards().length > before, opts.scrollWaitMs || 2500);
    if (blocker()) break;
    if (!grew) { stopReason = 'no more orders loaded'; scrolls++; break; }
  }
  b = blocker();
  if (b) return fail(b.code, b.detail);

  // ---------------------------------------------------------------- 3. open the dialogs
  const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"]')).filter(visible);
  const looksLikeOrder = (t) => P.looksLikeOrderView(t) || (/\border status\b/i.test(t) && (O.parsePriceLine(t).index >= 0 || /tracking number|seller information/i.test(t)));
  const orderDialog = (before) => {
    const c = dialogs().filter((d) => looksLikeOrder(d.innerText || ''));
    const fresh = before ? c.filter((d) => before.indexOf(d) === -1) : c;
    const pool = fresh.length ? fresh : [];
    const inner = pool.filter((d) => !pool.some((o) => o !== d && d.contains(o)));
    return inner[inner.length - 1] || null;
  };
  const settle = async (el, ms) => {
    const end = Date.now() + ms;
    let prev = -1, same = 0;
    while (Date.now() < end) {
      const len = (el.innerText || '').length;
      if (len === prev && len > 0) { if (++same >= 2) return; } else same = 0;
      prev = len;
      await sleep(Math.min(pollMs, 400));
    }
  };
  const robustClick = (el) => {
    try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ }
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
  const clickTarget = (el) => {
    const up = el.closest('[role="button"], [role="link"], a[href]');
    if (up && root().contains(up) && (up.innerText || '').length <= 800) return up;
    return el.querySelector('[role="button"], [role="link"]') || el;
  };
  const closeDialog = async (d) => {
    const gone = () => !d.isConnected || !visible(d);
    const btn = Array.from(d.querySelectorAll('[aria-label]')).find((n) => /^close\b/i.test(n.getAttribute('aria-label') || '') && visible(n));
    if (btn) { btn.click(); if (await waitFor(gone, 3000)) return true; }
    try {
      const k = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', k));
      d.dispatchEvent(new KeyboardEvent('keydown', k));
    } catch (e) { /* ignore */ }
    return !!(await waitFor(gone, 2000));
  };

  const progress = (opts.resume && store.get()) || { at: Date.now(), dialogs: {} };
  if (!opts.resume) store.set(progress);
  const listUrl = location.href;
  const wanted = findCards().filter((c) => (!earliest || !c.card.orderDate || c.card.orderDate >= earliest) && (opts.openAll || O.cardMayMatch(c.card, items)));
  const keys = wanted.map((c) => c.key).slice(0, maxDialogs);
  let opened = 0, budgetHit = false;
  const budgetEnd = now + (opts.budgetMs || 200000);              // stay well inside the service worker's script timeout
  for (const key of keys) {
    if (progress.dialogs[key]) continue;
    if (Date.now() > budgetEnd) { budgetHit = true; break; }     // return what was read; unread cards keep their card status
    b = blocker();
    if (b) return fail(b.code, b.detail);
    const c = findCards().find((x) => x.key === key);                 // re-find: the list can re-render after a dialog
    if (!c) { progress.dialogs[key] = { error: 'CARD_GONE' }; continue; }
    const before = dialogs(), startUrl = location.href;
    const isOpen = () => orderDialog(before) || (location.href !== startUrl && looksLikeOrder(bodyText()) ? document.body : null);
    const target = clickTarget(c.el);
    target.click();
    let view = await waitFor(isOpen, (opts.dialogWaitMs || 8000) / 2);
    if (!view) { robustClick(target); view = await waitFor(isOpen, (opts.dialogWaitMs || 8000) / 2); }
    if (!view) {
      progress.dialogs[key] = { error: 'DIALOG_DID_NOT_OPEN' + (location.href !== startUrl ? ' (page changed to ' + location.pathname + ')' : '') };
      if (location.href !== listUrl) { try { history.back(); } catch (e) { /* ignore */ } await waitFor(() => location.href === listUrl && findCards().length, 8000); }
      store.set(progress);
      continue;
    }
    await settle(view, opts.settleMs || 4000);
    const text = view.innerText || '';
    const hrefs = Array.from(view.querySelectorAll('a[href]')).map((a) => a.href).filter(Boolean).slice(0, 60);
    const parsed = O.parseOrderDialogText(text, hrefs, { orderDate: c.card.orderDate, url: location.href });
    progress.dialogs[key] = { data: parsed, textPreview: opts.probe ? text.slice(0, 1500) : undefined };
    opened++;
    store.set(progress);
    if (view !== document.body) await closeDialog(view);
    if (location.href !== listUrl) { try { history.back(); } catch (e) { /* ignore */ } await waitFor(() => location.href === listUrl && findCards().length, 8000); }
    await sleep(opts.betweenMs == null ? 600 : opts.betweenMs);
  }

  // ---------------------------------------------------------------- result
  const cards = findCards();
  const orders = cards.map((c) => {
    const d = progress.dialogs[c.key];
    const card = Object.assign({}, c.card, d && d.error ? { dialogError: d.error } : {});
    return O.mergeOrder(card, d && d.data ? d.data : null);
  });
  const out = { ok: true, orders, cardsSeen: cards.length, dialogsOpened: opened, dialogsWanted: keys.length, scrolls,
    stopReason: stopReason + (budgetHit ? '; time budget reached before every dialog was read' : ''), earliest, url: location.href };
  if (opts.probe) {
    out.probe = { textPreview: (root().innerText || '').slice(0, 3000), env: env(),
      dialogTexts: Object.keys(progress.dialogs).filter((k) => progress.dialogs[k].textPreview).map((k) => ({ card: k, text: progress.dialogs[k].textPreview })) };
  }
  return out;
}
