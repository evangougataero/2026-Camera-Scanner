// Reads the scanner's own per-listing Analysis Log (the "View Log" file in column I; plain text produced by util.format of console.log/warn/error).
// What that log REALLY contains (verified against server.js):
//   YES  "[STEP 2] Raw gallery N response:" + JSON            -> modelReadabilityScore per product per image
//   YES  "[LENS RESOLVER] ..." / "[DATAFORSEO GATE] ..." etc.  -> how each lens identity was reached (all carry productId)
//   YES  "[STEP 5] Raw reconciliation response:" one-line JSON -> per-product lensIdentity + extracted_evidence (confirmed on a real log)
//   NO   the object printed by console.dir at "[STEP 5] Final primary products:" (console.dir is not captured)
//   NO   image URLs, and the listing description text (only its character count)
// So the log supplies grades + scanner reasoning; photo links and listing text must come from the saved snapshot.

const MARKER = /^\[([A-Z][A-Z0-9 +_.\-]*)\]\s*(.*)$/;

// ---- tolerant JS-literal / JSON parser (no eval). Handles util.inspect output: unquoted keys, 'single' strings, [Object], "... n more items". ----
class Lit {
  constructor(s, i) { this.s = s; this.i = i; }
  ws() { for (;;) { while (/\s/.test(this.s[this.i] || '')) this.i++; if (this.s.startsWith('//', this.i)) { while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++; } else break; } }
  value(depth = 0) {
    if (depth > 40) throw new Error('too deep');
    this.ws(); const c = this.s[this.i];
    if (c === '{') return this.object(depth);
    if (c === '[') {
      if (/^\[(Object|Array|Function|Circular|Getter|Setter)/.test(this.s.slice(this.i, this.i + 12))) { const j = this.s.indexOf(']', this.i); this.i = j + 1; return '[truncated]'; }
      return this.array(depth);
    }
    if (c === "'" || c === '"' || c === '`') return this.string();
    const m = /^-?(?:\d+\.?\d*(?:e[+-]?\d+)?|NaN|Infinity)n?/i.exec(this.s.slice(this.i, this.i + 40));
    if (m) { this.i += m[0].length; return Number(m[0].replace(/n$/, '')); }
    const id = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 20));
    if (id) { this.i += id[0].length; const lit = { true: true, false: false, null: null, undefined: null }; if (Object.prototype.hasOwnProperty.call(lit, id[0])) return lit[id[0]]; throw new Error('unsupported identifier ' + id[0]); }
    throw new Error('unexpected token at ' + this.i);
  }
  string() {
    let out = '';
    for (;;) {                                                                  // adjacent strings joined by "+" (util.inspect splits long strings)
      const q = this.s[this.i++]; let r = '';
      while (this.i < this.s.length && this.s[this.i] !== q) {
        if (this.s[this.i] === '\\') {
          const n = this.s[this.i + 1]; this.i += 2;
          if (n === 'n') r += '\n'; else if (n === 't') r += '\t'; else if (n === 'r') r += '\r'; else if (n === 'u') { r += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; } else if (n === 'x') { r += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16)); this.i += 2; } else r += n;
        } else r += this.s[this.i++];
      }
      if (this.i >= this.s.length) throw new Error('unterminated string');
      this.i++; out += r;
      const save = this.i; this.ws();
      if (this.s[this.i] === '+') { this.i++; this.ws(); if (/['"`]/.test(this.s[this.i])) continue; }
      this.i = save; return out;
    }
  }
  key() {
    this.ws(); const c = this.s[this.i];
    if (c === "'" || c === '"' || c === '`') return this.string();
    const m = /^[A-Za-z_$][\w$-]*|^\d+/.exec(this.s.slice(this.i, this.i + 80)); if (!m) throw new Error('bad key at ' + this.i);
    this.i += m[0].length; return m[0];
  }
  object(depth) {
    const o = {}; this.i++;
    for (;;) {
      this.ws(); if (this.s[this.i] === '}') { this.i++; return o; }
      if (this.s.startsWith('...', this.i)) { this.skipMore(); continue; }
      const k = this.key(); this.ws(); if (this.s[this.i] !== ':') throw new Error('expected : at ' + this.i); this.i++;
      o[k] = this.value(depth + 1); this.ws();
      if (this.s[this.i] === ',') this.i++; else if (this.s[this.i] !== '}') throw new Error('expected , or } at ' + this.i);
    }
  }
  array(depth) {
    const a = []; this.i++;
    for (;;) {
      this.ws(); if (this.s[this.i] === ']') { this.i++; return a; }
      if (this.s.startsWith('...', this.i)) { this.skipMore(); continue; }
      a.push(this.value(depth + 1)); this.ws();
      if (this.s[this.i] === ',') this.i++; else if (this.s[this.i] !== ']') throw new Error('expected , or ] at ' + this.i);
    }
  }
  skipMore() { while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i])) this.i++; if (this.s[this.i] === ',') this.i++; }
}
export function parseLiteralAt(text, from = 0) {
  const m = /[{[]/.exec(text.slice(from)); if (!m) return null;
  const p = new Lit(text, from + m.index);
  try { return p.value(); } catch (e) { return null; }
}

/** Splits the log into [TAG] blocks. A block runs until the next line that starts with a [TAG]. */
export function splitBlocks(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n'), blocks = [];
  let cur = null;
  lines.forEach((ln, idx) => {
    const m = MARKER.exec(ln);
    if (m) { cur = { tag: m[1].trim(), head: m[2], body: [], line: idx + 1 }; blocks.push(cur); cur.body.push(m[2]); }
    else if (cur) cur.body.push(ln);
  });
  return blocks.map(b => { const raw = b.body.join('\n'); const label = (raw.split('\n')[0].match(/^(.*?):(?:\s|$)/) || [null, b.head])[1].trim(); return { tag: b.tag, label, line: b.line, raw, value: parseLiteralAt(raw, 0) }; });
}

const NOTE_TAGS = new Set(['LENS RESOLVER', 'DATAFORSEO GATE', 'DATAFORSEO + LENSFUN', 'NON-SELLABLE LENS', 'PHANTOM VALIDATION', 'LENS RESOLVER']);
const compact = (v, n) => { let s; try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); } return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/** @returns {{galleries, resolved, notes, general, listingFacts, stats}} */
export function parseScannerLog(text) {
  const blocks = splitBlocks(text), galleries = new Map(), resolved = {}, notes = {}, general = [];
  let listingFacts = null, serpAnswers = 0, reconciliation = null;
  for (const b of blocks) {
    const g = /^STEP 2$/.test(b.tag) && /^Raw gallery (\d+)(?: retry)? response/.exec(b.label);
    if (g) { const v = b.value && !Array.isArray(b.value) ? b.value : null; if (v && Array.isArray(v.images)) galleries.set(Number(g[1]), { galleryIndex: Number(g[1]), products: v.products || [], images: v.images }); continue; }
    if (b.tag === 'STEP 1' && /Parsed listing facts/.test(b.label)) { listingFacts = b.value; continue; }
    // One-line JSON from the reconcile call: what the scanner read for each product (stands in for the console.dir "Final primary products" object, which the log does not capture).
    if (b.tag === 'STEP 5' && /Raw reconciliation response/.test(b.label) && b.value && Array.isArray(b.value.primaryProducts)) {
      reconciliation = {};
      for (const p of b.value.primaryProducts) if (p && typeof p.productId === 'string') reconciliation[p.productId] = { galleryIndex: p.galleryIndex ?? null, productType: p.productType || null, lensIdentity: p.lensIdentity || null, extracted_evidence: Array.isArray(p.extracted_evidence) ? p.extracted_evidence : [] };
      continue;
    }
    if (b.tag === 'LENS RESOLVER' && /^Complete/.test(b.label) && b.value?.productId) { resolved[b.value.productId] = { mode: b.value.mode || null, identity: b.value.identity || null }; }
    if (b.tag === 'SERPAPI AI MODE' && /Raw identification answer/.test(b.label) && b.value) { if (serpAnswers++ < 6) general.push(`SerpApi AI Mode answer: ${compact(b.value.answer, 260)}`); continue; }
    if (b.tag === 'DATAFORSEO CLEANER' && b.value) { if (general.length < 12) general.push(`Visual-search evidence: ${compact(b.value, 300)}`); continue; }
    if (NOTE_TAGS.has(b.tag)) {
      const pid = b.value && !Array.isArray(b.value) && typeof b.value.productId === 'string' ? b.value.productId : null;
      const line = `${b.tag} — ${b.label}${b.value ? ' ' + compact(b.value, 420) : ''}`;
      if (pid) (notes[pid] = notes[pid] || []).push(line); else if (general.length < 12) general.push(line);
    }
  }
  const galleryList = [...galleries.values()].sort((a, b) => a.galleryIndex - b.galleryIndex);
  return { galleries: galleryList, resolved, notes, general, listingFacts, reconciliation, stats: { blocks: blocks.length, galleries: galleryList.length, lensesResolved: Object.keys(resolved).length, reconciled: reconciliation ? Object.keys(reconciliation).length : 0 } };
}

/** Short, bounded trail for one lens (the scanner's reasoning, NOT independent evidence). */
export function notesForLens(parsed, productId, maxChars = 1800, skipEvidence = false) {
  if (!parsed) return [];
  const out = [];
  const rc = parsed.reconciliation?.[productId]; if (!skipEvidence && rc?.extracted_evidence?.length) out.push(`OCR strings the scanner relied on: ${compact(rc.extracted_evidence.slice(0, 6), 400)}`);
  const r = parsed.resolved?.[productId]; if (r) out.push(`Final scanner identity (resolver mode ${r.mode || 'n/a'}): ${compact(r.identity, 500)}`);
  for (const n of parsed.notes?.[productId] || []) out.push(n);
  let total = 0; return out.filter((s) => (total += s.length) <= maxChars);
}
