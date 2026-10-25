#!/usr/bin/env node
// Usage:  node lens-verification/scripts/apply-to-server.mjs path/to/server.js [--dry-run] [--revert]
// Makes exactly three additive edits to the scanner server (backup written first). Safe to run twice.
import fs from 'node:fs';

const file = process.argv[2];
const dry = process.argv.includes('--dry-run'), revert = process.argv.includes('--revert');
if (!file) { console.error('Usage: node apply-to-server.mjs <server.js> [--dry-run] [--revert]'); process.exit(1); }
const bak = `${file}.bak-lens-verification`;
if (revert) { if (!fs.existsSync(bak)) { console.error('No backup found:', bak); process.exit(1); } fs.copyFileSync(bak, file); console.log('Restored', file, 'from', bak); process.exit(0); }

let src = fs.readFileSync(file, 'utf8');
if (src.includes('LENS_VERIFICATION_INSTALLED')) { console.log('Already installed. Nothing to do.'); process.exit(0); }

const IMPORT_ANCHOR = 'import util from "util";';
const INSTALL_ANCHOR = 'function getSupabaseHitLogObjectPath(';
const START_ANCHOR = /\napp\.listen\(\s*\d+/;                       // start right before the server begins listening
for (const [name, ok] of [['import anchor', src.split(IMPORT_ANCHOR).length === 2], ['install anchor', src.split(INSTALL_ANCHOR).length === 2], ['start anchor', (src.match(new RegExp(START_ANCHOR.source, 'g')) || []).length === 1]]) {
  if (!ok) { console.error(`Cannot patch: ${name} not found exactly once. Nothing was changed.`); process.exit(2); }
}

const importLine = `${IMPORT_ANCHOR}\nimport { createLensVerification } from "./lens-verification/src/index.js";   // LENS_VERIFICATION_INSTALLED`;
const installBlock = `/*
  ============================================================
  LENS VERIFICATION (pre-purchase second opinion)
  Registers a passive capture middleware + local routes.
  Polling/worker start at the bottom of this file.
  ============================================================
*/
const lensVerification = createLensVerification({
  app,
  env: process.env,
  getSupabase: () => supabaseAdmin,
  getSheets: () => {
    const auth = createGoogleOAuthClient();
    auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
    return google.sheets({ version: "v4", auth });
  },
  createLoggedOpenAiResponse: (args) => createLoggedOpenAiResponse(args),
  openDb: (dbPath) => {
    const db = new Database(path.resolve(dbPath));
    db.pragma("journal_mode = WAL");
    return db;
  },
  sharp,
  log: (...args) => console.log(...args)
});

${INSTALL_ANCHOR}`;
src = src.replace(IMPORT_ANCHOR, () => importLine).replace(INSTALL_ANCHOR, () => installBlock)
  .replace(START_ANCHOR, (m) => `\nlensVerification.start();\n${m}`);
if (dry) { console.log('Dry run OK: all three anchors found. No file written.'); process.exit(0); }
fs.copyFileSync(file, bak); fs.writeFileSync(file, src);
console.log(`Patched ${file}. Backup: ${bak}`);
