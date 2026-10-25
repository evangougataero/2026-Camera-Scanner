import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { openQueue } from '../src/queue.js';
import { createSheet, colIndex } from '../src/sheet.js';
import { createAi, VerifyError } from '../src/ai.js';
import { createWorker } from '../src/worker.js';
import { createLensVerification } from '../src/index.js';

export const clock = (t0 = Date.UTC(2026, 9, 25, 12, 0, 0)) => { const c = { t: t0, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; };
export const makeDb = () => new DatabaseSync(':memory:');

// ------------------------------------------------------------------------------------------------ fake Google Sheets
export class FakeSheets {
  constructor() { this.tabs = new Map(); this.nextGid = 100; this.writes = []; this.failNext = null; this.addTab('Main'); }
  addTab(title) { const t = { gid: this.nextGid++, title, grid: new Map(), merges: [], formats: [] }; this.tabs.set(title, t); return t; }
  tab(title) { return this.tabs.get(title); }
  set(title, r, c, v) { this.tab(title).grid.set(`${r},${c}`, v); }                      // 0-based
  get(title, r, c) { return this.tab(title).grid.get(`${r},${c}`) ?? ''; }
  rows(title) { const t = this.tab(title); let mr = -1, out = []; for (const k of t.grid.keys()) mr = Math.max(mr, +k.split(',')[0]); for (let r = 0; r <= mr; r++) { const row = []; let mc = -1; for (const [k, v] of t.grid) { const [rr, cc] = k.split(',').map(Number); if (rr === r && v !== '') mc = Math.max(mc, cc); } for (let c = 0; c <= mc; c++) row.push(t.grid.get(`${r},${c}`) ?? ''); out.push(row); } return out; }
  parse(range) { const m = String(range).match(/^(?:'((?:[^']|'')+)'|([^!]+))!([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/); if (!m) throw new Error('bad range ' + range); return { tab: (m[1] || m[2]).replace(/''/g, "'"), c: colIndex(m[3]), r: m[4] ? +m[4] - 1 : 0 }; }
  fail() { if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; } }
  get client() {
    const self = this;
    return { spreadsheets: {
      values: {
        async get({ range }) { self.fail(); const p = self.parse(range); return { data: { values: self.rows(p.tab) } }; },
        async batchUpdate({ requestBody }) { self.fail(); for (const d of requestBody.data) { const p = self.parse(d.range); d.values.forEach((row, i) => row.forEach((v, j) => self.set(p.tab, p.r + i, p.c + j, v))); self.writes.push(...requestBody.data.map(d => d.range)); } return { data: {} }; },
        async update({ range, requestBody }) { self.fail(); const p = self.parse(range); requestBody.values.forEach((row, i) => row.forEach((v, j) => self.set(p.tab, p.r + i, p.c + j, v))); self.writes.push(range); return { data: {} }; },
        async append({ range, requestBody }) { self.fail(); const p = self.parse(range); const t = self.tab(p.tab); let last = -1; for (const k of t.grid.keys()) last = Math.max(last, +k.split(',')[0]); const start = last + 1; requestBody.values.forEach((row, i) => row.forEach((v, j) => self.set(p.tab, start + i, j, v))); self.writes.push(range); return { data: { updates: { updatedRange: `'${p.tab}'!A${start + 1}:P${start + requestBody.values.length}` } } }; }
      },
      async get() { self.fail(); return { data: { sheets: [...self.tabs.values()].map(t => ({ properties: { sheetId: t.gid, title: t.title }, merges: t.merges })) } }; },
      async batchUpdate({ requestBody }) {
        self.fail(); const replies = [];
        for (const rq of requestBody.requests) {
          if (rq.addSheet) { const t = self.addTab(rq.addSheet.properties.title); replies.push({ addSheet: { properties: { sheetId: t.gid, title: t.title } } }); }
          else if (rq.mergeCells) { const t = [...self.tabs.values()].find(x => x.gid === rq.mergeCells.range.sheetId); const r = rq.mergeCells.range; if (!t.merges.some(m => JSON.stringify(m) === JSON.stringify(r))) t.merges.push({ startRowIndex: r.startRowIndex, endRowIndex: r.endRowIndex, startColumnIndex: r.startColumnIndex, endColumnIndex: r.endColumnIndex }); replies.push({}); }
          else if (rq.repeatCell) { const t = [...self.tabs.values()].find(x => x.gid === rq.repeatCell.range.sheetId); t.formats.push(rq.repeatCell); replies.push({}); }
          else replies.push({});
        }
        return { data: { replies } };
      }
    } };
  }
}

// ---------------------------------------------------------------------------------------------- scanner-shaped Main tab
export const MAIN_HEADERS = ['Item', 'Facebook Link', 'Decision', 'Ask Price', 'Est. Resale', 'Std Dev', 'Manual Eval', 'Threshold Buy', 'Analysis Log', 'Ongoing Conversation', 'Purchased?', 'Notes', 'Checklist', 'Hit Date', 'Interested', 'P', 'Relisted', 'Purchase Price'];
export function seedMain(fs, listings, { merge = true } = {}) {
  MAIN_HEADERS.forEach((h, c) => fs.set('Main', 0, c, h));
  let r = 1;
  for (const L of listings) {
    const start = r;
    L.items.forEach((name, i) => { fs.set('Main', r, 0, name); if (i === 0) { fs.set('Main', r, 1, `https://www.facebook.com/marketplace/item/${L.id}/`); fs.set('Main', r, 2, 'Buy Now'); fs.set('Main', r, 8, `=HYPERLINK("https://x.supabase.co/storage/v1/object/public/marketplace-hit-logs/${L.id}/${L.runId || L.id + '_run1'}.log","View Log")`); fs.set('Main', r, 10, ''); } r++; });
    L.rows = [start, r];
    if (merge && L.items.length > 1) for (const c of [1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) fs.tab('Main').merges.push({ startRowIndex: start, endRowIndex: r, startColumnIndex: c, endColumnIndex: c + 1 });
  }
}
export const setY = (fs, row1, v = 'Y') => fs.set('Main', row1 - 1, 14, v);

// --------------------------------------------------------------------------------------------------------- evidence
export function makeEvidence({ id = '1000000000000001', runId, lenses, nonLens = [], title = 'Lens lot', description = 'Seller lens lot', images = 4 } = {}) {
  runId = runId || `${id}_run1`;
  const imageUrls = Array.from({ length: images }, (_, i) => `https://cdn.example/img${i + 1}.jpg`);
  const galleryProducts = [], imgs = Array.from({ length: images }, (_, i) => ({ imageIndex: i + 1, visibleProducts: [] }));
  const primaryProducts = [], items = [], bestTargets = [];
  lenses.forEach((L, k) => {
    const pid = L.productId || `lens_${k + 1}`;
    galleryProducts.push({ productId: pid, productType: 'camera lens' });
    Object.entries(L.scores).forEach(([idx, sc]) => imgs[idx - 1].visibleProducts.push({ productId: pid, productType: 'camera lens', modelReadabilityScore: sc }));
    primaryProducts.push({ productId: pid, productType: 'camera lens', lensIdentity: { brand: L.brand || 'Nikon', focalLength: L.focal, maxAperture: L.aperture || null, featureTokens: L.features || [] }, extracted_evidence: L.evidence || [] });
    items.push({ index: items.length, name: L.name, productType: 'camera lens', brand: L.brand || 'Nikon', model: '', isPrimarySellableItem: true, estimatedResale: L.resale ?? null, productId: L.itemProductId || null });
    const best = Object.entries(L.scores).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    if (best) bestTargets.push({ productId: pid, productType: 'camera lens', bestImageIndex: +best[0], modelReadabilityScore: best[1], imageUrl: imageUrls[best[0] - 1] });
  });
  nonLens.forEach((n, k) => { items.push({ index: items.length, name: n, productType: 'camera body', brand: '', model: '', isPrimarySellableItem: true, estimatedResale: 300 }); primaryProducts.push({ productId: `camera_${k + 1}`, productType: 'camera body', lensIdentity: null }); });
  return { schemaVersion: 1, capturedAt: '2026-10-25T10:00:00.000Z', runId, listingId: id, facebookUrl: `https://www.facebook.com/marketplace/item/${id}/`, title, description, imageUrls,
    galleryResults: [{ galleryIndex: 1, products: galleryProducts, images: imgs }], bestTargets, productOcr: [], primaryProducts, explicitFacts: null, items };
}
export const memStorage = (evidence = {}, reports = [], extras = {}) => ({
  async loadScannerLog({ listingId }) { if (extras.logError) throw new Error('log fetch down'); return extras.logs?.[listingId] ?? null; },
  async loadImage(rel) { return extras.images?.[rel] ?? null; },
  async saveImage(rel, buf) { (extras.saved = extras.saved || {})[rel] = buf.length; return rel; }, extras,
  async load(listingId) { const ev = evidence[listingId]; return ev ? { evidence: ev, runIdMismatch: false } : null; },
  async save(ev) { evidence[ev.listingId] = ev; return 'mem'; },
  async uploadReport(job, report) { reports.push({ job, report }); return `https://reports.example/${job.id}.json`; }, evidence, reports
});

// ------------------------------------------------------------------------------------------------------- fake OpenAI
export const P1 = (over = {}) => ({ imageUsable: true, imageNote: null, lenses: [{ location: 'centre', brand: 'Nikon', modelName: 'AF-S 70-300mm', mount: 'F', focalLength: '70-300mm', maxAperture: 'f/4.5-5.6', features: ['VR'], generationOrVersion: null, fullIdentification: 'Nikon AF-S 70-300mm f/4.5-5.6G ED VR', readableMarkings: ['AF-S', '70-300mm', 'VR'], evidence: [{ claim: 'VR present', source: 'visual', detail: 'VR switch visible' }], alternatives: [], unresolved: [], ...over }] });
export const P2 = (over = {}) => ({ matchedPass1Lens: 0, agreement: 'agrees', outcome: 'PASS', evidenceLimited: false, independentIdentification: 'Nikon AF-S 70-300mm f/4.5-5.6G ED VR', alternatives: [], contradictions: [], findingSummary: 'Listing and visible markings are consistent. No meaningful competing variant.', valueImpact: { level: 'none', description: null }, recommendedManualCheck: null, ...over });
export const httpErr = (status, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

/** script(ctx) -> object | throws.  ctx = {pass:1|2, prompt, hasImage, call, n}. Returns an `openai.responses.create`-shaped result. */
export function fakeOpenAi(script) {
  const calls = [];
  const fn = async (step, request) => {
    const content = request.input[0].content, prompt = content.find(c => c.type === 'input_text').text, hasImage = content.some(c => c.type === 'input_image');
    const pass = request.text.format.name.includes('pass1') ? 1 : 2;
    const ctx = { pass, prompt, hasImage, step, n: calls.length, request };
    calls.push(ctx);
    const out = await script(ctx);
    return { output_text: typeof out === 'string' ? out : JSON.stringify(out) };
  };
  fn.calls = calls; return fn;
}

// ------------------------------------------------------------------------------------------------------------- rig
export function makeRig({ lenses, nonLens, script, listings, evidenceOverride, cfgOver = {}, prepare, db = makeDb(), fs = new FakeSheets(), seed = true, logs, images, logError } = {}) {
  const c = clock();
  const cfg = { ...loadConfig({ GOOGLE_SHEETS_SPREADSHEET_ID: 'ss1' }), debounceMs: 20000, ...cfgOver };
  const listing = listings || [{ id: '1000000000000001', items: (lenses || []).map(l => l.name).concat(nonLens || []) }];
  if (seed) seedMain(fs, listing);
  const ev = evidenceOverride || (lenses ? { [listing[0].id]: makeEvidence({ id: listing[0].id, lenses, nonLens }) } : {});
  const storage = memStorage(ev, [], { logs, images, logError });
  const openai = fakeOpenAi(script || (({ pass }) => (pass === 1 ? P1() : P2())));
  const queue = openQueue(db, { maxAttempts: cfg.maxAttempts, backoffMs: cfg.backoffMs, now: c.now });
  const sheet = createSheet({ sheets: fs.client, cfg, log: () => {} });
  const ai = createAi({ cfg, callOpenAI: openai });
  const prep = prepare || (async (url) => { if (/missing/.test(url)) throw new VerifyError('IMAGE_UNAVAILABLE', 'HTTP 404 (link expired or removed).'); return { dataUrl: 'data:image/jpeg;base64,AAAA', bytes: 4, sha256: 'abc', sourceUrl: url }; });
  const worker = createWorker({ queue, cfg, ai, evidenceStore: storage, sheet, uploadReport: storage.uploadReport, prepare: prep, log: () => {}, now: c.now });
  const lv = createLensVerification({ cfgOverrides: cfg, db, queue, sheet, ai, storage, prepareImage: prep, now: c.now, log: () => {}, env: {} });
  lv.parts();   // build worker
  const main = () => fs.rows('Main');
  const mainStatus = (listingRow1 = 2) => ({ job: fs.get('Main', listingRow1 - 1, 18), result: fs.get('Main', listingRow1 - 1, 19), summary: fs.get('Main', listingRow1 - 1, 20), report: fs.get('Main', listingRow1 - 1, 21) });
  /** poll twice (debounce) then run worker until idle */
  async function run({ polls = 2 } = {}) {
    for (let i = 0; i < polls; i++) { await lv.poll(); c.advance(cfg.debounceMs + 1000); }
    await lv.poll();
    for (let i = 0; i < 10; i++) { if (!(await lv.parts().worker.tick())) break; }
  }
  return { c, cfg, fs, db, queue, sheet, worker: lv.parts().worker, lv, openai, storage, listing, run, main, mainStatus };
}
