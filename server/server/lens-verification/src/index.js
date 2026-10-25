// Wiring for the scanner server. Usage (see scripts/apply-to-server.mjs for the exact lines):
//   const lensVerification = createLensVerification({ app, express?, ...lazy getters });   // early: registers the capture middleware + routes
//   lensVerification.start();                                                              // late: starts polling + worker
import { loadConfig } from './config.js';
import { buildEvidence, createCaptureStore, listingIdFromUrl, sanitizeRunId, mapLensItems, selectLensImage } from './evidence.js';
import { openQueue } from './queue.js';
import { createSheet } from './sheet.js';
import { createStorage } from './storage.js';
import { createAi, prepareImage } from './ai.js';
import { createWorker } from './worker.js';

function dryRunAi() {            // no network, no cost: exercises queue + sheet + report only
  const p1 = { imageUsable: true, imageNote: 'DRY RUN', lenses: [{ location: 'dry run', brand: null, modelName: null, mount: null, focalLength: null, maxAperture: null, features: [], generationOrVersion: null, fullIdentification: 'DRY RUN (no AI called)', readableMarkings: [], evidence: [], alternatives: [], unresolved: [] }] };
  return { pass1: async () => structuredClone(p1), pass2: async () => ({ matchedPass1Lens: 0, agreement: 'cannot_compare', outcome: 'PASS', rawOutcome: 'PASS', guardrail: { applied: false, reason: null }, evidenceLimited: true, independentIdentification: 'DRY RUN', alternatives: [], contradictions: [], findingSummary: 'DRY RUN — no AI was called; this is a placeholder result.', valueImpact: { level: 'none', description: null }, recommendedManualCheck: null }) };
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function createLensVerification(deps) {
  const cfg = { ...loadConfig(deps.env), ...(deps.cfgOverrides || {}) };
  const log = deps.log || ((...a) => console.log(...a));
  const now = deps.now || (() => Date.now());
  if (!cfg.enabled) { log('[LENS VERIFY] disabled (LENS_VERIFY_ENABLED=false).'); return { start() {}, stop() {}, enabled: false }; }

  const captured = createCaptureStore(cfg.evidenceTtlMs, now);
  const storage = deps.storage || createStorage({ supabase: deps.getSupabase?.(), bucket: cfg.storageBucket, prefix: cfg.storagePrefix, log });
  const livePrepare = deps.prepareImage || (cfg.dryRun ? (async (url) => ({ dataUrl: 'data:image/jpeg;base64,AAAA', bytes: 0, sha256: 'dry-run', sourceUrl: url }))
    : (url) => prepareImage(url, { sharp: deps.sharp || null, fetchImpl: deps.fetchImpl, timeoutMs: cfg.imageTimeoutMs, maxBytes: cfg.imageMaxBytes, maxEdge: cfg.imageMaxEdge }));
  // Prefer the copy archived at scan time (Facebook CDN links expire); fall back to the live link.
  const prepareFor = async (url, evidence) => {
    const rel = evidence?.archivedImages?.[url];
    if (rel && storage.loadImage) { try { const a = await storage.loadImage(rel); if (a) return { ...a, sourceUrl: url, archived: true }; } catch (e) { log('[LENS VERIFY] archived photo unreadable, trying the original link:', e.message); } }
    return livePrepare(url);
  };
  /** At scan time keep ONE copy of each lens's chosen photo. Best effort; never blocks or breaks the scanner. */
  async function archiveLensImages(ev) {
    const archived = {}, seenUrl = new Set();
    for (const m of mapLensItems(ev).mapped) {
      const sel = selectLensImage(ev, m.productId); if (!sel.ok || seenUrl.has(sel.url)) continue; seenUrl.add(sel.url);
      try {
        const p = await livePrepare(sel.url); const buf = Buffer.from(String(p.dataUrl).split(',')[1] || '', 'base64'); if (!buf.length) continue;
        archived[sel.url] = await storage.saveImage(`${cfg.storagePrefix}/images/${ev.listingId}/${ev.runId}/${sel.imageIndex}.jpg`, buf, 'image/jpeg');
      } catch (e) { log(`[LENS VERIFY] photo ${sel.imageIndex} not archived: ${e.message}`); }
    }
    if (Object.keys(archived).length) { ev.archivedImages = archived; await storage.save(ev); log(`[LENS VERIFY] archived ${Object.keys(archived).length} lens photo(s) for listing ${ev.listingId}.`); }
  }
  let started = null;                                                                     // lazily built pieces (the server defines some of its objects later in the file)
  const parts = () => {
    if (started) return started;
    const db = deps.db || deps.openDb(cfg.dbPath);
    const queue = deps.queue || openQueue(db, { maxAttempts: cfg.maxAttempts, backoffMs: cfg.backoffMs, now });
    const sheet = deps.sheet || createSheet({ sheets: deps.getSheets(), cfg, log });
    const ai = deps.ai || (cfg.dryRun ? dryRunAi() : createAi({ cfg, callOpenAI: (step, request) => deps.createLoggedOpenAiResponse({ step, request }) }));
    const prepare = prepareFor;
    const worker = createWorker({ queue, cfg, ai, evidenceStore: storage, sheet, uploadReport: (j, r) => storage.uploadReport(j, r), prepare, log, now });
    started = { queue, sheet, worker, ai };
    return started;
  };

  // ---- 1. capture middleware: observes (never alters) the scanner's own requests ------------------------------------
  function capture(req, res, next) {
    try {
      if (req.method !== 'POST') return next();
      const p = req.path;
      if (p !== '/analyze-listing-gallery' && p !== '/reconcile-primary-products' && p !== '/save-deal-to-sheet') return next();
      const runId = sanitizeRunId(req.get('X-Analysis-Run-Id') || req.body?.deal?.analysisRunId);
      if (p === '/analyze-listing-gallery') { captured.recordGallery(runId, req.body); return next(); }
      const orig = res.json.bind(res);
      res.json = (body) => {
        const out = orig(body);                                                           // the scanner's response goes out first, unchanged
        try {
          if (p === '/reconcile-primary-products') captured.recordReconcile(runId, req.body, body);
          else if (body?.ok === true) {
            const deal = req.body?.deal || {};
            const ev = buildEvidence({ captured: captured.get(runId), deal, runId, now: new Date(now()) });
            if (!ev.listingId || !ev.runId) log('[LENS VERIFY] snapshot skipped: no listing id/run id.');
            else storage.save(ev).then(() => { log(`[LENS VERIFY] snapshot saved for listing ${ev.listingId} (${ev.items.length} item(s), images:${ev.imageUrls.length}).`); return cfg.archiveImages && storage.saveImage ? archiveLensImages(ev) : null; }).catch(e => log('[LENS VERIFY] snapshot save/archive failed:', e.message));
          }
        } catch (e) { log('[LENS VERIFY] capture error (ignored):', e.message); }
        return out;
      };
    } catch (e) { log('[LENS VERIFY] capture middleware error (ignored):', e.message); }
    next();
  }

  // ---- 2. poller: column O = Y  ->  job ------------------------------------------------------------------------------
  const seen = new Map();
  async function poll() {
    let queue, sheet, worker; try { ({ queue, sheet, worker } = parts()); } catch (e) { log('[LENS VERIFY] not ready:', e.message); return { error: e.message }; }
    let cands; try { cands = await sheet.scan(); } catch (e) { log('[LENS VERIFY] poll failed:', e.message); return { error: e.message }; }
    const t = now(), live = new Set(), created = [];
    for (const c of cands) {
      live.add(c.listingId);
      if (queue.activeForListing(c.listingId)) continue;                                  // duplicate edits / several Y rows -> one job
      const latest = queue.latestForListing(c.listingId);
      if (latest && !(c.statusCell === '' && latest.sheet_synced === 1 && t - (latest.finished_at || 0) > 15000)) continue;   // finished: only an explicit clear of the status cell re-runs
      const prev = seen.get(c.listingId);
      if (!prev || prev.sig !== c.signature) { seen.set(c.listingId, { sig: c.signature, at: t }); continue; }
      if (t - prev.at < cfg.debounceMs) continue;                                          // wait until the row block is stable (scanner may still be writing)
      const r = queue.create({ listingId: c.listingId, facebookUrl: c.facebookUrl, runId: c.runId, rerunOf: latest ? latest.id : null });
      if (r.created) { created.push(r.job.id); log(`[LENS VERIFY] queued ${c.listingId}${latest ? ' (re-run)' : ''}`); await worker.syncJob(queue.get(r.job.id)); }
      seen.delete(c.listingId);
    }
    for (const k of [...seen.keys()]) if (!live.has(k)) seen.delete(k);
    return { candidates: cands.length, created };
  }

  // ---- 3. routes (loopback only) ---------------------------------------------------------------------------------------
  function routes(app) {
    const local = (req, res) => { if (LOOPBACK.has(req.socket?.remoteAddress)) return true; res.status(403).json({ ok: false, error: 'local only' }); return false; };
    app.get('/lens-verification/status', (req, res) => { if (!local(req, res)) return; const { queue } = parts(); res.json({ ok: true, jobs: queue.list(30) }); });
    app.get('/lens-verification/jobs/:listingId', (req, res) => { if (!local(req, res)) return; const { queue } = parts(); const j = queue.latestForListing(String(req.params.listingId)); res.json({ ok: !!j, job: j, lenses: j ? queue.lenses(j.id) : [] }); });
    app.post('/lens-verification/selftest', async (req, res) => {          // POST on purpose: makes one tiny paid OpenAI call
      if (!local(req, res)) return;
      const out = {};
      const step = async (name, fn) => { try { out[name] = { ok: true, detail: await fn() }; } catch (e) { out[name] = { ok: false, error: String(e?.message || e).slice(0, 300) }; } };
      await step('sheets_read', async () => { const c = await parts().sheet.scan(); return `${c.length} row-block(s) currently marked Y`; });
      await step('results_tab', async () => { await parts().sheet.ensureResultsTab(); return cfg.resultsTab; });
      await step('storage', async () => { const rel = await storage.save({ listingId: 'selftest', runId: 'selftest', capturedAt: new Date(now()).toISOString() }); return rel; });
      if (!cfg.dryRun) await step('openai_structured_vision', async () => {
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const r = await parts().ai.pass1({ image: { dataUrl: png }, title: 'self test', description: 'blank image', ocrText: '', lensNumber: 1, lensCount: 1 });
        return `model ${cfg.model} accepted the strict schema (${r.lenses.length} lens object(s) returned)`;
      });
      res.json({ ok: Object.values(out).every(v => v.ok), dryRun: cfg.dryRun, checks: out });
    });
    app.post('/lens-verification/rerun', async (req, res) => {
      if (!local(req, res)) return;
      const { queue, worker } = parts(); const listingId = listingIdFromUrl(req.body?.facebookUrl) || String(req.body?.listingId || '').trim();
      if (!listingId) return res.status(400).json({ ok: false, error: 'listingId or facebookUrl required' });
      const latest = queue.latestForListing(listingId);
      const r = queue.create({ listingId, facebookUrl: req.body?.facebookUrl || latest?.facebook_url || '', runId: latest?.run_id || '', rerunOf: latest?.id || null });
      if (r.created) await worker.syncJob(queue.get(r.job.id));
      res.json({ ok: true, created: r.created, jobId: r.job?.id });
    });
  }
  if (deps.app) { deps.app.use(capture); routes(deps.app); }

  let timers = [];
  return {
    enabled: true, cfg, capture, poll, parts, storage, captured, archiveLensImages,
    start() {
      let queue, worker;
      try { ({ queue, worker } = parts()); } catch (e) { log('[LENS VERIFY] could not start (scanner is unaffected):', e.message); return false; }
      const n = queue.recoverStale(); if (n) log(`[LENS VERIFY] resumed ${n} job(s) interrupted by restart.`);
      timers.push(setInterval(() => { poll().catch(e => log('[LENS VERIFY] poll error:', e.message)); }, cfg.pollMs));
      timers.push(setInterval(() => { worker.tick().catch(e => log('[LENS VERIFY] worker error:', e.message)); }, cfg.workerTickMs));
      log(`[LENS VERIFY] ready${cfg.dryRun ? ' (DRY RUN: no OpenAI calls)' : ''}. Watching ${cfg.mainTab}!${cfg.triggerColumn} for "Y" every ${Math.round(cfg.pollMs / 1000)}s.`);
      return true;
    },
    stop() { timers.forEach(clearInterval); timers = []; }
  };
}
export { loadConfig };
