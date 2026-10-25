/**
 * usps-extractor.js — PT_uspsInPage(opts) is serialized by chrome.scripting.executeScript({func}),
 * so it must be fully self-contained. Relies on globalThis.PTParseUsps (injected from parse-usps.js).
 *
 * Verified by the user: https://tools.usps.com/tracking/<number> shows the result directly, and the form's
 * button is <button id="trackBtn" class="button tracking-btn" type="submit">Track</button>.
 *
 * Phases:
 *   'auto'   (default) page was opened at /tracking/<number>: read the result; if the page shows the
 *            form instead, type the number in and click #trackBtn.
 *   'submit' same form flow, starting from the tracking home page.
 *   'read'   a result page is already loaded (after a navigation): just read it.
 *
 * Never tries to get past a bot check / "Access Denied" / CAPTCHA: reports USPS_BLOCKED and stops.
 */
async function PT_uspsInPage(opts) {
  opts = opts || {};
  const P = globalThis.PTParseUsps;
  if (!P) return { ok: false, error: 'PARSER_NOT_INJECTED' };
  const number = String(opts.number || '').replace(/\s/g, '');
  if (!number) return { ok: false, error: 'NO_NUMBER' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const bodyText = () => (document.body && document.body.innerText) || '';
  const visible = (el) => {
    try { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; }
    catch (e) { return false; }
  };
  const waitFor = async (fn, ms, step) => {
    const end = Date.now() + ms;
    for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 400); }
  };
  const savedTrace = () => { try { return JSON.parse(sessionStorage.getItem('pt_trace') || 'null'); } catch (e) { return null; } };
  const controls = () => {
    const out = [];
    for (const n of document.querySelectorAll('input, button, [role="button"], a[href]')) {
      const t = norm(n.innerText || n.value || n.getAttribute('aria-label') || n.placeholder || n.id || '');
      if (t && t.length <= 40 && visible(n) && out.indexOf(t) === -1) out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  };
  const resultPreview = () => {
    const t = bodyText();
    const m = t.match(new RegExp(number.split('').join('[\\s-]*')));
    const i = m ? m.index : 0;
    return t.slice(Math.max(0, i - 300), i + 3500);
  };
  const diag = () => ({ probe: opts.probe ? { controls: controls(), textPreview: resultPreview(), title: document.title, trace: savedTrace() } : undefined, trace: savedTrace() });
  const fail = (error, detail, extra) => Object.assign({ ok: false, error, detail: detail || '', url: location.href }, extra || {});

  const blocked = () => {
    const t = (document.title + '\n' + bodyText().slice(0, 2500)).toLowerCase();
    return /access denied|reference #\d|unusual traffic|captcha|verify (that )?you are (a )?human|are you a robot|pardon our interruption|request blocked|errors\.edgesuite\.net/.test(t);
  };
  const resultShown = () => {
    const t = bodyText();
    const hasNum = t.replace(/[\s\-]/g, '').indexOf(number) !== -1;
    const looksResult = /latest update|tracking history|status not available|expected delivery|delivered|in transit|label created|out for delivery/i.test(t);
    return hasNum && looksResult;
  };

  async function readResult() {
    if (blocked()) return fail('USPS_BLOCKED');
    const got = await waitFor(resultShown, 20000);
    if (blocked()) return fail('USPS_BLOCKED');
    if (!got) {
      if (/status not available|couldn.t find|could not be found|no record of this item/i.test(bodyText())) return { ok: true, notFound: true, url: location.href };
      return fail('RESULT_NOT_FOUND', 'controls: ' + controls().slice(0, 20).join(' / ').slice(0, 300), diag());
    }
    await sleep(1500);
    const r = P.parseUspsText(bodyText(), number);
    if (!r.numberSeen) return fail('WRONG_NUMBER', 'result page does not show the requested number', diag());
    const out = Object.assign({ ok: true, trackingNumber: number, url: location.href }, r);
    if (opts.probe) out.probe = { controls: controls(), textPreview: resultPreview(), trace: savedTrace() };
    return out;
  }

  if (opts.phase === 'read') return await readResult();

  await waitFor(() => bodyText().length > 150, 15000);
  if (blocked()) return fail('USPS_BLOCKED');

  if (opts.phase === 'auto') {
    // Direct /tracking/<number> URL: usually the result renders by itself. Only use the form if it does not.
    await waitFor(() => resultShown() || blocked(), 12000);
    if (blocked()) return fail('USPS_BLOCKED');
    if (resultShown()) return await readResult();
  }

  // ----- form flow: type the number, click #trackBtn -----
  const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type]), textarea')).filter(visible);
  const score = (el) => {
    const k = [el.id, el.name, el.placeholder, el.getAttribute('aria-label')].join(' ').toLowerCase();
    return (/track|label|tracking/.test(k) ? 2 : 0) - (/search|zip|city|address/.test(k) ? 3 : 0);
  };
  inputs.sort((a, b) => score(b) - score(a));
  const input = inputs.length && score(inputs[0]) > 0 ? inputs[0] : null;
  if (!input) return fail('INPUT_NOT_FOUND', 'controls: ' + controls().slice(0, 20).join(' / ').slice(0, 300), diag());

  input.focus();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
  (setter && setter.set ? setter.set : (v) => { input.value = v; }).call(input, number);   // works with controlled inputs
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);

  const txt = (b) => norm(b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '');
  const CAND = 'button, input[type="submit"], input[type="button"], a, [role="button"]';
  const textMatch = (b) => { const t = txt(b); return visible(b) && t.length > 0 && t.length <= 20 && /^track\b/i.test(t) && !/another|plus|more|your|my /i.test(t); };
  let btn = document.querySelector('#trackBtn') || document.querySelector('button.tracking-btn');
  if (btn && !visible(btn)) btn = null;
  if (!btn) btn = Array.from(document.querySelectorAll(CAND)).find(textMatch) || null;

  const trace = { input: [input.id, input.name, input.placeholder].filter(Boolean).join(' | '), button: btn ? (btn.tagName + '#' + btn.id + ': ' + txt(btn)) : 'none', from: location.href };
  const stash = () => { try { sessionStorage.setItem('pt_trace', JSON.stringify(trace)); } catch (e) { /* ignore */ } };
  const startUrl = location.href;

  if (btn) {
    await waitFor(() => !(btn.disabled || btn.getAttribute('aria-disabled') === 'true'), 3000, 200);
    trace.method = 'click #trackBtn'; stash();
    btn.click();
  } else {
    trace.method = 'enter-key'; stash();
  }

  await waitFor(() => location.href !== startUrl || resultShown() || blocked(), 6000, 300);
  if (location.href === startUrl && !resultShown() && !blocked()) {          // nothing happened: Enter, then requestSubmit
    trace.method += ' + enter'; stash();
    input.focus();
    ['keydown', 'keypress', 'keyup'].forEach((type) => input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })));
    await waitFor(() => location.href !== startUrl || resultShown(), 4000, 300);
  }
  if (location.href === startUrl && !resultShown() && input.form && input.form.requestSubmit) {
    trace.method += ' + requestSubmit'; stash();
    try { input.form.requestSubmit(); } catch (e) { /* ignore */ }
    await waitFor(() => location.href !== startUrl || resultShown(), 4000, 300);
  }
  return await readResult();
}
