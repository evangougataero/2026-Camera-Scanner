// Pure helpers: ids, evidence snapshot, per-lens image selection, mapping the scanner's final lens items to products.

export function sanitizeRunId(v) {                         // identical rule to the scanner's sanitizeAnalysisRunId
  return String(v || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 240);
}
export const listingIdFromUrl = (u) => { const m = String(u || '').match(/marketplace\/item\/(\d{6,25})/); return m ? m[1] : ''; };
export const listingIdFromRunId = (r) => sanitizeRunId(r).split('_')[0] || '';
export function runIdFromLogCell(cell) {                   // =HYPERLINK("https://.../<listingId>/<runId>.log","View Log")  or a bare url
  const m = String(cell || '').match(/([A-Za-z0-9_-]+)\.log(?=["'\s)?]|$)/);
  return m ? m[1] : '';
}
export const isLensType = (t) => /\blens(es)?\b/i.test(String(t || ''));
const str = (v) => (v == null ? '' : String(v)).trim();

// ---------------------------------------------------------------------------------------------------------------
// Capture store: remembers what the scanner sent/received during ONE analysis run, until the hit is saved.
// ---------------------------------------------------------------------------------------------------------------
export function createCaptureStore(ttlMs = 6 * 3600 * 1000, now = () => Date.now()) {
  const runs = new Map();
  const sweep = () => { const t = now(); for (const [k, v] of runs) if (t - v.touched > ttlMs) runs.delete(k); };
  const slot = (runId) => { sweep(); if (!runs.has(runId)) runs.set(runId, { touched: now() }); const s = runs.get(runId); s.touched = now(); return s; };
  return {
    recordGallery(runId, body) { if (!runId) return; const s = slot(runId); if (Array.isArray(body?.imageUrls) && body.imageUrls.length) s.imageUrls = body.imageUrls.map(str).filter(Boolean); },
    recordReconcile(runId, body, response) {
      if (!runId) return; const s = slot(runId);
      // reconcile can run more than once per scan; the last complete call wins, field by field.
      if (str(body?.listingTitle)) s.title = str(body.listingTitle);
      if (str(body?.listingDescription)) s.description = str(body.listingDescription);
      if (Array.isArray(body?.galleryResults) && body.galleryResults.length) s.galleryResults = body.galleryResults.map(g => { const { debugCollageDataUrl, ...rest } = g || {}; return rest; });
      if (Array.isArray(body?.bestGoogleTargets) && body.bestGoogleTargets.length) s.bestTargets = body.bestGoogleTargets;
      if (Array.isArray(body?.productOcrResults) && body.productOcrResults.length) s.productOcr = body.productOcrResults;
      if (body?.explicitFacts) s.explicitFacts = body.explicitFacts;
      if (Array.isArray(response?.primaryProducts) && response.primaryProducts.length) s.primaryProducts = response.primaryProducts;
    },
    get(runId) { sweep(); return runs.get(runId) || null; },
    size() { return runs.size; }
  };
}

function itemResale(it) {
  for (const k of ['expectedSalePrice', 'estimatedResaleValue', 'medianSoldPrice', 'totalExpectedSalePrice']) { const n = Number(it?.[k]); if (Number.isFinite(n) && n > 0) return n; }
  return null;
}
function itemName(it) {
  return str(it?.ebaySearchQuery || it?.searchQuery || it?.itemName) || `${str(it?.brand)} ${str(it?.model)} ${str(it?.productType)}`.replace(/\s+/g, ' ').trim();
}

/** Builds the saved verification snapshot (JSON) when a hit is saved. Never throws on missing optional pieces. */
export function buildEvidence({ captured, deal, runId, now = new Date() }) {
  const c = captured || {};
  const d = deal || {};
  const items = (Array.isArray(d.items) ? d.items : []).map((it, i) => ({
    index: i, name: itemName(it), productId: str(it?.productId) || null, productType: str(it?.productType),
    brand: str(it?.brand), model: str(it?.model), isPrimarySellableItem: it?.isPrimarySellableItem !== false, estimatedResale: itemResale(it)
  }));
  return {
    schemaVersion: 1, capturedAt: now.toISOString(), runId: sanitizeRunId(runId || d.analysisRunId),
    listingId: listingIdFromUrl(d.facebookUrl) || listingIdFromRunId(runId || d.analysisRunId), facebookUrl: str(d.facebookUrl),
    title: str(c.title) || str(d.title), description: str(c.description), imageUrls: c.imageUrls || [],
    galleryResults: c.galleryResults || [], bestTargets: c.bestTargets || [], productOcr: c.productOcr || [],
    primaryProducts: c.primaryProducts || [], explicitFacts: c.explicitFacts || null, items,
    scannerRecommendation: str(d.recommendation), scannerEstimatedResale: d.estimatedResaleValue ?? null,
    completeness: { hasTitle: !!(str(c.title) || str(d.title)), hasDescription: !!str(c.description), hasImages: !!(c.imageUrls && c.imageUrls.length) || !!(c.bestTargets && c.bestTargets.length), hasGallery: !!(c.galleryResults && c.galleryResults.length), hasProducts: !!(c.primaryProducts && c.primaryProducts.length) }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lens image selection
// ---------------------------------------------------------------------------------------------------------------
const MODEL_TOKEN = /\b(\d{2,3}(?:-\d{2,3})?\s?mm|f\/?\s?\d(?:\.\d)?|1:\s?\d(?:\.\d)?|[A-Z]{1,4}\s?(?:II|III|IV|V)|VR|IS|OSS|USM|STM|AF-?S|EF-?S?|RF|ED|IF|DX|FX|G2|ASPH)\b/gi;
const markingRichness = (text) => (String(text || '').match(MODEL_TOKEN) || []).length;

/**
 * For one lens productId pick the single image the ORIGINAL scanner rated best for reading that product's model markings
 * (modelReadabilityScore). Ties: strongest readable markings (OCR token count, when OCR exists for the tied images), then the
 * scanner's own pick, then the earliest image. Never substitutes an unrelated photo.
 */
export function selectLensImage(ev, productId) {
  const imageUrls = ev.imageUrls || [];
  const cands = [];
  for (const g of ev.galleryResults || []) for (const im of g.images || []) for (const vp of im.visibleProducts || []) {
    if (str(vp.productId) !== productId) continue;
    const idx = Number(im.imageIndex), score = Number(vp.modelReadabilityScore);
    if (!Number.isFinite(idx) || !Number.isFinite(score)) continue;
    cands.push({ imageIndex: idx, score, url: imageUrls[idx - 1] || '' });
  }
  const bt = (ev.bestTargets || []).find(t => str(t.productId) === productId);
  if (bt && !cands.some(c => c.imageIndex === Number(bt.bestImageIndex))) cands.push({ imageIndex: Number(bt.bestImageIndex), score: Number(bt.modelReadabilityScore), url: str(bt.imageUrl) });
  for (const c of cands) if (!c.url && bt && Number(bt.bestImageIndex) === c.imageIndex) c.url = str(bt.imageUrl);
  const usable = cands.filter(c => c.url && Number.isFinite(c.score));
  if (!usable.length) return { ok: false, reason: cands.length ? 'NO_IMAGE_URL' : 'NO_IMAGE_RATED', candidates: cands };
  const top = Math.max(...usable.map(c => c.score));
  let tied = usable.filter(c => c.score === top).sort((a, b) => a.imageIndex - b.imageIndex);
  let method = tied.length === 1 ? 'highest_score' : 'tie';
  if (tied.length > 1) {
    const ocr = new Map((ev.productOcr || []).filter(o => str(o.productId) === productId).map(o => [Number(o.imageIndex), markingRichness(o.ocrText)]));
    const scored = tied.filter(c => ocr.has(c.imageIndex));
    if (scored.length > 1) { const best = Math.max(...scored.map(c => ocr.get(c.imageIndex))); const w = scored.filter(c => ocr.get(c.imageIndex) === best); if (w.length < tied.length) { tied = w; method = 'tie_broken_by_ocr_markings'; } }
    if (tied.length > 1 && bt) { const pick = tied.find(c => c.imageIndex === Number(bt.bestImageIndex)); if (pick) { tied = [pick]; method = 'tie_scanner_pick'; } }
  }
  const chosen = tied[0];
  const ocrRow = (ev.productOcr || []).find(o => str(o.productId) === productId && Number(o.imageIndex) === chosen.imageIndex);
  return { ok: true, imageIndex: chosen.imageIndex, url: chosen.url, score: chosen.score, method, otherCandidates: usable.filter(c => c !== chosen).map(c => ({ imageIndex: c.imageIndex, score: c.score })), ocrText: ocrRow ? str(ocrRow.ocrText).slice(0, 1500) : '' };
}

// ---------------------------------------------------------------------------------------------------------------
// Lens mapping: scanner's FINAL lens items  <->  lens productIds (so we know which image belongs to which conclusion)
// ---------------------------------------------------------------------------------------------------------------
const focalOf = (s) => { const m = String(s || '').match(/(\d{2,3})(?:\s*-\s*(\d{2,3}))?\s*mm/i); return m ? [m[1], m[2] || m[1]].join('-') : ''; };
const lensProducts = (ev) => {
  const out = [], seen = new Set();
  for (const p of ev.primaryProducts || []) if (isLensType(p.productType) || p.lensIdentity) { const id = str(p.productId); if (id && !seen.has(id)) { seen.add(id); out.push(p); } }
  if (!out.length) for (const t of ev.bestTargets || []) if (isLensType(t.productType)) { const id = str(t.productId); if (id && !seen.has(id)) { seen.add(id); out.push({ productId: id, productType: t.productType, lensIdentity: null }); } }
  return out;
};

export function mapLensItems(ev) {
  const items = (ev.items || []).filter(i => i.isPrimarySellableItem && isLensType(i.productType || i.name));
  const prods = lensProducts(ev);
  const used = new Set(), mapped = [], unmapped = [];
  const take = (item, prod, method) => { used.add(str(prod.productId)); mapped.push({ item, productId: str(prod.productId), product: prod, method }); };
  const rest = [];
  for (const it of items) {                                                    // 1. explicit productId
    const p = it.productId && prods.find(x => str(x.productId) === it.productId && !used.has(str(x.productId)));
    if (p) take(it, p, 'product_id'); else rest.push(it);
  }
  const rest2 = [];
  for (const it of rest) {                                                     // 2. unique focal-length (+brand) match
    const f = focalOf(it.name || `${it.brand} ${it.model}`), brand = str(it.brand).toLowerCase();
    const matches = prods.filter(p => !used.has(str(p.productId)) && f && focalOf(p.lensIdentity?.focalLength) === f && (!brand || !p.lensIdentity?.brand || str(p.lensIdentity.brand).toLowerCase().includes(brand) || brand.includes(str(p.lensIdentity.brand).toLowerCase())));
    if (matches.length === 1) take(it, matches[0], 'focal_length_brand'); else rest2.push(it);
  }
  const freeProds = prods.filter(p => !used.has(str(p.productId)));
  if (rest2.length && rest2.length === freeProds.length) rest2.forEach((it, i) => take(it, freeProds[i], 'order'));   // 3. same count: by order
  else rest2.forEach(it => unmapped.push({ item: it, reason: freeProds.length ? 'AMBIGUOUS_LENS_MAPPING' : 'NO_LENS_PRODUCT_RECORD' }));
  mapped.sort((a, b) => a.item.index - b.item.index);
  return { mapped, unmapped, nonLensItems: (ev.items || []).filter(i => !items.includes(i)).map(i => i.name) };
}
