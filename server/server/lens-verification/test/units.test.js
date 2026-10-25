import test from 'node:test';
import assert from 'node:assert/strict';
import { createLensVerification } from '../src/index.js';
import { buildEvidence, createCaptureStore, selectLensImage, mapLensItems, runIdFromLogCell, listingIdFromUrl, sanitizeRunId } from '../src/evidence.js';
import { prepareImage, classifyError, VerifyError } from '../src/ai.js';
import { aggregate, summarize, parseJsonLenient, validatePass2, AiOutputError } from '../src/validate.js';
import { makeEvidence, memStorage, makeDb, FakeSheets, seedMain, setY, makeRig } from './helpers.js';
import { openQueue } from '../src/queue.js';

const ID = '1000000000000001';

test('ids: listing id from url, run id from the log hyperlink the scanner writes, run-id sanitising matches the scanner', () => {
  assert.equal(listingIdFromUrl('https://www.facebook.com/marketplace/item/1234567890123/?ref=x'), '1234567890123');
  assert.equal(listingIdFromUrl('=HYPERLINK("https://www.facebook.com/marketplace/item/1234567890123/","x")'), '1234567890123');
  assert.equal(runIdFromLogCell('=HYPERLINK("https://x.supabase.co/storage/v1/object/public/marketplace-hit-logs/123/123_run-9.log","View Log")'), '123_run-9');
  assert.equal(runIdFromLogCell(''), '');
  assert.equal(sanitizeRunId(' a b/c:d '), 'a_b_c_d');
});

test('capture middleware: records what the scanner sends, never alters the scanner response, saves a snapshot when the hit is saved', async () => {
  const store = memStorage(); const logs = [];
  const app = { mw: [], use(f) { this.mw.push(f); }, get() {}, post() {} };
  const lv = createLensVerification({ app, env: { LENS_VERIFY_ENABLED: 'true' }, storage: store, log: (...a) => logs.push(a.join(' ')), db: makeDb(), now: () => Date.UTC(2026, 9, 25) });
  const mw = app.mw[0];
  const call = (path, body, headers = {}) => new Promise((resolve) => {
    const sent = []; const res = { json(b) { sent.push(b); return this; } };
    const req = { method: 'POST', path, body, get: (h) => ({ 'X-Analysis-Run-Id': `${ID}_run1`, ...headers })[h] };
    mw(req, res, () => { res.json({ ok: true, echo: path }); setTimeout(() => resolve(sent), 5); });
  });
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR', focal: '70-300mm', scores: { 1: 3, 2: 9 } }], nonLens: ['Canon 6D body'] });
  await call('/analyze-listing-gallery', { imageUrls: ev.imageUrls });
  const out = await call('/reconcile-primary-products', { listingTitle: 'My title', listingDescription: 'My description', galleryResults: [{ ...ev.galleryResults[0], debugCollageDataUrl: 'data:HUGE' }], bestGoogleTargets: ev.bestTargets, productOcrResults: [{ productId: 'lens_1', imageIndex: 2, ocrText: 'AF-S 70-300mm VR' }] });
  assert.deepEqual(out, [{ ok: true, echo: '/reconcile-primary-products' }]);                       // scanner's own response untouched
  assert.equal(store.evidence[ID], undefined);                                                     // nothing saved until the hit is saved
  await call('/save-deal-to-sheet', { deal: { facebookUrl: `https://www.facebook.com/marketplace/item/${ID}/`, analysisRunId: `${ID}_run1`, title: 'My title', recommendation: 'Buy Now', items: ev.items.map(i => ({ ebaySearchQuery: i.name, productType: i.productType, brand: i.brand, isPrimarySellableItem: true, expectedSalePrice: i.estimatedResale })) } });
  await new Promise(r => setTimeout(r, 20));
  const saved = store.evidence[ID];
  assert.ok(saved, 'snapshot saved'); assert.equal(saved.title, 'My title'); assert.equal(saved.description, 'My description'); assert.equal(saved.imageUrls.length, 4);
  assert.ok(!JSON.stringify(saved).includes('HUGE'));                                              // collage data URLs stripped
  assert.equal(saved.bestTargets[0].bestImageIndex, 2); assert.equal(saved.items.length, 2); assert.equal(saved.runId, `${ID}_run1`);
});

test('capture middleware: failure to save a snapshot never breaks the scanner; non-matching routes are ignored; failed saves (ok:false) store nothing', async () => {
  const bad = { async save() { throw new Error('supabase down'); }, async load() { return null; } };
  const app = { mw: [], use(f) { this.mw.push(f); }, get() {}, post() {} }; const logs = [];
  createLensVerification({ app, env: {}, storage: bad, log: (...a) => logs.push(a.join(' ')), db: makeDb() });
  const mw = app.mw[0]; const sent = [];
  const res = { json(b) { sent.push(b); return this; } };
  mw({ method: 'POST', path: '/save-deal-to-sheet', body: { deal: { facebookUrl: `https://www.facebook.com/marketplace/item/${ID}/`, analysisRunId: `${ID}_r` } }, get: () => `${ID}_r` }, res, () => res.json({ ok: true }));
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(sent, [{ ok: true }]); assert.ok(logs.some(l => /snapshot save\/archive failed/.test(l)));
  const res2 = { json(b) { return this; } }; let touched = false;
  mw({ method: 'POST', path: '/evaluate-comps', body: {}, get: () => '' }, res2, () => { touched = true; }); assert.ok(touched);
  const saves = []; const app3 = { mw: [], use(f) { this.mw.push(f); }, get() {}, post() {} };
  createLensVerification({ app: app3, env: {}, storage: { async save(e) { saves.push(e); }, async load() { return null; } }, log: () => {}, db: makeDb() });
  const res3 = { json() { return this; } };
  app3.mw[0]({ method: 'POST', path: '/save-deal-to-sheet', body: { deal: { facebookUrl: `https://www.facebook.com/marketplace/item/${ID}/` } }, get: () => `${ID}_r` }, res3, () => res3.json({ ok: false, error: 'x' }));
  await new Promise(r => setTimeout(r, 10)); assert.equal(saves.length, 0);
});

test('capture store expires old runs (memory stays bounded)', () => {
  let t = 0; const s = createCaptureStore(1000, () => t);
  s.recordGallery('a', { imageUrls: ['x'] }); assert.ok(s.get('a')); t = 2000; assert.equal(s.get('a'), null); assert.equal(s.size(), 0);
});

test('lens image: highest modelReadabilityScore wins; ties use readable-marking OCR, then the scanner\'s own pick; unrelated photos are never substituted', () => {
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'L', focal: '50mm', scores: { 1: 6, 2: 9, 3: 7 } }] });
  let s = selectLensImage(ev, 'lens_1'); assert.equal(s.imageIndex, 2); assert.equal(s.method, 'highest_score');
  const tie = makeEvidence({ id: ID, lenses: [{ name: 'L', focal: '50mm', scores: { 1: 8, 3: 8, 4: 8 } }] });
  s = selectLensImage(tie, 'lens_1'); assert.equal(s.imageIndex, 1); assert.equal(s.method, 'tie_scanner_pick');
  tie.productOcr = [{ productId: 'lens_1', imageIndex: 1, ocrText: 'Canon' }, { productId: 'lens_1', imageIndex: 3, ocrText: 'EF 50mm 1:1.8 STM II' }];
  s = selectLensImage(tie, 'lens_1'); assert.equal(s.imageIndex, 3); assert.equal(s.method, 'tie_broken_by_ocr_markings'); assert.match(s.ocrText, /STM/);
  const none = makeEvidence({ id: ID, lenses: [{ name: 'L', focal: '50mm', scores: {} }] });
  s = selectLensImage(none, 'lens_1'); assert.equal(s.ok, false); assert.equal(s.reason, 'NO_IMAGE_RATED');
  const only = makeEvidence({ id: ID, lenses: [{ name: 'L', focal: '50mm', scores: { 2: 5 } }] }); only.galleryResults = [];
  assert.equal(selectLensImage(only, 'lens_1').imageIndex, 2);                                      // falls back to the scanner's recorded best target
});

test('lens mapping: explicit productId, then unique focal-length+brand, then order; ambiguity is reported, never guessed', () => {
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: 'Sigma 35mm f/1.4 Art', brand: 'Sigma', focal: '35mm', scores: { 2: 9 } }], nonLens: ['Camera body'] });
  const m = mapLensItems(ev); assert.deepEqual(m.mapped.map(x => [x.item.name, x.productId, x.method]), [['Canon EF 50mm f/1.8 STM', 'lens_1', 'focal_length_brand'], ['Sigma 35mm f/1.4 Art', 'lens_2', 'focal_length_brand']]); assert.deepEqual(m.nonLensItems, ['Camera body']);
  const byId = makeEvidence({ id: ID, lenses: [{ name: 'odd', focal: '50mm', scores: { 1: 9 }, itemProductId: 'lens_1' }] }); assert.equal(mapLensItems(byId).mapped[0].method, 'product_id');
  const dup = makeEvidence({ id: ID, lenses: [{ name: 'Nikon 50mm A', focal: '50mm', scores: { 1: 9 } }, { name: 'Nikon 50mm B', focal: '50mm', scores: { 2: 9 } }] });
  assert.deepEqual(mapLensItems(dup).mapped.map(x => x.method), ['order', 'order']);
  const lost = makeEvidence({ id: ID, lenses: [{ name: 'Nikon 50mm A', focal: '50mm', scores: { 1: 9 } }] }); lost.items.push({ index: 5, name: 'Mystery lens', productType: 'camera lens', brand: '', isPrimarySellableItem: true });
  const ml = mapLensItems(lost); assert.equal(ml.mapped.length, 1); assert.equal(ml.unmapped.length, 1); assert.equal(ml.unmapped[0].reason, 'NO_LENS_PRODUCT_RECORD');
});

test('prepareImage: expired links are permanent, 5xx/network are retriable, non-images and oversize are rejected', async () => {
  const ok = (type, body) => async () => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => body });
  const p = await prepareImage('https://x/i.jpg', { fetchImpl: ok('image/jpeg', new Uint8Array([1, 2, 3, 4]).buffer) });
  assert.match(p.dataUrl, /^data:image\/jpeg;base64,/); assert.equal(p.bytes, 4);
  await assert.rejects(prepareImage('https://x/i.jpg', { fetchImpl: async () => ({ ok: false, status: 403 }) }), (e) => e.code === 'IMAGE_UNAVAILABLE' && !e.retriable);
  await assert.rejects(prepareImage('https://x/i.jpg', { fetchImpl: async () => ({ ok: false, status: 503 }) }), (e) => e.code === 'IMAGE_FETCH_FAILED' && e.retriable);
  await assert.rejects(prepareImage('https://x/i.jpg', { fetchImpl: async () => { throw new Error('fetch failed'); } }), (e) => e.retriable);
  await assert.rejects(prepareImage('https://x/i.jpg', { fetchImpl: ok('text/html', new Uint8Array([1]).buffer) }), (e) => e.code === 'IMAGE_UNUSABLE');
  await assert.rejects(prepareImage('https://x/i.jpg', { fetchImpl: ok('image/png', new Uint8Array(20).buffer), maxBytes: 10 }), (e) => e.code === 'IMAGE_UNUSABLE');
  await assert.rejects(prepareImage('', {}), (e) => e.code === 'IMAGE_UNAVAILABLE');
  const withSharp = await prepareImage('https://x/i.png', { fetchImpl: ok('image/png', new Uint8Array([9, 9]).buffer), sharp: () => ({ rotate() { return this; }, resize() { return this; }, jpeg() { return this; }, toBuffer: async () => Buffer.from([7, 7, 7]) }) });
  assert.match(withSharp.dataUrl, /^data:image\/jpeg/); assert.equal(withSharp.bytes, 3);
});

test('error classification', () => {
  const c = (status, message = '') => classifyError(Object.assign(new Error(message), { status }));
  assert.deepEqual([c(429).code, c(429).retriable], ['AI_RATE_LIMITED', true]); assert.deepEqual([c(503).code, c(503).retriable], ['AI_SERVER_ERROR', true]);
  assert.deepEqual([c(401).code, c(401).retriable], ['AI_AUTH', false]); assert.deepEqual([c(400).code, c(400).retriable], ['AI_REJECTED_INPUT', false]);
  assert.equal(classifyError(new Error('ECONNRESET')).retriable, true); assert.equal(classifyError(new VerifyError('X', 'm', { retriable: true })).retriable, true);
});

test('validation: lenient JSON, enum enforcement, aggregate precedence, summaries', () => {
  assert.deepEqual(parseJsonLenient('```json\n{"a":1}\n```'), { a: 1 }); assert.deepEqual(parseJsonLenient('noise {"a":2} trailing'), { a: 2 });
  assert.throws(() => parseJsonLenient('nope'), AiOutputError);
  assert.throws(() => validatePass2({ outcome: 'MAYBE' }), AiOutputError);
  assert.equal(validatePass2({ outcome: 'pass', matchedPass1Lens: 5, valueImpact: { level: 'weird' } }, 1).matchedPass1Lens, null);
  const L = (o) => ({ status: 'done', outcome: o, scannerName: 'n', finding: 'f' });
  assert.equal(aggregate([L('PASS'), L('PASS')]).verdict, 'PASS'); assert.equal(aggregate([L('PASS'), L('REVIEW')]).verdict, 'REVIEW');
  assert.equal(aggregate([L('REVIEW'), L('MISMATCH'), { status: 'error' }]).verdict, 'MISMATCH'); assert.equal(aggregate([L('PASS'), { status: 'error' }]).verdict, 'ERROR');
  assert.equal(aggregate([L('REVIEW'), { status: 'error' }]).verdict, 'REVIEW'); assert.equal(aggregate([L('REVIEW'), { status: 'error' }]).incomplete, true);
  assert.equal(aggregate([]).verdict, 'NO_LENSES');
  const lenses = [L('REVIEW'), { status: 'error', errorCode: 'NO_IMAGE', scannerName: 'z' }]; assert.match(summarize(lenses, aggregate(lenses)), /could not be verified \(NO_IMAGE\)/);
});

test('listing with no lenses finishes as "No lenses", not Pass or Error', async () => {
  const ev = makeEvidence({ id: ID, lenses: [], nonLens: ['Canon 6D body'] });
  const rig = makeRig({ listings: [{ id: ID, items: ['Canon 6D body'] }], evidenceOverride: { [ID]: ev } });
  setY(rig.fs, 2); await rig.run();
  const j = rig.queue.list(5)[0]; assert.equal(j.status, 'done'); assert.equal(j.verdict, 'NO_LENSES'); assert.equal(rig.mainStatus(2).result, 'No lenses'); assert.equal(rig.openai.calls.length, 0);
});

test('poller: only Y/y triggers; blank/N ignored; the scanner can still be mid-write (unstable rows are not queued)', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }] });
  rig.fs.set('Main', 1, 14, 'N'); for (let i = 0; i < 3; i++) { await rig.lv.poll(); rig.c.advance(30000); } assert.equal(rig.queue.list().length, 0);
  rig.fs.set('Main', 1, 14, 'y'); await rig.lv.poll(); rig.c.advance(10000);
  rig.fs.tab('Main').merges.push({ startRowIndex: 1, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 });    // block changes between polls (scanner still writing)
  await rig.lv.poll(); rig.c.advance(10000); await rig.lv.poll(); assert.equal(rig.queue.list().length, 0);          // signature changed -> debounce restarted
  rig.c.advance(25000); await rig.lv.poll(); assert.equal(rig.queue.list().length, 1);
});

test('sheet failures are retried without re-running the AI: job stays done, status syncs on a later tick', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }] });
  setY(rig.fs, 2); await rig.lv.poll(); rig.c.advance(21000); await rig.lv.poll();
  rig.fs.failNext = Object.assign(new Error('sheets 503'), { status: 503 });                                          // first sheet call after queueing fails
  await rig.lv.parts().worker.tick();
  const callsAfter = rig.openai.calls.length;
  for (let i = 0; i < 4; i++) await rig.lv.parts().worker.tick();
  const j = rig.queue.list()[0]; assert.equal(j.status, 'done'); assert.equal(j.sheet_synced, 1); assert.equal(rig.openai.calls.length, callsAfter); assert.equal(rig.mainStatus(2).job, 'Done');
  assert.equal(rig.openai.calls.length, 2);
});

test('queue: attempts cap, restart limit, and one active job per listing', () => {
  let t = 1000; const q = openQueue(makeDb(), { maxAttempts: 2, backoffMs: [100, 200], now: () => t });
  const a = q.create({ listingId: 'L1' }); assert.ok(a.created); assert.equal(q.create({ listingId: 'L1' }).created, false);
  const j = q.claimNext(); assert.equal(j.attempts, 1); q.scheduleRetry(j.id, { code: 'X', message: 'm' }); assert.equal(q.get(j.id).status, 'retry_wait'); assert.equal(q.claimNext(), null);
  t += 150; const j2 = q.claimNext(); assert.equal(j2.attempts, 2); assert.equal(q.scheduleRetry(j2.id, { code: 'X', message: 'm' }).status, 'failed');
  assert.ok(q.create({ listingId: 'L1' }).created);
  const k = q.claimNext(); q.recoverStale(); t += 1; const k2 = q.claimNext(); q.recoverStale(); assert.equal(q.get(k.id).status, 'failed'); assert.equal(q.get(k.id).error_code, 'RESTART_LIMIT');
});

test('start() never throws into the scanner: bad Google credentials or DB problems only log', () => {
  const logs = [];
  const lv = createLensVerification({ env: {}, log: (...a) => logs.push(a.join(' ')), getSheets: () => { throw new Error('Missing GOOGLE_OAUTH_CLIENT_ID'); }, openDb: () => makeDb() });
  assert.equal(lv.start(), false); assert.ok(logs.some(l => /could not start \(scanner is unaffected\)/.test(l)));
  const lv2 = createLensVerification({ env: {}, log: () => {}, getSheets: () => ({}), openDb: () => { throw new Error('native module missing'); } });
  assert.equal(lv2.start(), false);
  const off = createLensVerification({ env: { LENS_VERIFY_ENABLED: 'false' }, log: () => {} }); assert.equal(off.enabled, false); off.start();
});

test('dry run: whole flow (queue, sheet, report) with placeholder AI and ZERO OpenAI calls', async () => {
  let openaiCalls = 0; const fs = new FakeSheets(); seedMain(fs, [{ id: ID, items: ['Canon EF 50mm f/1.8 STM'] }]);
  const ev = { [ID]: makeEvidence({ id: ID, lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }] }) };
  const { loadConfig } = await import('../src/config.js'); const { createSheet } = await import('../src/sheet.js');
  let t = Date.UTC(2026, 9, 25); const cfg = { ...loadConfig({ LENS_VERIFY_DRY_RUN: 'true', GOOGLE_SHEETS_SPREADSHEET_ID: 's' }), debounceMs: 1000 };
  const lv = createLensVerification({ env: {}, cfgOverrides: cfg, db: makeDb(), sheet: createSheet({ sheets: fs.client, cfg, log: () => {} }), storage: memStorage(ev), createLoggedOpenAiResponse: async () => { openaiCalls++; return { output_text: '{}' }; }, now: () => t, log: () => {} });
  setY(fs, 2); await lv.poll(); t += 2000; await lv.poll(); for (let i = 0; i < 4; i++) await lv.parts().worker.tick();
  assert.equal(openaiCalls, 0); assert.equal(fs.get('Main', 1, 18), 'Done'); assert.equal(fs.get('Main', 1, 19), 'Pass'); assert.match(fs.get('Main', 1, 20), /No manual action/);
  assert.match(fs.rows('Lens Verification')[1][9], /DRY RUN/);
});

test('selftest route: reports each prerequisite separately; one OpenAI structured-output call', async () => {
  const routes = {}; const app = { use() {}, get(p, f) { routes[p] = f; }, post(p, f) { routes[p] = f; } };
  const fs = new FakeSheets(); seedMain(fs, [{ id: ID, items: ['x'] }]); const { loadConfig } = await import('../src/config.js'); const { createSheet } = await import('../src/sheet.js'); const { createAi } = await import('../src/ai.js');
  const cfg = loadConfig({ GOOGLE_SHEETS_SPREADSHEET_ID: 's' }); let calls = 0;
  createLensVerification({ app, env: {}, cfgOverrides: cfg, db: makeDb(), sheet: createSheet({ sheets: fs.client, cfg, log: () => {} }), storage: memStorage(), ai: createAi({ cfg, callOpenAI: async () => { calls++; return { output_text: JSON.stringify({ imageUsable: false, imageNote: 'blank', lenses: [] }) }; } }), log: () => {} });
  let body; const res = { status() { return this; }, json(b) { body = b; } };
  await routes['/lens-verification/selftest']({ socket: { remoteAddress: '127.0.0.1' } }, res);
  assert.equal(body.ok, true, JSON.stringify(body)); assert.equal(calls, 1); assert.ok(body.checks.sheets_read.ok && body.checks.results_tab.ok && body.checks.storage.ok && body.checks.openai_structured_vision.ok);
  let denied; await routes['/lens-verification/selftest']({ socket: { remoteAddress: '203.0.113.9' } }, { status() { return this; }, json(b) { denied = b; } }); assert.equal(denied.ok, false);
});
