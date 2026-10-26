// SQLite-backed job queue. Uses only the API subset shared by better-sqlite3 (the scanner server) and node:sqlite (tests):
// db.exec(sql), db.prepare(sql).run/get/all(...positional).
import { randomUUID } from 'node:crypto';

const ACTIVE = `('pending','running','retry_wait')`;

export function openQueue(db, { maxAttempts = 5, backoffMs = [30000, 120000, 600000, 1800000, 3600000], now = () => Date.now() } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lens_verification_jobs (
      id TEXT PRIMARY KEY, listing_id TEXT NOT NULL, facebook_url TEXT, run_id TEXT,
      status TEXT NOT NULL,               -- pending | running | retry_wait | done | failed   (JOB state, never the AI verdict)
      verdict TEXT,                       -- PASS | REVIEW | MISMATCH | ERROR | NO_LENSES   (AI result, only when finished)
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, heartbeat_at INTEGER,
      last_error TEXT, error_code TEXT, evidence_source TEXT, summary TEXT, report_url TEXT, report_json TEXT,
      sheet_synced INTEGER NOT NULL DEFAULT 0, sheet_error TEXT, rerun_of TEXT, results_row INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_lv_one_active_per_listing ON lens_verification_jobs (listing_id) WHERE status IN ${ACTIVE};
    CREATE INDEX IF NOT EXISTS ix_lv_status ON lens_verification_jobs (status, next_attempt_at);
    CREATE TABLE IF NOT EXISTS lens_verification_lenses (
      job_id TEXT NOT NULL, lens_key TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL,   -- done | error
      outcome TEXT, error_code TEXT, error_message TEXT, retriable INTEGER NOT NULL DEFAULT 0, pass1_json TEXT, result_json TEXT, updated_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, lens_key)
    );`);
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ } throw e; } };
  const q = (sql) => db.prepare(sql);
  const row = (id) => q('SELECT * FROM lens_verification_jobs WHERE id=?').get(id) || null;

  return {
    tx, get: row,
    latestForListing: (listingId) => q('SELECT * FROM lens_verification_jobs WHERE listing_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(listingId) || null,
    activeForListing: (listingId) => q(`SELECT * FROM lens_verification_jobs WHERE listing_id=? AND status IN ${ACTIVE}`).get(listingId) || null,
    list: (limit = 50) => q('SELECT id,listing_id,status,verdict,attempts,error_code,last_error,created_at,finished_at,sheet_synced FROM lens_verification_jobs ORDER BY created_at DESC LIMIT ?').all(limit),

    /** Creates a job unless one is already active for the listing (DB-enforced). Returns {created, job}. */
    create({ listingId, facebookUrl = '', runId = '', rerunOf = null }) {
      const id = randomUUID(), t = now();
      try {
        q(`INSERT INTO lens_verification_jobs (id,listing_id,facebook_url,run_id,status,attempts,max_attempts,next_attempt_at,created_at,rerun_of) VALUES (?,?,?,?, 'pending',0,?,?,?,?)`)
          .run(id, listingId, facebookUrl, runId, maxAttempts, t, t, rerunOf);
        return { created: true, job: row(id) };
      } catch (e) {
        if (/UNIQUE/i.test(String(e?.message))) return { created: false, job: this.activeForListing(listingId) };
        throw e;
      }
    },

    /** Next due job, atomically marked running (attempts++). */
    claimNext() {
      return tx(() => {
        const t = now();
        const j = q(`SELECT * FROM lens_verification_jobs WHERE status IN ('pending','retry_wait') AND COALESCE(next_attempt_at,0) <= ? ORDER BY created_at LIMIT 1`).get(t);
        if (!j) return null;
        q(`UPDATE lens_verification_jobs SET status='running', attempts=attempts+1, started_at=?, heartbeat_at=? WHERE id=?`).run(t, t, j.id);
        return row(j.id);
      });
    },
    heartbeat: (id) => q('UPDATE lens_verification_jobs SET heartbeat_at=? WHERE id=?').run(now(), id),
    setRunInfo: (id, { runId, evidenceSource }) => q('UPDATE lens_verification_jobs SET run_id=COALESCE(?,run_id), evidence_source=COALESCE(?,evidence_source) WHERE id=?').run(runId ?? null, evidenceSource ?? null, id),

    /** After a retriable failure: back off, or fail permanently once attempts are exhausted. */
    scheduleRetry(id, { code, message }) {
      const j = row(id); const t = now();
      if (j.attempts >= j.max_attempts) { q(`UPDATE lens_verification_jobs SET status='failed', verdict='ERROR', finished_at=?, last_error=?, error_code=?, sheet_synced=0 WHERE id=?`).run(t, String(message).slice(0, 500), code, id); return row(id); }
      const wait = backoffMs[Math.min(j.attempts - 1, backoffMs.length - 1)];
      q(`UPDATE lens_verification_jobs SET status='retry_wait', next_attempt_at=?, last_error=?, error_code=?, sheet_synced=0 WHERE id=?`).run(t + wait, String(message).slice(0, 500), code, id);
      return row(id);
    },
    fail(id, { code, message, summary, reportUrl = null, reportJson = null }) {
      q(`UPDATE lens_verification_jobs SET status='failed', verdict='ERROR', finished_at=?, last_error=?, error_code=?, summary=COALESCE(?,summary), report_url=COALESCE(?,report_url), report_json=COALESCE(?,report_json), sheet_synced=0 WHERE id=?`)
        .run(now(), String(message).slice(0, 500), code, summary ?? null, reportUrl, reportJson, id);
      return row(id);
    },
    complete(id, { verdict, summary, reportUrl = null, reportJson = null }) {
      q(`UPDATE lens_verification_jobs SET status='done', verdict=?, finished_at=?, summary=?, report_url=?, report_json=?, last_error=NULL, error_code=NULL, sheet_synced=0 WHERE id=?`)
        .run(verdict, now(), summary, reportUrl, reportJson, id);
      return row(id);
    },
    /** Process restart: nothing can really be running. Resume those jobs (attempt already counted, so crash loops terminate). */
    recoverStale() {
      const t = now();
      const stuck = q(`SELECT id, attempts, max_attempts FROM lens_verification_jobs WHERE status='running'`).all();
      for (const j of stuck) {
        if (j.attempts >= j.max_attempts) q(`UPDATE lens_verification_jobs SET status='failed', verdict='ERROR', finished_at=?, error_code='RESTART_LIMIT', last_error='Interrupted by restart too many times', sheet_synced=0 WHERE id=?`).run(t, j.id);
        else q(`UPDATE lens_verification_jobs SET status='retry_wait', next_attempt_at=?, error_code='RESTARTED', last_error='Server restarted during verification; resuming', sheet_synced=0 WHERE id=?`).run(t, j.id);
      }
      return stuck.length;
    },
    unsynced: () => q(`SELECT * FROM lens_verification_jobs WHERE sheet_synced=0 AND status IN ('done','failed','retry_wait','running','pending') ORDER BY created_at LIMIT 20`).all(),
    markSynced: (id, resultsRow = null) => q('UPDATE lens_verification_jobs SET sheet_synced=1, sheet_error=NULL, results_row=COALESCE(?,results_row) WHERE id=?').run(resultsRow, id),
    markSyncFailed: (id, msg) => q('UPDATE lens_verification_jobs SET sheet_error=? WHERE id=?').run(String(msg).slice(0, 300), id),

    // per-lens persistence: successful lenses survive a later failure and are skipped on retry
    saveLens({ jobId, lensKey, position, status, outcome = null, errorCode = null, errorMessage = null, retriable = false, pass1 = null, result = null }) {
      q(`INSERT INTO lens_verification_lenses (job_id,lens_key,position,status,outcome,error_code,error_message,retriable,pass1_json,result_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id,lens_key) DO UPDATE SET position=excluded.position,status=excluded.status,outcome=excluded.outcome,error_code=excluded.error_code,error_message=excluded.error_message,retriable=excluded.retriable,
           pass1_json=COALESCE(excluded.pass1_json,lens_verification_lenses.pass1_json),result_json=excluded.result_json,updated_at=excluded.updated_at`)
        .run(jobId, lensKey, position, status, outcome, errorCode, errorMessage ? String(errorMessage).slice(0, 400) : null, retriable ? 1 : 0, pass1 ? JSON.stringify(pass1) : null, result ? JSON.stringify(result) : null, now());
    },
    lenses: (jobId) => q('SELECT * FROM lens_verification_lenses WHERE job_id=? ORDER BY position').all(jobId)
      .map(r => ({ ...r, retriable: !!r.retriable, pass1: r.pass1_json ? JSON.parse(r.pass1_json) : null, result: r.result_json ? JSON.parse(r.result_json) : null }))
  };
}
