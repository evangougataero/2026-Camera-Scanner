/**
 * parse-orders.js — pure parsing + matching for Facebook's "Purchased orders" page
 *   https://www.facebook.com/marketplace/you/orders
 * (globalThis.PTOrders). No DOM, no chrome.* APIs: runs in the page (injected before orders-extractor.js), in the
 * service worker (importScripts) and in Node tests. Depends on parse-order.js (globalThis.PTParse) for seller-name
 * helpers and USPS number normalisation, when available.
 *
 * Page shape (Nov 2026, from screenshots):
 *   list of order CARDS, newest first:  <status: Shipped / Confirmed / Delivered / Canceled / Refunded …>
 *                                        <listing title, truncated with "…">  <order date "Nov 8, 2026">  (+ thumbnail)
 *   clicking a card opens an "Order status" DIALOG:
 *     <full title> / $200.00 · Quantity: 1 / Shipped / Estimated Arrival: Nov 19 / USPS TRACKING NUMBER: 9334… /
 *     Order Confirmed / Nov 8 at 9:41 PM / Shipped / Nov 9 at 7:08 PM / Out for delivery / Delivered /
 *     Seller information / Tabitha Shippee / View order details
 * Everything works on VISIBLE TEXT (class names are obfuscated and rotate).
 *
 * Safety rules implemented here:
 *   - Canceled / Refunded / Expired on this page is EXPLICIT evidence (Facebook's own order record).
 *   - A tracked purchase that is NOT FOUND on the page is never canceled: it is only reported as not found.
 *   - An order that fits two purchases (or a purchase that fits two orders) equally well changes nothing (ambiguous).
 */
(function (root) {
  'use strict';

  var P = function () { return root.PTParse || (typeof require === 'function' ? safeRequire('./parse-order.js') : null); };
  function safeRequire(p) { try { return require(p); } catch (e) { return null; } }

  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };
  var lines = function (t) { return String(t || '').split(/\n+/).map(norm).filter(Boolean); };

  // ---- dates ------------------------------------------------------------------
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  var MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var iso = function (y, m, d) {
    var dt = new Date(Date.UTC(y, m, d));
    return dt.getUTCMonth() === m && dt.getUTCDate() === d ? y + '-' + pad(m + 1) + '-' + pad(d) : '';
  };
  var dayMs = function (isoDate) {
    var m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  };

  /**
   * "Nov 8, 2026" / "November 8 2026" / "Nov 8" -> 'yyyy-MM-dd'. Without a year: the most recent such date that is not
   * in the future (relative to nowMs + 1 day) — order dates are always in the past. Returns '' if none.
   */
  function parseOrderDate(text, nowMs) {
    var m = String(text || '').match(new RegExp('\\b' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'i'));
    if (!m) return '';
    var mo = MONTHS[m[1].toLowerCase().slice(0, 3)], d = parseInt(m[2], 10);
    if (m[3]) return iso(parseInt(m[3], 10), mo, d);
    var now = new Date(nowMs || Date.now()), y = now.getUTCFullYear();
    var cand = iso(y, mo, d);
    if (cand && dayMs(cand) > (nowMs || Date.now()) + 86400000) cand = iso(y - 1, mo, d);
    return cand;
  }

  /** A month/day with no year that comes AFTER refIso (estimated arrival): same year, or the next one if it would be earlier. */
  function futureDate(text, refIso) {
    var m = String(text || '').match(new RegExp('\\b' + MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b', 'i'));
    if (!m) return '';
    var mo = MONTHS[m[1].toLowerCase().slice(0, 3)], d = parseInt(m[2], 10);
    if (m[3]) return iso(parseInt(m[3], 10), mo, d);
    var ref = dayMs(refIso);
    var y = isNaN(ref) ? new Date().getUTCFullYear() : new Date(ref).getUTCFullYear();
    var c = iso(y, mo, d);
    if (c && !isNaN(ref) && dayMs(c) < ref - 30 * 86400000) c = iso(y + 1, mo, d);       // "Jan 3" after a December order
    return c;
  }

  /** Whole days from purchasedAt ('yyyy-MM-dd…') to the order date. Negative = order date earlier. null if unknown. */
  function dayOffset(orderIso, purchasedAt) {
    var a = dayMs(orderIso), b = dayMs(purchasedAt);
    return isNaN(a) || isNaN(b) ? null : Math.round((a - b) / 86400000);
  }

  // ---- status -----------------------------------------------------------------
  var STATUS_RE = [
    ['out_for_delivery', /^out for delivery\b/i],
    ['delivered', /^(order )?delivered\b/i],
    ['shipped', /^(order )?(shipped|in transit|on its way)\b/i],
    ['confirmed', /^(order )?(confirmed|placed|processing|awaiting shipment|preparing( to ship)?|ready to ship|pending)\b/i],
    ['canceled', /^(order )?cancell?ed\b/i],
    ['refunded', /^(order )?refunded\b/i],
    ['expired', /^(order )?expired\b/i]
  ];
  var HEADLINE = { confirmed: 'Confirmed', shipped: 'Shipped', out_for_delivery: 'Out for delivery', delivered: 'Delivered',
                   canceled: 'Canceled', refunded: 'Refunded', expired: 'Expired' };

  /** Facebook status wording -> 'confirmed'|'shipped'|'out_for_delivery'|'delivered'|'canceled'|'refunded'|'expired'|''. */
  function normalizeOrderStatus(raw) {
    var t = norm(raw);
    if (!t || t.length > 60) return '';
    if (/^partially refunded|request|requested|^refund (requested|pending)|cancellation requested/i.test(t)) return '';
    for (var i = 0; i < STATUS_RE.length; i++) if (STATUS_RE[i][1].test(t)) return STATUS_RE[i][0];
    return '';
  }

  /**
   * What a status means for the Purchased tab (the backend derives the final value; it never downgrades):
   *   confirmed -> Purchased (order confirmed, awaiting shipment)
   *   shipped / out_for_delivery -> Shipped (tracking stored; backend shows "Tracking Available" until USPS confirms acceptance)
   *   delivered -> Delivered (Facebook-confirmed delivery: transfer to Inventory)
   *   canceled / refunded / expired -> Canceled with explicit evidence
   */
  function statusEffect(key) {
    switch (key) {
      case 'confirmed': return { purchaseStatus: 'Purchased', canceled: false, outcome: '' };
      case 'shipped': case 'out_for_delivery': return { purchaseStatus: 'Shipped', canceled: false, outcome: '' };
      case 'delivered': return { purchaseStatus: 'Delivered', canceled: false, outcome: '' };
      case 'canceled': case 'refunded': case 'expired': return { purchaseStatus: 'Canceled', canceled: true, outcome: key };
      default: return { purchaseStatus: '', canceled: false, outcome: '' };
    }
  }

  // ---- small line classifiers -------------------------------------------------------
  var RE_DATE_LINE = new RegExp('^(ordered( on)?|purchased( on)?|placed( on)?|order date:?)?\\s*' + MON + '\\s+\\d{1,2}(?:st|nd|rd|th)?(,?\\s+\\d{4})?$', 'i');
  var RE_PRICE_LINE = /^\$\s?[\d,]+(\.\d{2})?\b/;
  var RE_UI = /^(purchased orders|orders|your orders|date range:?.*|select|filter|sort|see (more|all)|load more|buying|selling|marketplace|order status|view order details|order help|seller information|order information|close|back|more|message seller|contact seller|track package)$/i;

  function isStatusLine(l) { return l.length <= 40 && !!normalizeOrderStatus(l); }
  function isDateLine(l) { return l.length <= 40 && RE_DATE_LINE.test(l); }

  function cleanTitle(s) {
    var c = P() && P().cleanTitle ? P().cleanTitle(s) : norm(s);
    return norm(c);
  }

  /**
   * One card's visible text -> {status, statusRaw, title, orderDate} or null. A card has exactly one status line and at
   * most one date line (more means the text spans several cards: a list container, not a card).
   */
  function parseCardText(text, nowMs) {
    var ls = lines(text);
    if (!ls.length || ls.length > 12) return null;
    var statuses = ls.filter(isStatusLine), dates = ls.filter(isDateLine);
    if (statuses.length !== 1 || dates.length > 1) return null;
    var title = '';
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      if (isStatusLine(l) || isDateLine(l) || RE_PRICE_LINE.test(l) || RE_UI.test(l) || l.length < 3) continue;
      title = cleanTitle(l); break;
    }
    if (!title) return null;
    var dateLine = dates[0] || '';
    return { status: normalizeOrderStatus(statuses[0]), statusRaw: statuses[0], title: title.slice(0, 200), orderDateRaw: dateLine,
             orderDate: dateLine ? parseOrderDate(dateLine, nowMs) : '' };
  }

  /** Fallback when card elements cannot be told apart: splits the list text at status lines (status, title, date per card). */
  function parseOrdersListText(text, nowMs) {
    var ls = lines(text), out = [], cur = null;
    var flush = function () { if (cur && cur.title) out.push(cur); cur = null; };
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      if (isStatusLine(l)) { flush(); cur = { status: normalizeOrderStatus(l), statusRaw: l, title: '', orderDateRaw: '', orderDate: '' }; continue; }
      if (!cur) continue;
      if (isDateLine(l)) { if (!cur.orderDate) { cur.orderDateRaw = l; cur.orderDate = parseOrderDate(l, nowMs); } continue; }
      if (!cur.title && !RE_PRICE_LINE.test(l) && !RE_UI.test(l) && l.length >= 3) cur.title = cleanTitle(l).slice(0, 200);
    }
    flush();
    return out;
  }

  // ---- links -> IDs ---------------------------------------------------------------
  /** {listingId, orderId} from hrefs found in a card / dialog, or from the page URL after a card was opened. */
  function idsFromHrefs(hrefs) {
    var out = { listingId: '', orderId: '' };
    (hrefs || []).forEach(function (h) {
      var s = String(h || '');
      try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
      var m = s.match(/\/marketplace\/item\/(\d{6,25})/);
      if (m && !out.listingId) out.listingId = m[1];
      m = s.match(/[?&](?:order_id|orderID|orderId|buyer_order_id|id)=(\d{8,25})\b/) || s.match(/\/(?:you\/)?orders?\/(\d{8,25})\b/) ||
          s.match(/\/buyer_order_status\/(\d{8,25})\b/);
      if (m && !out.orderId && !/\/marketplace\/item\//.test(s.slice(0, s.indexOf(m[0])))) out.orderId = m[1];
    });
    return out;
  }

  // ---- dialog -----------------------------------------------------------------------
  var CARRIER_RE = /\b(USPS|UPS|FED\s?EX|DHL)\b[^\n]{0,12}?\btracking\b\s*(?:number|no\.?|#|id)?\s*[:#]?\s*\n?\s*([^\n]{6,80})/i;

  function validNumber(carrier, num) {
    var p = P();
    if (carrier === 'USPS') {
      var u = p && p.normalizeUsps ? p.normalizeUsps(num) : (/^9[1-5]\d{18,20}$/.test(num) ? num : null);
      if (u) return u;
      return /^[A-Z]{2}\d{9}US$/.test(num) ? num : '';
    }
    if (carrier === 'UPS') return /^1Z[0-9A-Z]{16}$/.test(num) || /^\d{9,26}$/.test(num) || /^[A-Z]\d{10}$/.test(num) ? num : '';
    if (carrier === 'FedEx') return /^\d{12,22}$/.test(num) ? num : '';
    if (carrier === 'DHL') return /^\d{10,11}$/.test(num) || /^[A-Z]{3}\d{7}$/.test(num) ? num : '';
    return '';
  }

  /** "USPS TRACKING NUMBER: 9334…" (number on the same or the next line). Returns {trackingNumber, carrier} or null. */
  function parseCarrierTracking(text) {
    var m = String(text || '').match(CARRIER_RE);
    if (!m) return null;
    var cn = m[1].toUpperCase().replace(/\s/g, '');
    var carrier = cn === 'USPS' ? 'USPS' : cn === 'UPS' ? 'UPS' : cn === 'DHL' ? 'DHL' : 'FedEx';
    var toks = m[2].split(/[\s\-]+/), num = '';
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/[.,;]+$/, '');
      if (/^[A-Za-z0-9]+$/.test(t) && /\d/.test(t)) num += t.toUpperCase(); else break;   // stop at "Copy", "Track" …
    }
    var v = num ? validNumber(carrier, num) : '';
    return v ? { trackingNumber: v, carrier: carrier } : null;
  }

  /** "Estimated Arrival: Nov 19" / "Estimated arrival Nov 19 - Nov 21" -> {raw, date} (first day of a range). */
  function parseEstimatedArrival(text, refIso) {
    var ls = lines(text);
    for (var i = 0; i < ls.length; i++) {
      if (!/^(estimated|expected|est\.?) (arrival|delivery)\b/i.test(ls[i])) continue;
      var rest = ls[i].replace(/^(estimated|expected|est\.?) (arrival|delivery)( date)?\s*:?\s*/i, '');
      if (!rest && ls[i + 1]) rest = ls[i + 1];
      var raw = norm(rest).slice(0, 60);
      return { raw: raw, date: futureDate(raw, refIso) };
    }
    return { raw: '', date: '' };
  }

  var STEP_RE = /^(order (confirmed|placed)|confirmed|shipped|in transit|out for delivery|delivered|canceled|cancelled|refunded|expired)$/i;
  var STAMP_RE = new RegExp('^' + MON + '\\s+\\d{1,2}(?:,?\\s+\\d{4})?(?:\\s*(?:at|,|·)?\\s*\\d{1,2}:\\d{2}\\s*(?:[ap]\\.?m\\.?)?)?$', 'i');

  /**
   * Timeline steps after the status headline: [{step, at, done}]. A step followed by (or carrying) a timestamp is completed
   * (Facebook checks it); a step with no timestamp is still pending. The first occurrence of each step name wins after the
   * first "Order Confirmed"-type step (so the headline itself is not counted twice).
   */
  function parseTimeline(text) {
    var ls = lines(text), out = [], started = false, seen = {};
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i], name = l, stamp = '';
      var same = l.match(new RegExp('^(.+?)\\s*[·:\\-–]?\\s+(' + MON + '\\s+\\d{1,2}.*)$', 'i'));
      if (same && STEP_RE.test(norm(same[1])) && STAMP_RE.test(norm(same[2]))) { name = norm(same[1]); stamp = norm(same[2]); }
      if (!STEP_RE.test(name)) continue;
      if (!started && !/^order (confirmed|placed)$|^confirmed$/i.test(name)) continue;
      started = true;
      if (!stamp && ls[i + 1] && STAMP_RE.test(ls[i + 1])) { stamp = ls[i + 1]; i++; }
      var key = name.toLowerCase().replace('cancelled', 'canceled');
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ step: name, at: stamp, done: !!stamp });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** "$200.00 · Quantity: 1" (the separator may render as ·, •, |, - or a stray ?). */
  function parsePriceLine(text) {
    var ls = lines(text);
    for (var i = 0; i < ls.length; i++) {
      var m = ls[i].match(/^\$\s?([\d,]+(?:\.\d{2})?)\s*(?:[·•|?\-–]\s*)?(?:quantity|qty)\s*:?\s*(\d+)/i);
      if (m) return { price: parseFloat(m[1].replace(/,/g, '')), quantity: parseInt(m[2], 10), index: i };
    }
    for (var j = 0; j < Math.min(ls.length, 8); j++) {
      var p = ls[j].match(/^\$\s?([\d,]+\.\d{2})$/);
      if (p) return { price: parseFloat(p[1].replace(/,/g, '')), quantity: 1, index: j };
    }
    return { price: '', quantity: '', index: -1 };
  }

  /** The status HEADLINE of the dialog: first status-looking line after the price line (or anywhere if no price line). */
  function dialogHeadline(ls, priceIdx) {
    for (var i = priceIdx >= 0 ? priceIdx + 1 : 0; i < ls.length; i++) {
      if (/^order status$/i.test(ls[i])) continue;
      var k = normalizeOrderStatus(ls[i]);
      if (k && ls[i].length <= 40) return { key: k, raw: ls[i] };
    }
    return { key: '', raw: '' };
  }

  /**
   * Visible text (+ hrefs) of an "Order status" dialog / "order details" view -> parsed order. Never includes the
   * shipping address or contact info (those lines are not read into any field).
   */
  function parseOrderDialogText(text, hrefs, ctx) {
    ctx = ctx || {};
    var p = P();
    var ls = lines(text);
    var price = parsePriceLine(text);
    var head = dialogHeadline(ls, price.index);
    var title = '';
    if (price.index > 0) {
      var t = cleanTitle(ls[price.index - 1]);
      if (t && !/^order (status|details)$/i.test(t) && t.length <= 200) title = t;
    }
    var tr = parseCarrierTracking(text);
    if (!tr && p && p.parseOrderText) {
      var g = p.parseOrderText(text, hrefs || []);
      if (g.trackingNumber) tr = { trackingNumber: g.trackingNumber, carrier: g.carrier || 'Unknown' };
    } else if (!tr && hrefs && p && p.trackingFromHref) {
      hrefs.some(function (h) { var r = p.trackingFromHref(h); if (r) tr = { trackingNumber: r.number, carrier: r.carrier }; return !!r; });
    }
    var eta = parseEstimatedArrival(text, ctx.orderDate || '');
    var ids = idsFromHrefs((hrefs || []).concat(ctx.url ? [ctx.url] : []));
    var idm = String(text || '').match(/order\s*(?:#|no\.?|number|id)\s*[:#]?\s*(\d{8,25})/i);
    return {
      status: head.key, statusRaw: head.raw, title: title,
      price: price.price, quantity: price.quantity,
      trackingNumber: tr ? tr.trackingNumber : '', carrier: tr ? tr.carrier : '',
      estimatedArrival: eta.raw, estimatedDelivery: eta.date,
      timeline: parseTimeline(text),
      seller: p && p.parseSeller ? p.parseSeller(text) : '',
      orderId: idm ? idm[1] : ids.orderId, listingId: ids.listingId
    };
  }

  /** Card + dialog -> one order record (dialog wins where it has data). */
  function mergeOrder(card, dialog) {
    card = card || {}; dialog = dialog || null;
    var d = dialog || {};
    var status = d.status || card.status || '';
    return {
      key: card.key || '', status: status, statusRaw: d.statusRaw || card.statusRaw || '',
      title: d.title || card.title || '', cardTitle: card.title || '',
      orderDate: card.orderDate || '', orderDateRaw: card.orderDateRaw || '',
      price: d.price === undefined ? '' : d.price, quantity: d.quantity === undefined ? '' : d.quantity,
      trackingNumber: d.trackingNumber || '', carrier: d.carrier || '',
      estimatedArrival: d.estimatedArrival || '', estimatedDelivery: d.estimatedDelivery || '',
      timeline: d.timeline || [], seller: d.seller || '',
      orderId: d.orderId || card.orderId || '', listingId: d.listingId || card.listingId || '',
      dialogOpened: !!dialog, dialogError: card.dialogError || ''
    };
  }

  // ---- matching ------------------------------------------------------------------------
  function normalizeName(s) {
    var t = norm(s);
    try { t = t.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* keep accents */ }
    return t.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** Same rules as Logic.gs sellerMatchLevel_: 2 = same name, 1 = same first+last word / contained, 0 = different. */
  function sellerMatchLevel(a, b) {
    var na = normalizeName(a), nb = normalizeName(b);
    if (!na || !nb) return 0;
    if (na === nb) return 2;
    var ta = na.split(' ').filter(function (w) { return w.length > 1; }), tb = nb.split(' ').filter(function (w) { return w.length > 1; });
    if (ta.length < 2 || tb.length < 2) return 0;
    if (ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return 1;
    var sub = function (x, y) { return x.every(function (w) { return y.indexOf(w) !== -1; }); };
    return (sub(ta, tb) || sub(tb, ta)) ? 1 : 0;
  }

  var STOP = { the: 1, a: 1, an: 1, and: 1, with: 1, for: 1, of: 1, in: 1, on: 1, to: 1, w: 1, plus: 1, camera: 1, kit: 1, used: 1, new: 1, great: 1, condition: 1, excellent: 1, good: 1 };

  /** Significant words of a title. A truncated title ("…Hard C...") drops its cut-off last word. */
  function titleTokens(s) {
    var raw = String(s || '');
    var truncated = /(\.\.\.|…)\s*$/.test(raw);
    var toks = normalizeName(raw.replace(/(\.\.\.|…)\s*$/, '')).split(' ').filter(function (w) { return w && !STOP[w]; });
    if (truncated && toks.length > 1) toks.pop();
    return toks.filter(function (w, i, a) { return a.indexOf(w) === i; });
  }

  /**
   * 0..1 similarity between a (possibly truncated) order title and a purchase's titles: the share of the order title's
   * significant words found in the Facebook listing title, or the share of a scanner product name's words found in the
   * order title (scanner names are short, e.g. "Nikon D80"). Model numbers make the difference, so digits count double.
   */
  function titleSimilarity(orderTitle, item) {
    var ot = titleTokens(orderTitle);
    if (!ot.length) return { score: 0, shared: 0 };
    var weight = function (w) { return /\d/.test(w) ? 2 : 1; };
    var best = { score: 0, shared: 0 };
    var cmp = function (from, into) {
      if (!from.length) return;
      var tot = 0, hit = 0, shared = 0;
      from.forEach(function (w) { tot += weight(w); if (into.indexOf(w) !== -1) { hit += weight(w); shared++; } });
      var s = tot ? hit / tot : 0;
      if (s > best.score || (s === best.score && shared > best.shared)) best = { score: s, shared: shared };
    };
    var fbTitle = titleTokens(item.fbTitle || item.title || '');
    if (fbTitle.length) cmp(ot, fbTitle);
    String(item.product || '').split(/\s\+\s/).forEach(function (name) { cmp(titleTokens(name), ot); });
    return best;
  }

  var money = function (v) {
    if (typeof v === 'number') return isFinite(v) ? v : '';
    var s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : '';
  };

  var DEFAULTS = { daysBefore: 6, daysAfter: 2, titleMin: 0.6, titleSharedMin: 2, titleTieEps: 0.05 };

  /** Is the order date inside the purchase's window (-daysBefore .. +daysAfter around Purchased At)? null = unknown. */
  function inWindow(order, item, cfg) {
    var d = dayOffset(order.orderDate, item.purchasedAt);
    if (d === null) return null;
    return d >= -cfg.daysBefore && d <= cfg.daysAfter;
  }

  /**
   * How well an order fits a purchase: {tier, score, via} | null. Tiers (strongest first):
   *   3 ID          — listing ID or Facebook order ID equal
   *   2 seller+price — seller name matches the Seller column AND price equals Purchase Cost or Ask Price (to the cent);
   *                    the order date (if known) must be in the purchase window
   *   1 title+date  — title similarity >= titleMin with >= titleSharedMin shared words AND order date in the window
   */
  function pairScore(order, item, cfg) {
    cfg = cfg || DEFAULTS;
    if ((order.listingId && order.listingId === String(item.listingId || '')) || (order.orderId && order.orderId === String(item.orderId || ''))) {
      return { tier: 3, score: 100, via: order.listingId && order.listingId === String(item.listingId || '') ? 'listing ID' : 'order ID' };
    }
    var win = inWindow(order, item, cfg);
    var d = dayOffset(order.orderDate, item.purchasedAt);
    var lvl = sellerMatchLevel(order.seller, item.seller);
    var price = money(order.price);
    if (lvl && price !== '' && win !== false) {
      var prices = [money(item.cost), money(item.ask)].filter(function (x) { return x !== ''; });
      if (prices.some(function (x) { return Math.abs(x - price) <= 0.011; })) {
        return { tier: 2, score: lvl * 10 - (d === null ? 3 : Math.min(Math.abs(d), 9)), via: 'seller+price' };
      }
    }
    if (win === true) {
      var sim = titleSimilarity(order.title || order.cardTitle, item);
      if (sim.score >= cfg.titleMin && sim.shared >= cfg.titleSharedMin) {
        return { tier: 1, score: Math.round(sim.score * 100) - Math.abs(d) * 3, via: 'title+date (' + Math.round(sim.score * 100) + '%)' };
      }
    }
    return null;
  }

  /**
   * One-to-one assignment of orders to tracked purchases.
   * items: [{purchaseId, listingId, orderId, seller, cost, ask, purchasedAt, fbTitle, product, mode}]
   * Returns {matches:[{purchaseId, item, order, via, tier}], ambiguous:[{orderKey, title, purchaseIds, via}],
   *          notFound:[purchaseId], unmatchedOrders:[order]}.
   * Ambiguity: within a tier, a pair whose order (or purchase) has a rival with the same score (title tier: within
   * titleTieEps) is not applied; the order and the purchases involved take no further part (nothing changes for them).
   */
  function matchOrders(orders, items, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    orders = orders || []; items = items || [];
    var pairs = [];
    orders.forEach(function (o, oi) {
      items.forEach(function (it, ii) {
        var s = pairScore(o, it, cfg);
        if (s) pairs.push({ oi: oi, ii: ii, tier: s.tier, score: s.score, via: s.via });
      });
    });
    pairs.sort(function (a, b) { return b.tier - a.tier || b.score - a.score; });
    var oUsed = {}, iUsed = {}, oAmb = {}, iAmb = {}, matches = [], ambiguous = [];
    var eps = function (tier) { return tier === 1 ? cfg.titleTieEps * 100 : 0; };
    pairs.forEach(function (pr) {
      if (oUsed[pr.oi] || iUsed[pr.ii] || oAmb[pr.oi] || iAmb[pr.ii]) return;
      var rivals = pairs.filter(function (o) {
        return o !== pr && o.tier === pr.tier && Math.abs(o.score - pr.score) <= eps(pr.tier) &&
          ((o.oi === pr.oi && !iUsed[o.ii] && !iAmb[o.ii]) || (o.ii === pr.ii && !oUsed[o.oi] && !oAmb[o.oi]));
      });
      if (rivals.length) {
        var ids = [pr].concat(rivals).map(function (x) { return String(items[x.ii].purchaseId); }).filter(function (v, i, a) { return a.indexOf(v) === i; });
        [pr].concat(rivals).forEach(function (x) { oAmb[x.oi] = true; iAmb[x.ii] = true; });
        ambiguous.push({ orderKey: orders[pr.oi].key || '', title: orders[pr.oi].title || orders[pr.oi].cardTitle || '', orderDate: orders[pr.oi].orderDate || '',
                         purchaseIds: ids, via: pr.via });
        return;
      }
      oUsed[pr.oi] = true; iUsed[pr.ii] = true;
      matches.push({ purchaseId: String(items[pr.ii].purchaseId), item: items[pr.ii], order: orders[pr.oi], via: pr.via, tier: pr.tier });
    });
    var notFound = items.filter(function (it, ii) { return !iUsed[ii] && !iAmb[ii]; }).map(function (it) { return String(it.purchaseId); });
    var unmatchedOrders = orders.filter(function (o, oi) { return !oUsed[oi] && !oAmb[oi]; });
    return { matches: matches, ambiguous: ambiguous, notFound: notFound, unmatchedOrders: unmatchedOrders };
  }

  /** Could this card belong to any tracked purchase? (Decides which cards get their dialog opened.) */
  function cardMayMatch(card, items, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    if (!items || !items.length) return true;
    return items.some(function (it) {
      if (card.listingId && card.listingId === String(it.listingId || '')) return true;
      if (card.orderId && card.orderId === String(it.orderId || '')) return true;
      var w = inWindow(card, it, cfg);
      return w === null || w === true;
    });
  }

  /** Earliest order date the run needs: the oldest Purchased At minus the matching window (yyyy-MM-dd), or ''. */
  function earliestNeeded(items, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    var min = NaN;
    (items || []).forEach(function (it) { var t = dayMs(it.purchasedAt); if (!isNaN(t) && (isNaN(min) || t < min)) min = t; });
    if (isNaN(min)) return '';
    var d = new Date(min - cfg.daysBefore * 86400000);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  /**
   * "FB Status (raw)" for the backend: canonical HEADLINE first (the backend reads "Delivered" from the first segment),
   * then Facebook's own wording if different, the estimated arrival and the completed timeline steps.
   */
  function statusRawOf(order) {
    var head = HEADLINE[order.status] || norm(order.statusRaw);
    var segs = [head];
    if (order.statusRaw && norm(order.statusRaw).toLowerCase() !== head.toLowerCase()) segs.push(norm(order.statusRaw));
    if (order.estimatedArrival) segs.push('Estimated Arrival: ' + order.estimatedArrival);
    (order.timeline || []).filter(function (s) { return s.done; }).forEach(function (s) { segs.push(s.step + ': ' + s.at); });
    return segs.filter(Boolean).join(' | ').slice(0, 300);
  }

  /**
   * Order (+ the tracked purchase it matched) -> the existing submitFbResult payload. mode 'seller' rows (seller backfill)
   * only carry seller/title. Status-less orders (unknown wording) still carry tracking/seller but no status claims.
   */
  function toFbResult(order, item) {
    var mode = item && item.mode === 'seller' ? 'seller' : 'order';
    var base = { ok: true, mode: mode, source: 'orders-page', seller: order.seller || '', itemTitle: order.title || '', orderView: true };
    if (mode === 'seller') return base;
    var eff = statusEffect(order.status);
    return Object.assign(base, {
      fbStatusRaw: order.status || order.statusRaw ? statusRawOf(order) : '',
      orderStatus: order.status || '', purchaseStatus: eff.purchaseStatus,
      canceled: eff.canceled, outcome: eff.outcome,
      trackingNumber: order.trackingNumber || '', carrier: order.trackingNumber ? (order.carrier || 'Unknown') : '',
      orderId: order.orderId || '', orderTotal: order.price !== '' && order.price !== undefined ? '$' + Number(order.price).toFixed(2) : '',
      estimatedDelivery: order.estimatedDelivery || '', estimatedArrival: order.estimatedArrival || '',
      timeline: (order.timeline || []).map(function (s) { return { step: s.step, at: s.at, done: !!s.done }; }),
      orderDate: order.orderDate || '', matchedVia: ''
    });
  }

  /**
   * Full plan for one orders-page read: what to submit per purchase, and what to log.
   * Returns {submissions:[{purchaseId, result, via, order}], notFound, ambiguous, unmatchedOrders, newUspsTracking:[{purchaseId, trackingNumber}]}.
   * NOTHING is ever submitted for a purchase that is not found or ambiguous.
   */
  function planOrderResults(orders, items, cfg) {
    var m = matchOrders(orders, items, cfg);
    var notFound = m.notFound.slice();
    var submissions = [];
    m.matches.forEach(function (x) {
      var r = toFbResult(x.order, x.item);
      // A seller-backfill row matched to a card whose dialog gave no seller has nothing to report: not a "miss" on the row.
      if (r.mode === 'seller' && !r.seller) { notFound.push(x.purchaseId); return; }
      if (r.mode === 'order') r.matchedVia = x.via;
      submissions.push({ purchaseId: x.purchaseId, result: r, via: x.via, order: x.order, mode: r.mode });
    });
    // Tracking that is NEW for the row (the work item had none) and USPS: the run can check it on USPS right away.
    var newUspsTracking = submissions.filter(function (s) {
      return s.mode === 'order' && s.result.trackingNumber && s.result.carrier === 'USPS' && !s.result.canceled &&
        s.result.orderStatus !== 'delivered' && !norm(findItem(items, s.purchaseId).trackingNumber);
    }).map(function (s) { return { purchaseId: s.purchaseId, trackingNumber: s.result.trackingNumber }; });
    return { submissions: submissions, notFound: notFound, ambiguous: m.ambiguous, unmatchedOrders: m.unmatchedOrders, newUspsTracking: newUspsTracking };
  }
  function findItem(items, id) { return (items || []).filter(function (i) { return String(i.purchaseId) === String(id); })[0] || {}; }

  /** One-line, human-readable summary of an order (logs / probe). */
  function describeOrder(o) {
    return [HEADLINE[o.status] || o.statusRaw || '?', '"' + String(o.title || o.cardTitle || '').slice(0, 60) + '"', o.orderDate || o.orderDateRaw || 'no date',
      o.price !== '' && o.price !== undefined ? '$' + Number(o.price).toFixed(2) : '', o.seller ? 'seller ' + o.seller : '',
      o.trackingNumber ? (o.carrier || '') + ' ' + o.trackingNumber : ''].filter(Boolean).join(' · ');
  }

  var api = {
    parseOrderDate: parseOrderDate, futureDate: futureDate, dayOffset: dayOffset,
    normalizeOrderStatus: normalizeOrderStatus, statusEffect: statusEffect,
    parseCardText: parseCardText, parseOrdersListText: parseOrdersListText, idsFromHrefs: idsFromHrefs,
    parseCarrierTracking: parseCarrierTracking, parseEstimatedArrival: parseEstimatedArrival, parseTimeline: parseTimeline,
    parsePriceLine: parsePriceLine, parseOrderDialogText: parseOrderDialogText, mergeOrder: mergeOrder,
    sellerMatchLevel: sellerMatchLevel, titleTokens: titleTokens, titleSimilarity: titleSimilarity,
    pairScore: pairScore, matchOrders: matchOrders, cardMayMatch: cardMayMatch, earliestNeeded: earliestNeeded,
    statusRawOf: statusRawOf, toFbResult: toFbResult, planOrderResults: planOrderResults, describeOrder: describeOrder,
    DEFAULTS: DEFAULTS
  };
  root.PTOrders = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
