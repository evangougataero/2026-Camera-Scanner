/**
 * parse-usps.js — pure parsing of the visible text on a tools.usps.com tracking RESULT page.
 * No DOM / chrome APIs (runs in the page, the worker and Node tests).
 *
 * The extension only reports what it SAW (status line, history lines, raw delivery-date text).
 * Classification into stages happens in Apps Script (Logic.gs), so there is one source of truth.
 * USPS markup/wording is unverified: parsing is text-based and conservative.
 */
(function (root) {
  'use strict';
  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); };

  var STATUS_RE = /^(delivered|out for delivery|in transit|moving through network|label created|shipping label created|pre-?shipment|usps awaiting item|awaiting item|accepted|usps in possession|arrived|departed|alert|delivery attempted|available for pickup|we.re waiting|awaiting)/i;
  var SUMMARY_RE = /^(your item|item (was|is)|we.re waiting|usps (is|has|picked))/i;
  var HISTORY_STOP = /^(usps tracking plus|product information|see less|see more|text & email updates|available actions|feedback|remove|track another|can.t find|need more help)/i;
  var NOT_FOUND = /status not available|could(n.t| not) (be )?found|no record of this item|tracking number.*(not|isn.t).*(found|recogni[sz]ed)|not (yet )?in (our )?system/i;

  function parseUspsText(text, trackingNumber) {
    var lines = String(text || '').split(/\n+/).map(norm).filter(Boolean);
    var flat = lines.join('\n');
    var compact = flat.replace(/[\s\-]/g, '');
    var out = { numberSeen: !trackingNumber || compact.indexOf(String(trackingNumber).replace(/\s/g, '')) !== -1,
                status: '', summary: '', history: [], expectedDelivery: '', notFound: false };

    var li = -1, ti = -1;
    for (var i = 0; i < lines.length; i++) {
      if (li < 0 && /^latest update$/i.test(lines[i])) li = i;
      if (ti < 0 && trackingNumber && lines[i].replace(/[\s\-]/g, '').indexOf(String(trackingNumber)) !== -1) ti = i;
    }
    // The "Latest Update" line is a SENTENCE (e.g. "Your item was picked up at the post office at ...").
    // The real status is the banner line (e.g. "Delivered, Individual Picked Up at Post Office") before it.
    if (li >= 0 && lines[li + 1]) out.summary = lines[li + 1].slice(0, 200);
    var from = ti >= 0 ? ti + 1 : 0, to = li >= 0 ? li : lines.length;
    for (var j = from; j < to; j++) if (lines[j].length <= 120 && STATUS_RE.test(lines[j])) { out.status = lines[j]; break; }
    if (!out.status && out.summary) out.status = out.summary.slice(0, 120);
    if (!out.status) {
      for (var q = 0; q < lines.length; q++) if (lines[q].length <= 200 && (STATUS_RE.test(lines[q]) || SUMMARY_RE.test(lines[q]))) { out.status = lines[q].slice(0, 120); break; }
    }

    var hi = -1;
    for (var k = 0; k < lines.length; k++) if (/^tracking history$/i.test(lines[k])) { hi = k; break; }
    if (hi >= 0) {
      for (var n = hi + 1; n < lines.length && out.history.length < 60; n++) {
        if (HISTORY_STOP.test(lines[n])) break;
        if (lines[n].length <= 100) out.history.push(lines[n]);
      }
    }

    // Window of text after the delivery label; Apps Script's inferDate_ extracts the date (or leaves blank).
    var m = flat.match(/(expected delivery(?: by| on)?|scheduled delivery(?: day)?|arriving (?:by|on))\s*[:\-]?\s*([\s\S]{0,90})/i);
    if (m) out.expectedDelivery = norm(m[2]);

    out.notFound = !out.status && NOT_FOUND.test(flat.slice(0, 4000));
    return out;
  }

  var api = { parseUspsText: parseUspsText };
  root.PTParseUsps = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
