// Central settings. Everything can be overridden with environment variables (.env) in the scanner server.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v != null ? n : d; };

export function loadConfig(env = process.env) {
  return {
    enabled: String(env.LENS_VERIFY_ENABLED ?? 'true').toLowerCase() !== 'false',
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
    mainTab: env.GOOGLE_SHEETS_TAB_NAME || 'Main',
    resultsTab: env.LENS_VERIFY_RESULTS_TAB || 'Lens Verification',
    triggerColumn: (env.LENS_VERIFY_TRIGGER_COLUMN || 'O').toUpperCase(),     // "Interested"
    urlColumn: 'B', logColumn: 'I',                                              // as written by appendSavedDealToGoogleSheet
    statusHeaders: { job: 'Verify Job', result: 'Verify Result', summary: 'Verify Summary', report: 'Verify Report' },
    pollMs: num(env.LENS_VERIFY_POLL_MS, 30000),
    debounceMs: num(env.LENS_VERIFY_DEBOUNCE_MS, 20000),                         // Y must be stable this long (avoids half-written rows)
    workerTickMs: num(env.LENS_VERIFY_TICK_MS, 5000),
    model: env.LENS_VERIFY_MODEL || 'gpt-5.6-luna',                              // same vision model family the scanner uses for gallery analysis
    pass2SendsImage: String(env.LENS_VERIFY_PASS2_IMAGE ?? 'true').toLowerCase() !== 'false',
    maxAttempts: num(env.LENS_VERIFY_MAX_ATTEMPTS, 5),
    backoffMs: [30000, 120000, 600000, 1800000, 3600000],                        // retry schedule after a retriable failure
    imageMaxEdge: 1568, imageTimeoutMs: 20000, imageMaxBytes: 15 * 1024 * 1024,
    evidenceTtlMs: 6 * 3600 * 1000,
    archiveImages: String(env.LENS_VERIFY_ARCHIVE_IMAGES ?? 'true').toLowerCase() !== 'false',   // keep a copy of each lens's chosen photo at scan time (Facebook links expire)
    dryRun: String(env.LENS_VERIFY_DRY_RUN ?? 'false').toLowerCase() === 'true',   // fake AI answers, no OpenAI cost (sheet flow is still real)
    dbPath: env.LENS_VERIFY_DB || 'lens-verification.db',
    storageBucket: env.SUPABASE_HIT_LOG_BUCKET || 'marketplace-hit-logs',
    storagePrefix: 'lens-verification'
  };
}
