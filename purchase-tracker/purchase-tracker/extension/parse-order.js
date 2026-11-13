/**
 * parse-order.js — pure text parsing for a Facebook Marketplace "Order status" dialog / "Order details" view
 * and the buyer's listing page (seller name, item title).
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
    var m = h.match(/usps\.com[^#]*[?&](?:tLabels|tLc|trackingNumbers?)=([A-Za-z0-9]+)/i) || h.match(/usps\.com\/tracking\/([A-Za-z0-9]{10,34})\b/i);
    if (m) return { number: m[1].toUpperCase(), carrier: 'USPS' };
    m = h.match(/ups\.com[^#]*[?&](?:tracknum|trackNums?|InquiryNumber1)=(1Z[0-9A-Za-z]{16})/i);
    if (m) return { number: m[1].toUpperCase(), carrier: 'UPS' };
    m = h.match(/fedex\.com[^#]*[?&](?:trknbr|tracknumbers)=(\d{12,22})/i);
    if (m) return { number: m[1], carrier: 'FedEx' };
    return null;
  }

  // ---- Status / cancellation ----------------------------------------------

  var STATUS_WORD = '(placed|confirmed|processing|shipped|in transit|out for delivery|delivered|canceled|cancelled|refunded|expired|may be delayed|pending|awaiting shipment|preparing|ready to ship|on its way|label created)';
  var RE_STATUS_START = new RegExp('^' + STATUS_WORD + '\\b', 'i');
  var RE_STATUS_ANY = new RegExp('\\b(order|package|item|payment|purchase|shipment)\\b.*\\b' + STATUS_WORD, 'i');
  var RE_INSTRUCTION = /^(if|when|once|unless|in case|you can|you may|to |please|after|before|for |learn|see our)\b/i;

  function isStatusLine(line) {
    if (!line || line.length > 120) return false;
    if (RE_INSTRUCTION.test(line)) return false;
    if (/^(cancel|view|track|contact|report|get help|message|request)\b/i.test(line) && !/^cancell?ed/i.test(line)) return false;
    if (/^(this )?item is (sold|shipped)/i.test(line)) return false;          // "Item is sold and shipped by <seller>"
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

  /**
   * Headline-style outcome statements only: 'canceled' | 'expired' | 'refunded' | ''.
   * ("Expired", "Your order expired", "Refunded", "Your order was refunded", "You've been refunded".)
   */
  function outcomeOfLine(line) {
    var l = norm(line);
    if (!l || l.length > 160 || RE_INSTRUCTION.test(l)) return '';
    if (isCanceledLine(l)) return 'canceled';
    if (/^(order )?expired\b/i.test(l) || /^(this |your |the )?(order|purchase)( has| was| is)? expired\b/i.test(l)) return 'expired';
    if (/^(order )?refunded\b/i.test(l) || /^(this |your |the )?(order|purchase|payment)( has been| was| is)? refunded\b/i.test(l) ||
        /^you(.ve| have)? (been|were) refunded\b/i.test(l)) return 'refunded';
    return '';
  }

  // ---- Seller / item title -----------------------------------------------------

  // Short UI strings that sit next to the seller's name and must never be taken for it.
  var NOT_A_NAME = /^(seller (information|details|info)|seller|details|message|send|follow|following|see (more|less|all)|view|joined|ratings?|reviews?|no ratings|highly rated|good rating|responsive|location|about|item is|sold and shipped|shipped by|order|delivered|shipped|confirmed|canceled|cancelled|expired|refunded|may be delayed|today|yesterday|marketplace|facebook|more|share|save|report|block|send seller a message|message seller|is this still available|open claim|contact seller|unknown)\b/i;

  /** A plausible person/shop display name: 2-60 chars with letters, no sentence, no prices, not a UI label. */
  function isNameLike(s) {
    var t = norm(s);
    if (t.length < 2 || t.length > 60) return false;
    if (!/[A-Za-zÀ-ɏЀ-ӿ]/.test(t)) return false;
    if (/[$@:|•·]|https?:|\d{3,}/.test(t)) return false;
    if (NOT_A_NAME.test(t)) return false;
    if (t.split(/\s+/).length > 6) return false;          // sentences are not names
    if (/[.!?]$/.test(t) && !/\b[A-Z]\.$/.test(t)) return false;
    return true;
  }

  function cleanName(s) {
    return norm(String(s || '').replace(/[​-‏﻿-]/g, '').replace(/\s*[·•|]\s.*$/, '').replace(/[.,;:]+$/, ''));
  }

  /**
   * Seller's display name from the visible text of the Order status dialog or a listing page.
   * Strongest first: "Item is sold and shipped by X" / "Sold by X" > the line after a "Seller information/details" heading.
   * Returns '' when not confident (never guesses).
   */
  function parseSeller(text) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    var i, m;
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^(?:this )?item is (?:sold and shipped|sold|shipped) by (.{2,60}?)\.?$/i) || lines[i].match(/^sold (?:and shipped )?by (.{2,60}?)\.?$/i);
      if (m && isNameLike(cleanName(m[1]))) return cleanName(m[1]);
    }
    for (i = 0; i < lines.length; i++) {
      if (!/^(seller (information|details|info)|about (the )?seller|meet the seller)$/i.test(lines[i])) continue;
      for (var j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        if (/^(seller (information|details|info))$/i.test(lines[j])) continue;   // "Seller information" -> "Seller details" -> name
        var c = cleanName(lines[j]);
        if (isNameLike(c)) return c;
        if (c.length > 60) break;
      }
    }
    return '';
  }

  /** Strips icon glyphs (Facebook renders some icons as private-use characters / emoji) and extra whitespace. */
  function cleanTitle(s) {
    return norm(String(s || '').replace(/[-​-‏﻿]/g, '').replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
  }

  /** The item title at the top of the Order status dialog: the line right before "$225.00 · Quantity: 1". */
  function parseItemTitle(text) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    for (var i = 1; i < lines.length; i++) {
      if (/^\$\s?[\d,]+(\.\d{2})?\s*[·•]\s*quantity\b/i.test(lines[i])) {
        var t = cleanTitle(lines[i - 1]);
        if (t && t.length <= 200 && !/^order (status|details)$/i.test(t)) return t;
      }
    }
    return '';
  }

  /** True when the text is a Facebook ORDER view (Order status dialog / order page), not merely a listing page. */
  function looksLikeOrderView(text) {
    var t = String(text || ''), hits = 0;
    [/\border status\b/i, /\border information\b/i, /\btracking number\b/i, /\border confirmed\b/i, /\byour order (was|has|is)\b/i,
     /\border help\b/i, /\bitem is sold and shipped by\b/i, /\bview order details\b/i, /\$\s?[\d,]+\.\d{2}\s*[·•]\s*quantity\b/i,
     /^(order )?(canceled|cancelled|expired|refunded)$/im]
      .forEach(function (re) { if (re.test(t)) hits++; });
    return hits >= 2;
  }

  /**
   * Buyer-visible state of a LISTING page (not an order view): 'sold' | 'pending' | ''.
   * Facebook marks a listing you bought as "Sold" or "Pending" (a badge line, "Marked as sold", "Sale pending"). Both mean
   * the order is ACTIVE: a missing View Order button on such a page is never evidence of a cancellation.
   * "Item is sold and shipped by …" (the seller line of an order dialog) does not count.
   */
  function listingStateFromText(text) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean).slice(0, 200);
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (l.length > 120 || /sold and shipped by/i.test(l)) continue;
      if (/^(sold|pending|sale pending)$/i.test(l) || /^(sold|pending)\s*[·•|]/i.test(l) || /[·•|]\s*(sold|pending)$/i.test(l) ||
          /\b(marked as|listing is|item is|item has been|listing has been) (sold|pending)\b/i.test(l)) {
        return /pending/i.test(l) ? 'pending' : 'sold';
      }
    }
    return '';
  }

  // ---- Main entry -----------------------------------------------------------

  /**
   * text: visible text of the order dialog/page.
   * hrefs: optional array of link URLs found on the page.
   */
  function parseOrderText(text, hrefs) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    var statusLines = lines.filter(isStatusLine).slice(0, 3);
    var anyCanceled = lines.some(isCanceledLine);

    // The outcome is decided by the dialog HEADLINE (first status line): a delivered order that later mentions a refund
    // (a claim) is not "refunded", while an order whose headline is "Expired" is gone even though "Order Confirmed" follows.
    var head = statusLines[0] || '';
    var deliveredHead = /^delivered\b|order was delivered/i.test(head);
    var outcome = outcomeOfLine(head);
    if (!outcome && anyCanceled && !deliveredHead) outcome = 'canceled';
    if (!outcome && !deliveredHead) {
      for (var oi = 0; oi < lines.length && !outcome; oi++) if (outcomeOfLine(lines[oi]) === 'expired') outcome = 'expired';
    }

    var tracking = '', carrier = '';
    (hrefs || []).some(function (h) {
      var r = trackingFromHref(h);
      if (r) { tracking = r.number; carrier = r.carrier; return true; }
      return false;
    });
    var flat = lines.join('\n');
    if (!tracking) {
      // A carrier-labelled line ("USPS TRACKING NUMBER: 9334...") names its carrier explicitly.
      var lm = flat.match(/\b(USPS|UPS|FEDEX|FED EX|DHL)\s+TRACKING\s*(?:NUMBER|NO\.?|#|ID)?\s*[:#]?\s*([A-Z0-9](?:[A-Z0-9]|[ \-](?=[A-Z0-9])){9,40})/i);
      if (lm) {
        var num = lm[2].replace(/[\s\-]/g, '').toUpperCase();
        var cn = lm[1].toUpperCase().replace(/\s/g, '');
        if (cn === 'USPS') {
          var u = normalizeUsps(num);
          if (u) { tracking = u; carrier = 'USPS'; } else if (/^[A-Z]{2}\d{9}US$/.test(num)) { tracking = num; carrier = 'USPS'; }
        } else if (/\d/.test(num)) { tracking = num; carrier = cn === 'UPS' ? 'UPS' : cn === 'DHL' ? 'DHL' : 'FedEx'; }
      }
    }
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
      canceled: anyCanceled || outcome !== '',
      outcome: outcome,                                     // '' | 'canceled' | 'expired' | 'refunded'
      trackingNumber: tracking,
      carrier: carrier,
      orderId: idm ? idm[1] : '',
      orderTotal: orderTotal,
      seller: parseSeller(text),
      itemTitle: parseItemTitle(text)
    };
  }

  var api = {
    parseOrderText: parseOrderText, findUspsNumbers: findUspsNumbers, trackingFromHref: trackingFromHref,
    isCanceledLine: isCanceledLine, isStatusLine: isStatusLine, normalizeUsps: normalizeUsps,
    outcomeOfLine: outcomeOfLine, parseSeller: parseSeller, parseItemTitle: parseItemTitle,
    isNameLike: isNameLike, cleanName: cleanName, cleanTitle: cleanTitle, looksLikeOrderView: looksLikeOrderView,
    listingStateFromText: listingStateFromText
  };
  root.PTParse = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
