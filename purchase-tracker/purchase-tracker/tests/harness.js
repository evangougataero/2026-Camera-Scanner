'use strict';
/**
 * Loads the REAL Logic.gs + Code.gs into a Node vm context with in-memory fakes of the Google
 * services. The fake deliberately reproduces one nasty Sheets behaviour: a digit-only string
 * written to a cell that is NOT formatted as text becomes a Number (and loses precision past 15
 * digits). If Code.gs forgot to protect long IDs / tracking numbers, tests would fail.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

class FakeRange {
  constructor(sheet, row, col, nr, nc) { this.sheet = sheet; this.row = row; this.col = col; this.nr = nr; this.nc = nc; }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.nr; }
  getNumColumns() { return this.nc; }
  getLastColumn() { return this.col + this.nc - 1; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) { const row = []; for (let c = 0; c < this.nc; c++) row.push(this.sheet._get(this.row + r, this.col + c)); out.push(row); }
    return out;
  }
  getValue() { return this.sheet._get(this.row, this.col); }
  getFormula() { return this.sheet._formulas[`${this.row},${this.col}`] || ''; }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  setValues(vs) { vs.forEach((rv, r) => rv.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v))); return this; }
  setNumberFormat(f) {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._formats[`${this.row + r},${this.col + c}`] = f;
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; } setFontColor() { return this; } setFontSize() { return this; } setWrap() { return this; }
  setVerticalAlignment() { return this; } setHorizontalAlignment() { return this; } merge() { return this; }
  applyRowBanding() { this.sheet._bandingApplied = (this.sheet._bandingApplied || 0) + 1; return this; }
  createFilter() { this.sheet._filter = { remove: () => { this.sheet._filter = null; } }; this.sheet._filterCreates = (this.sheet._filterCreates || 0) + 1; return this.sheet._filter; }
  insertCheckboxes() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) {
      const k = `${this.row + r},${this.col + c}`;
      if (this.sheet._data[k] === undefined || this.sheet._data[k] === '') this.sheet._data[k] = false;
      (this.sheet._checkboxes = this.sheet._checkboxes || {})[k] = true;
    }
    return this;
  }
  setBorder() { return this; }
  breakApart() { return this; }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) delete this.sheet._data[`${this.row + r},${this.col + c}`];
    return this;
  }
  copyTo(dest) { dest.sheet._formulas[`${dest.row},${dest.col}`] = this.getFormula(); return this; }
}

class FakeSheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this._data = {}; this._formats = {}; this._formulas = {}; this._maxRows = 2000; this._maxCols = 40; }
  getName() { return this.name; }
  _get(r, c) { const v = this._data[`${r},${c}`]; return v === undefined ? '' : v; }
  _set(r, c, v) {
    if (r > this._maxRows) throw new Error('write beyond maxRows ' + r);
    if (v === null || v === undefined) v = '';
    const fmt = this._formats[`${r},${c}`];
    if (typeof v === 'string' && fmt !== '@' && /^\d+$/.test(v)) v = Number(v);          // Sheets auto-parses numerics
    const dm = typeof v === 'string' && fmt !== '@' && v.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (dm) {                                                                              // Sheets parses datetimes in the sheet's timezone (America/Los_Angeles)
      const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +dm[4], +dm[5], +(dm[6] || 0));
      const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        .formatToParts(new Date(guess)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
      v = new Date(guess + (guess - asUtc));
    }
    this._data[`${r},${c}`] = v;
  }
  getLastRow() { let m = 0; for (const k in this._data) if (this._data[k] !== '') m = Math.max(m, +k.split(',')[0]); return m; }
  getLastColumn() { let m = 0; for (const k in this._data) if (this._data[k] !== '') m = Math.max(m, +k.split(',')[1]); return m; }
  getMaxRows() { return this._maxRows; }
  insertRowsAfter(_, n) { this._maxRows += n; }
  insertColumnsAfter(_, n) { this._maxCols += n; }
  deleteRows(row, n) {
    const out = {};
    for (const k in this._data) {
      const [r, c] = k.split(',').map(Number);
      if (r >= row && r < row + n) continue;
      out[`${r >= row + n ? r - n : r},${c}`] = this._data[k];
    }
    this._data = out;
  }
  setFrozenRows(n) { this._frozen = n; } setFrozenColumns() {}
  getMaxColumns() { return this._maxCols; }
  clear() { this._data = {}; this._formats = {}; this._formulas = {}; this._cf = []; }
  clearConditionalFormatRules() { this._cf = []; }
  setName(n) {
    const ss = this.ss; delete ss.sheets[this.name];
    const i = ss.order.indexOf(this.name); if (i >= 0) ss.order[i] = n;
    this.name = n; ss.sheets[n] = this; return this;
  }
  copyTo(ss) {
    const c = ss.insertSheet('Copy of ' + this.name);
    c._data = JSON.parse(JSON.stringify(this._data)); c._formats = Object.assign({}, this._formats);
    return c;
  }
  deleteColumn(col) {
    const out = {}, fm = {};
    for (const k in this._data) { const [r, c] = k.split(',').map(Number); if (c === col) continue; out[`${r},${c > col ? c - 1 : c}`] = this._data[k]; }
    for (const k in this._formats) { const [r, c] = k.split(',').map(Number); if (c === col) continue; fm[`${r},${c > col ? c - 1 : c}`] = this._formats[k]; }
    this._data = out; this._formats = fm;
  }

  setColumnWidth(c, w) { (this._widths = this._widths || {})[c] = w; }
  setRowHeight() {}
  hideColumns(c) { (this._hidden = this._hidden || []).push(c); }
  getFilter() { return this._filter || null; }
  setConditionalFormatRules(r) { this._cf = r; }
  getConditionalFormatRules() { return this._cf || []; }
  getBandings() { return []; }
  getSheetId() { return this._gid || (this._gid = 1000 + Math.floor(Math.random() * 9000)); }
  getRange(r, c, nr, nc) { return new FakeRange(this, r, c, nr || 1, nc || 1); }
  appendRow(arr) { const r = this.getLastRow() + 1; arr.forEach((v, i) => this._set(r, i + 1, v)); }
  // test helpers
  put(r, c, v) { this._data[`${r},${c}`] = v; }
  rowObj(r) { const o = {}; const lc = this.getLastColumn(); for (let c = 1; c <= lc; c++) { const h = this._get(1, c); if (h !== '') o[h] = this._get(r, c); } return o; }
}

class FakeSpreadsheet {
  constructor(id) { this.id = id; this.sheets = {}; this.order = []; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n, idx) { this.order.splice(idx === undefined ? this.order.length : idx, 0, n); return (this.sheets[n] = new FakeSheet(this, n)); }
  getSpreadsheetTimeZone() { return 'America/Los_Angeles'; }
}

function buildContext() {
  const clock = { now: Date.UTC(2026, 9, 19, 18, 0, 0) };
  class FDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now); }
    static now() { return clock.now; }
  }
  const spreadsheets = {};
  const props = {}, cache = {}, triggers = [];
  const fetchLog = []; let fetchHandler = () => ({ code: 500, body: '' });
  const logs = [];

  const ctx = {
    console, Date: FDate, JSON, Math, Object, Array, String, Number, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, Error, RegExp,
    SpreadsheetApp: {
      openById: (id) => { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; },
      CopyPasteType: { PASTE_FORMULA: 'F' },
      BandingTheme: { LIGHT_GREY: 'LG' },
      BorderStyle: { SOLID: 'SOLID' },
      newConditionalFormatRule: () => {
        const r = {};
        const b = {
          whenFormulaSatisfied(f) { r.formula = f; return b; }, setBackground(c) { r.bg = c; return b; }, setFontColor(c) { r.fg = c; return b; },
          setBold(v) { r.bold = v; return b; }, setRanges(x) { r.ranges = x; return b; }, build() { return Object.assign({}, r); }
        };
        return b;
      }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetchLog.push({ url, opts });
        const r = fetchHandler(url, opts);
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
      }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ text: s, setMimeType() { return this; } }) },
    Utilities: {
      parseDate: (s, tz, fmt) => {
        const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) throw new Error('bad date ' + s);
        const guess = Date.UTC(+m[1], +m[2] - 1, +m[3]);
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
          .formatToParts(new Date(guess)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
        const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === '24' ? 0 : p.hour), +p.minute, +p.second);
        return new Date(guess + (guess - asUtc));
      },
      sleep: () => {}, getUuid: () => crypto.randomUUID(),
      formatDate: (d, tz, fmt) => {
        const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d)
          .reduce((a, x) => { a[x.type] = x.value; return a; }, {});
        const hh = p.hour === '24' ? '00' : p.hour;
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', hh).replace('mm', p.minute).replace('ss', p.second);
      }
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => {
        const t = { fn, kind: '', getHandlerFunction: () => fn, getTriggerSourceId: () => t.ss };
        const b = {
          forSpreadsheet: (id) => { t.ss = id; return b; }, onEdit: () => { t.kind = 'onEdit'; return b; },
          timeBased: () => { t.kind = 'time'; return b; }, everyMinutes: (n) => { t.every = n + 'min'; return b; }, everyHours: (n) => { t.every = n + 'h'; return b; },
          create: () => { triggers.push(t); return t; }
        };
        return b;
      }
    },
    Logger: { log: (m) => logs.push(m) }
  };
  vm.createContext(ctx);
  const dir = path.join(__dirname, '..', 'apps-script');
  vm.runInContext(fs.readFileSync(path.join(dir, 'Config.gs'), 'utf8'), ctx, { filename: 'Config.gs' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'Logic.gs'), 'utf8'), ctx, { filename: 'Logic.gs' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'Inventory.gs'), 'utf8'), ctx, { filename: 'Inventory.gs' });
  vm.runInContext(fs.readFileSync(path.join(dir, 'Dashboard.gs'), 'utf8'), ctx, { filename: 'Dashboard.gs' });

  const api = {
    ctx, clock, spreadsheets, props, triggers, fetchLog, logs,
    setFetch(fn) { fetchHandler = fn; },
    addSpreadsheet(id) { return (spreadsheets[id] = new FakeSpreadsheet(id)); },
    run(code) { return vm.runInContext(code, ctx); },
    advance(ms) { clock.now += ms; }
  };
  return api;
}

module.exports = { buildContext, FakeSheet, FakeRange };
