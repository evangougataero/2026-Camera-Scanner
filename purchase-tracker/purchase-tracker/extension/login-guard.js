/**
 * login-guard.js — shared, conservative login-wall / checkpoint detection (globalThis.PTGuard).
 * Injected into pages before the page functions (fb-extractor.js, signals-extractor.js) and imported by background.js.
 *
 * Rule (fixes false LOGIN_REQUIRED reports while the user was logged in):
 *   - URL: only the PATHNAME is checked (a "login" inside a query string such as ?next=/login/ is ignored).
 *   - DOM: LOGIN_REQUIRED only when a VISIBLE password field or a VISIBLE login form is present AND the page shows no
 *     logged-in markers ("Your profile" / "Account" / Messenger / Notifications nav controls, or a c_user cookie).
 *     Hidden `input[name="pass"]` / `form[action*="/login"]` nodes that Facebook keeps in the DOM never count by themselves.
 * Real login walls and checkpoints are still reported and never bypassed.
 */
(function (root) {
  const CHECKPOINT_PATH = /(^|\/)(checkpoint|two_step_verification)(\/|$)|^\/recover(\/|$)/i;
  const LOGIN_PATH = /(^|\/)(login|login\.php)(\/|$)/i;
  const MARKER_LABEL = /^(your profile|account( controls and settings)?|messenger|notifications|facebook menu)\b/i;

  const pathOf = (href) => { try { return new URL(String(href || '')).pathname || ''; } catch (e) { return ''; } };

  /** 'CHECKPOINT' | 'LOGIN_REQUIRED' | null from a URL's pathname only. */
  function pathBlocker(href) {
    const p = pathOf(href);
    if (CHECKPOINT_PATH.test(p)) return 'CHECKPOINT';
    if (LOGIN_PATH.test(p)) return 'LOGIN_REQUIRED';
    return null;
  }

  /** Short, diagnosable, privacy-trimmed text: e-mails and long digit runs are masked, max `max` chars. */
  function snippet(text, max) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]').replace(/\d{6,}/g, '[#]').slice(0, max || 150);
  }

  /** "path=/x/ · <snippet>" — used in LOGIN_REQUIRED / CHECKPOINT details. */
  function describe(href, text, via) {
    return (via ? 'via ' + via + ' · ' : '') + 'path=' + (pathOf(href) || '?') + ' · "' + snippet(text, 150) + '"';
  }

  function isVisible(el) {
    try {
      if (!el || (el.getAttribute && el.getAttribute('type') === 'hidden')) return false;
      if (el.closest && el.closest('[aria-hidden="true"], [hidden]')) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      if (r.left + r.width <= 0 || r.top + r.height <= 0) return false;            // parked off-screen
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (e) { return false; }
  }

  /** Signed-in UI present? Returns the matching marker labels (empty array = none found). */
  function loggedInMarkers(doc) {
    const out = [];
    try {
      for (const n of doc.querySelectorAll('[aria-label]')) {
        const l = String(n.getAttribute('aria-label') || '').trim();
        if (MARKER_LABEL.test(l) && out.indexOf(l) === -1) out.push(l);
        if (out.length >= 5) break;
      }
    } catch (e) { /* ignore */ }
    try { if (/(^|;\s*)c_user=\d+/.test(String(doc.cookie || ''))) out.push('c_user'); } catch (e) { /* ignore */ }
    return out;
  }

  /**
   * Inspects the current page. Returns { code: 'CHECKPOINT'|'LOGIN_REQUIRED'|null, via, detail, passwordVisible, markers }.
   * `via`: 'url' | 'visible-password' | 'login-form'.
   */
  function inspect(doc, loc) {
    doc = doc || root.document; loc = loc || root.location;
    const href = (loc && loc.href) || '';
    const bodyText = () => (doc.body && doc.body.innerText) || '';
    const title = () => String(doc.title || '');
    const byPath = pathBlocker(href);
    if (byPath) return { code: byPath, via: 'url', detail: describe(href, title() + ' | ' + bodyText().slice(0, 300), 'url'), passwordVisible: false, markers: [] };

    const pw = Array.from(doc.querySelectorAll('input[type="password"], input[name="pass"]')).filter(isVisible);
    const forms = Array.from(doc.querySelectorAll('form[action*="/login"], form[action*="login.php"]')).filter(isVisible);
    const markers = loggedInMarkers(doc);
    if ((pw.length || forms.length) && !markers.length) {
      const el = forms[0] || pw[0];
      const box = (el.closest && el.closest('form, [role="dialog"]')) || el;
      const via = pw.length ? 'visible-password' : 'login-form';
      return { code: 'LOGIN_REQUIRED', via, detail: describe(href, title() + ' | ' + ((box.innerText || '') || bodyText().slice(0, 300)), via), passwordVisible: pw.length > 0, markers };
    }
    return { code: null, via: '', detail: '', passwordVisible: pw.length > 0, markers };
  }

  const api = { pathBlocker, inspect, describe, snippet, loggedInMarkers, isVisible };
  root.PTGuard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
