# Pre-Purchase Lens Verification

Type **`Y`** in column **O (Interested)** of the Main tab → your scanner server runs a two-pass AI second opinion on every **lens** in that listing and writes **Pass / Review / Mismatch** back to the sheet. It only answers one question: *could the scanner have confused this lens with a similar model/variant/generation/mount that is worth meaningfully different money?* No condition analysis, no price changes, no purchase advice.

## Where it lives (and why)
Inside your **scanner server** (`server.js`), as a self-contained folder — not in the tracker and not a new Chrome extension. The server already holds everything this needs: the OpenAI key + `createLoggedOpenAiResponse`, Supabase (hit logs), the Google Sheets login, and the SQLite job-queue pattern (`ebay-worker.db`). The server polls column O itself, so no Apps Script or tunnel is needed. Nothing here touches the product-tracker.

**Limitation:** the server must be running. If it is off, nothing is lost: the `Y` stays in the sheet and jobs are stored in `lens-verification.db`; work resumes (including interrupted jobs) when the server starts.

## Install (≈5 minutes)
1. Copy the `lens-verification/` folder next to `server.js`.
2. Preview, then apply (adds 3 small blocks to `server.js`, verified against both the earlier and your latest `server.js`; writes `server.js.bak-lens-verification`; safe to re-run; `--revert` undoes it):
   ```
   node lens-verification/scripts/apply-to-server.mjs server.js --dry-run
   node lens-verification/scripts/apply-to-server.mjs server.js
   ```
3. Restart the server. Look for `[LENS VERIFY] ready. Watching Main!O …`. (If anything in this module fails to start, it only logs — the scanner still runs.)
4. **Check prerequisites with one call** (makes one tiny paid OpenAI call to prove the model accepts the strict JSON schema):
   ```
   curl -X POST http://localhost:3000/lens-verification/selftest
   ```
5. Optional free rehearsal of the sheet flow: start the server with `LENS_VERIFY_DRY_RUN=true` (placeholder answers, zero OpenAI calls, but it *does* write real status cells and a row on the results tab).

No new `.env` keys are required. It reuses `OPENAI_API_KEY`, `GOOGLE_*`, `SUPABASE_*`. Optional: `LENS_VERIFY_MODEL` (default `gpt-5.6-luna`, the vision model your gallery step uses), `LENS_VERIFY_POLL_MS` (30000), `LENS_VERIFY_MAX_ATTEMPTS` (5), `LENS_VERIFY_PASS2_IMAGE=false` (send the photo only in pass 1), `LENS_VERIFY_ARCHIVE_IMAGES=false`, `LENS_VERIFY_ENABLED=false`.

## What comes from the scanner's log, and what needs a saved snapshot
Checked against your current `server.js` / `content.js`:

| Needed | In the Analysis Log (column I "View Log")? | Where this module gets it |
|---|---|---|
| Per-image, per-product `modelReadabilityScore` | **Yes** (`[STEP 2] Raw gallery N response:` JSON) | Log (used as a backfill and cross-check) and the snapshot |
| How each lens identity was reached (Lensfun/ExifTool candidates, resale consensus, DataForSEO gate, final `[LENS RESOLVER] Complete` identity) | **Yes**, every block carries its `productId` | Log, passed to Pass 2 as the scanner's reasoning (never to Pass 1) |
| Final primary-products object | **No**: it is printed with `console.dir`, which the log capture does not hook (only the label appears). The one-line `[STEP 5] Raw reconciliation response` JSON is in the log and is parsed instead (identity + OCR strings per lens) | Snapshot / reconciliation line |
| Photo links (image URLs) | **No** (only "Downloading image i/N") | Snapshot |
| Listing title / description text | **No** (only "received N characters" and the parsed facts) | Snapshot |

So a small **passive** middleware stores a snapshot when a hit is saved (title, description, image URLs, grades, the scanner's best-photo picks, final lens items) in Supabase (`lens-verification/evidence/<listingId>/<runId>.json`) and on local disk. It observes your scanner's own requests and never changes their responses. It also keeps **one copy of each lens's chosen photo** (`lens-verification/images/…`), because Facebook CDN links expire; verification prefers that copy and only then tries the original link. Turn that off with `LENS_VERIFY_ARCHIVE_IMAGES=false`.
- **Listings scanned before you install this have no snapshot** → job fails with `NO_EVIDENCE` and a "re-scan" message (the log alone cannot supply photo links or the description). Re-scan, then re-run.
- The snapshot used is the one matching the run ID in that row's Analysis Log link, and the log is read from that same run.

## How it works
1. **Trigger:** every 30 s the server reads Main. A `Y`/`y` in column O on *any* row of a listing (the scanner merges the listing's rows; if merges were removed it still finds the block) queues **one job per listing**. The `Y` must be stable for ~20 s so a half-written scanner row is never read. A database rule makes two active jobs for one listing impossible.
2. **Lenses only:** non-lens products are ignored (listed in the report).
3. **One photo per lens:** the photo the scanner graded best for reading *that lens's* markings (`modelReadabilityScore`). Ties → strongest readable markings (OCR) → the scanner's own pick. If that photo is gone/unusable the lens gets a processing **Error** — no other photo is substituted. A photo shared by two lenses is analysed once in pass 1.
4. **Pass 1 (independent):** photo + listing title/description (+ raw OCR hint). It is **never told** the scanner's answer or shown anything from the scanner's log. Returns what it can read, labelled by evidence kind (visual / seller / inference / unresolved), plausible alternatives and value-relevant unresolved ambiguities.
5. **Pass 2 (adversarial):** gets the scanner's answer as a *hypothesis*, the scanner's own resolution trail from its log, and pass-1's findings, and tries to break it. Guardrails then keep it quiet and honest: a **Mismatch** needs a direct contradiction from readable markings; a **Review** needs a concrete alternative + material value difference + a concrete thing to check. Unsupported flags are downgraded (the raw model verdict is kept in the report). Guardrails never upgrade.
6. **Results:** per-lens + listing aggregate (worst of: Mismatch > Review > Error > Pass). A lens that couldn't be verified is never counted as a Pass.

## Where results appear
- **Main tab, 4 new columns** (created by header name in the first free columns to the right of your last header, i.e. S–V; it refuses to write over existing data): `Verify Job`, `Verify Result`, `Verify Summary`, `Verify Report`. They are merged across the listing's rows like your other listing columns. Nothing in A–R or the Y cell is ever written.
- **`Lens Verification` tab** (auto-created): one row per lens — original scanner identification, verdict, independent identification, potential alternative, finding, value impact, recommended manual check, photo used (link), evidence used, notes. The `Verify Report` cell links to the right row.
- **Full audit JSON** (both passes, alternatives, guardrail adjustments, photo choice incl. other candidates, evidence source) in Supabase `lens-verification/reports/<listingId>/<jobId>.json` and in the job database. Every OpenAI call is also in your existing `openai-api-logs`.

## Statuses
| `Verify Job` (processing) | meaning |
|---|---|
| Pending / Running | queued / in progress |
| Retrying (n/5) | transient failure (rate limit, 5xx, network); backing off 30 s → 2 m → 10 m → 30 m → 1 h; finished lenses are kept |
| Done | finished (see Result) |
| Failed | could not run, or no lens could be verified |

| `Verify Result` (AI verdict) | meaning |
|---|---|
| Pass | evidence supports the scanner; nothing worth a manual check |
| Review | plausible lookalike with a material value difference, or a critical designation unresolved — do the listed manual check before buying |
| Mismatch | readable markings contradict the scanner's exact model/variant/generation |
| Error | at least one lens couldn't be verified (and none is a Mismatch/Review); other lenses' results are preserved |
| No lenses | nothing to verify |

## Re-running / troubleshooting
- **Re-run:** clear the `Verify Job` cell (with `Y` still in column O) — a new job starts within ~1 minute. Or `POST http://localhost:3000/lens-verification/rerun` with `{"facebookUrl":"…"}`. Finished listings are never re-run automatically.
- **Inspect:** `GET /lens-verification/status`, `GET /lens-verification/jobs/<listingId>` (localhost only).
- **Failed + `NO_EVIDENCE`:** re-scan the listing (needed for snapshot), then re-run.
- **`IMAGE_UNAVAILABLE`:** Facebook photo link expired; re-scan to refresh the links.
- **`AI_AUTH` / `AI_REJECTED_INPUT`:** check `OPENAI_API_KEY` / run the selftest; if the model rejects structured output set `LENS_VERIFY_MODEL`.
- **Sheet cells not updating but job Done:** the job's `sheet_error` says why; it retries each tick. `COLUMN_COLLISION` = something is already in S–V; move it or add the four headers elsewhere (matched by name).
- Server log lines are prefixed `[LENS VERIFY]`.

## Not verified / honest limits
- Tested with fakes only (45 automated tests: Sheets API incl. merged cells, scripted OpenAI, SQLite). **Never run against your real sheet, Supabase, OpenAI or a live scan.** Run the selftest and a dry run first.
- The log parser was written from the exact `console.log` calls in your server and tested on logs produced with the same `util.format`/`util.inspect`; it has been checked against one real log (a 3-lens Nikon DX bundle; kept as `test/fixtures/real-scanner-log.txt`): grades, per-lens resolver trails, final identities and the reconciliation line all parse. Other paths (Google Lens / SerpApi / DataForSEO branches, multi-gallery listings) are covered only by synthetic logs, so after your first such listing check the report's `scannerLog` section (`used: true`, `galleries`, `lensesResolved`).
- Field names in the scanner's final `items` (e.g. `ebaySearchQuery`, `productType`, resale fields) and the shape of `/reconcile-primary-products` traffic were read from your code, not from a live run. Lens↔photo mapping uses productId, then focal length+brand, then order; if it can't tell, that lens is reported as an error rather than guessed.
- Whether `gpt-5.6-luna` accepts strict JSON-schema output is unconfirmed (your code uses schemas only with `gpt-4o-mini`) — the selftest checks it.
- The live Facebook listing is **not re-opened** in this version (the saved snapshot has everything required); reports say "saved". Adding a live check would need your logged-in browser (extension) — not built.
- Tests use Node's built-in SQLite; the server uses `better-sqlite3`. The queue only uses their shared API, but this is untested on `better-sqlite3`.
- Photo links can expire before you verify; this is reported, not worked around.
- It does not do market-price research, change any scanner value, mark purchases, create inventory or touch the product tracker.

## Tests
`node --test test/*.test.js` (Node ≥ 22). Covers: clear pass; seller-stated-but-unseen detail; VR vs non-VR review; direct-contradiction mismatch; ambiguous photo; multi-lens; lens+non-lens; multi-row listings (merged/unmerged); duplicate/repeated Y; missing/expired photo; no snapshot; API failure→retry; backoff/exhaustion; restart mid-job; scanner-column safety; capture middleware; image selection ties; dry run; selftest.
