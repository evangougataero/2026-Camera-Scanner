import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRig, makeEvidence, seedMain, setY, P1, P2, httpErr, FakeSheets, makeDb } from './helpers.js';

const VR = 'Nikon AF-S 70-300mm f/4.5-5.6G IF-ED VR';
const lensVR = { name: VR, focal: '70-300mm', scores: { 1: 4, 2: 9 }, resale: 220 };
const ID = '1000000000000001';
const jobs = (rig) => rig.queue.list(50);
const resultsRows = (rig) => rig.fs.rows('Lens Verification');

test('1. single lens, clear and correct -> PASS; job done; Main shows Done/Pass; results row written', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }] });
  setY(rig.fs, 2); await rig.run();
  const j = jobs(rig); assert.equal(j.length, 1); assert.equal(j[0].status, 'done'); assert.equal(j[0].verdict, 'PASS');
  const st = rig.mainStatus(2);
  assert.equal(st.job, 'Done'); assert.equal(st.result, 'Pass'); assert.match(st.summary, /No manual action needed/); assert.match(st.report, /HYPERLINK\(.*Lens Verification|HYPERLINK\("https:\/\/docs\.google\.com/);
  assert.equal(resultsRows(rig).length, 2);                                      // header + 1 lens
  assert.equal(resultsRows(rig)[1][6], 'Pass');
  assert.equal(rig.fs.get('Main', 1, 14), 'Y');                                  // trigger cell untouched
});

test('2. Pass 1 is independent (never sees the scanner model); Pass 2 is given it; seller-stated detail not visible in photo still PASSES', async () => {
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1({ evidence: [{ claim: 'AF-S per seller', source: 'seller', detail: 'title says AF-S' }] }) : P2({ evidenceLimited: true, findingSummary: 'AF-S stated by seller; mount not visible in photo but nothing contradicts it.' })) });
  setY(rig.fs, 2); await rig.run();
  const [c1, c2] = rig.openai.calls;
  assert.equal(c1.pass, 1); assert.ok(!c1.prompt.includes('IF-ED')); assert.ok(!c1.prompt.includes(VR)); assert.ok(!/scanner concluded/i.test(c1.prompt));
  assert.ok(c1.prompt.includes('Seller lens lot'));                              // listing text IS given to pass 1
  assert.equal(c2.pass, 2); assert.ok(c2.prompt.includes(VR)); assert.ok(c2.prompt.includes('HYPOTHESIS'));
  assert.ok(c1.hasImage && c2.hasImage);
  assert.equal(jobs(rig)[0].verdict, 'PASS');
  const rep = rig.storage.evidence; assert.ok(rep);
});

test('3. VR vs non-VR: plausible variant with material value difference -> REVIEW with exact check; scanner name preserved', async () => {
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1({ features: [], unresolved: [{ topic: 'VR', detail: 'VR marking not readable', couldAffectValue: true }] })
    : P2({ outcome: 'REVIEW', agreement: 'partially_agrees', alternatives: [{ model: 'Nikon AF-S 70-300mm f/4.5-5.6G (non-VR)', plausibility: 'medium', whyConfusable: 'same name minus VR' }],
      findingSummary: 'VR designation not established by photo or listing; a non-VR version exists.', valueImpact: { level: 'material', description: 'VR version typically worth notably more.' }, recommendedManualCheck: 'Confirm "VR" is printed on the barrel.' })) });
  setY(rig.fs, 2); await rig.run();
  assert.equal(jobs(rig)[0].verdict, 'REVIEW');
  const st = rig.mainStatus(2); assert.equal(st.result, 'Review'); assert.match(st.summary, /VR/); assert.match(st.summary, /Check: Confirm "VR"/);
  const row = resultsRows(rig)[1]; assert.equal(row[5], VR); assert.match(row[8], /non-VR/); assert.match(row[11], /Confirm "VR"/);
});

test('4. readable markings directly contradict the scanner -> MISMATCH; a Mismatch without direct marking evidence is downgraded', async () => {
  const mm = P2({ outcome: 'MISMATCH', agreement: 'disagrees', independentIdentification: 'Nikon AF-S 70-300mm f/4.5-5.6G ED (non-VR)', contradictions: [{ description: 'Barrel reads "70-300mm 1:4.5-5.6G ED" with no VR', source: 'visible_marking', directness: 'direct' }],
    alternatives: [{ model: 'Nikon AF-S 70-300mm non-VR', plausibility: 'high', whyConfusable: 'x' }], valueImpact: { level: 'material', description: 'non-VR is the cheaper model' }, recommendedManualCheck: 'Read the barrel text.', findingSummary: 'Barrel text shows non-VR model.' });
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1() : mm) });
  setY(rig.fs, 2); await rig.run();
  assert.equal(jobs(rig)[0].verdict, 'MISMATCH'); assert.equal(rig.mainStatus(2).result, 'Mismatch');

  const weak = { ...mm, contradictions: [{ description: 'VR switch not visible', source: 'visible_marking', directness: 'indirect' }] };
  const rig2 = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1() : weak) });
  setY(rig2.fs, 2); await rig2.run();
  assert.equal(jobs(rig2)[0].verdict, 'REVIEW');                                   // downgraded, not Mismatch
  const lens = rig2.queue.lenses(jobs(rig2)[0].id)[0].result; assert.equal(lens.rawOutcome, 'MISMATCH'); assert.equal(lens.guardrail.applied, true);
});

test('5. ambiguous photo, nothing conflicting -> PASS (evidence-limited); unsupported REVIEW (no material value difference) is downgraded to PASS', async () => {
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1({ readableMarkings: [] }) : P2({ evidenceLimited: true, findingSummary: 'Photo angle hides markings; listing is consistent.' })) });
  setY(rig.fs, 2); await rig.run();
  assert.equal(jobs(rig)[0].verdict, 'PASS'); assert.match(resultsRows(rig)[1][14], /Evidence-limited/);

  const rig2 = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 ? P1() : P2({ outcome: 'REVIEW', alternatives: [{ model: 'Some sibling', plausibility: 'low', whyConfusable: 'x' }], valueImpact: { level: 'minor', description: 'tiny' }, recommendedManualCheck: 'look' })) });
  setY(rig2.fs, 2); await rig2.run();
  assert.equal(jobs(rig2)[0].verdict, 'PASS'); assert.equal(rig2.queue.lenses(jobs(rig2)[0].id)[0].result.rawOutcome, 'REVIEW');
});

test('6. several lenses: ONE job, each lens judged on its own highest-rated photo; aggregate follows worst result', async () => {
  const lenses = [
    { name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9, 2: 4 } },
    { name: 'Sigma 35mm f/1.4 DG HSM Art', brand: 'Sigma', focal: '35mm', scores: { 2: 8, 3: 8, 4: 2 } },       // tie 2 vs 3 -> scanner pick (earliest) = image 2
    { name: VR, focal: '70-300mm', scores: { 3: 10 } }];
  const script = ({ pass, prompt }) => pass === 1 ? P1() : (prompt.includes('Sigma 35mm') ? P2({ outcome: 'REVIEW', alternatives: [{ model: 'Sigma 35mm f/1.4 DG HSM (non-Art)', plausibility: 'medium', whyConfusable: 'older version' }], valueImpact: { level: 'material', description: 'Art costs more' }, recommendedManualCheck: 'Check for the Art logo.' }) : P2());
  const rig = makeRig({ lenses, script });
  setY(rig.fs, 2); await rig.run();
  assert.equal(jobs(rig).length, 1);
  const res = rig.queue.lenses(jobs(rig)[0].id).map(l => l.result);
  assert.deepEqual(res.map(r => r.image.index), [1, 2, 3]);                        // each lens: its own best photo
  assert.deepEqual(res.map(r => r.outcome), ['PASS', 'REVIEW', 'PASS']);
  assert.equal(jobs(rig)[0].verdict, 'REVIEW');
  assert.equal(rig.openai.calls.filter(c => c.pass === 1).length, 3);              // 3 distinct photos
  assert.equal(resultsRows(rig).length, 4);
  const withMismatch = makeRig({ lenses, script: ({ pass, prompt }) => pass === 1 ? P1() : (prompt.includes(VR) ? P2({ outcome: 'MISMATCH', agreement: 'disagrees', contradictions: [{ description: 'no VR text', source: 'visible_marking', directness: 'direct' }], alternatives: [{ model: 'non-VR', plausibility: 'high', whyConfusable: 'x' }], valueImpact: { level: 'material', description: 'y' }, recommendedManualCheck: 'z' }) : P2()) });
  setY(withMismatch.fs, 2); await withMismatch.run();
  assert.equal(jobs(withMismatch)[0].verdict, 'MISMATCH');
});

test('6b. two lenses sharing one photo -> photo analysed once in pass 1, lenses still judged separately', async () => {
  const lenses = [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 2: 9 } }, { name: 'Canon EF 85mm f/1.8 USM', brand: 'Canon', focal: '85mm', scores: { 2: 9 } }];
  const rig = makeRig({ lenses }); setY(rig.fs, 2); await rig.run();
  assert.equal(rig.openai.calls.filter(c => c.pass === 1).length, 1); assert.equal(rig.openai.calls.filter(c => c.pass === 2).length, 2);
  assert.equal(jobs(rig)[0].verdict, 'PASS');
});

test('7. lens + non-lens products: only the lens is verified; others recorded as ignored', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }], nonLens: ['Canon EOS 6D body', 'Godox TT600 flash'] });
  setY(rig.fs, 2); await rig.run();
  assert.equal(rig.openai.calls.length, 2);
  const rep = JSON.parse(jobs(rig).length && rig.queue.get(jobs(rig)[0].id).report_json);
  assert.deepEqual(rep.nonLensProductsIgnored.sort(), ['Canon EOS 6D body', 'Godox TT600 flash']); assert.equal(rep.lenses.length, 1);
});

test('8. Y on ANY row of a multi-row listing (merged or unmerged) verifies the whole listing once; status lands on the listing\'s rows', async () => {
  const lenses = [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: VR, focal: '70-300mm', scores: { 2: 9 } }, { name: 'Sigma 35mm f/1.4', brand: 'Sigma', focal: '35mm', scores: { 3: 9 } }];
  const rig = makeRig({ lenses });
  setY(rig.fs, 4);                                                                // 3rd row of the block, not the top row
  await rig.run();
  assert.equal(jobs(rig).length, 1); assert.equal(rig.queue.lenses(jobs(rig)[0].id).length, 3);
  assert.equal(rig.mainStatus(2).job, 'Done');                                    // written on the top row
  assert.ok(rig.fs.tab('Main').merges.some(m => m.startColumnIndex === 18 && m.startRowIndex === 1 && m.endRowIndex === 4));   // merged over the listing like the scanner does

  const fs = new FakeSheets(); const listing = [{ id: ID, items: lenses.map(l => l.name) }, { id: '2000000000000002', items: ['Other lens'] }];
  seedMain(fs, listing, { merge: false });
  const rig2 = makeRig({ lenses, fs, listings: listing, seed: false });
  setY(fs, 4); await rig2.run();                                                  // merges removed by hand: block still found
  assert.equal(jobs(rig2).length, 1); assert.equal(jobs(rig2)[0].listing_id, ID); assert.equal(rig2.queue.lenses(jobs(rig2)[0].id).length, 3);
});

test('9. repeated / duplicate Y never creates duplicate jobs; completed listing is not re-run; clearing the status cell re-runs once', async () => {
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: 'Sigma 35mm', brand: 'Sigma', focal: '35mm', scores: { 2: 9 } }] });
  setY(rig.fs, 2); setY(rig.fs, 3);                                               // two rows, same listing
  for (let i = 0; i < 6; i++) await rig.lv.poll();                                // hammering the poller inside the debounce window
  assert.equal(jobs(rig).length, 0);                                              // nothing until the Y is stable
  await rig.run(); assert.equal(jobs(rig).length, 1);
  const before = rig.openai.calls.length;
  for (let i = 0; i < 5; i++) { rig.c.advance(60000); await rig.lv.poll(); await rig.lv.parts().worker.tick(); }
  assert.equal(jobs(rig).length, 1); assert.equal(rig.openai.calls.length, before);   // Y still there, finished -> no repeat
  rig.fs.set('Main', 1, 18, '');                                                  // intentional re-run: clear the status cell
  await rig.run(); assert.equal(jobs(rig).length, 2);
  assert.equal(rig.queue.get(jobs(rig)[0].id).rerun_of !== null || rig.queue.get(jobs(rig)[1].id).rerun_of !== null, true);
  const dup = rig.queue.create({ listingId: ID }); assert.equal(dup.created, true);   // finished jobs don't block a new one…
  const dup2 = rig.queue.create({ listingId: ID }); assert.equal(dup2.created, false); // …but two ACTIVE jobs for one listing are impossible (DB-enforced)
});

test('10a. a lens with no usable photo is reported as a processing error; other lenses keep their results; listing is NOT shown as Pass', async () => {
  const ev = makeEvidence({ id: ID, lenses: [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: 'Sigma 35mm', brand: 'Sigma', focal: '35mm', scores: {} }] });
  const rig = makeRig({ lenses: [{ name: 'Canon EF 50mm f/1.8 STM', focal: '50mm', scores: { 1: 9 } }, { name: 'Sigma 35mm', focal: '35mm', scores: {} }], evidenceOverride: { [ID]: ev } });
  setY(rig.fs, 2); await rig.run();
  const j = jobs(rig)[0]; assert.equal(j.status, 'done'); assert.equal(j.verdict, 'ERROR');
  const ls = rig.queue.lenses(j.id); assert.equal(ls[0].status, 'done'); assert.equal(ls[0].outcome, 'PASS'); assert.equal(ls[1].status, 'error'); assert.equal(ls[1].error_code, 'NO_IMAGE');
  assert.equal(rig.mainStatus(2).result, 'Error'); assert.match(rig.mainStatus(2).summary, /could not be verified/); assert.notEqual(rig.mainStatus(2).result, 'Pass');
  assert.equal(resultsRows(rig)[1][6], 'Pass'); assert.equal(resultsRows(rig)[2][6], 'Error');
});

test('10b. expired photo link -> lens error (no substitute photo); live Facebook listing is never required (saved evidence used and reported as such)', async () => {
  const ev = makeEvidence({ id: ID, lenses: [{ name: VR, focal: '70-300mm', scores: { 2: 9, 1: 5 } }] }); ev.imageUrls[1] = 'https://cdn.example/missing2.jpg';
  const rig = makeRig({ lenses: [lensVR], evidenceOverride: { [ID]: ev } }); setY(rig.fs, 2); await rig.run();
  const j = jobs(rig)[0]; assert.equal(j.status, 'failed'); assert.equal(rig.openai.calls.length, 0);   // no AI call, no photo-1 substitution
  assert.equal(rig.mainStatus(2).job, 'Failed'); assert.match(rig.mainStatus(2).summary, /expired|IMAGE_UNAVAILABLE/);
  const ok = makeRig({ lenses: [lensVR] }); setY(ok.fs, 2); await ok.run();
  assert.match(JSON.parse(ok.queue.get(jobs(ok)[0].id).report_json).evidenceSource, /saved/);
});

test('10c. no saved scan snapshot (listing scanned before capture existed) -> clear failure telling you to re-scan; not a verdict', async () => {
  const rig = makeRig({ lenses: [lensVR], evidenceOverride: {} }); setY(rig.fs, 2); await rig.run();
  const j = jobs(rig)[0]; assert.equal(j.status, 'failed'); assert.equal(j.error_code, 'NO_EVIDENCE');
  assert.equal(rig.mainStatus(2).job, 'Failed'); assert.match(rig.mainStatus(2).summary, /Re-scan/i);
});

test('11a. API failure (429) then success on retry: backoff, "Retrying" shown, final result correct', async () => {
  let n = 0;
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => { if (pass === 1 && n++ === 0) throw httpErr(429, 'rate limited'); return pass === 1 ? P1() : P2(); } });
  setY(rig.fs, 2); await rig.run();
  let j = jobs(rig)[0]; assert.equal(j.status, 'retry_wait'); assert.equal(j.error_code, 'AI_RATE_LIMITED'); assert.equal(rig.mainStatus(2).job, 'Retrying (1/5)');
  await rig.lv.parts().worker.tick(); assert.equal(rig.queue.get(j.id).status, 'retry_wait');   // not due yet: backoff respected
  rig.c.advance(31000); await rig.lv.parts().worker.tick();
  j = rig.queue.get(j.id); assert.equal(j.status, 'done'); assert.equal(j.verdict, 'PASS'); assert.equal(j.attempts, 2); assert.equal(rig.mainStatus(2).job, 'Done');
});

test('11b. partial progress is kept across retries (finished lens is not re-run); exhausted retries end as Failed with partial results preserved', async () => {
  const lenses = [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: VR, focal: '70-300mm', scores: { 2: 9 } }];
  const rig = makeRig({ lenses, script: ({ pass, prompt }) => { if (pass === 1 && prompt.includes('lens #2')) throw httpErr(503); return pass === 1 ? P1() : P2(); } });
  setY(rig.fs, 2); await rig.run();
  for (let i = 0; i < 6; i++) { rig.c.advance(3700000); await rig.lv.parts().worker.tick(); }
  const j = jobs(rig)[0]; assert.equal(j.status, 'done');                         // lens 1 succeeded, lens 2 permanently unverifiable after 5 attempts
  assert.equal(j.attempts, 5); assert.equal(j.verdict, 'ERROR');
  const ls = rig.queue.lenses(j.id); assert.equal(ls[0].outcome, 'PASS'); assert.equal(ls[1].status, 'error');
  assert.equal(rig.openai.calls.filter(c => c.pass === 2).length, 1);             // lens 1 pass-2 ran exactly once across all attempts
  assert.equal(rig.mainStatus(2).result, 'Error');
  const dead = makeRig({ lenses: [lensVR], script: () => { throw httpErr(429); } }); setY(dead.fs, 2); await dead.run();
  for (let i = 0; i < 6; i++) { dead.c.advance(3700000); await dead.lv.parts().worker.tick(); }
  assert.equal(jobs(dead)[0].status, 'failed'); assert.equal(dead.mainStatus(2).job, 'Failed');
});

test('11c. malformed model output is re-asked once inside the same attempt; auth errors are not retried', async () => {
  let n = 0;
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => (pass === 1 && n++ === 0 ? 'not json at all' : pass === 1 ? P1() : P2()) });
  setY(rig.fs, 2); await rig.run(); assert.equal(jobs(rig)[0].status, 'done'); assert.equal(jobs(rig)[0].attempts, 1);
  const bad = makeRig({ lenses: [lensVR], script: () => { throw httpErr(401, 'bad key'); } }); setY(bad.fs, 2); await bad.run();
  assert.equal(jobs(bad)[0].attempts, 1); assert.equal(jobs(bad)[0].status, 'failed');
});

test('12. restart while a job is running: it is resumed, finished lenses are kept, nothing is stranded or duplicated', async () => {
  const lenses = [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: VR, focal: '70-300mm', scores: { 2: 9 } }];
  const rig = makeRig({ lenses }); setY(rig.fs, 2);
  await rig.lv.poll(); rig.c.advance(21000); await rig.lv.poll();                 // job created (pending)
  const claimed = rig.queue.claimNext();                                          // worker picks it up…
  rig.queue.saveLens({ jobId: claimed.id, lensKey: 'lens_1', position: 0, status: 'done', outcome: 'PASS', result: { lensKey: 'lens_1', position: 0, status: 'done', outcome: 'PASS', scannerName: 'Canon EF 50mm f/1.8 STM', image: { url: 'u', index: 1, score: 9 }, evidenceUsed: {} } });
  assert.equal(rig.queue.get(claimed.id).status, 'running');                       // …and the process dies here
  const r2 = makeRig({ lenses, db: rig.db, fs: rig.fs, seed: false });             // new process, same database + sheet
  r2.c.t = rig.c.t;
  assert.equal(r2.queue.recoverStale(), 1);
  for (let i = 0; i < 5; i++) await r2.lv.parts().worker.tick();
  const j = r2.queue.get(claimed.id); assert.equal(j.status, 'done'); assert.equal(j.verdict, 'PASS');
  assert.equal(r2.openai.calls.filter(c => c.pass === 2).length, 1);               // only the unfinished lens was re-checked
  assert.equal(r2.mainStatus(2).job, 'Done'); assert.equal(jobs(r2).length, 1);
});

test('safety: only Main!S:V (status) and the results tab are ever written; scanner columns A:R and the trigger cell are untouched', async () => {
  const lenses = [{ name: 'Canon EF 50mm f/1.8 STM', brand: 'Canon', focal: '50mm', scores: { 1: 9 } }, { name: VR, focal: '70-300mm', scores: { 2: 9 } }];
  const rig = makeRig({ lenses }); setY(rig.fs, 2);
  const snap = () => { const o = {}; for (const [k, v] of rig.fs.tab('Main').grid) { const c = +k.split(',')[1]; if (c < 18) o[k] = v; } return JSON.stringify(o); };
  const before = snap(); await rig.run();
  assert.equal(snap(), before);
  for (const w of rig.fs.writes) assert.ok(/^'Lens Verification'!|^'Main'!(S|T|U|V)\d+$/.test(w), `unexpected write ${w}`);
  assert.deepEqual(rig.fs.rows('Main')[0].slice(18), ['Verify Job', 'Verify Result', 'Verify Summary', 'Verify Report']);
  assert.equal(rig.fs.tabs.size, 2);                                               // Main + Lens Verification, nothing else
});

test('safety: refuses to create status columns over existing data; reuses existing headers by name', async () => {
  const fs = new FakeSheets(); const listing = [{ id: ID, items: [VR] }]; seedMain(fs, listing); fs.set('Main', 1, 18, 'someone elses note');   // data sits where S would be
  const rig = makeRig({ lenses: [lensVR], fs, listings: listing, seed: false }); setY(fs, 2);
  await rig.run();
  assert.equal(fs.get('Main', 1, 18), 'someone elses note');                       // never overwritten
  assert.equal(jobs(rig)[0].status, 'done');                                       // job itself still completes; results tab has the report
  assert.ok(jobs(rig)[0].sheet_synced === 0 && rig.queue.get(jobs(rig)[0].id).sheet_error.includes('COLUMN_COLLISION'));
  assert.equal(resultsRows(rig).length >= 2, true);
});

test('job state and verdict are separate: Main shows job state while running, verdict only when finished', async () => {
  let seenDuring = null; let rigRef;
  const rig = makeRig({ lenses: [lensVR], script: ({ pass }) => { if (pass === 2) seenDuring = rigRef.mainStatus(2); return pass === 1 ? P1() : P2(); } }); rigRef = rig;
  setY(rig.fs, 2); await rig.run();
  assert.equal(seenDuring.job, 'Running'); assert.equal(seenDuring.result, '');
  assert.equal(rig.mainStatus(2).job, 'Done'); assert.equal(rig.mainStatus(2).result, 'Pass');
});
