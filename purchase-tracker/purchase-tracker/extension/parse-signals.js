/**
 * parse-signals.js — pure parsing of two cancellation/status sources (no DOM, no chrome.* APIs; runs in the page,
 * the service worker and Node tests):
 *
 *   1. Meta Pay wallet (accountscenter.facebook.com/meta_pay_wallet/): rows of
 *        <Seller name> / <Status> / <Date> / <Amount>        e.g. "Olga Serdinskaya / Delivered / Nov 3, 2026 / $262.84"
 *      NOTE: it shows the SELLER'S NAME, never the listing title. Matching to purchases happens in Apps Script (Logic.gs).
 *   2. Facebook Marketplace notifications: short sentences that name the listing ("Your order for <title> was canceled").
 *
 * Only reports what it SAW; classification of what to do with it lives in Logic.gs (one source of truth).
 */
(function (root) {
  'use strict';
  var norm = function (s) { return String(s == null ? '' : s).replace(/[​-‏﻿-]/g, '').replace(/\s+/g, ' ').trim(); };

  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };

  // ---- Meta Pay -------------------------------------------------------------------------------------------

  var META_STATUS = {
    'confirmed': 'Confirmed', 'may be delayed': 'May be delayed', 'delayed': 'May be delayed', 'delivered': 'Delivered',
    'canceled': 'Canceled', 'cancelled': 'Canceled', 'expired': 'Expired', 'refunded': 'Refunded', 'partially refunded': 'Partially refunded',
    'refund pending': 'Refund pending', 'shipped': 'Shipped', 'in transit': 'In transit', 'pending': 'Pending', 'processing': 'Processing',
    'completed': 'Completed', 'complete': 'Completed', 'paid': 'Paid', 'failed': 'Failed', 'declined': 'Failed', 'on its way': 'Shipped'
  };

  var RE_DATE = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i;
  var RE_AMOUNT = /^([-+−]?)\s*(?:US)?\$\s?([\d,]+\.\d{2})(?:\s*USD)?$/i;

  /** 'Nov 3, 2026' -> '2026-11-03'. Without a year the most recent past date is used. Today/Yesterday supported. */
  function parseWalletDate(s, nowMs) {
    var t = norm(s), now = new Date(nowMs || Date.now());
    if (/^today$/i.test(t)) return now.getUTCFullYear() + '-' + pad2(now.getUTCMonth() + 1) + '-' + pad2(now.getUTCDate());
    if (/^yesterday$/i.test(t)) { var y = new Date(now.getTime() - 86400000); return y.getUTCFullYear() + '-' + pad2(y.getUTCMonth() + 1) + '-' + pad2(y.getUTCDate()); }
    var m = t.match(RE_DATE);
    if (!m) return '';
    var mo = MONTHS[m[1].toLowerCase().slice(0, 3)], d = parseInt(m[2], 10), yr = m[3] ? parseInt(m[3], 10) : now.getUTCFullYear();
    if (!m[3] && Date.UTC(yr, mo, d) > now.getTime() + 2 * 86400000) yr--;                // "Dec 30" seen in January
    var dt = new Date(Date.UTC(yr, mo, d));
    if (dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) return '';
    return yr + '-' + pad2(mo + 1) + '-' + pad2(d);
  }

  function isDateLine(l) { return RE_DATE.test(norm(l)) || /^(today|yesterday)$/i.test(norm(l)); }

  function parseAmount(l) {
    var m = norm(l).match(RE_AMOUNT);
    if (!m) return null;
    var v = parseFloat(m[2].replace(/,/g, ''));
    return { value: v, sign: m[1] && m[1] !== '+' ? -1 : 1 };
  }

  function canonicalStatus(l) {
    var k = norm(l).toLowerCase().replace(/[.!]$/, '');
    return META_STATUS[k] || '';
  }

  var UI_LINE = /^(all|money transfer|orders|donations|games|others|meta pay|wallet|payment methods|activity|see (all|more)|show more|filter|settings|help|accounts center|transactions|payments?)$/i;

  function looksLikeName(s) {
    var t = norm(s);
    if (t.length < 2 || t.length > 60 || !/[A-Za-zÀ-ɏЀ-ӿ]/.test(t)) return false;
    if (/[$@:|]|https?:|\d{3,}/.test(t)) return false;
    if (UI_LINE.test(t) || canonicalStatus(t) || isDateLine(t)) return false;
    return t.split(/\s+/).length <= 7;
  }

  /**
   * Visible text of the Meta Pay wallet -> [{seller, status, statusRaw, date:'yyyy-MM-dd'|'' , dateRaw, amount:number|'', amountRaw}].
   * Anchored on DATE lines: name = 2 lines above, status = 1 line above, amount = next money line (or the one before the name).
   */
  function parseMetaPayText(text, nowMs) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    var out = [], seen = {};
    // Layout detection: the wallet shows the amount AFTER the date (screenshot). If a page variant puts it BEFORE the
    // name instead, "the line after the date" is the NEXT row's amount — so decide once, for the whole page.
    var afterN = 0, beforeN = 0;
    for (var a = 0; a < lines.length; a++) {
      if (!isDateLine(lines[a])) continue;
      if (lines[a + 1] && parseAmount(lines[a + 1])) afterN++;
      if (a >= 3 && parseAmount(lines[a - 3])) beforeN++;
    }
    var amountBefore = beforeN > afterN;
    for (var i = 0; i < lines.length; i++) {
      if (!isDateLine(lines[i])) continue;
      var statusRaw = lines[i - 1] || '', name = lines[i - 2] || '', nameIdx = i - 2;
      var status = canonicalStatus(statusRaw);
      if (!status) {                                                    // some rows omit the status: name sits right above the date
        if (looksLikeName(statusRaw) && !looksLikeName(name)) { name = statusRaw; statusRaw = ''; nameIdx = i - 1; }
        else if (!/^[A-Za-z][A-Za-z ,'\-]{1,30}$/.test(statusRaw)) continue;
        status = statusRaw;
      }
      if (!looksLikeName(name)) continue;
      var amt = null, amtRaw = '';
      if (amountBefore) { if (nameIdx - 1 >= 0) { amt = parseAmount(lines[nameIdx - 1]); if (amt) amtRaw = lines[nameIdx - 1]; } }
      else {
        for (var j = i + 1; j <= i + 2 && j < lines.length && !amt; j++) {
          if (isDateLine(lines[j]) || looksLikeName(lines[j])) break;          // never take the next row's amount
          amt = parseAmount(lines[j]); if (amt) amtRaw = lines[j];
        }
      }
      var row = {
        seller: name, status: status, statusRaw: statusRaw, date: parseWalletDate(lines[i], nowMs), dateRaw: lines[i],
        amount: amt ? amt.value : '', amountRaw: amtRaw
      };
      var key = [row.seller, row.status, row.dateRaw, row.amountRaw].join('|');
      if (seen[key]) continue;
      seen[key] = true;
      out.push(row);
    }
    return out;
  }

  // ---- Marketplace notifications ------------------------------------------------------------------------

  /**
   * One notification sentence -> 'canceled' | 'refunded' | 'expired' | 'delivered' | 'shipped' | 'delayed' | 'cancel_requested' | ''.
   * Cancellation REQUESTS and instructions ("you can cancel") are never reported as cancellations.
   */
  function classifyNotification(text) {
    var t = norm(text).toLowerCase();
    if (!t) return '';
    if (/\b(request(ed|s)?|wants?|asked) to cancel\b|\bcancell?ation request\b/.test(t)) return 'cancel_requested';
    if (/\b(you can|you may|how to|to cancel|if you)\b[^.]*\bcancel/.test(t) && !/\b(was|has been|been|got)\s+cancell?ed\b/.test(t)) return '';
    if (/\brefund(ed)?\b/.test(t) && /\b(you('ve| have)? (been|were) refunded|refund (was|has been|is) (issued|processed|sent|completed)|(was|has been|been) refunded|received (a|your) refund|refunded)\b/.test(t)) return 'refunded';
    if (/\bcancell?ed\b/.test(t)) return 'canceled';
    if (/\b(order|purchase|offer)\b[^.]*\bexpired\b|\bexpired\b[^.]*\b(order|purchase)\b/.test(t)) return 'expired';
    if (/\b(was|has been|been) delivered\b|\bdelivered\b.*\border\b|\border\b.*\bdelivered\b/.test(t)) return 'delivered';
    if (/\bmay be delayed\b|\bis delayed\b|\bdelayed\b/.test(t)) return 'delayed';
    if (/\b(has |was )?shipped\b|\bon (its|the) way\b/.test(t)) return 'shipped';
    return '';
  }

  var UNIT_MS = { m: 60000, h: 3600000, d: 86400000, w: 7 * 86400000, y: 365 * 86400000 };

  /** Facebook's relative timestamps ("3d", "1w", "5 hours ago", "Yesterday", "Just now") -> age in ms, or '' if absent. */
  function parseRelativeAge(text) {
    var t = norm(text).toLowerCase();
    if (/\bjust now\b/.test(t)) return 0;
    if (/\byesterday\b/.test(t)) return 86400000;
    var m = t.match(/(?:^|\s|·)(an?|\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?|y|yr|yrs|years?)(?:\s+ago)?\s*$/) ||
            t.match(/(?:^|\s|·)(an?|\d{1,3})\s*(minutes?|hours?|days?|weeks?|years?)\s+ago\b/);
    if (!m) return '';
    var n = /^an?$/.test(m[1]) ? 1 : parseInt(m[1], 10);
    return n * UNIT_MS[m[2].charAt(0)];
  }

  function idsFrom(hrefs, text) {
    var listingIds = [], orderIds = [];
    (hrefs || []).concat([String(text || '')]).forEach(function (h) {
      var s = String(h || ''), m;
      var re = /\/marketplace\/item\/(\d{6,25})/g;
      while ((m = re.exec(s))) if (listingIds.indexOf(m[1]) === -1) listingIds.push(m[1]);
      var ro = /(?:buyer_order_status|order_id|orderID|order)[/?=&a-z_]*?(?:id=)(\d{8,25})/gi;
      while ((m = ro.exec(s))) if (orderIds.indexOf(m[1]) === -1) orderIds.push(m[1]);
    });
    return { listingIds: listingIds, orderIds: orderIds };
  }

  /**
   * blocks: [{text, hrefs}] (one per notification element) or plain strings.
   * Returns only notifications with a recognised order event: [{text, kind, listingIds, orderIds, ageMs, atMs}].
   */
  function parseNotifications(blocks, nowMs) {
    var now = nowMs || Date.now(), out = [], seen = {};
    (blocks || []).forEach(function (b) {
      var text = norm(typeof b === 'string' ? b : b && b.text);
      if (!text || text.length < 8 || text.length > 600) return;
      var kind = classifyNotification(text);
      if (!kind) return;
      var ids = idsFrom(typeof b === 'string' ? [] : (b.hrefs || []), text);
      var age = parseRelativeAge(text);
      var key = kind + '|' + text.replace(/\s*·?\s*(\d{1,3}\s*[a-z]+|yesterday|just now)(\s+ago)?$/i, '');
      if (seen[key]) return;
      seen[key] = true;
      out.push({ text: text.slice(0, 400), kind: kind, listingIds: ids.listingIds, orderIds: ids.orderIds,
                 ageMs: age, atMs: age === '' ? '' : now - age });
    });
    return out;
  }

  var api = {
    parseMetaPayText: parseMetaPayText, parseWalletDate: parseWalletDate, canonicalStatus: canonicalStatus,
    classifyNotification: classifyNotification, parseRelativeAge: parseRelativeAge, parseNotifications: parseNotifications
  };
  root.PTSignals = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
