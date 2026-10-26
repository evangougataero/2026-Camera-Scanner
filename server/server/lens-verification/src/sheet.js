// Google Sheets I/O for the Main tab (trigger column + status columns) and the "Lens Verification" results tab.
// Takes a googleapis v4 `sheets` client. Never touches existing scanner columns; status columns are found by HEADER NAME
// and only created in empty columns to the right of the last used header.
import { listingIdFromUrl, runIdFromLogCell } from './evidence.js';

export const colIndex = (L) => String(L).toUpperCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
export const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const safe = (v) => { const t = String(v ?? ''); return /^[=+\-@]/.test(t) ? `'${t}` : t; };
const q = (name) => `'${String(name).replace(/'/g, "''")}'`;
const RESULT_HEADERS = ['Verified At', 'Listing ID', 'Facebook Listing', 'Job ID', 'Lens #', 'Original Scanner Identification', 'Verification', 'Independent Identification', 'Potential Alternative',
  'Finding', 'Potential Value Impact', 'Recommended Manual Check', 'Photo Used', 'Evidence Used', 'Notes', 'Full Report (JSON)'];
const COLORS = { Pass: { red: 0.80, green: 0.93, blue: 0.80 }, Review: { red: 1, green: 0.90, blue: 0.60 }, Mismatch: { red: 0.96, green: 0.70, blue: 0.68 }, Error: { red: 0.85, green: 0.85, blue: 0.85 } };

export function createSheet({ sheets, cfg, log = console.log }) {
  const ssId = cfg.spreadsheetId;
  // Column letters are only the fallback: on every read the header row decides (so adding/removing/reordering columns on Main is safe).
  let trig = colIndex(cfg.triggerColumn), urlCol = colIndex(cfg.urlColumn), logCol = colIndex(cfg.logColumn);
  const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function resolveColumns(rows) {
    const hdr = (rows[0] || []).map(norm);
    const find = (test) => hdr.findIndex(test);
    const t = find(h => h.startsWith('interested')), u = find(h => h === 'facebooklink' || h === 'facebookurl' || h === 'listinglink'), l = find(h => h === 'loglink' || h === 'analysislog' || h === 'viewlog');
    if (t >= 0) trig = t; if (u >= 0) urlCol = u; if (l >= 0) logCol = l;
  }
  let resultsGid = null;

  async function readMain() {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: ssId, range: `${q(cfg.mainTab)}!A1:AD`, valueRenderOption: 'FORMULA' });
    const rows = r.data.values || []; resolveColumns(rows); return rows;
  }
  async function meta() {
    const r = await sheets.spreadsheets.get({ spreadsheetId: ssId, fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)),merges)' });
    const all = r.data.sheets || [];
    const main = all.find(s => s.properties.title === cfg.mainTab);
    if (!main) throw new Error(`Tab not found: ${cfg.mainTab}`);
    return { mainGid: main.properties.sheetId, mainCols: main.properties.gridProperties?.columnCount ?? null, merges: main.merges || [], all };
  }
  const cell = (rows, r, c) => String((rows[r] || [])[c] ?? '');
  const logUrlOf = (c) => (String(c).match(/https?:\/\/[^"')\s]+\.log/) || [''])[0];

  /**
   * [start,end) 0-based rows of the listing containing row r. The scanner merges the listing columns across its rows, so the merge is
   * authoritative. If the merge is gone (unmerged by hand), fall back to the contiguous run of rows around r that has no OTHER listing link.
   */
  function blockOf(r, merges, rows) {
    for (const c of [urlCol, trig]) {
      const m = merges.find(x => x.startColumnIndex <= c && c < x.endColumnIndex && x.startRowIndex <= r && r < x.endRowIndex);
      if (m) return [m.startRowIndex, m.endRowIndex];
    }
    if (!rows) return [r, r + 1];
    const hasUrl = (i) => !!listingIdFromUrl(cell(rows, i, urlCol));
    let s = r; while (s > 1 && !hasUrl(s) && r - s < 12) s--;
    if (!hasUrl(s)) return [r, r + 1];
    let e = s + 1; while (e < rows.length && !hasUrl(e) && cell(rows, e, 0).trim() && e - s < 12) e++;
    return [s, Math.max(e, r + 1)];
  }
  function listingOfBlock(rows, [s, e]) {
    for (let r = s; r < e; r++) { const id = listingIdFromUrl(cell(rows, r, urlCol)); if (id) return { id, url: cell(rows, r, urlCol), row: r }; }
    return null;
  }
  const headerIdx = (rows, name) => (rows[0] || []).findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
  const statusCols = (rows) => { const h = cfg.statusHeaders; const o = { job: headerIdx(rows, h.job), result: headerIdx(rows, h.result), summary: headerIdx(rows, h.summary), report: headerIdx(rows, h.report) }; return Object.values(o).every(i => i >= 0) ? o : null; };

  /** A tab only has as many columns as it was created with (your Main tab: A–Q). Writing past that fails, so add columns first. */
  async function ensureColumns(needed) {
    const { mainGid, mainCols } = await meta();
    if (mainCols == null || mainCols >= needed) return;
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [{ appendDimension: { sheetId: mainGid, dimension: 'COLUMNS', length: needed - mainCols } }] } });
    log(`[LENS VERIFY] ${cfg.mainTab} tab had ${mainCols} columns; added ${needed - mainCols} so the status columns fit.`);
  }

  async function ensureStatusColumns(rows) {
    const have = statusCols(rows); if (have) return have;
    const hdr = rows[0] || []; let last = -1; hdr.forEach((h, i) => { if (String(h).trim()) last = i; });
    const start = Math.max(last + 1, 18);                                        // never earlier than column S
    const missing = ['job', 'result', 'summary', 'report'].filter(k => headerIdx(rows, cfg.statusHeaders[k]) < 0);
    // Use the existing columns for headers already present; place missing ones in free columns to the right.
    const idx = {}; let next = start;
    for (const k of ['job', 'result', 'summary', 'report']) { const f = headerIdx(rows, cfg.statusHeaders[k]); idx[k] = f >= 0 ? f : next++; }
    for (const k of missing) { for (let r = 1; r < rows.length; r++) if (cell(rows, r, idx[k]).trim()) throw new Error(`COLUMN_COLLISION: ${colLetter(idx[k])} already has data; refusing to overwrite.`); }
    await ensureColumns(Math.max(...Object.values(idx)) + 1);
    await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: { valueInputOption: 'RAW', data: missing.map(k => ({ range: `${q(cfg.mainTab)}!${colLetter(idx[k])}1`, values: [[cfg.statusHeaders[k]]] })) } });
    return idx;
  }

  return {
    /** Returns every listing that currently has Y in the trigger column (any row of its block), de-duplicated by listing. */
    async scan() {
      const rows = await readMain();
      const hits = []; for (let r = 1; r < rows.length; r++) if (cell(rows, r, trig).trim().toUpperCase() === 'Y') hits.push(r);
      if (!hits.length) return [];
      const { merges } = await meta();
      const sc = statusCols(rows), out = new Map();
      for (const r of hits) {
        const block = blockOf(r, merges, rows), l = listingOfBlock(rows, block);
        if (!l) { log(`[LENS VERIFY] Y in row ${r + 1} but no Facebook listing link found in its block; skipped.`); continue; }
        if (out.has(l.id)) continue;
        const runId = runIdFromLogCell(cell(rows, block[0], logCol)) || runIdFromLogCell(cell(rows, l.row, logCol));
        out.set(l.id, { listingId: l.id, facebookUrl: l.url, runId, logUrl: logUrlOf(cell(rows, block[0], logCol)), block: [block[0] + 1, block[1]], statusCell: sc ? cell(rows, block[0], sc.job).trim() : '', signature: `${l.id}|${block[0]}-${block[1]}|${runId}` });
      }
      return [...out.values()];
    },

    /** Where is this listing right now (rows can move)? */
    async locate(listingId) {
      const rows = await readMain();
      let r0 = -1; for (let r = 1; r < rows.length; r++) if (listingIdFromUrl(cell(rows, r, urlCol)) === listingId) { r0 = r; break; }
      if (r0 < 0) return null;
      const { merges } = await meta(); const b = blockOf(r0, merges, rows);
      return { rows: [b[0] + 1, b[1]], runId: runIdFromLogCell(cell(rows, b[0], logCol)), logUrl: logUrlOf(cell(rows, b[0], logCol)), facebookUrl: cell(rows, r0, urlCol) };
    },

    async writeStatus(listingId, { job, result, summary, resultsRow }) {
      const rows = await readMain(); const idx = await ensureStatusColumns(rows);
      let r0 = -1; for (let r = 1; r < rows.length; r++) if (listingIdFromUrl(cell(rows, r, urlCol)) === listingId) { r0 = r; break; }
      if (r0 < 0) throw new Error(`Listing ${listingId} is no longer on the ${cfg.mainTab} tab.`);
      const { merges, mainGid } = await meta(); const [s, e] = blockOf(r0, merges, rows); const row = s + 1;
      if (resultsRow && resultsGid == null) await this.ensureResultsTab();
      const report = resultsRow && resultsGid != null ? `=HYPERLINK("https://docs.google.com/spreadsheets/d/${ssId}/edit#gid=${resultsGid}&range=A${resultsRow}","Open report")` : '';
      const vals = { job, result, summary, report };
      await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: ssId, requestBody: { valueInputOption: 'USER_ENTERED', data: ['job', 'result', 'summary', 'report'].map(k => ({ range: `${q(cfg.mainTab)}!${colLetter(idx[k])}${row}`, values: [[k === 'report' ? vals[k] : safe(vals[k])]] })) } });
      const requests = [];
      if (e - s > 1) for (const k of ['job', 'result', 'summary', 'report']) requests.push({ mergeCells: { range: { sheetId: mainGid, startRowIndex: s, endRowIndex: e, startColumnIndex: idx[k], endColumnIndex: idx[k] + 1 }, mergeType: 'MERGE_ALL' } });
      const color = COLORS[result];
      requests.push({ repeatCell: { range: { sheetId: mainGid, startRowIndex: s, endRowIndex: s + 1, startColumnIndex: idx.result, endColumnIndex: idx.result + 1 }, cell: { userEnteredFormat: { backgroundColor: color || { red: 1, green: 1, blue: 1 } } }, fields: 'userEnteredFormat.backgroundColor' } });
      requests.push({ repeatCell: { range: { sheetId: mainGid, startRowIndex: s, endRowIndex: s + 1, startColumnIndex: idx.summary, endColumnIndex: idx.summary + 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } });
      try { await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests } }); } catch (err) { log('[LENS VERIFY] cosmetic formatting/merge skipped:', err.message); }   // text already written; merges/colour are best-effort
    },

    async ensureResultsTab() {
      const { all } = await meta();
      let t = all.find(s => s.properties.title === cfg.resultsTab);
      if (!t) {
        const r = await sheets.spreadsheets.batchUpdate({ spreadsheetId: ssId, requestBody: { requests: [{ addSheet: { properties: { title: cfg.resultsTab, gridProperties: { frozenRowCount: 1 } } } }] } });
        resultsGid = r.data.replies[0].addSheet.properties.sheetId;
        await sheets.spreadsheets.values.update({ spreadsheetId: ssId, range: `${q(cfg.resultsTab)}!A1`, valueInputOption: 'RAW', requestBody: { values: [RESULT_HEADERS] } });
      } else resultsGid = t.properties.sheetId;
      return resultsGid;
    },

    /** One row per lens (or a single note row). Returns the first appended row number. */
    async appendResults(job, lensRows, report) {
      await this.ensureResultsTab();
      const when = report?.generatedAt || new Date().toISOString();
      const link = report?.facebookUrl ? `=HYPERLINK("${report.facebookUrl}","Open listing")` : '';
      const body = (lensRows.length ? lensRows : [{ status: 'done', outcome: 'N/A', scannerName: '', finding: report?.summary || job.summary || '' }]).map((l, i) => {
        const done = l.status === 'done';
        const photo = done && l.image?.url ? `=HYPERLINK("${l.image.url}","Photo ${l.image.index} (score ${l.image.score})")` : '';
        const used = done ? `${l.evidenceUsed?.source || 'saved'}: title${l.evidenceUsed?.description ? ' + description' : ''}${l.evidenceUsed?.ocrHint ? ' + OCR hint' : ''} + 1 photo` : '';
        const notes = [l.evidenceLimited ? 'Evidence-limited result.' : '', l.guardrail?.applied ? `Adjusted from ${l.rawOutcome}: ${l.guardrail.reason}` : '', l.image?.selection && l.image.selection !== 'highest_score' ? `Photo chosen by: ${l.image.selection}.` : '', report && report.sheetRunIdMatchedSnapshot === false ? 'Sheet row was scanned in a different run than the snapshot used.' : ''].filter(Boolean).join(' ');
        return [when, job.listing_id, link, job.id, i + 1, safe(l.scannerName || ''), done ? (l.outcome || '').charAt(0) + (l.outcome || '').slice(1).toLowerCase() : 'Error',
          safe(l.independentIdentification || ''), safe(l.potentialAlternative || ''), safe(done ? l.finding || '' : l.error || l.errorCode || ''), safe(l.valueImpact?.level && l.valueImpact.level !== 'none' ? `${l.valueImpact.level}: ${l.valueImpact.description || ''}` : ''),
          safe(l.recommendedCheck || (done && l.outcome === 'PASS' ? 'No manual action necessary.' : '')), photo, used, safe(notes), job.report_url || ''];
      });
      const r = await sheets.spreadsheets.values.append({ spreadsheetId: ssId, range: `${q(cfg.resultsTab)}!A1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: body } });
      const m = String(r.data?.updates?.updatedRange || '').match(/!?[A-Z]+(\d+):/);
      return m ? Number(m[1]) : null;
    }
  };
}
