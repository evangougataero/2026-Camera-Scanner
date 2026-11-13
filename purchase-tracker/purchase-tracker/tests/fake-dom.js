'use strict';
/**
 * A deliberately tiny fake DOM — just enough to run the REAL page functions (fb-extractor.js, signals-extractor.js)
 * in a Node vm: elements with attributes, visible text, children, simple selectors, clicks and timers.
 * Supported selectors: comma lists of  tag | [attr] | [attr="v"] | [attr*="v"] | [attr*="v" i] | tag[...]  (no combinators).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(tag, attrs, text, children) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.ownText = text || '';
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.onclick = null;
    (children || []).forEach((c) => this.append(c));
  }
  append(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((x) => x !== this); this.parent = null; } }
  get isConnected() { let n = this; while (n.parent) n = n.parent; return n.tagName === 'BODY'; }
  get innerText() {
    if (this.hidden) return '';
    return [this.ownText].concat(this.children.map((c) => c.innerText)).filter(Boolean).join('\n');
  }
  get href() { return this.attrs.href ? new URL(this.attrs.href, 'https://www.facebook.com/').href : undefined; }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
  getBoundingClientRect() { const v = !this.hidden && (!this.parent || this.parent.getBoundingClientRect().width > 0); return { width: v ? 100 : 0, height: v ? 20 : 0, left: 0, top: 0 }; }
  contains(o) { for (let n = o; n; n = n.parent) if (n === this) return true; return false; }
  closest(sel) { for (let n = this; n; n = n.parent) if (matches(n, sel)) return n; return null; }
  all() { const out = []; const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); }); walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter((n) => matches(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  click() { for (let n = this; n; n = n.parent) if (n.onclick) { n.onclick(); return; } }
  dispatchEvent() { return true; }
  scrollIntoView() {}
}

function matchOne(n, sel) {
  const m = sel.trim().match(/^([a-z0-9]*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && n.tagName !== m[1].toUpperCase()) return false;
  const attrs = m[2].match(/\[[^\]]+\]/g) || [];
  return attrs.every((a) => {
    const am = a.match(/^\[([\w-]+)(?:(\*?=)"([^"]*)"(\s+i)?)?\]$/);
    if (!am) return false;
    const v = n.attrs[am[1]];
    if (v === undefined) return false;
    if (!am[2]) return true;
    const want = am[4] ? am[3].toLowerCase() : am[3], have = am[4] ? String(v).toLowerCase() : String(v);
    return am[2] === '=' ? have === want : have.indexOf(want) !== -1;
  });
}
function matches(n, sel) { return String(sel).split(',').some((s) => matchOne(n, s)); }

const h = (tag, attrs, text, children) => new El(tag, attrs, text, children);

/** Builds a vm context with document/location/timers and loads the given extension files into it. */
function pageContext(body, opts) {
  opts = opts || {};
  const store = {};
  const doc = {
    body, title: opts.title || 'Facebook', readyState: 'complete', visibilityState: 'hidden',
    querySelectorAll: (s) => (matches(body, s) ? [body] : []).concat(body.querySelectorAll(s)),
    querySelector: (s) => doc.querySelectorAll(s)[0] || null
  };
  const href = opts.url || 'https://www.facebook.com/marketplace/item/1288988733112094/';
  const ctx = {
    document: doc, location: { href, pathname: new URL(href).pathname },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', overflowY: 'visible' }),
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    setTimeout, clearTimeout, URL, JSON, Math, Date, Object, Array, String, RegExp, Number, Promise, console,
    PointerEvent: class { constructor(t) { this.type = t; } }, MouseEvent: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t) { this.type = t; } }, Event: class { constructor(t) { this.type = t; } },
    window: { scrollTo() {} }
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  (opts.files || []).forEach((f) => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

module.exports = { El, h, pageContext, matches };
