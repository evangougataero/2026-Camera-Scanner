/**
 * parse-order.js — pure text parsing for a Facebook Marketplace "Order details" view.
 * No DOM, no chrome.* APIs: runs in the page (injected), the service worker, and Node tests.
 *
 * IMPORTANT: Facebook's markup and wording are not documented and change often. This parser
 * therefore works on VISIBLE TEXT with conservative patterns, records Facebook's own wording
 * verbatim, and only trusts "canceled" when a line is clearly a statement about the order.
 */
(function (root) {
  'use strict';

  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };

  // ---- Tracking numbers ----------------------------------------------------

  /** USPS: 20-22 digits starting 91-95; or 420+ZIP(5|9) prefix + that; or S10 "EA123456789US". */
  function normalizeUsps(digits) {
    var m = digits.match(/^420\d{5}(?:\d{4})?(9[1-5]\d{18,20})$/);
    if (m) return m[1];
    if (/^9[1-5]\d{18,20}$/.test(digits)) return digits;
    return null;
  }

  function findUspsNumbers(text) {
    var out = [], t = String(text || '');
    function add(n) { if (n && out.indexOf(n) === -1) out.push(n); }
    // digits possibly grouped with single spaces/dashes on ONE line (newlines never merge)
    (t.match(/\d(?:[ \-]?\d){17,36}/g) || []).forEach(function (ch) { add(normalizeUsps(ch.replace(/\D/g, ''))); });
    (t.match(/\b9[1-5]\d{18,20}\b/g) || []).forEach(function (d) { add(normalizeUsps(d)); });
    (t.toUpperCase().match(/\b[A-Z]{2}\d{9}US\b/g) || []).forEach(add);
    return out;
  }

  /** Carrier tracking links (Facebook wraps outbound links via l.facebook.com/l.php?u=...). */
  function trackingFromHref(href) {
    var h = String(href || '');
    try {
      var u = new URL(h, 'https://www.facebook.com');
      if (/(^|\.)facebook\.com$/.test(u.hostname) && u.searchParams.get('u')) h = u.searchParams.get('u');
    } catch (e) { /* ignore */ }
    try { h = decodeURIComponent(h); } catch (e) { /* ignore */ }
    var m = h.match(/usps\.com[^#]*[?&](?:tLabels|tLc|trackingNumbers?)=([A-Za-z0-9]+)/i);
    if (m) return { number: m[1].toUpperCase(), carrier: 'USPS' };
    m = h.match(/ups\.com[^#]*[?&](?:tracknum|trackNums?|InquiryNumber1)=(1Z[0-9A-Za-z]{16})/i);
    if (m) return { number: m[1].toUpperCase(), carrier: 'UPS' };
    m = h.match(/fedex\.com[^#]*[?&](?:trknbr|tracknumbers)=(\d{12,22})/i);
    if (m) return { number: m[1], carrier: 'FedEx' };
    return null;
  }

  // ---- Status / cancellation ----------------------------------------------

  var STATUS_WORD = '(placed|confirmed|processing|shipped|in transit|out for delivery|delivered|canceled|cancelled|refunded|pending|awaiting shipment|preparing|ready to ship|on its way|label created)';
  var RE_STATUS_START = new RegExp('^' + STATUS_WORD + '\\b', 'i');
  var RE_STATUS_ANY = new RegExp('\\b(order|package|item|payment|purchase|shipment)\\b.*\\b' + STATUS_WORD, 'i');
  var RE_INSTRUCTION = /^(if|when|once|unless|in case|you can|you may|to |please|after|before|for |learn|see our)\b/i;

  function isStatusLine(line) {
    if (!line || line.length > 120) return false;
    if (RE_INSTRUCTION.test(line)) return false;
    if (/^(cancel|view|track|contact|report|get help|message|request)\b/i.test(line) && !/^cancell?ed/i.test(line)) return false;
    return RE_STATUS_START.test(line) || RE_STATUS_ANY.test(line);
  }

  /** True only for statements like "Order canceled" / "Seller canceled your order". Never for buttons or policy text. */
  function isCanceledLine(line) {
    var l = norm(line);
    if (!l || l.length > 160) return false;
    if (RE_INSTRUCTION.test(l)) return false;
    if (/\b(can|may|to|want to|would like to)\s+(?:\w+\s+){0,4}cancel\b/i.test(l)) return false;   // verb form = instruction
    if (/cancell?ation (policy|window|fee)|policy/i.test(l)) return false;
    if (/^(this |your |the )?(order|purchase|item)( has been| was| is| got)? cancell?ed\b/i.test(l)) return true;
    if (/^(order |purchase )?cancell?ed\b/i.test(l)) return true;
    if (/\b(seller|buyer|you|facebook|marketplace)\s+(has\s+)?cancell?ed\s+(this|the|your|an?)?\s*(order|purchase)\b/i.test(l)) return true;
    return false;
  }

  // ---- Main entry -----------------------------------------------------------

  /**
   * text: visible text of the order details dialog/page.
   * hrefs: optional array of link URLs found on the page.
   */
  function parseOrderText(text, hrefs) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    var statusLines = lines.filter(isStatusLine).slice(0, 3);
    var canceled = lines.some(isCanceledLine);

    var tracking = '', carrier = '';
    (hrefs || []).some(function (h) {
      var r = trackingFromHref(h);
      if (r) { tracking = r.number; carrier = r.carrier; return true; }
      return false;
    });
    var flat = lines.join('\n');
    if (!tracking) {
      var us = findUspsNumbers(flat);
      if (us.length) { tracking = us[0]; carrier = 'USPS'; }
    }
    if (!tracking) {
      var ups = flat.match(/\b1Z[0-9A-Z]{16}\b/i);
      if (ups) { tracking = ups[0].toUpperCase(); carrier = 'UPS'; }
    }
    if (!tracking) {
      var lab = flat.match(/tracking\s*(?:number|no\.?|#|id|code)?\s*[:#]?\s*([A-Z0-9]{10,34})\b/i);
      if (lab && /\d/.test(lab[1])) {
        tracking = lab[1].toUpperCase();
        carrier = /usps|united states postal/i.test(flat) ? 'USPS' : /fedex/i.test(flat) ? 'FedEx' : /\bups\b/i.test(flat) ? 'UPS' : 'Unknown';
      }
    }

    var idm = flat.match(/order\s*(?:#|no\.?|number|id)\s*[:#]?\s*(\d{8,20})/i);
    // Order total: only a line that STARTS with "Total"/"Order total"/"Total paid" (never "Item total"/"Subtotal").
    var orderTotal = '';
    for (var i = 0; i < lines.length; i++) {
      if (!/^(order |grand )?total( paid| charged)?\b/i.test(lines[i])) continue;
      var m = (lines[i] + ' ' + (lines[i + 1] || '')).match(/\$\s?([\d,]+\.\d{2})/);
      if (m) orderTotal = '$' + m[1];                       // keep the LAST such line (the final total)
    }

    return {
      fbStatusRaw: statusLines.join(' | ').slice(0, 300),
      statusLines: statusLines,
      canceled: canceled,
      trackingNumber: tracking,
      carrier: carrier,
      orderId: idm ? idm[1] : '',
      orderTotal: orderTotal
    };
  }

  var api = {
    parseOrderText: parseOrderText, findUspsNumbers: findUspsNumbers, trackingFromHref: trackingFromHref,
    isCanceledLine: isCanceledLine, isStatusLine: isStatusLine, normalizeUsps: normalizeUsps
  };
  root.PTParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
