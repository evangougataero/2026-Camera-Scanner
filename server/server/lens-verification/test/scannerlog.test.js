import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { parseScannerLog, splitBlocks, parseLiteralAt, notesForLens } from '../src/scannerLog.js';
import { makeRig, makeEvidence, setY, P1, P2 } from './helpers.js';

const ID = '1000000000000001';
const fmt = (...a) => util.format(...a);                       // exactly what the scanner's console.log override writes to the log
const gallery = (imgs) => JSON.stringify({ products: [{ productId: 'lens_1', productType: 'camera lens', visibleInImages: imgs.map(i => i.i) }], images: imgs.map(i => ({ imageIndex: i.i, visibleProducts: [{ productId: 'lens_1', productType: 'camera lens', modelReadabilityScore: i.s }] })) }, null, 2);

const SAMPLE_LOG = [
  fmt('[REQ START] POST /analyze-listing-gallery'),
  fmt('[STEP 1] Google-extracted listing text received:', 812, 'characters'),
  fmt('[STEP 1] Parsed listing facts:'), fmt({ explicitlyIncluded: ['lens cap'], explicitlyExcluded: [], listingNotes: ["seller says 'works great'"] }),
  fmt('[STEP 2] Received 4 listing image(s).'),
  fmt('[STEP 2] Raw gallery 1 response:'), gallery([{ i: 1, s: 3 }, { i: 2, s: 9 }]),
  fmt('[STEP 2] Raw gallery 2 response:'), 'this is not json {',
  fmt('[STEP 2] Raw gallery 2 retry response:'), gallery([{ i: 3, s: 7 }, { i: 4, s: 2 }]),
  fmt('[LENS RESOLVER] Structured evidence:', { productId: 'lens_1', brand: 'Nikon', focalLength: '70-300mm', maxAperture: 'f/4.5-5.6', featureTokens: ['VR', 'ED'], modelCodes: [], rawEvidence: ["it's 'AF-S'", 'line\nbreak'] }),
  fmt('[LENS RESOLVER] Lens candidates (Lensfun + ExifTool):', { productId: 'lens_1', lensfunCount: 2, exifToolCount: 0, count: 2, candidates: [{ candidateId: 'a', maker: 'Nikon', model: 'Nikkor AF-S 70-300mm f/4.5-5.6G VR', mount: 'Nikon F AF' }, { candidateId: 'b', maker: 'Nikon', model: 'Nikkor AF 70-300mm f/4-5.6G', mount: 'Nikon F AF' }], deep: { a: { b: { c: { d: { e: 1 } } } } }, many: Array.from({ length: 130 }, (_, i) => i) }),
  fmt('[LENS RESOLVER] Resolved via candidate resale consensus:', { productId: 'lens_1', candidateModels: ['Nikkor AF-S 70-300mm f/4.5-5.6G VR', 'Nikkor AF 70-300mm f/4-5.6G'], prices: [210, 120], averagedResalePrice: 165 }),
  fmt('[LENS RESOLVER] Complete:', { productId: 'lens_1', mode: 'lensfun-candidate-resale-consensus', identity: { brand: 'Nikon', canonicalModel: 'Nikon AF-S Nikkor 70-300mm f/4.5-5.6G IF-ED VR', mountSeries: 'F' } }),
  fmt('[SERPAPI AI MODE] Raw identification answer:', { searchId: 'abc', prompt: 'Identify the camera lens', answer: 'Nikon AF-S 70-300mm\nf/4.5-5.6G ED VR' }),
  fmt('[DATAFORSEO GATE] Exact lens identity accepted:', { productId: 'lens_2', canonicalModel: 'Canon EF 50mm f/1.8 STM', confidence: 'high', consensus: 3, resolutionMode: 'dataforseo' }),
  fmt('[STEP 5] Final primary products:'),                     // console.dir output is NOT captured by the scanner's log
  fmt('[GOOGLE SHEETS] Column filter cleared.')
].join('\n');

test('log parser: grades per image per product from the raw gallery JSON; a retry response replaces an unusable one', () => {
  const p = parseScannerLog(SAMPLE_LOG);
  assert.equal(p.galleries.length, 2);
  assert.deepEqual(p.galleries[0].images.map(i => [i.imageIndex, i.visibleProducts[0].modelReadabilityScore]), [[1, 3], [2, 9]]);
  assert.deepEqual(p.galleries[1].images.map(i => [i.imageIndex, i.visibleProducts[0].modelReadabilityScore]), [[3, 7], [4, 2]]);
});

test('log parser: scanner resolution trail attributed per productId; final identity from "[LENS RESOLVER] Complete"; unattributed answers kept as general', () => {
  const p = parseScannerLog(SAMPLE_LOG);
  assert.equal(p.resolved.lens_1.identity.canonicalModel, 'Nikon AF-S Nikkor 70-300mm f/4.5-5.6G IF-ED VR'); assert.equal(p.resolved.lens_1.mode, 'lensfun-candidate-resale-consensus');
  const n1 = notesForLens(p, 'lens_1'); assert.ok(n1.length >= 3); assert.ok(n1.some(x => /resale consensus/.test(x))); assert.ok(n1.join(' ').length <= 1900);
  assert.ok(notesForLens(p, 'lens_2').some(x => /DATAFORSEO GATE/.test(x) && /Canon EF 50mm/.test(x)));
  assert.ok(p.general.some(x => /SerpApi AI Mode answer: Nikon AF-S 70-300mm\nf\/4\.5/.test(x)));
  assert.deepEqual(p.listingFacts.listingNotes, ["seller says 'works great'"]);
  assert.equal(p.stats.lensesResolved, 1);
});

test('log parser: inspect-style literals (quotes, newlines, [Object], "... more items", unquoted keys) parse; hostile or broken text never throws or executes', () => {
  assert.deepEqual(parseLiteralAt(util.inspect({ a: "it's", b: ['x\ny'], c: { d: null, e: undefined, f: -1.5 } }), 0), { a: "it's", b: ['x\ny'], c: { d: null, e: null, f: -1.5 } });
  const deep = parseLiteralAt(util.inspect({ a: { b: { c: { d: 1 } } } }, { depth: 1 }), 0); assert.equal(deep.a.b, '[truncated]');
  const many = parseLiteralAt(util.inspect(Array.from({ length: 150 }, (_, i) => i)), 0); assert.equal(many.length, 100);
  assert.equal(parseLiteralAt("{ a: require('child_process').execSync('x') }", 0), null);
  globalThis.__pwned = false; parseLiteralAt("{ a: (globalThis.__pwned = true) }", 0); assert.equal(globalThis.__pwned, false);
  assert.equal(parseLiteralAt('{ a: [1, 2', 0), null);
  const empty = parseScannerLog('garbage\n[STEP 2] Raw gallery 1 response:\n{"images": [ {'); assert.deepEqual(empty.galleries, []);
  assert.deepEqual(parseScannerLog('').galleries, []); assert.deepEqual(notesForLens(null, 'x'), []);
  assert.equal(splitBlocks('no markers at all').length, 0);
});

test('worker: scanner trail + final identity from the log reach Pass 2 (as the scanner\'s reasoning, not evidence); report records the log was used', async () => {
  const rig = makeRig({ lenses: [{ name: 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR', focal: '70-300mm', scores: { 2: 9 } }], logs: { [ID]: SAMPLE_LOG } });
  setY(rig.fs, 2); await rig.run();
  const p2 = rig.openai.calls.find(c => c.pass === 2).prompt, p1 = rig.openai.calls.find(c => c.pass === 1).prompt;
  assert.match(p2, /resolution trail/); assert.match(p2, /resale consensus/); assert.match(p2, /canonicalModel/); assert.match(p2, /NOT independent evidence/);
  assert.ok(!/resale consensus|canonicalModel|resolution trail/.test(p1), 'pass 1 must stay independent of the scanner log');
  const rep = JSON.parse(rig.queue.get(rig.queue.list()[0].id).report_json);
  assert.equal(rep.scannerLog.used, true); assert.match(rep.evidenceSource, /Analysis Log/); assert.equal(rep.lenses[0].evidenceUsed.scannerLog, true); assert.deepEqual(rep.lenses[0].imageCrossCheck, { scannerLogImageIndex: 2, usedImageIndex: 2, agrees: true });
});

test('worker: if the snapshot has no grades, the log\'s grades pick the photo; if log and snapshot disagree the snapshot (what the scanner used) wins and it is flagged', async () => {
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR', focal: '70-300mm', scores: { 1: 3, 2: 9 } }] });
  const noGrades = { ...ev, galleryResults: [], bestTargets: [] };
  const rig = makeRig({ lenses: [{ name: 'x', focal: '70-300mm', scores: { 2: 9 } }], evidenceOverride: { [ID]: noGrades }, logs: { [ID]: SAMPLE_LOG } });
  setY(rig.fs, 2); await rig.run();
  const lens = rig.queue.lenses(rig.queue.list()[0].id)[0].result; assert.equal(lens.image.index, 2); assert.equal(JSON.parse(rig.queue.get(rig.queue.list()[0].id).report_json).scannerLog.gradesFromLog, true);

  const disagree = makeRig({ lenses: [{ name: 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR', focal: '70-300mm', scores: { 1: 9, 3: 2 } }], logs: { [ID]: SAMPLE_LOG } });   // log says image 2 is best, snapshot says 1
  setY(disagree.fs, 2); await disagree.run();
  const l2 = disagree.queue.lenses(disagree.queue.list()[0].id)[0].result; assert.equal(l2.image.index, 1); assert.deepEqual(l2.imageCrossCheck, { scannerLogImageIndex: 2, usedImageIndex: 1, agrees: false });
});

test('worker: an unreadable/unreachable scanner log never blocks verification', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }], logError: true });
  setY(rig.fs, 2); await rig.run(); const j = rig.queue.list()[0]; assert.equal(j.status, 'done'); assert.equal(j.verdict, 'PASS');
  assert.equal(JSON.parse(rig.queue.get(j.id).report_json).scannerLog.used, false);
  const junk = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }], logs: { [ID]: '\u0000\u0001 not a log {{{' } });
  setY(junk.fs, 2); await junk.run(); assert.equal(junk.queue.list()[0].verdict, 'PASS');
});

test('log URL and run id are read from the column I "View Log" hyperlink the scanner writes', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }] });
  const ctx = await rig.sheet.locate(ID); assert.equal(ctx.runId, `${ID}_run1`); assert.equal(ctx.logUrl, `https://x.supabase.co/storage/v1/object/public/marketplace-hit-logs/${ID}/${ID}_run1.log`);
});

test('photo archived at scan time is used when the Facebook link has expired; a missing archive falls back to the live link', async () => {
  const lens = { name: 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR', focal: '70-300mm', scores: { 2: 9 } };
  const ev = makeEvidence({ id: ID, lenses: [lens] }); const url = ev.imageUrls[1]; ev.imageUrls[1] = 'https://cdn.example/missing2.jpg';
  ev.bestTargets[0].imageUrl = ev.imageUrls[1]; ev.archivedImages = { [ev.imageUrls[1]]: 'lens-verification/images/x/2.jpg' };
  const rel = 'lens-verification/images/x/2.jpg';
  const rig = makeRig({ lenses: [lens], evidenceOverride: { [ID]: ev }, images: { [rel]: { dataUrl: 'data:image/jpeg;base64,QUJD', bytes: 3, sha256: 'z' } } });
  setY(rig.fs, 2); await rig.run();
  const j = rig.queue.list()[0]; assert.equal(j.status, 'done'); assert.equal(j.verdict, 'PASS');
  assert.equal(rig.queue.lenses(j.id)[0].result.image.fromArchivedCopy, true); assert.ok(url);
  const none = makeRig({ lenses: [lens], evidenceOverride: { [ID]: ev }, images: {} }); setY(none.fs, 2); await none.run();
  assert.equal(none.queue.list()[0].status, 'failed'); assert.equal(none.openai.calls.length, 0);                    // archive absent + link expired -> honest failure
});

test('scan-time archiving: one copy of each lens\'s chosen photo only; failures are logged and never break the scanner', async () => {
  const { createLensVerification } = await import('../src/index.js'); const { makeDb, memStorage } = await import('./helpers.js');
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9, 2: 8 } }, { name: 'Sigma 35mm f/1.4', brand: 'Sigma', focal: '35mm', scores: { 3: 9 } }], images: 4 });
  const store = memStorage({}, [], {}); const fetched = []; const logs = [];
  const lv = createLensVerification({ env: {}, db: makeDb(), storage: store, log: (...a) => logs.push(a.join(' ')), prepareImage: async (u) => { fetched.push(u); if (/img3/.test(u)) throw new Error('expired'); return { dataUrl: 'data:image/jpeg;base64,QUJD', bytes: 3, sha256: 'q' }; } });
  const copy = JSON.parse(JSON.stringify(ev)); await lv.archiveLensImages(copy);
  assert.deepEqual(fetched.sort(), [ev.imageUrls[0], ev.imageUrls[2]].sort());                                         // exactly the 2 chosen photos, not all 4
  assert.equal(Object.keys(copy.archivedImages).length, 1); assert.equal(Object.keys(store.extras.saved).length, 1); assert.ok(logs.some(l => /not archived/.test(l)));
  assert.ok(store.evidence[ID].archivedImages);                                                                        // evidence re-saved with the archive map
});

// ---- Real log from the user's scanner (Nikon DX bundle, 3 lenses, 1 gallery image) ----
import fs from 'node:fs';
import { parseScannerLog as parseReal, notesForLens as notesReal, splitBlocks as splitReal } from '../src/scannerLog.js';
test('real scanner log: grades, resolver identities, reconciliation and facts are all parsed', () => {
  const text = fs.readFileSync(new URL('./fixtures/real-scanner-log.txt', import.meta.url), 'utf8');
  const r = parseReal(text);
  assert.equal(r.galleries.length, 1);
  const scores = r.galleries[0].images[0].visibleProducts.map(p => [p.productId, p.modelReadabilityScore]);
  assert.deepEqual(scores, [['lens_1', 9], ['lens_2', 8], ['lens_3', 8]]);
  assert.equal(Object.keys(r.resolved).length, 3);
  assert.equal(r.resolved.lens_3.identity.canonicalModel, '40mm f/2.8G');
  assert.equal(r.resolved.lens_1.identity.focalLength, '55-300mm');
  assert.equal(r.reconciliation.lens_2.lensIdentity.maxAperture, 'f/1.8G');
  assert.deepEqual(r.reconciliation.lens_1.extracted_evidence, ['AF-S NIKKOR 55-300mm 1:4.5-5.6G ED VR']);
  assert.equal(r.listingFacts.explicitlyIncluded.length, 6);
  assert.equal(r.stats.reconciled, 3);
  // OCR noise lines such as "Marketplace" must not be mistaken for [TAG] blocks, and the empty console.dir block yields no value
  assert.equal(splitReal(text).find(b => b.tag === 'STEP 5' && /Final primary/.test(b.label)).value, null);
  const n = notesReal(r, 'lens_2');
  assert.ok(n.some(x => /OCR strings the scanner relied on/.test(x)) && n.some(x => /Final scanner identity/.test(x)));
  assert.ok(!notesReal(r, 'lens_2', 1800, true).some(x => /OCR strings/.test(x)));
});
