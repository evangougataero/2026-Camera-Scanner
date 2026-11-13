/**
 * signals-extractor.js — two self-contained page functions (serialized by chrome.scripting.executeScript({func})).
 * Both rely on globalThis.PTSignals (parse-signals.js, injected first). They only READ the page (plus scrolling and
 * "See more" buttons to load older rows). Login walls, checkpoints and Meta "re-enter your password" prompts are
 * reported (LOGIN_REQUIRED / CHECKPOINT / REAUTH_REQUIRED) and never bypassed.
 *
 *   PT_metaPayInPage(opts)       https://accountscenter.facebook.com/meta_pay_wallet/  -> {ok, transactions:[...]}
 *   PT_notificationsInPage(opts) https://www.facebook.com/marketplace/notifications/  -> {ok, notifications:[...]}
 */
async function PT_metaPayInPage(opts) {
  opts = opts || {};
  const S = globalThis.PTSignals;
  if (!S) return { ok: false, error: 'PARSER_NOT_INJECTED' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const bodyText = () => (document.body && document.body.innerText) || '';
  const visible = (el) => { try { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (e) { return false; } };
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(500); } };
  const fail = (error, detail) => Object.assign({ ok: false, error, detail: detail || '', url: location.href },
    opts.probe ? { probe: { textPreview: bodyText().slice(0, 3000), url: location.href, visibility: document.visibilityState } } : {});

  const blocker = () => {
    const u = location.href, t = bodyText().slice(0, 4000);
    if (/\/checkpoint|two_step_verification/i.test(u)) return 'CHECKPOINT';
    if (/\/login|login\.php/i.test(u) || document.querySelector('form[action*="/login"]')) return 'LOGIN_REQUIRED';
    const pw = Array.from(document.querySelectorAll('input[type="password"], input[name="pass"]')).some(visible);
    if (pw || /re-?enter (your )?password|enter your password|confirm (it.s|that it.s) you|for your security, (please )?(re-?enter|confirm)/i.test(t)) return 'REAUTH_REQUIRED';
    if (/confirm you.?re human|captcha|suspicious activity|temporarily blocked/i.test(t)) return 'CHECKPOINT';
    return null;
  };

  await waitFor(() => bodyText().length > 100, 20000);
  let b = blocker();
  if (b) return fail(b);
  const rows = () => S.parseMetaPayText(bodyText(), Date.now());
  await waitFor(() => rows().length > 0 || blocker(), 20000);
  b = blocker();
  if (b) return fail(b);
  if (!rows().length) return fail('META_PAY_NO_TRANSACTIONS', 'no "name / status / date / amount" rows found');

  // Load older rows: scroll the page and any scrollable list, and press a "See more"-style button (max a few times).
  const maxRounds = opts.maxRounds || 4;
  for (let i = 0; i < maxRounds; i++) {
    const before = rows().length;
    window.scrollTo(0, document.body.scrollHeight);
    Array.from(document.querySelectorAll('div')).filter((d) => d.scrollHeight > d.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(d).overflowY))
      .slice(0, 3).forEach((d) => { d.scrollTop = d.scrollHeight; });
    const more = Array.from(document.querySelectorAll('[role="button"], button, a')).find((n) => visible(n) && /^(see|show|load) (more|older)( transactions| activity)?$/i.test(norm(n.innerText || n.getAttribute('aria-label') || '')));
    if (more) more.click();
    await sleep(1800);
    if (blocker()) break;
    if (rows().length <= before && !more) break;
  }
  const transactions = rows();
  const out = { ok: true, transactions, count: transactions.length, url: location.href };
  if (opts.probe) out.probe = { textPreview: bodyText().slice(0, 3000), visibility: document.visibilityState };
  return out;
}

async function PT_notificationsInPage(opts) {
  opts = opts || {};
  const S = globalThis.PTSignals;
  if (!S) return { ok: false, error: 'PARSER_NOT_INJECTED' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const bodyText = () => (document.body && document.body.innerText) || '';
  const visible = (el) => { try { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; } catch (e) { return false; } };
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(500); } };
  const fail = (error, detail) => Object.assign({ ok: false, error, detail: detail || '', url: location.href },
    opts.probe ? { probe: { textPreview: bodyText().slice(0, 3000), url: location.href, visibility: document.visibilityState } } : {});

  const blocker = () => {
    const u = location.href;
    if (/\/checkpoint|two_step_verification|\/recover/i.test(u)) return 'CHECKPOINT';
    if (/\/login/i.test(u) || document.querySelector('input[name="pass"], form[action*="/login"]')) return 'LOGIN_REQUIRED';
    if (/confirm you.?re human|security check|captcha|suspicious activity|temporarily blocked|we suspect automated/i.test(bodyText().slice(0, 3000))) return 'CHECKPOINT';
    return null;
  };

  await waitFor(() => bodyText().length > 200, 20000);
  const b = blocker();
  if (b) return fail(b);
  if (/(this (page|content) (isn.t|is not) available|content isn.t available|page not found)/i.test(bodyText().slice(0, 3000))) return fail('NOTIFICATIONS_UNAVAILABLE', 'page not available');

  const root = () => document.querySelector('[role="main"]') || document.body;
  const blocks = () => {
    const out = [], seen = {};
    for (const el of root().querySelectorAll('[role="row"], [role="listitem"], [role="article"], [role="gridcell"], a[href]')) {
      if (!visible(el)) continue;
      const text = norm(el.innerText || el.getAttribute('aria-label') || '');
      if (text.length < 8 || text.length > 600 || seen[text]) continue;
      seen[text] = true;
      const hrefs = [];
      if (el.href) hrefs.push(el.href);
      el.querySelectorAll('a[href]').forEach((a) => { if (hrefs.length < 6) hrefs.push(a.href); });
      const up = el.closest('a[href]');
      if (up && hrefs.indexOf(up.href) === -1) hrefs.push(up.href);
      out.push({ text, hrefs });
    }
    // Fallback for unusual markup: single text lines.
    bodyText().split(/\n+/).map(norm).filter((l) => l.length >= 15 && l.length <= 400 && !seen[l]).forEach((l) => out.push({ text: l, hrefs: [] }));
    return out;
  };
  await waitFor(() => blocks().some((x) => S.classifyNotification(x.text)), 12000);

  for (let i = 0; i < (opts.maxRounds || 3); i++) {
    window.scrollTo(0, document.body.scrollHeight);
    const more = Array.from(document.querySelectorAll('[role="button"], button, a')).find((n) => visible(n) && /^(see (more|previous|older)|show more|load more)( notifications)?$/i.test(norm(n.innerText || n.getAttribute('aria-label') || '')));
    if (more) more.click();
    await sleep(1500);
    if (!more && i >= 1) break;
  }
  const all = blocks();
  const notifications = S.parseNotifications(all, Date.now());
  const out = { ok: true, notifications, scanned: all.length, url: location.href };
  if (opts.probe) out.probe = { textPreview: bodyText().slice(0, 3000), visibility: document.visibilityState };
  return out;
}
