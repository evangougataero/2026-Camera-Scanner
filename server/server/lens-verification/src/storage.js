// Evidence snapshots + audit reports. Written to Supabase (same bucket as the scanner's hit logs) AND to local disk as a fallback.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function createStorage({ supabase, bucket, prefix = 'lens-verification', dir = 'lens-verification-data', log = console.log }) {
  const evPath = (listingId, runId) => `${prefix}/evidence/${listingId}/${runId}.json`;
  const diskPath = (...p) => path.join(dir, ...p);
  const writeDisk = (rel, data) => { try { const f = diskPath(rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); } catch (e) { log('[LENS VERIFY] disk write failed:', e.message); } };

  async function upload(rel, text) {
    if (!supabase) return null;
    const { error } = await supabase.storage.from(bucket).upload(rel, Buffer.from(text, 'utf8'), { contentType: 'application/json; charset=utf-8', cacheControl: '60', upsert: true });
    if (error) throw new Error(`Supabase upload failed: ${error.message || error}`);
    return supabase.storage.from(bucket).getPublicUrl(rel)?.data?.publicUrl || null;
  }
  async function download(rel) {
    if (!supabase) return null;
    const { data, error } = await supabase.storage.from(bucket).download(rel);
    if (error || !data) return null;
    return await data.text();
  }

  return {
    async save(evidence) {
      if (!evidence.listingId || !evidence.runId) throw new Error('Evidence needs listingId and runId.');
      const rel = evPath(evidence.listingId, evidence.runId), text = JSON.stringify(evidence);
      writeDisk(rel, text);                                                    // local copy first: survives a Supabase outage
      try { await upload(rel, text); } catch (e) { log('[LENS VERIFY] evidence kept on disk only:', e.message); }
      return rel;
    },
    /** Exact run if the sheet tells us which scan produced the row; otherwise the newest snapshot for the listing. */
    async load(listingId, runIdHint) {
      const tryRun = async (runId) => {
        const rel = evPath(listingId, runId);
        let text = null; try { text = await download(rel); } catch (e) { /* fall through to disk */ }
        if (!text) { try { text = fs.readFileSync(diskPath(rel), 'utf8'); } catch (e) { /* none */ } }
        return text ? JSON.parse(text) : null;
      };
      if (runIdHint) { const ev = await tryRun(runIdHint); if (ev) return { evidence: ev, runIdMismatch: false }; }
      const names = new Set();
      try { const { data } = supabase ? await supabase.storage.from(bucket).list(`${prefix}/evidence/${listingId}`, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } }) : { data: [] }; (data || []).forEach(o => names.add(o.name)); } catch (e) { /* ignore */ }
      try { fs.readdirSync(diskPath(prefix, 'evidence', listingId)).forEach(n => names.add(n)); } catch (e) { /* none */ }
      let best = null;
      for (const n of [...names].filter(n => n.endsWith('.json'))) { const ev = await tryRun(n.replace(/\.json$/, '')); if (ev && (!best || ev.capturedAt > best.capturedAt)) best = ev; }
      return best ? { evidence: best, runIdMismatch: !!runIdHint } : null;
    },
    /** The scanner's own Analysis Log (what column I's "View Log" opens). Supabase object first, then the public link from the sheet. */
    async loadScannerLog({ listingId, runId, url }, fetchImpl = globalThis.fetch) {
      if (runId && listingId && supabase) {
        try { const { data, error } = await supabase.storage.from(bucket).download(`${listingId}/${runId}.log`); if (!error && data) return await data.text(); } catch (e) { /* try the link */ }
      }
      if (url && fetchImpl) {
        try { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000); const r = await fetchImpl(url, { signal: ctl.signal }); clearTimeout(t); if (r.ok) return await r.text(); } catch (e) { /* none */ }
      }
      return null;
    },
    async saveImage(rel, buffer, mime = 'image/jpeg') {
      writeDisk(rel, buffer);
      if (supabase) { const { error } = await supabase.storage.from(bucket).upload(rel, buffer, { contentType: mime, cacheControl: '3600', upsert: true }); if (error) log('[LENS VERIFY] image kept on disk only:', error.message || error); }
      return rel;
    },
    async loadImage(rel) {
      let buf = null;
      if (supabase) { try { const { data, error } = await supabase.storage.from(bucket).download(rel); if (!error && data) buf = Buffer.from(await data.arrayBuffer()); } catch (e) { /* disk */ } }
      if (!buf) { try { buf = fs.readFileSync(diskPath(rel)); } catch (e) { return null; } }
      return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16) };
    },
    async uploadReport(job, report) {
      const rel = `${prefix}/reports/${job.listing_id}/${job.id}.json`, text = JSON.stringify(report, null, 2);
      writeDisk(rel, text);
      return await upload(rel, text);
    }
  };
}
