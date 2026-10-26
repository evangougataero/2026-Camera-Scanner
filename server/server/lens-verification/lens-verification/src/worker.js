import { mapLensItems, selectLensImage } from './evidence.js';
import { applyGuardrails, aggregate, summarize } from './validate.js';
import { VerifyError, classifyError } from './ai.js';
import { parseScannerLog, notesForLens } from './scannerLog.js';

const JOB_LABEL = { pending: 'Pending', running: 'Running', retry_wait: 'Retrying', done: 'Done', failed: 'Failed' };
const VERDICT_LABEL = { PASS: 'Pass', REVIEW: 'Review', MISMATCH: 'Mismatch', ERROR: 'Error', NO_LENSES: 'No lenses' };
export const jobLabel = (j) => (j.status === 'retry_wait' ? `Retrying (${j.attempts}/${j.max_attempts})` : JOB_LABEL[j.status] || j.status);
export const verdictLabel = (v) => VERDICT_LABEL[v] || '';

const ERROR_HELP = {
  NO_EVIDENCE: 'No saved scan snapshot for this listing (scanned before verification capture was installed, or the save failed). Re-scan the listing, then clear the Verify Job cell to re-run.',
  IMAGE_UNAVAILABLE: 'The selected photo link has expired or was removed.', AI_AUTH: 'OpenAI rejected the API key.', AMBIGUOUS_LENS_MAPPING: 'Could not tell which photo belongs to this lens.'
};

export function createWorker({ queue, cfg, ai, evidenceStore, sheet, uploadReport, prepare, log = console.log, now = () => Date.now() }) {
  let busy = false;

  async function loadEvidence(job) {
    let ctx = null;
    try { ctx = await sheet.locate(job.listing_id); } catch (e) { log('[LENS VERIFY] could not read sheet context:', e.message); }
    const hint = ctx?.runId || '';
    const ev = await evidenceStore.load(job.listing_id, hint);
    if (!ev) throw new VerifyError('NO_EVIDENCE', ERROR_HELP.NO_EVIDENCE);
    // The scanner's own Analysis Log: used for its grades (backfill/cross-check) and its resolution reasoning. Never required.
    let parsedLog = null, logMeta = { used: false };
    try {
      const text = await evidenceStore.loadScannerLog?.({ listingId: job.listing_id, runId: ev.evidence.runId || hint, url: ctx?.logUrl });
      if (text) { parsedLog = parseScannerLog(text); logMeta = { used: true, ...parsedLog.stats }; }
    } catch (e) { log('[LENS VERIFY] scanner log not read (continuing without it):', e.message); }
    let evidence = ev.evidence;
    if (parsedLog && !(evidence.galleryResults || []).length && parsedLog.galleries.length) { evidence = { ...evidence, galleryResults: parsedLog.galleries }; logMeta.gradesFromLog = true; }
    return { ...ev, evidence, parsedLog, logMeta, sheetRows: ctx?.rows || null, sheetRunId: hint };
  }

  async function runLens({ job, planned, ev, position, total, cache, existing }) {
    const key = planned.productId;
    const sel = selectLensImage(ev.evidence, key);
    if (!sel.ok) throw new VerifyError('NO_IMAGE', `No usable rated photo for this lens (${sel.reason}).`);
    let prepared = cache.images.get(sel.url);
    if (!prepared) { prepared = await prepare(sel.url, ev.evidence); cache.images.set(sel.url, prepared); }
    let imageCrossCheck = null;
    if (ev.parsedLog?.galleries?.length) { const sl = selectLensImage({ ...ev.evidence, galleryResults: ev.parsedLog.galleries }, key); if (sl.ok) imageCrossCheck = { scannerLogImageIndex: sl.imageIndex, usedImageIndex: sel.imageIndex, agrees: sl.imageIndex === sel.imageIndex }; }
    const scannerNotes = [...(planned.product?.extracted_evidence || []).slice(0, 8).map(x => `Evidence string: ${x}`), ...notesForLens(ev.parsedLog, key, 1800, !!planned.product?.extracted_evidence?.length)];
    let p1 = cache.pass1.get(sel.url) || (existing?.pass1 && existing.pass1._url === sel.url ? existing.pass1 : null);
    if (!p1) {
      p1 = await ai.pass1({ image: prepared, title: ev.evidence.title, description: ev.evidence.description, ocrText: sel.ocrText, lensNumber: position + 1, lensCount: total });
      p1._url = sel.url;
      cache.pass1.set(sel.url, p1);
    }
    queue.saveLens({ jobId: job.id, lensKey: key, position, status: 'partial', pass1: p1 });
    const p2raw = await ai.pass2({
      image: prepared, title: ev.evidence.title, description: ev.evidence.description, scannerName: planned.item.name,
      scannerIdentity: ev.parsedLog?.resolved?.[key]?.identity || planned.product?.lensIdentity || null, scannerResale: planned.item.estimatedResale, scannerNotes,
      pass1: p1, lensNumber: position + 1, lensCount: total
    });
    const p2 = applyGuardrails(p2raw);
    const alt = p2.alternatives[0];
    return {
      lensKey: key, position, status: 'done', outcome: p2.outcome, rawOutcome: p2.rawOutcome, guardrail: p2.guardrail,
      scannerName: planned.item.name, scannerResale: planned.item.estimatedResale, mapping: planned.method,
      independentIdentification: p2.independentIdentification, agreement: p2.agreement, matchedPass1Lens: p2.matchedPass1Lens,
      potentialAlternative: alt ? alt.model : null, alternatives: p2.alternatives, contradictions: p2.contradictions,
      finding: p2.findingSummary, valueImpact: p2.valueImpact, recommendedCheck: p2.outcome === 'PASS' ? null : p2.recommendedManualCheck, evidenceLimited: p2.evidenceLimited,
      image: { url: sel.url, index: sel.imageIndex, score: sel.score, selection: sel.method, otherCandidates: sel.otherCandidates, bytes: prepared.bytes, sha256: prepared.sha256, fromArchivedCopy: !!prepared.archived },
      imageCrossCheck, scannerTrailLines: scannerNotes.length,
      evidenceUsed: { title: !!ev.evidence.title, description: !!ev.evidence.description, ocrHint: !!sel.ocrText, scannerLog: !!ev.parsedLog, source: 'saved' },
      pass1: { imageUsable: p1.imageUsable, imageNote: p1.imageNote, lenses: p1.lenses }
    };
  }

  async function process(job) {
    log(`[LENS VERIFY] job ${job.id} listing ${job.listing_id} attempt ${job.attempts}/${job.max_attempts}`);
    let ev;
    try { ev = await loadEvidence(job); }
    catch (e) {
      const c = classifyError(e);
      if (c.retriable) return queue.scheduleRetry(job.id, c);
      return queue.fail(job.id, { code: c.code, message: c.message, summary: `Could not run: ${ERROR_HELP[c.code] || c.message}` });
    }
    queue.setRunInfo(job.id, { runId: ev.evidence.runId, evidenceSource: 'saved' });

    const plan = mapLensItems(ev.evidence);
    const total = plan.mapped.length + plan.unmapped.length;
    if (!total) return finish(job, ev, plan, []);

    const saved = new Map(queue.lenses(job.id).map(l => [l.lens_key, l]));
    const cache = { images: new Map(), pass1: new Map() };
    let retriableLeft = null;

    for (let i = 0; i < plan.mapped.length; i++) {
      const planned = plan.mapped[i], prev = saved.get(planned.productId);
      if (prev && prev.status === 'done') continue;                                  // keep successful lenses across retries
      if (prev && prev.status === 'error' && !prev.retriable) continue;
      queue.heartbeat(job.id);
      try {
        const res = await runLens({ job, planned, ev, position: i, total, cache, existing: prev });
        queue.saveLens({ jobId: job.id, lensKey: planned.productId, position: i, status: 'done', outcome: res.outcome, result: res });
      } catch (e) {
        const c = classifyError(e);
        log(`[LENS VERIFY] lens ${planned.productId} failed: ${c.code} ${c.message}`);
        queue.saveLens({ jobId: job.id, lensKey: planned.productId, position: i, status: 'error', errorCode: c.code, errorMessage: c.message, retriable: c.retriable,
          result: { lensKey: planned.productId, position: i, status: 'error', scannerName: planned.item.name, errorCode: c.code, error: ERROR_HELP[c.code] || c.message } });
        if (c.retriable) retriableLeft = c;
        if (c.code === 'AI_AUTH') break;                                             // pointless to continue
      }
    }
    plan.unmapped.forEach((u, k) => queue.saveLens({ jobId: job.id, lensKey: `unmapped_${k}`, position: plan.mapped.length + k, status: 'error', errorCode: u.reason, errorMessage: ERROR_HELP.AMBIGUOUS_LENS_MAPPING, retriable: false,
      result: { lensKey: `unmapped_${k}`, status: 'error', scannerName: u.item.name, errorCode: u.reason, error: ERROR_HELP.AMBIGUOUS_LENS_MAPPING } }));

    if (retriableLeft && job.attempts < job.max_attempts) return queue.scheduleRetry(job.id, retriableLeft);
    return finish(job, ev, plan, queue.lenses(job.id));
  }

  async function finish(job, ev, plan, lensRows) {
    const lenses = lensRows.map(l => l.result || { status: l.status, errorCode: l.error_code, scannerName: l.lens_key }).map(r => ({ ...r, status: r.status === 'done' ? 'done' : 'error' }));
    const agg = aggregate(lenses);
    const summary = summarize(lenses, agg);
    const report = {
      schemaVersion: 1, jobId: job.id, listingId: job.listing_id, facebookUrl: ev.evidence.facebookUrl, scanRunId: ev.evidence.runId, generatedAt: new Date(now()).toISOString(),
      verdict: agg.verdict, incomplete: agg.incomplete, counts: agg.counts, summary, evidenceSource: `saved (scanner snapshot${ev.logMeta?.used ? ' + scanner Analysis Log' : ''}); live Facebook listing was not re-opened`, scannerLog: ev.logMeta || { used: false },
      sheetRunIdMatchedSnapshot: !ev.sheetRunId || ev.sheetRunId === ev.evidence.runId, model: cfg.model,
      listing: { title: ev.evidence.title, descriptionChars: (ev.evidence.description || '').length, imageCount: (ev.evidence.imageUrls || []).length },
      nonLensProductsIgnored: plan.nonLensItems, lenses
    };
    let reportUrl = null;
    try { reportUrl = await uploadReport(job, report); } catch (e) { log('[LENS VERIFY] report upload failed (kept in database):', e.message); }
    const nothingDone = lenses.length > 0 && lenses.every(l => l.status !== 'done');
    if (nothingDone) return queue.fail(job.id, { code: lenses[0].errorCode || 'ALL_LENSES_FAILED', message: summary, summary, reportUrl, reportJson: JSON.stringify(report) });
    return queue.complete(job.id, { verdict: agg.verdict, summary, reportUrl, reportJson: JSON.stringify(report) });
  }

  /** Pushes job state (+ results rows once finished) to the sheet. Failure leaves sheet_synced=0 so it is retried. */
  const syncFails = new Map();                                                    // jobId -> { n, nextAt }: do not hammer the Sheets API (or the log) when a sync keeps failing
  const syncKey = (job) => `${job.id}:${job.status}:${job.attempts}`;            // a new job state is synced immediately; only repeats of the SAME state back off
  const syncDue = (job) => { const f = syncFails.get(syncKey(job)); return !f || now() >= f.nextAt; };
  async function syncJob(job) {
    try {
      let resultsRow = job.results_row || null;
      if ((job.status === 'done' || job.status === 'failed') && !resultsRow) {
        const rep = job.report_json ? JSON.parse(job.report_json) : null;
        const lensRows = rep ? rep.lenses : queue.lenses(job.id).map(l => l.result).filter(Boolean);
        resultsRow = await sheet.appendResults(job, lensRows, rep);
      }
      await sheet.writeStatus(job.listing_id, { job: jobLabel(job), result: verdictLabel(job.verdict), summary: job.summary || job.last_error || '', resultsRow });
      queue.markSynced(job.id, resultsRow); syncFails.delete(syncKey(job));
      return true;
    } catch (e) {
      const f = syncFails.get(syncKey(job)) || { n: 0 }; f.n++; f.nextAt = now() + Math.min(10 * 60000, 15000 * 2 ** (f.n - 1)); syncFails.set(syncKey(job), f);
      queue.markSyncFailed(job.id, e.message);
      if (f.n === 1 || f.n % 10 === 0) log(`[LENS VERIFY] sheet sync failed (attempt ${f.n}; next try in ${Math.round((f.nextAt - now()) / 1000)}s):`, e.message);
      return false;
    }
  }

  return {
    syncJob, process,
    /** One scheduler step: run the next due job, then flush any unsynced sheet state. Never overlaps itself. */
    async tick() {
      if (busy) return false; busy = true;
      try {
        const job = queue.claimNext();
        if (job) { await syncJob(queue.get(job.id)); let r; try { r = await process(job); } catch (e) { const c = classifyError(e); log('[LENS VERIFY] job crashed:', e); r = queue.scheduleRetry(job.id, c); } }
        for (const j of queue.unsynced()) if (syncDue(j)) await syncJob(j);
        return !!job;
      } finally { busy = false; }
    }
  };
}
