import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import sharp from "sharp";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import vision from "@google-cloud/vision";
import {
  createClient
} from "@supabase/supabase-js";

import {
  AsyncLocalStorage
} from "async_hooks";

import util from "util";

/*
  ============================================================
  SUPABASE PROCESSED MARKETPLACE LISTINGS
  ============================================================
*/

/*
  Check which of a group of listing IDs
  have already been processed.
*/

/*
  Atomically claim a Marketplace listing.

  claimed: true
      This listing was not in Supabase and this
      scanner successfully claimed it.

  claimed: false
      Another scanner/device has already processed
      or claimed this listing.
*/


function cleanupOldLocalAnalysisLogs() {
  const MAX_AGE_MS =
    24 * 60 * 60 * 1000;

  try {
    const files =
      fs.readdirSync(
        ANALYSIS_LOG_DIRECTORY
      );

    const now =
      Date.now();

    for (
      const fileName of files
    ) {
      if (
        !fileName.endsWith(
          ".log"
        )
      ) {
        continue;
      }

      const filePath =
        path.join(
          ANALYSIS_LOG_DIRECTORY,
          fileName
        );

      try {
        const stats =
          fs.statSync(
            filePath
          );

        if (
          now -
            stats.mtimeMs >
          MAX_AGE_MS
        ) {
          fs.unlinkSync(
            filePath
          );
        }
      } catch (error) {
        originalConsoleWarn(
          "[ANALYSIS LOG] Could not clean temporary log:",
          filePath,
          error?.message ||
            error
        );
      }
    }
  } catch (error) {
    originalConsoleWarn(
      "[ANALYSIS LOG] Cleanup failed:",
      error?.message ||
        error
    );
  }
}


const app = express();


/*
  ============================================================
  GLOBAL EXPRESS MIDDLEWARE

  IMPORTANT:
  These MUST appear before every app.get/app.post/etc.
  ============================================================
*/

app.use((req, res, next) => {
  const startedAt = Date.now();

  console.log(`[REQ START] ${req.method} ${req.url}`);

  res.on("finish", () => {
    console.log(
      `[REQ END] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`
    );
  });

  res.on("close", () => {
    console.log(
      `[REQ CLOSED] ${req.method} ${req.url} ${Date.now() - startedAt}ms`
    );
  });

  next();
});

app.use(cors({
  origin: "*"
}));

app.use(express.json({
  limit: "50mb"
}));

const SUPABASE_URL =
  String(
    process.env.SUPABASE_URL ||
    ""
  ).trim();

const SUPABASE_SECRET_KEY =
  String(
    process.env.SUPABASE_SECRET_KEY ||
    ""
  ).trim();

const SUPABASE_HIT_LOG_BUCKET =
  String(
    process.env.SUPABASE_HIT_LOG_BUCKET ||
    "marketplace-hit-logs"
  ).trim();

if (!SUPABASE_URL) {
  throw new Error(
    "Missing SUPABASE_URL in .env"
  );
}

if (!SUPABASE_SECRET_KEY) {
  throw new Error(
    "Missing SUPABASE_SECRET_KEY in .env"
  );
}

const supabaseAdmin =
  createClient(
    SUPABASE_URL,
    SUPABASE_SECRET_KEY,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );

  const ANALYSIS_LOG_DIRECTORY =
  path.resolve(
    "marketplace-analysis-logs"
  );

fs.mkdirSync(
  ANALYSIS_LOG_DIRECTORY,
  {
    recursive: true
  }
);

function sanitizeAnalysisRunId(
  value
) {
  return String(value || "")
    .trim()
    .replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    )
    .slice(
      0,
      240
    );
}


function getAnalysisLogFilePath(
  analysisRunId
) {
  const safeId =
    sanitizeAnalysisRunId(
      analysisRunId
    );

  if (!safeId) {
    return null;
  }

  return path.join(
    ANALYSIS_LOG_DIRECTORY,
    `${safeId}.log`
  );
}


function appendAnalysisLogText(
  text
) {
  const context =
    analysisLogStorage.getStore();

  const analysisRunId =
    context?.analysisRunId;

  if (!analysisRunId) {
    return;
  }

  const filePath =
    getAnalysisLogFilePath(
      analysisRunId
    );

  if (!filePath) {
    return;
  }

  try {
    fs.appendFileSync(
      filePath,
      `${text}\n`,
      "utf8"
    );
  } catch (error) {
    /*
      Do NOT use console.error here.

      console.error itself will be intercepted
      by our logger below, which could cause
      recursion.
    */
    process.stderr.write(
      `[ANALYSIS LOG ERROR] ${
        error?.message ||
        String(error)
      }\n`
    );
  }
}

const analysisLogStorage =
  new AsyncLocalStorage();

const visionClient =
  new vision.ImageAnnotatorClient();

const PRODUCT_DATABASE_PATH = path.resolve(
  "camera-products.db"
);

const productDb = new Database(
  PRODUCT_DATABASE_PATH
);

/*
  ============================================================
  MARKETPLACE OUTREACH QUEUE DATABASE
  ============================================================

  This database is separate from camera-products.db.

  Scanner extension:
      analyzes listing
      -> generates message
      -> stores outreach job here

  Outreach extension:
      requests next pending job
      -> sends Facebook message
      -> marks job sent
*/

const MARKETPLACE_OUTREACH_DATABASE_PATH =
  path.resolve(
    "marketplace-outreach.db"
  );

  /*
  ============================================================
  REMOTE EBAY WORKER DATABASE
  ============================================================

  Main scanner:
      queues exact eBay sold-search URL

  Worker extension:
      claims pending job
      opens URL
      scrapes listings
      returns raw listings

  Main scanner:
      receives listings
      continues normal /evaluate-comps flow
*/

const EBAY_WORKER_DATABASE_PATH =
  path.resolve(
    "ebay-worker.db"
  );

const ebayWorkerDb =
  new Database(
    EBAY_WORKER_DATABASE_PATH
  );

ebayWorkerDb.pragma(
  "journal_mode = WAL"
);

ebayWorkerDb.exec(`
  CREATE TABLE IF NOT EXISTS ebay_worker_jobs (
    id TEXT PRIMARY KEY,

    marketplace_listing_id TEXT,
    marketplace_url TEXT,

    ebay_url TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending',

    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    completed_at INTEGER,
    failed_at INTEGER,

    listings_json TEXT,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ebay_worker_jobs_status
    ON ebay_worker_jobs (
      status,
      created_at
    );
`);

console.log(
  "[EBAY WORKER DATABASE] Ready:",
  EBAY_WORKER_DATABASE_PATH
);

const outreachDb =
  new Database(
    MARKETPLACE_OUTREACH_DATABASE_PATH
  );

outreachDb.pragma(
  "journal_mode = WAL"
);

outreachDb.pragma(
  "foreign_keys = ON"
);

outreachDb.exec(`
  CREATE TABLE IF NOT EXISTS marketplace_outreach_sessions (
    session_id TEXT PRIMARY KEY,

    started_at INTEGER NOT NULL,
    ended_at INTEGER,

    list_url TEXT,
    scan_mode TEXT,

    stop_reason TEXT,

    clicked_listings INTEGER NOT NULL DEFAULT 0,
    hits_found INTEGER NOT NULL DEFAULT 0,
    outreach_queued INTEGER NOT NULL DEFAULT 0,

    status TEXT NOT NULL DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS marketplace_outreach_items (
    id TEXT PRIMARY KEY,

    session_id TEXT NOT NULL,
    listing_id TEXT NOT NULL UNIQUE,
    listing_url TEXT NOT NULL,

    message TEXT NOT NULL,

    recommendation TEXT,

    status TEXT NOT NULL DEFAULT 'pending',

    created_at INTEGER NOT NULL,
    claimed_at INTEGER,
    sent_at INTEGER,
    failed_at INTEGER,

    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,

    FOREIGN KEY (
      session_id
    )
    REFERENCES marketplace_outreach_sessions(
      session_id
    )
    ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_marketplace_outreach_items_status
    ON marketplace_outreach_items(
      status,
      created_at
    );

  CREATE INDEX IF NOT EXISTS idx_marketplace_outreach_items_session
    ON marketplace_outreach_items(
      session_id,
      status,
      created_at
    );
`);

console.log(
  "[OUTREACH DATABASE] Ready:",
  MARKETPLACE_OUTREACH_DATABASE_PATH
);

function validateRemoteEbayUrl(
  value
) {
  try {
    const url =
      new URL(
        String(value || "")
      );

    const hostname =
      url.hostname
        .toLowerCase();

    const validHost =
      hostname === "ebay.com" ||
      hostname === "www.ebay.com" ||
      hostname.endsWith(
        ".ebay.com"
      );

    const validPath =
      url.pathname.startsWith(
        "/sch/"
      );

    if (
      !validHost ||
      !validPath
    ) {
      return null;
    }

    return url.toString();

  } catch (error) {
    return null;
  }
}

/*
  ============================================================
  REMOTE EBAY — QUEUE SEARCH
  ============================================================
*/

app.post(
  "/ebay-worker/jobs",
  (req, res) => {
    try {
      const ebayUrl =
        validateRemoteEbayUrl(
          req.body?.ebayUrl
        );

      if (!ebayUrl) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Invalid eBay sold-search URL."
          });
      }

      const marketplaceListingId =
        String(
          req.body
            ?.marketplaceListingId ||
          ""
        ).trim();

      const marketplaceUrl =
        String(
          req.body
            ?.marketplaceUrl ||
          ""
        ).trim();

      const jobId =
        randomUUID();

      const createdAt =
        Date.now();

      ebayWorkerDb
        .prepare(`
          INSERT INTO ebay_worker_jobs (
            id,
            marketplace_listing_id,
            marketplace_url,
            ebay_url,
            status,
            created_at
          )
          VALUES (
            ?,
            ?,
            ?,
            ?,
            'pending',
            ?
          )
        `)
        .run(
          jobId,
          marketplaceListingId,
          marketplaceUrl,
          ebayUrl,
          createdAt
        );

      console.log(
        "[EBAY WORKER] Search queued:",
        {
          jobId,
          marketplaceListingId,
          ebayUrl
        }
      );

      return res.json({
        ok: true,
        jobId,
        status:
          "pending",
        ebayUrl,
        createdAt
      });

    } catch (error) {
      console.error(
        "[EBAY WORKER] Queue failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not queue remote eBay search."
        });
    }
  }
);

/*
  ============================================================
  REMOTE EBAY — GET JOB STATUS
  ============================================================
*/

app.get(
  "/ebay-worker/jobs/:jobId",
  (req, res) => {
    try {
      const jobId =
        String(
          req.params.jobId ||
          ""
        ).trim();

      const row =
        ebayWorkerDb
          .prepare(`
            SELECT *
            FROM ebay_worker_jobs
            WHERE id = ?
          `)
          .get(
            jobId
          );

      if (!row) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Remote eBay job not found."
          });
      }

      let listings =
        null;

      if (
        row.listings_json
      ) {
        try {
          listings =
            JSON.parse(
              row.listings_json
            );
        } catch (error) {
          listings =
            [];
        }
      }

      return res.json({
        ok: true,

        jobId:
          row.id,

        status:
          row.status,

        ebayUrl:
          row.ebay_url,

        listings,

        error:
          row.error || "",

        createdAt:
          row.created_at,

        claimedAt:
          row.claimed_at,

        completedAt:
          row.completed_at
      });

    } catch (error) {
      console.error(
        "[EBAY WORKER] Status lookup failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not read remote eBay job."
        });
    }
  }
);

/*
  ============================================================
  REMOTE EBAY — CLAIM NEXT SEARCH
  ============================================================
*/

const claimNextRemoteEbayJob =
  ebayWorkerDb.transaction(
    () => {
      const row =
        ebayWorkerDb
          .prepare(`
            SELECT *
            FROM ebay_worker_jobs
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
          `)
          .get();

      if (!row) {
        return null;
      }

      const claimedAt =
        Date.now();

      const result =
        ebayWorkerDb
          .prepare(`
            UPDATE ebay_worker_jobs
            SET
              status = 'claimed',
              claimed_at = ?
            WHERE
              id = ?
              AND status = 'pending'
          `)
          .run(
            claimedAt,
            row.id
          );

      if (
        result.changes !== 1
      ) {
        return null;
      }

      return ebayWorkerDb
        .prepare(`
          SELECT *
          FROM ebay_worker_jobs
          WHERE id = ?
        `)
        .get(
          row.id
        );
    }
  );

app.post(
  "/ebay-worker/jobs/claim",
  (req, res) => {
    try {
      const row =
        claimNextRemoteEbayJob();

      if (!row) {
        return res.json({
          ok: true,
          job: null
        });
      }

      console.log(
        "[EBAY WORKER] Claimed:",
        {
          jobId:
            row.id,
          ebayUrl:
            row.ebay_url
        }
      );

      return res.json({
        ok: true,

        job: {
          jobId:
            row.id,

          ebayUrl:
            row.ebay_url,

          marketplaceListingId:
            row.marketplace_listing_id,

          createdAt:
            row.created_at,

          claimedAt:
            row.claimed_at
        }
      });

    } catch (error) {
      console.error(
        "[EBAY WORKER] Claim failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not claim remote eBay job."
        });
    }
  }
);

/*
  ============================================================
  REMOTE EBAY — COMPLETE SEARCH
  ============================================================
*/

app.post(
  "/ebay-worker/jobs/:jobId/complete",
  (req, res) => {
    try {
      const jobId =
        String(
          req.params.jobId ||
          ""
        ).trim();

      const listings =
        Array.isArray(
          req.body?.listings
        )
          ? req.body.listings
          : [];

      const result =
        ebayWorkerDb
          .prepare(`
            UPDATE ebay_worker_jobs
            SET
              status = 'completed',
              completed_at = ?,
              listings_json = ?,
              error = NULL
            WHERE id = ?
          `)
          .run(
            Date.now(),
            JSON.stringify(
              listings
            ),
            jobId
          );

      if (
        result.changes !== 1
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Remote eBay job not found."
          });
      }

      console.log(
        "[EBAY WORKER] Completed:",
        {
          jobId,
          listings:
            listings.length
        }
      );

      return res.json({
        ok: true,
        jobId,
        listingsCount:
          listings.length
      });

    } catch (error) {
      console.error(
        "[EBAY WORKER] Completion failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not complete remote eBay job."
        });
    }
  }
);

app.post(
  "/ebay-worker/jobs/:jobId/fail",
  (req, res) => {
    try {
      const jobId =
        String(
          req.params.jobId ||
          ""
        ).trim();

      const errorMessage =
        String(
          req.body?.error ||
          "Remote eBay worker failed."
        ).trim();

      ebayWorkerDb
        .prepare(`
          UPDATE ebay_worker_jobs
          SET
            status = 'failed',
            failed_at = ?,
            error = ?
          WHERE id = ?
        `)
        .run(
          Date.now(),
          errorMessage,
          jobId
        );

      return res.json({
        ok: true,
        jobId
      });

    } catch (error) {
      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not fail remote eBay job."
        });
    }
  }
);

function normalizeMarketplaceOutreachItem(
  row
) {
  if (!row) {
    return null;
  }

  return {
    id:
      row.id,

    sessionId:
      row.session_id,

    listingId:
      row.listing_id,

    listingUrl:
      row.listing_url,

    message:
      row.message,

    recommendation:
      row.recommendation || "",

    status:
      row.status,

    createdAt:
      row.created_at,

    claimedAt:
      row.claimed_at,

    sentAt:
      row.sent_at,

    failedAt:
      row.failed_at,

    attempts:
      Number(
        row.attempts || 0
      ),

    lastError:
      row.last_error || ""
  };
}

const originalConsoleLog =
  console.log.bind(
    console
  );

const originalConsoleWarn =
  console.warn.bind(
    console
  );

const originalConsoleError =
  console.error.bind(
    console
  );


console.log = (...args) => {
  originalConsoleLog(
    ...args
  );

  appendAnalysisLogText(
    util.format(
      ...args
    )
  );
};


console.warn = (...args) => {
  originalConsoleWarn(
    ...args
  );

  appendAnalysisLogText(
    util.format(
      ...args
    )
  );
};

app.use(
  (req, res, next) => {
    const analysisRunId =
      sanitizeAnalysisRunId(
        req.get(
          "X-Analysis-Run-Id"
        )
      );

    if (!analysisRunId) {
      next();
      return;
    }

    analysisLogStorage.run(
      {
        analysisRunId
      },
      next
    );
  }
);

function getSupabaseHitLogObjectPath(
  analysisRunId
) {
  const safeId =
    sanitizeAnalysisRunId(
      analysisRunId
    );

  if (!safeId) {
    throw new Error(
      "Missing analysis run ID."
    );
  }

  /*
    The Facebook Marketplace listing ID
    is the portion before the first "_".
  */
  const listingId =
    safeId.split("_")[0] ||
    "unknown";

  return (
    `${listingId}/` +
    `${safeId}.log`
  );
}


async function uploadAnalysisLogToSupabase(
  analysisRunId
) {
  const safeId =
    sanitizeAnalysisRunId(
      analysisRunId
    );

  if (!safeId) {
    throw new Error(
      "Cannot upload hit log without analysisRunId."
    );
  }

  const localFilePath =
    getAnalysisLogFilePath(
      safeId
    );

  if (
    !localFilePath ||
    !fs.existsSync(
      localFilePath
    )
  ) {
    throw new Error(
      `Analysis log file does not exist for ${safeId}.`
    );
  }

  const objectPath =
    getSupabaseHitLogObjectPath(
      safeId
    );

  const logBuffer =
    fs.readFileSync(
      localFilePath
    );

  const {
    error: uploadError
  } =
    await supabaseAdmin
      .storage
      .from(
        SUPABASE_HIT_LOG_BUCKET
      )
      .upload(
        objectPath,
        logBuffer,
        {
          contentType:
            "text/plain; charset=utf-8",

          cacheControl:
            "60",

          upsert:
            true
        }
      );

  if (uploadError) {
    throw new Error(
      `Supabase hit-log upload failed: ${
        uploadError.message ||
        String(uploadError)
      }`
    );
  }

  const {
    data: publicUrlData
  } =
    supabaseAdmin
      .storage
      .from(
        SUPABASE_HIT_LOG_BUCKET
      )
      .getPublicUrl(
        objectPath
      );

  const publicUrl =
    String(
      publicUrlData
        ?.publicUrl ||
      ""
    ).trim();

  if (!publicUrl) {
    throw new Error(
      "Supabase did not return a public hit-log URL."
    );
  }

  return {
    publicUrl,
    objectPath,
    localFilePath
  };
}


console.error = (...args) => {
  originalConsoleError(
    ...args
  );

  appendAnalysisLogText(
    util.format(
      ...args
    )
  );
};

cleanupOldLocalAnalysisLogs();

productDb.exec(`
  CREATE TABLE IF NOT EXISTS products (
    canonical_name TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    product_type TEXT NOT NULL,
    estimated_resale_price REAL NOT NULL
  )
`);

console.log(
  "[PRODUCT DATABASE] Ready:",
  PRODUCT_DATABASE_PATH
);

function normalizeCanonicalName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()

    // Normalize trivial product-type wording.
    .replace(/\bcamera lens\b/g, "lens")

    // Normalize whitespace after replacements.
    .replace(/\s+/g, " ")
    .trim();
}

function cleanNullableIdentityField(value) {
  if (value == null) {
    return null;
  }

  const cleaned =
    String(value)
      .replace(/\s+/g, " ")
      .trim();

  return cleaned || null;
}

function normalizeLensIdentity(lensIdentity = {}) {
  return {
    brand:
      cleanNullableIdentityField(
        lensIdentity?.brand
      ),

    mountSeries:
      cleanNullableIdentityField(
        lensIdentity?.mountSeries
      ),

    focalLength:
      cleanNullableIdentityField(
        lensIdentity?.focalLength
      ),

    maxAperture:
      cleanNullableIdentityField(
        lensIdentity?.maxAperture
      ),

    featureModelCodes:
      cleanNullableIdentityField(
        lensIdentity?.featureModelCodes
      ),

    generation:
      cleanNullableIdentityField(
        lensIdentity?.generation
      )
  };
}

function buildNormalizedLensModel(
  lensIdentity = {}
) {
  const normalized =
    normalizeLensIdentity(
      lensIdentity
    );

  return [
    normalized.mountSeries,
    normalized.focalLength,
    normalized.maxAperture,
    normalized.featureModelCodes,
    normalized.generation
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getCanonicalNameForItem(item) {
  return normalizeCanonicalName(
    item?.ebaySearchQuery ||
    `${item?.brand || ""} ${item?.model || ""} ${item?.productType || ""}`
  );
}

function findProductInDatabase(item) {
  const canonicalName =
    getCanonicalNameForItem(item);

  if (!canonicalName) {
    return null;
  }

  return productDb
    .prepare(`
      SELECT
        canonical_name,
        brand,
        model,
        product_type,
        estimated_resale_price
      FROM products
      WHERE canonical_name = ?
    `)
    .get(canonicalName) || null;
}

function saveProductToDatabase({
  item,
  estimatedResalePrice
}) {
  const canonicalName =
    getCanonicalNameForItem(item);

  const price =
    Number(estimatedResalePrice);

  if (
    !canonicalName ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return false;
  }

  productDb.prepare(`
    INSERT INTO products (
      canonical_name,
      brand,
      model,
      product_type,
      estimated_resale_price
    )
    VALUES (?, ?, ?, ?, ?)

    ON CONFLICT(canonical_name)
    DO UPDATE SET
      brand = excluded.brand,
      model = excluded.model,
      product_type = excluded.product_type,
      estimated_resale_price =
        excluded.estimated_resale_price
  `).run(
    canonicalName,
    String(item.brand || "").trim(),
    String(item.model || "").trim(),
    String(item.productType || "").trim(),
    price
  );

  console.log(
    "[PRODUCT DATABASE] Saved:",
    canonicalName,
    "$" + price
  );

  return true;
}

process.on("uncaughtException", error => {
  console.error("UNCAUGHT EXCEPTION:");
  console.error(error);
});

process.on("unhandledRejection", reason => {
  console.error("UNHANDLED REJECTION:");
  console.error(reason);
});

app.post(
  "/processed-marketplace-listings/claim",
  async (req, res) => {
    try {
      const listingId =
        String(
          req.body?.listingId || ""
        ).trim();

      if (!listingId) {
        return res.status(400).json({
          error:
            "Missing listingId."
        });
      }

      const {
        error
      } =
        await supabaseAdmin
          .from(
            "marketplace_processed_listings"
          )
          .insert({
            listing_id:
              listingId
          });

      /*
        PostgreSQL unique-constraint violation.

        Because listing_id is the primary key,
        this means another scanner/device
        already claimed it.
      */
      if (
        error?.code === "23505"
      ) {
        console.log(
          "[PROCESSED LISTINGS] Already claimed:",
          listingId
        );

        return res.json({
          claimed: false,
          listingId
        });
      }

      if (error) {
        throw error;
      }

      console.log(
        "[PROCESSED LISTINGS] Claimed:",
        listingId
      );

      res.json({
        claimed: true,
        listingId
      });
    } catch (error) {
      console.error(
        "[PROCESSED LISTINGS] Claim failed:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Could not claim Marketplace listing."
      });
    }
  }
);

app.post(
  "/processed-marketplace-listings/check",
  async (req, res) => {
    try {
      const listingIds = [
        ...new Set(
          (
            Array.isArray(req.body?.listingIds)
              ? req.body.listingIds
              : []
          )
            .map(value =>
              String(value || "").trim()
            )
            .filter(Boolean)
        )
      ];

      if (!listingIds.length) {
        res.json({
          processedListingIds: []
        });

        return;
      }

      const {
        data,
        error
      } =
        await supabaseAdmin
          .from(
            "marketplace_processed_listings"
          )
          .select(
            "listing_id"
          )
          .in(
            "listing_id",
            listingIds
          );

      if (error) {
        throw error;
      }

      const processedListingIds =
        Array.isArray(data)
          ? data
              .map(row =>
                String(
                  row?.listing_id || ""
                ).trim()
              )
              .filter(Boolean)
          : [];

      res.json({
        processedListingIds
      });
    } catch (error) {
      console.error(
        "[PROCESSED LISTINGS] Check failed:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Could not check processed listings."
      });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — START SCANNER SESSION
  ============================================================
*/

app.post(
  "/marketplace-outreach/session/start",
  (req, res) => {
    try {
      const sessionId =
        String(
          req.body?.sessionId || ""
        ).trim();

      const startedAt =
        Number(
          req.body?.startedAt ||
          Date.now()
        );

      const listUrl =
        String(
          req.body?.listUrl || ""
        ).trim();

      const scanMode =
        String(
          req.body?.scanMode ||
          "standard"
        ).trim();

      if (!sessionId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing sessionId."
          });
      }

      outreachDb
        .prepare(`
          INSERT INTO marketplace_outreach_sessions (
            session_id,
            started_at,
            list_url,
            scan_mode,
            status
          )
          VALUES (?, ?, ?, ?, 'open')

          ON CONFLICT(session_id)
          DO UPDATE SET
            started_at =
              excluded.started_at,

            list_url =
              excluded.list_url,

            scan_mode =
              excluded.scan_mode,

            status =
              'open'
        `)
        .run(
          sessionId,
          startedAt,
          listUrl,
          scanMode
        );

      console.log(
        "\n[OUTREACH SESSION START]"
      );

      console.log(
        "Session:",
        sessionId
      );

      console.log(
        "Scan mode:",
        scanMode
      );

      console.log(
        "Started:",
        new Date(
          startedAt
        ).toISOString()
      );

      return res.json({
        ok: true,
        sessionId
      });

    } catch (error) {
      console.error(
        "[OUTREACH SESSION] Start failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not start outreach session."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — QUEUE HIT
  ============================================================
*/

app.post(
  "/marketplace-outreach/queue",
  (req, res) => {
    try {
      const sessionId =
        String(
          req.body?.sessionId || ""
        ).trim();

      const listingId =
        String(
          req.body?.listingId || ""
        ).trim();

      const listingUrl =
        String(
          req.body?.listingUrl || ""
        ).trim();

      const message =
        String(
          req.body?.message || ""
        ).trim();

      const recommendation =
        String(
          req.body?.recommendation || ""
        ).trim();

      const createdAt =
        Number(
          req.body?.createdAt ||
          Date.now()
        );

      if (!sessionId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing sessionId."
          });
      }

      if (!listingId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing listingId."
          });
      }

      if (!listingUrl) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing listingUrl."
          });
      }

      if (!message) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing generated outreach message."
          });
      }

      /*
        Safety fallback:

        If the session-start request somehow failed
        but the queue request reaches the server,
        create the session automatically.
      */
      outreachDb
        .prepare(`
          INSERT OR IGNORE INTO marketplace_outreach_sessions (
            session_id,
            started_at,
            status
          )
          VALUES (?, ?, 'open')
        `)
        .run(
          sessionId,
          createdAt
        );

      const outreachId =
        randomUUID();

      const result =
        outreachDb
          .prepare(`
            INSERT OR IGNORE INTO marketplace_outreach_items (
              id,
              session_id,
              listing_id,
              listing_url,
              message,
              recommendation,
              status,
              created_at
            )
            VALUES (
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              'pending',
              ?
            )
          `)
          .run(
            outreachId,
            sessionId,
            listingId,
            listingUrl,
            message,
            recommendation,
            createdAt
          );

      /*
        listing_id is UNIQUE.

        If changes === 0, this listing was already
        queued during this or another session.
      */
      if (
        result.changes === 0
      ) {
        const existing =
          outreachDb
            .prepare(`
              SELECT *
              FROM marketplace_outreach_items
              WHERE listing_id = ?
            `)
            .get(
              listingId
            );

        console.log(
          "[OUTREACH QUEUE] Duplicate ignored:",
          listingId
        );

        return res.json({
          ok: true,

          queued: false,
          duplicate: true,

          item:
            normalizeMarketplaceOutreachItem(
              existing
            )
        });
      }

      console.log(
        "\n[OUTREACH QUEUE]"
      );

      console.log(
        "+ Listing:",
        listingId
      );

      console.log(
        "  Session:",
        sessionId
      );

      console.log(
        "  URL:",
        listingUrl
      );

      console.log(
        "  Recommendation:",
        recommendation
      );

      console.log(
        "  Message:",
        message
      );

      return res.json({
        ok: true,

        queued: true,
        duplicate: false,

        item: {
          id:
            outreachId,

          sessionId,
          listingId,
          listingUrl,
          message,
          recommendation,

          status:
            "pending",

          createdAt
        }
      });

    } catch (error) {
      console.error(
        "[OUTREACH QUEUE] Queue failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not queue Marketplace outreach."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — FINALIZE SCANNER SESSION
  ============================================================
*/

app.post(
  "/marketplace-outreach/session/finalize",
  (req, res) => {
    try {
      const sessionId =
        String(
          req.body?.sessionId || ""
        ).trim();

      if (!sessionId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing sessionId."
          });
      }

      const endedAt =
        Number(
          req.body?.endedAt ||
          Date.now()
        );

      const stopReason =
        String(
          req.body?.stopReason || ""
        ).trim();

      const clickedListings =
        Number(
          req.body?.clickedListings ||
          0
        );

      const hitsFound =
        Number(
          req.body?.hitsFound ||
          0
        );

      /*
        Do not blindly trust the extension's queue
        count. Read the authoritative value from DB.
      */
      const queuedCountRow =
        outreachDb
          .prepare(`
            SELECT COUNT(*) AS count
            FROM marketplace_outreach_items
            WHERE session_id = ?
          `)
          .get(
            sessionId
          );

      const outreachQueued =
        Number(
          queuedCountRow?.count ||
          0
        );

      const updateResult =
        outreachDb
          .prepare(`
            UPDATE marketplace_outreach_sessions

            SET
              ended_at = ?,
              stop_reason = ?,
              clicked_listings = ?,
              hits_found = ?,
              outreach_queued = ?,
              status = 'finalized'

            WHERE session_id = ?
          `)
          .run(
            endedAt,
            stopReason,
            clickedListings,
            hitsFound,
            outreachQueued,
            sessionId
          );

      if (
        updateResult.changes === 0
      ) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Outreach session was not found."
          });
      }

      const pendingRows =
        outreachDb
          .prepare(`
            SELECT *
            FROM marketplace_outreach_items

            WHERE
              session_id = ?
              AND status = 'pending'

            ORDER BY
              created_at ASC
          `)
          .all(
            sessionId
          );

      const pending =
        pendingRows.map(
          normalizeMarketplaceOutreachItem
        );

      /*
        Print exactly the queue you were describing
        into the Node terminal.
      */
      console.log(
        "\n========================================"
      );

      console.log(
        "[OUTREACH SESSION FINALIZED]"
      );

      console.log(
        "Session:",
        sessionId
      );

      console.log(
        "Listings scanned:",
        clickedListings
      );

      console.log(
        "Hits found:",
        hitsFound
      );

      console.log(
        "Outreach queued:",
        outreachQueued
      );

      console.log(
        "Pending:",
        pending.length
      );

      console.log(
        "========================================"
      );

      if (!pending.length) {
        console.log(
          "No pending outreach listings."
        );
      } else {
        console.log(
          "\nPENDING OUTREACH:"
        );

        pending.forEach(
          (
            item,
            index
          ) => {
            console.log(
              `${index + 1}. ${item.listingUrl}`
            );

            console.log(
              `   Listing ID: ${item.listingId}`
            );

            console.log(
              `   Message: ${item.message}`
            );
          }
        );
      }

      console.log(
        "========================================\n"
      );

      return res.json({
        ok: true,

        sessionId,

        status:
          "finalized",

        clickedListings,
        hitsFound,
        outreachQueued,

        pendingCount:
          pending.length,

        pending
      });

    } catch (error) {
      console.error(
        "[OUTREACH SESSION] Finalize failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not finalize outreach session."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — LATEST READY SESSION
  ============================================================
*/

app.get(
  "/marketplace-outreach/session/latest",
  (req, res) => {
    try {
      const session =
        outreachDb
          .prepare(`
            SELECT
              s.*,

              (
                SELECT COUNT(*)
                FROM marketplace_outreach_items i
                WHERE
                  i.session_id =
                    s.session_id
                  AND i.status =
                    'pending'
              ) AS pending_count

            FROM marketplace_outreach_sessions s

            WHERE
              s.status =
                'finalized'

            ORDER BY
              s.ended_at DESC

            LIMIT 1
          `)
          .get();

      if (!session) {
        return res.json({
          ok: true,
          session: null
        });
      }

      return res.json({
        ok: true,

        session: {
          sessionId:
            session.session_id,

          startedAt:
            session.started_at,

          endedAt:
            session.ended_at,

          stopReason:
            session.stop_reason || "",

          clickedListings:
            Number(
              session.clicked_listings ||
              0
            ),

          hitsFound:
            Number(
              session.hits_found ||
              0
            ),

          outreachQueued:
            Number(
              session.outreach_queued ||
              0
            ),

          pendingCount:
            Number(
              session.pending_count ||
              0
            )
        }
      });

    } catch (error) {
      console.error(
        "[OUTREACH SESSION] Latest lookup failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not load latest outreach session."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — CLAIM NEXT PENDING HIT
  ============================================================
*/

const claimNextMarketplaceOutreach =
  outreachDb.transaction(
    sessionId => {
      /*
        Recover jobs abandoned for over 30 minutes.

        Example:
        Chrome crashes after obtaining a job but before
        actually sending the message.
      */
      const staleBefore =
        Date.now() -
        30 * 60 * 1000;

      outreachDb
        .prepare(`
          UPDATE marketplace_outreach_items

          SET
            status = 'pending',
            claimed_at = NULL

          WHERE
            status = 'claimed'
            AND claimed_at IS NOT NULL
            AND claimed_at < ?
        `)
        .run(
          staleBefore
        );

      let item;

      if (sessionId) {
        item =
          outreachDb
            .prepare(`
              SELECT *
              FROM marketplace_outreach_items

              WHERE
                status = 'pending'
                AND session_id = ?

              ORDER BY
                created_at ASC

              LIMIT 1
            `)
            .get(
              sessionId
            );
      } else {
        item =
          outreachDb
            .prepare(`
              SELECT *
              FROM marketplace_outreach_items

              WHERE
                status = 'pending'

              ORDER BY
                created_at ASC

              LIMIT 1
            `)
            .get();
      }

      if (!item) {
        return null;
      }

      const claimedAt =
        Date.now();

      const result =
        outreachDb
          .prepare(`
            UPDATE marketplace_outreach_items

            SET
              status = 'claimed',
              claimed_at = ?,
              attempts =
                attempts + 1

            WHERE
              id = ?
              AND status = 'pending'
          `)
          .run(
            claimedAt,
            item.id
          );

      /*
        Defensive concurrency check.
      */
      if (
        result.changes !== 1
      ) {
        return null;
      }

      return outreachDb
        .prepare(`
          SELECT *
          FROM marketplace_outreach_items
          WHERE id = ?
        `)
        .get(
          item.id
        );
    }
  );

  app.get(
  "/marketplace-outreach/next",
  (req, res) => {
    try {
      const sessionId =
        String(
          req.query?.sessionId ||
          ""
        ).trim();

      const row =
        claimNextMarketplaceOutreach(
          sessionId || null
        );

      if (!row) {
        return res.json({
          ok: true,
          item: null
        });
      }

      const item =
        normalizeMarketplaceOutreachItem(
          row
        );

      console.log(
        "[OUTREACH CLAIM] Next listing:",
        {
          listingId:
            item.listingId,

          sessionId:
            item.sessionId,

          attempts:
            item.attempts
        }
      );

      return res.json({
        ok: true,
        item
      });

    } catch (error) {
      console.error(
        "[OUTREACH CLAIM] Failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not claim next outreach listing."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — MARK SENT
  ============================================================
*/

app.post(
  "/marketplace-outreach/:id/sent",
  (req, res) => {
    try {
      const id =
        String(
          req.params?.id || ""
        ).trim();

      if (!id) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing outreach item ID."
          });
      }

      const sentAt =
        Number(
          req.body?.sentAt ||
          Date.now()
        );

      const result =
        outreachDb
          .prepare(`
            UPDATE marketplace_outreach_items

            SET
              status = 'sent',
              sent_at = ?,
              failed_at = NULL,
              last_error = NULL

            WHERE
              id = ?
              AND status != 'sent'
          `)
          .run(
            sentAt,
            id
          );

      const item =
        outreachDb
          .prepare(`
            SELECT *
            FROM marketplace_outreach_items
            WHERE id = ?
          `)
          .get(
            id
          );

      if (!item) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Outreach item was not found."
          });
      }

      console.log(
        "[OUTREACH SENT]",
        {
          listingId:
            item.listing_id,

          itemId:
            id,

          updated:
            result.changes === 1
        }
      );

      return res.json({
        ok: true,

        item:
          normalizeMarketplaceOutreachItem(
            item
          )
      });

    } catch (error) {
      console.error(
        "[OUTREACH SENT] Failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not mark outreach item sent."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — SEND FAILURE
  ============================================================
*/

app.post(
  "/marketplace-outreach/:id/failed",
  (req, res) => {
    try {
      const id =
        String(
          req.params?.id || ""
        ).trim();

      const errorMessage =
        String(
          req.body?.error || ""
        ).trim();

      /*
        retryable = true:
            put it back into pending queue.

        retryable = false:
            permanently mark failed.
      */
      const retryable =
        req.body?.retryable !==
        false;

      if (!id) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing outreach item ID."
          });
      }

      const failedAt =
        Date.now();

      const status =
        retryable
          ? "pending"
          : "failed";

      outreachDb
        .prepare(`
          UPDATE marketplace_outreach_items

          SET
            status = ?,
            failed_at = ?,
            claimed_at = NULL,
            last_error = ?

          WHERE id = ?
        `)
        .run(
          status,
          failedAt,
          errorMessage,
          id
        );

      const item =
        outreachDb
          .prepare(`
            SELECT *
            FROM marketplace_outreach_items
            WHERE id = ?
          `)
          .get(
            id
          );

      if (!item) {
        return res
          .status(404)
          .json({
            ok: false,
            error:
              "Outreach item was not found."
          });
      }

      console.warn(
        "[OUTREACH FAILED]",
        {
          listingId:
            item.listing_id,

          retryable,

          attempts:
            item.attempts,

          error:
            errorMessage
        }
      );

      return res.json({
        ok: true,

        retryable,

        item:
          normalizeMarketplaceOutreachItem(
            item
          )
      });

    } catch (error) {
      console.error(
        "[OUTREACH FAILED] Update failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not update failed outreach."
        });
    }
  }
);

/*
  ============================================================
  MARKETPLACE OUTREACH — STATUS
  ============================================================
*/

app.get(
  "/marketplace-outreach/status",
  (req, res) => {
    try {
      const counts =
        outreachDb
          .prepare(`
            SELECT
              status,
              COUNT(*) AS count

            FROM marketplace_outreach_items

            GROUP BY status
          `)
          .all();

      const statusCounts = {
        pending: 0,
        claimed: 0,
        sent: 0,
        failed: 0
      };

      for (
        const row of counts
      ) {
        statusCounts[
          row.status
        ] =
          Number(
            row.count || 0
          );
      }

      const recent =
        outreachDb
          .prepare(`
            SELECT *
            FROM marketplace_outreach_items

            ORDER BY
              created_at DESC

            LIMIT 25
          `)
          .all()
          .map(
            normalizeMarketplaceOutreachItem
          );

      return res.json({
        ok: true,

        counts:
          statusCounts,

        recent
      });

    } catch (error) {
      console.error(
        "[OUTREACH STATUS] Failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error?.message ||
            "Could not read outreach status."
        });
    }
  }
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const OPENAI_LOG_DIRECTORY = path.resolve(
  process.env.OPENAI_LOG_DIRECTORY || "openai-api-logs"
);

/*
  Prices are in USD per 1 million tokens.

  Update this table if you change models or OpenAI changes pricing.
*/
const OPENAI_MODEL_PRICING_USD_PER_MILLION = {
  "gpt-4.1-mini": {
    input: 0.40,
    cachedInput: 0.10,
    output: 1.60
  },

  "gpt-4o-mini": {
    input: 0.15,
    cachedInput: 0.075,
    output: 0.60
  }
};


app.post(
  "/lookup-product-values",
  (req, res) => {
    try {
      const items =
        Array.isArray(req.body?.items)
          ? req.body.items
          : [];

const results =
  items.map((item, index) => {
    const databaseProduct =
      findProductInDatabase(item);

    if (!databaseProduct) {
      return {
        index,
        found: false,
        canonicalName:
          getCanonicalNameForItem(item)
      };
    }

    return {
      index,
      found: true,
      canonicalName:
        databaseProduct.canonical_name,
      estimatedResalePrice:
        Number(
          databaseProduct
            .estimated_resale_price
        )
    };
  });

console.log(
  "[PRODUCT DATABASE] Lookup results:",
  results
);

res.json({
  results
});
    } catch (error) {
      console.error(
        "Product database lookup failed:",
        error
      );

      res.status(500).json({
        error:
          "Product database lookup failed."
      });
    }
  }
);

/*
  Removes large base64 image contents from the saved log.

  The actual image is still sent to OpenAI. It is only omitted from
  the local log file so the log does not become extremely large.
*/
function sanitizeOpenAiLogValue(value) {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      const commaIndex = value.indexOf(",");

      const metadata =
        commaIndex >= 0
          ? value.slice(0, commaIndex)
          : "data:image";

      const encodedLength =
        commaIndex >= 0
          ? value.length - commaIndex - 1
          : value.length;

      return (
        `[${metadata}; base64 omitted; ` +
        `${encodedLength} encoded characters]`
      );
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeOpenAiLogValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        sanitizeOpenAiLogValue(child)
      ])
    );
  }

  return value;
}

function calculateOpenAiEstimatedCostUsd(
  model,
  usage = {}
) {
  const pricing =
    OPENAI_MODEL_PRICING_USD_PER_MILLION[model];

  if (!pricing) {
    return null;
  }

  const inputTokens =
    Number(usage.input_tokens || 0);

  const outputTokens =
    Number(usage.output_tokens || 0);

  const cachedInputTokens =
    Number(
      usage.input_tokens_details?.cached_tokens || 0
    );

  const uncachedInputTokens =
    Math.max(
      0,
      inputTokens - cachedInputTokens
    );

  return (
    (uncachedInputTokens * pricing.input) /
      1_000_000 +

    (cachedInputTokens * pricing.cachedInput) /
      1_000_000 +

    (outputTokens * pricing.output) /
      1_000_000
  );
}

async function downloadImageBuffer(
  url
) {
  const response =
    await fetch(
      url
    );

  if (!response.ok) {
    throw new Error(
      `Could not download listing image: ${response.status}`
    );
  }

  const contentType =
    String(
      response.headers
        .get(
          "content-type"
        ) ||
      ""
    )
      .toLowerCase();


  /*
    Sometimes an expired CDN URL returns
    HTML/JSON with HTTP 200 instead of
    an actual image.
  */
  if (
    contentType.includes(
      "text/html"
    ) ||
    contentType.includes(
      "application/json"
    ) ||
    contentType.includes(
      "text/plain"
    )
  ) {
    throw new Error(
      `Listing image URL returned non-image content: ${
        contentType ||
        "unknown"
      }`
    );
  }


  const arrayBuffer =
    await response
      .arrayBuffer();

  const buffer =
    Buffer.from(
      arrayBuffer
    );


  if (!buffer.length) {
    throw new Error(
      "Listing image download returned an empty buffer."
    );
  }


  return buffer;
}

function dataUrlToBuffer(dataUrl) {
  const value =
    String(dataUrl || "").trim();

  const match =
    value.match(
      /^data:image\/[^;]+;base64,(.+)$/i
    );

  if (!match) {
    throw new Error(
      "Invalid image data URL."
    );
  }

  return Buffer.from(
    match[1],
    "base64"
  );
}


async function getImageBufferForVision(
  imageSource
) {
  const source =
    String(imageSource || "").trim();

  if (!source) {
    throw new Error(
      "Missing image source for Vision OCR."
    );
  }

  if (
    source.startsWith(
      "data:image/"
    )
  ) {
    return dataUrlToBuffer(
      source
    );
  }

  return downloadImageBuffer(
    source
  );
}


async function readImageTextWithGoogleVision(
  imageSource
) {
  const imageBuffer =
    await getImageBufferForVision(
      imageSource
    );

  const [result] =
    await visionClient.textDetection({
      image: {
        content:
          imageBuffer
      }
    });

  const fullText =
    String(
      result
        ?.fullTextAnnotation
        ?.text ||
      result
        ?.textAnnotations
        ?.[0]
        ?.description ||
      ""
    ).trim();

  return fullText;
}

async function createCollageTile(
  originalBuffer,
  tileWidth,
  tileHeight
) {
  return sharp(originalBuffer)
    .rotate()
    .resize(
      tileWidth,
      tileHeight,
      {
        fit: "contain",
        background: {
          r: 255,
          g: 255,
          b: 255,
          alpha: 1
        }
      }
    )
    .jpeg({
      quality: 92
    })
    .toBuffer();
}

async function createUnavailableCollageTile(
  tileWidth,
  tileHeight,
  imageNumber
) {
  const svg =
    Buffer.from(`
      <svg
        width="${tileWidth}"
        height="${tileHeight}"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          width="100%"
          height="100%"
          fill="#f4f4f4"
        />

        <text
          x="50%"
          y="50%"
          dominant-baseline="middle"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="38"
          fill="#333333"
        >
          Image ${imageNumber} unavailable
        </text>
      </svg>
    `);


  return sharp(
    svg
  )
    .jpeg({
      quality: 90
    })
    .toBuffer();
}

async function buildMarketplaceCollage(
  imageUrls,
  startingImageIndex = 1
) {
  const urls =
    imageUrls;

  if (!urls.length) {
    throw new Error(
      "No image URLs supplied for collage."
    );
  }


  /*
    Three columns works well for most Marketplace
    listings without making every tile excessively tiny.

    1 image  -> 1 column
    2 images -> 2 columns
    3+       -> 3 columns
  */
  const columns =
    Math.min(
      3,
      urls.length
    );

  const rows =
    Math.ceil(
      urls.length /
      columns
    );


  /*
    Each original image is fit inside one 900 x 700 tile.

    Increase these later if model text is too small.
  */
  const tileWidth =
    900;

  const tileHeight =
    700;


  /*
    Red border separating every image.
  */
  const border =
    14;


  const collageWidth =
    columns *
      tileWidth +
    (columns + 1) *
      border;


  const collageHeight =
    rows *
      tileHeight +
    (rows + 1) *
      border;


  console.log(
    "[STEP 2] Building collage:",
    {
      imageCount:
        urls.length,

      columns,
      rows,

      collageWidth,
      collageHeight
    }
  );


  /*
    Download all Marketplace images IN ORDER.
  */
  const downloaded =
  [];

let validImageCount =
  0;


for (
  let index = 0;
  index < urls.length;
  index++
) {
  const actualImageNumber =
    startingImageIndex +
    index;

  console.log(
    `[STEP 2] Downloading image ${index + 1}/${urls.length}`
  );


  let tile;


  try {
    const buffer =
      await downloadImageBuffer(
        urls[index]
      );


    tile =
      await createCollageTile(
        buffer,
        tileWidth,
        tileHeight
      );


    validImageCount +=
      1;

  } catch (error) {
    console.warn(
      `[STEP 2] Image ${actualImageNumber} could not be decoded. ` +
      `Using a placeholder instead.`,
      {
        url:
          urls[index],

        error:
          error?.message ||
          String(error)
      }
    );


    /*
      Keep a placeholder in the SAME SLOT.

      This is important because the gallery's
      image numbering must continue matching
      the Marketplace image indexes.
    */
    tile =
      await createUnavailableCollageTile(
        tileWidth,
        tileHeight,
        actualImageNumber
      );
  }


  downloaded.push(
    tile
  );
}


if (
  validImageCount ===
  0
) {
  throw new Error(
    "All Marketplace listing images were unreadable."
  );
}


  /*
    Red canvas.

    Because the tiles don't touch one another,
    the exposed red canvas creates borders between them.
  */
  const composites =
    downloaded.map(
      (
        buffer,
        index
      ) => {
        const row =
          Math.floor(
            index /
            columns
          );

        const column =
          index %
          columns;


        const left =
          border +
          column *
            (
              tileWidth +
              border
            );


        const top =
          border +
          row *
            (
              tileHeight +
              border
            );


        return {
          input:
            buffer,

          left,
          top
        };
      }
    );


  const collageBuffer =
    await sharp({
      create: {
        width:
          collageWidth,

        height:
          collageHeight,

        channels:
          3,

        background: {
          r: 255,
          g: 0,
          b: 0
        }
      }
    })

      .composite(
        composites
      )

      .jpeg({
        quality: 94
      })

      .toBuffer();


return {
  collageBuffer,

  imageCount:
    urls.length,

  columns,
  rows,

  startingImageIndex,

  endingImageIndex:
    startingImageIndex +
    urls.length -
    1
};
}

const MAX_IMAGES_PER_COLLAGE = 6;

function chunkArray(
  array,
  size
) {
  const chunks = [];

  for (
    let index = 0;
    index < array.length;
    index += size
  ) {
    chunks.push(
      array.slice(
        index,
        index + size
      )
    );
  }

  return chunks;
}

function normalizeListingFactValue(
  value
) {
  if (
    value == null
  ) {
    return "";
  }


  if (
    typeof value ===
      "string" ||
    typeof value ===
      "number" ||
    typeof value ===
      "boolean"
  ) {
    return String(
      value
    )
      .replace(
        /\s+/g,
        " "
      )
      .trim();
  }


  if (
    Array.isArray(
      value
    )
  ) {
    return value
      .map(
        child =>
          normalizeListingFactValue(
            child
          )
      )
      .filter(Boolean)
      .join(", ");
  }


  if (
    typeof value ===
      "object"
  ) {
    const productValue =
      value.product ??
      value.item ??
      value.name ??
      value.model ??
      value.text ??
      value.description ??
      null;


    if (
      productValue != null
    ) {
      const productText =
        normalizeListingFactValue(
          productValue
        );


      const quantity =
        Number(
          value.quantity ??
          value.qty ??
          value.count
        );


      if (
        productText &&
        Number.isFinite(
          quantity
        ) &&
        quantity >
          0
      ) {
        return (
          `${quantity}x ` +
          productText
        );
      }


      return productText;
    }


    /*
      Unknown object format:
      preserve useful values instead of
      turning the object into "[object Object]".
    */
    return Object
      .entries(
        value
      )
      .map(
        (
          [
            key,
            child
          ]
        ) => {
          const normalized =
            normalizeListingFactValue(
              child
            );

          return normalized
            ? `${key}: ${normalized}`
            : "";
        }
      )
      .filter(Boolean)
      .join(", ");
  }


  return "";
}

app.post(
  "/vision-ocr",
  async (
    req,
    res
  ) => {
    try {
      const items =
        Array.isArray(
          req.body?.items
        )
          ? req.body.items
          : [];

      if (!items.length) {
        return res
          .status(400)
          .json({
            error:
              "No OCR items were supplied."
          });
      }

      const results = [];

      for (
        let index = 0;
        index < items.length;
        index++
      ) {
        const item =
          items[index] || {};

        const key =
          String(
            item.key ||
            `image_${index + 1}`
          ).trim();

        const imageSource =
          String(
            item.imageSource ||
            ""
          ).trim();

        if (!imageSource) {
          results.push({
            key,
            ok: false,
            text: "",
            error:
              "Missing imageSource."
          });

          continue;
        }

        try {
          console.log(
            `[VISION OCR] Reading ${key}`
          );

          const text =
            await readImageTextWithGoogleVision(
              imageSource
            );

          console.log(
            `[VISION OCR] ${key}:`
          );

          console.log(
            text ||
            "(no text detected)"
          );

          results.push({
            key,
            ok: true,
            text
          });

        } catch (error) {
          console.warn(
            `[VISION OCR] Failed ${key}:`,
            error
          );

          results.push({
            key,
            ok: false,
            text: "",
            error:
              error?.message ||
              String(error)
          });
        }
      }

      res.json({
        ok: true,
        results
      });

    } catch (error) {
      console.error(
        "[VISION OCR] Endpoint failed:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Vision OCR failed."
        });
    }
  }
);

app.post(
  "/analyze-listing-facts",
  async (
    req,
    res
  ) => {
    try {
      const listingText =
  String(
    req.body?.listingText ||
    ""
  ).trim();


if (!listingText) {
  return res
    .status(400)
    .json({
      error:
        "Missing listingText."
    });
}


console.log(
  "[STEP 1] Google-extracted listing text received:",
  listingText.length,
  "characters"
);



const prompt = `
You are analyzing seller-written text extracted from a Facebook Marketplace listing.

The text below came from Google's analysis of a screenshot of the listing.

Your ONLY job is to extract explicit textual facts from the listing title and seller-written description.

GOOGLE-EXTRACTED LISTING TEXT:

${listingText}

Return exactly one JSON object in this format:

{
  "explicitlyIncluded": [],
  "explicitlyExcluded": [],
  "listingNotes": []
}

explicitlyIncluded:
- Products or meaningful items that the seller explicitly states are included, come with the listing, or are being sold as part of it.
- Include quantities when explicitly stated.

explicitlyExcluded:
- Products or meaningful items that the seller explicitly states are NOT included.

CRITICAL RULE:
An item being absent from the title or description DOES NOT mean that it is excluded.

Only add something to explicitlyExcluded when the seller explicitly says it is not included.

listingNotes:
- Other explicit seller-written facts that may later help determine listing contents.
- Keep these concise.

Additional rules:
- Every element in explicitlyIncluded, explicitlyExcluded, and listingNotes MUST be a plain JSON string.
- Never return objects inside these arrays. If a quantity is known, include it in the string, for example: "2x Canon batteries".
- Use ONLY the supplied listing text.
- Do not invent facts.
- Do not make assumptions.
- Do not infer products from visual appearance.
- If there is no explicit evidence for a field, return an empty array.
- Return valid JSON only.
- Do not use Markdown.
- Do not use code fences.
`.trim();



      /*
        OpenAI Responses API supports
        image inputs using a data URL.

        Screenshot + instructions are
        submitted in the same request.
      */

    const response =
  await createLoggedOpenAiResponse({
    step:
      "Step 1 listing fact extraction",

    request: {
      model:
        "gpt-4o-mini",

      input: [
        {
          role:
            "user",

          content: [
            {
              type:
                "input_text",

              text:
                prompt
            }
          ]
        }
      ]
    }
  });



      const rawText =
        String(
          response.output_text ||
          ""
        ).trim();


      console.log(
        "[STEP 1] Raw OpenAI response:"
      );

      console.log(
        rawText
      );



      /*
        --------------------------------
        Parse strict JSON response
        --------------------------------
      */

      let parsed;


      try {
        parsed =
          JSON.parse(
            rawText
          );

      } catch (error) {
        console.error(
          "[STEP 1] Invalid JSON:",
          rawText
        );


        return res
          .status(502)
          .json({
            error:
              "OpenAI returned invalid JSON.",

            rawText
          });
      }



      /*
        --------------------------------
        Normalize the output

        Even if the model returns something
        slightly odd, the extension always
        receives the same structure.
        --------------------------------
      */

const result = {
  explicitlyIncluded:
    Array.isArray(
      parsed
        .explicitlyIncluded
    )
      ? parsed
          .explicitlyIncluded
          .map(
            value =>
              normalizeListingFactValue(
                value
              )
          )
          .filter(Boolean)
      : [],


  explicitlyExcluded:
    Array.isArray(
      parsed
        .explicitlyExcluded
    )
      ? parsed
          .explicitlyExcluded
          .map(
            value =>
              normalizeListingFactValue(
                value
              )
          )
          .filter(Boolean)
      : [],


  listingNotes:
    Array.isArray(
      parsed
        .listingNotes
    )
      ? parsed
          .listingNotes
          .map(
            value =>
              normalizeListingFactValue(
                value
              )
          )
          .filter(Boolean)
      : []
};



      console.log(
        "[STEP 1] Parsed listing facts:"
      );

      console.log(
        result
      );


      res.json(
        result
      );

    } catch (error) {
      console.error(
        "[STEP 1] Listing fact extraction failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Listing fact extraction failed."
        });
    }
  }
);

app.post(
  "/analyze-listing-gallery",
  async (
    req,
    res
  ) => {
    try {
      const imageUrls =
        Array.isArray(
          req.body?.imageUrls
        )
          ? req.body.imageUrls
              .map(
                value =>
                  String(
                    value || ""
                  ).trim()
              )
              .filter(Boolean)
          : [];


      if (!imageUrls.length) {
        return res
          .status(400)
          .json({
            error:
              "No imageUrls were supplied."
          });
      }


      console.log(
        `[STEP 2] Received ${imageUrls.length} listing image(s).`
      );


      /*
        Split into groups of at most 6.

        Example:
        9 images -> [1-6], [7-9]
      */
      const imageGroups =
        chunkArray(
          imageUrls,
          MAX_IMAGES_PER_COLLAGE
        );


      const galleryResults =
        [];


      for (
        let groupIndex = 0;
        groupIndex < imageGroups.length;
        groupIndex++
      ) {
        const groupImageUrls =
          imageGroups[
            groupIndex
          ];


        /*
          Global Marketplace image number.

          Group 1 starts at 1.
          Group 2 starts at 7.
          Group 3 starts at 13.
        */
        const startingImageIndex =
          groupIndex *
            MAX_IMAGES_PER_COLLAGE +
          1;


        console.log(
          `[STEP 2] Processing gallery ${groupIndex + 1}/${imageGroups.length}, starting at Image ${startingImageIndex}`
        );


        const {
          collageBuffer,
          imageCount,
          columns,
          rows,
          endingImageIndex
        } =
          await buildMarketplaceCollage(
            groupImageUrls,
            startingImageIndex
          );


        const collageDataUrl =
          `data:image/jpeg;base64,${collageBuffer.toString(
            "base64"
          )}`;


        console.log(
          `[STEP 2] Gallery ${groupIndex + 1} created:`,
          collageBuffer.length,
          "bytes"
        );


        const prompt = `
You are analyzing ONE collage made from photographs from a single Facebook Marketplace listing.

This collage contains original Marketplace Images ${startingImageIndex} through ${endingImageIndex}.

There are ${imageCount} images in this collage.

IMAGE ORDERING:

Read the collage:
- LEFT TO RIGHT across the first row.
- Then continue LEFT TO RIGHT across the next row.
- Continue row by row until the final image.

There are ${columns} columns and ${rows} rows.

The top-left tile is Image ${startingImageIndex}.

The next tile is Image ${startingImageIndex + 1}.

Continue sequentially until Image ${endingImageIndex}.

The red borders separate the original listing images.

YOUR JOB:

Determine which PHYSICAL PRIMARY PRODUCTS appear in each image and track the SAME physical product across multiple images within this collage.

For this application, primary products include:
- camera bodies
- cameras
- camera lenses
- flashes / Speedlites

Do not treat these as primary products:
- batteries
- chargers
- straps
- lens caps
- filters
- hoods
- cases
- bags
- manuals
- boxes
- memory cards
- cables
- adapters
- other small accessories

IMPORTANT:

This step is NOT for identifying the exact model.

Do NOT attempt to identify the actual camera or lens model yet.

Instead, create persistent physical-product identifiers such as:

camera_1
camera_2
lens_1
lens_2
flash_1

If the SAME physical camera appears in multiple images, use the same product ID in all of those images.

Do NOT create a new product ID merely because the same product appears again from another angle.

Likewise, if the same lens appears in multiple photographs, keep the same lens ID.

Only create a new product ID when there is visually sufficient evidence that it is a DIFFERENT physical product.

MODEL READABILITY SCORE:

For every product visible in every image, assign modelReadabilityScore from 1 through 10.

This score measures ONLY how useful that specific image is for determining the exact model from VISIBLE MODEL-IDENTIFYING TEXT OR MARKINGS on that physical product.

CRITICAL DOWNSTREAM OCR RULE:

The image receiving the highest modelReadabilityScore for a physical
product will be sent to an OCR system.

Therefore, when comparing images of the SAME physical product, strongly
prefer the image where the product's identifying printed text is most
likely to be successfully machine-read.

Examples include:

- exact camera model badges such as "60D", "D750", "α7 III"
- lens family markings such as "EF", "EF-S", "RF", "AF-S", "FE"
- focal length such as "18-55mm"
- maximum aperture such as "1:1.8", "f/2.8", "1:3.5-5.6"
- generation markers such as "II", "III", "G2"
- feature/model codes such as "STM", "USM", "IS", "VR", "OSS"

A sharp close-up containing readable printed model information should
score substantially higher than a visually attractive product photo
where those markings are hidden, tiny, blurred, or facing away.

Do NOT score based on whether YOU can visually recognize the product
from its shape. The purpose of this score is specifically to select
the best image for downstream OCR.

Examples of relevant visible markings:
- camera model badges
- printed model numbers
- lens focal-length markings
- aperture markings
- lens model names
- mount/model labels
- product labels

Scoring guidance:

10:
The exact model-identifying text is clearly visible and very easy to read.

8-9:
Most or all useful model-identifying markings are visible and readable with only minor difficulty.

6-7:
Some meaningful model-identifying text is visible, but it is incomplete, small, angled, or partially unclear.

4-5:
Only limited identifying text is readable, such as the brand, lens range, or partial model markings.

2-3:
Very little potentially useful model-identifying text can be read.

1:
No meaningful model-identifying text is readable on that product in that image.

CRITICAL SCORING RULE:

Score ONLY based on visible model-identifying text or markings.

Do NOT give a higher score because you recognize the product's:
- shape
- body design
- controls
- color
- grip
- silhouette
- lens geometry
- general appearance

PRODUCT MATCHING:

You MAY use visual appearance, shape, scratches, accessories, orientation, distinctive physical features, and surrounding context to determine whether a product shown in multiple images is the SAME physical object.

Return exactly one JSON object using this structure:

{
  "products": [
    {
      "productId": "camera_1",
      "productType": "camera body",
      "visibleInImages": [1, 2]
    }
  ],
  "images": [
    {
      "imageIndex": 1,
      "visibleProducts": [
        {
          "productId": "camera_1",
          "productType": "camera body",
          "modelReadabilityScore": 8
        }
      ]
    }
  ]
}

Rules:

- Every product ID appearing in images must also appear once in products.
- visibleInImages must contain every image where that product appears.
- Use the GLOBAL image numbers described above.
- Do NOT reset image numbering back to 1 for later collages.
- product IDs must remain consistent within this collage.
- modelReadabilityScore must be an integer from 1 through 10.
- Do not return exact model names.
- Do not guess model names.
- Do not include secondary accessories as primary products.
- Do not use Markdown.
- Do not use code fences.
- Return valid JSON only.
        `.trim();


      const response =
  await createLoggedOpenAiResponse({
    step:
      `Step 2 gallery analysis ${groupIndex + 1}`,

    request: {
      model:
        "gpt-5.6-luna",

      input: [
        {
          role:
            "user",

          content: [
            {
              type:
                "input_text",

              text:
                prompt
            },

            {
              type:
                "input_image",

              image_url:
                collageDataUrl,

              detail:
                "high"
            }
          ]
        }
      ]
    }
  });


        const rawText =
          String(
            response.output_text ||
            ""
          ).trim();


        console.log(
          `[STEP 2] Raw gallery ${groupIndex + 1} response:`
        );

        console.log(
          rawText
        );


        let parsed;


        try {
          parsed =
            JSON.parse(
              rawText
            );

        } catch (error) {
          console.error(
            `[STEP 2] Invalid JSON from gallery ${groupIndex + 1}:`,
            rawText
          );


          return res
            .status(502)
            .json({
              error:
                `OpenAI returned invalid Step-2 JSON for gallery ${groupIndex + 1}.`,

              rawText
            });
        }


galleryResults.push({
  galleryIndex:
    groupIndex + 1,

  startingImageIndex,

  endingImageIndex,

  imageCount,

  columns,

  rows,

  debugCollageDataUrl:
    collageDataUrl,

  galleryAnalysis:
    parsed
});
      }


      /*
        For now we return each gallery separately.

        We are NOT trying to merge product IDs across
        separate collages yet.
      */
      res.json({
        ok: true,

        totalImageCount:
          imageUrls.length,

        galleryCount:
          galleryResults.length,

        galleries:
          galleryResults
      });

    } catch (error) {
      console.error(
        "[STEP 2] Gallery analysis failed:",
        error
      );


      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Gallery analysis failed."
        });
    }
  }
);

app.post(
  "/reconcile-primary-products",
  async (
    req,
    res
  ) => {
    try {
      const listingTitle =
        String(
          req.body?.listingTitle ||
          ""
        ).trim();

      const listingDescription =
        String(
          req.body?.listingDescription ||
          ""
        ).trim();

      const listingScreenshotOcr =
        String(
          req.body?.listingScreenshotOcr ||
          ""
        ).trim();

      const productOcrResults =
        Array.isArray(
          req.body?.productOcrResults
        )
          ? req.body.productOcrResults
          : [];


      const explicitFacts =
        req.body?.explicitFacts || {
          explicitlyIncluded: [],
          explicitlyExcluded: [],
          listingNotes: []
        };

      const galleryResults =
  Array.isArray(
    req.body?.galleryResults
  )
    ? req.body.galleryResults.map(
        gallery => {
          const {
            debugCollageDataUrl,
            ...galleryWithoutDebugImage
          } = gallery || {};

          return galleryWithoutDebugImage;
        }
      )
    : [];

      const bestGoogleTargets =
        Array.isArray(
          req.body?.bestGoogleTargets
        )
          ? req.body.bestGoogleTargets
          : [];

      const googleLensResults =
        Array.isArray(
          req.body?.googleLensResults
        )
          ? req.body.googleLensResults
          : [];


      const prompt = `
You are performing the FINAL reconciliation step for a Facebook Marketplace camera-equipment listing.

Your job is to determine the final list of PRIMARY PRODUCTS being sold.

Primary products include:
- camera bodies
- cameras
- camera lenses
- flashes / Speedlites

Do NOT include:
- batteries
- chargers
- straps
- caps
- filters
- hoods
- cases
- bags
- manuals
- boxes
- memory cards
- cables
- adapters
- screen protectors
- other small accessories

You are receiving several evidence sources.

Your first objective is to identify each physical primary product as
specifically as the supplied evidence reliably supports.

Google Lens evidence may be completely absent. That is normal.

When seller text + OCR + gallery evidence are sufficient to establish
the exact specific model, resolve the product without requesting
Google Lens.

Only request Google Lens when the product identity remains too vague
to create a reliable exact-model resale/eBay lookup.

==================================================
SOURCE 0 — RAW LISTING INFORMATION
==================================================

LISTING TITLE:

${listingTitle}

LISTING DESCRIPTION:

${listingDescription}

VISIBLE SCREENSHOT OCR:

${listingScreenshotOcr}

Rules:

- This is seller/listing evidence.
- OCR may contain Facebook UI text unrelated to the listing.
- Use the title and description as cleaner evidence when available.
- OCR spelling can contain mistakes.
- Do not interpret unrelated Facebook interface text as a product.

==================================================
SOURCE A — EXPLICIT SELLER-WRITTEN FACTS
==================================================

These came from visible listing text.

${JSON.stringify(
  explicitFacts,
  null,
  2
)}

Rules for Source A:

- explicitlyIncluded means the seller directly stated that the item is included.
- explicitlyExcluded means the seller directly stated that the item is NOT included.
- listingNotes contains other explicit seller-written information.
- Seller-written model names can be strong evidence.
- An item being absent from seller text does NOT mean it is excluded.

==================================================
SOURCE B — GALLERY PRODUCT MAPPING
==================================================

This came from visual analysis of the listing photos.

${JSON.stringify(
  galleryResults,
  null,
  2
)}

Rules for Source B:

- productId represents a physical product tracked across images.
- The same product appearing in multiple images must NOT become multiple final products.
- modelReadabilityScore measures how readable model-identifying markings were for that specific product in that specific image.
- Higher readability means that image is stronger evidence for identifying that particular product.
- Gallery analysis did NOT intentionally identify exact models.

IMPORTANT:
If multiple separate gallery batches exist, product IDs are only guaranteed to be consistent WITHIN a gallery batch.
Do not automatically assume camera_1 from Gallery 1 is the same physical object as camera_1 from Gallery 2 unless the evidence supports that conclusion.

==================================================
SOURCE C — SELECTED GOOGLE TARGETS
==================================================

These show which image was selected as the strongest image for each detected product.

${JSON.stringify(
  bestGoogleTargets,
  null,
  2
)}

==================================================
SOURCE D — GOOGLE CLOUD VISION OCR FROM SELECTED PRODUCT IMAGES
==================================================

${JSON.stringify(
  productOcrResults,
  null,
  2
)}

Rules for Source D:

- Each entry corresponds to the selected best image for a physical product.
- ocrText is ALL text Google Vision detected in that complete image.
- More than one physical product may be visible in the image.
- Therefore, not every OCR string necessarily belongs to target productId.
- Use productType, gallery mapping, seller evidence, and surrounding evidence to determine which markings belong to which physical product.
- OCR can contain mistakes, missing characters, duplicated words, or incorrect spacing.
- Prefer combinations of markings that form a known coherent product identity.
- Do NOT invent missing model components.
- A highly readable OCR result such as:
  "Canon / EOS / 60D"
  is sufficient evidence for Canon EOS 60D.
- Lens OCR such as:
  "Canon / EF-S / 18-55mm / 1:3.5-5.6 / IS II"
  can support the normalized Canon EF-S 18-55mm f/3.5-5.6 IS II identity.

==================================================
SOURCE E GOOGLE LENS / AI RESULTS
==================================================

${JSON.stringify(
  googleLensResults,
  null,
  2
)}

Rules for Source E:

- Google results are OBSERVATIONS, not guaranteed truth.
- Google can identify multiple visible products even when only one product was the target.
- Do not assume every model mentioned by Google corresponds to the target product.
- Use targetProductId and targetProductType to understand what the Google search was intended to identify.
- Preserve awareness that another product may also be visible in the same image.

GROUP IDENTIFICATION RULES:

- A Google result with identificationMode = "group" was intentionally asked to identify MULTIPLE same-type physical products visible in one image.
- sameTypeProductIds contains the physical gallery product IDs represented by that group.
- groupIdentificationText may therefore contain multiple model names.
- Do NOT assign the entire groupIdentificationText to one targetProductId.
- Instead, treat the returned model names collectively as candidate identities for the physical products in sameTypeProductIds.
- Use gallery evidence, seller-written evidence, other Google observations, readability scores, already-resolved identities, and visible-product relationships to map individual models to individual physical product IDs when supported.
- Never create an additional physical product merely because a group Google result contains multiple model names.
- The number of model names in a group Google result does NOT override stronger gallery evidence about how many physical products exist.
- If the group identifies the models but there is insufficient evidence to determine which model belongs to which product ID, preserve the correct number of physical products and leave ambiguous individual models null rather than assigning them arbitrarily.

CRITICAL CONFLICT RULE:

When Google results disagree about the model of a particular physical product, prefer the Google observation coming from the image with the higher modelReadabilityScore FOR THAT SPECIFIC PRODUCT.

Example:

Image 1:
camera_1 readability = 10
lens_1 readability = 4
Google says:
Nikon D3100
18-55mm VR

Image 2:
camera_1 readability = 3
lens_1 readability = 10
Google says:
Nikon D3000
18-55mm VR II

Correct reconciliation:
camera_1 -> Nikon D3100
lens_1 -> 18-55mm VR II

Do NOT simply trust the entire Google result from whichever image had the highest score for the targeted product.

Instead, reason product-by-product.

OTHER RULES:

- Do not duplicate the same physical item.
- Seller-written text may explicitly establish a model even if visual evidence is weak.
- If seller text explicitly says multiple distinct primary products are included, preserve that unless there is strong contradictory evidence.
- If gallery evidence detects fewer products than seller text because an item is boxed, obscured, or not visibly identifiable, seller text may still establish that product as included.
- If exact model evidence is insufficient, use null for model rather than inventing one.
- If brand is unknown, use null.
- Prefer the most specific supported model name.
- Do not include secondary accessories.
- Do not include explanations in the final response.

SELLER QUANTITY RECONCILIATION RULE:

If seller text says a quantity such as "2 lenses" and gallery evidence
already contains 2 distinct physical camera lenses that reasonably
account for that quantity, those gallery products satisfy the seller's
quantity statement.

Do NOT create additional lens_text_* products merely because the
seller-written quantity does not explicitly map names to gallery IDs.

Only create *_text_* products when seller evidence establishes that
additional physical products are included BEYOND the products already
accounted for by the gallery evidence.

LENS NORMALIZATION RULES:

For every product whose productType is "camera lens", DO NOT return a free-form lens model string.

Instead, break the lens identity into these exact fields:

- brand
- mountSeries
- focalLength
- maxAperture
- featureModelCodes
- generation

Use null for any field that is not supported by the evidence.

Field definitions:

brand:
- The lens manufacturer/brand only.
- Examples: "Canon", "Nikon", "Sony", "Sigma", "Tamron", "Olympus".
- Do not include the brand again in any other lens field.

mountSeries:
- The mount, system, series, or manufacturer designation used to distinguish the lens family.
- Examples: "EF", "EF-S", "RF", "RF-S", "FE", "E", "Z", "F", "DX", "FX", "Micro Four Thirds".
- When a manufacturer commonly uses a combined family designation that is necessary to distinguish the lens, keep that combined designation here.
- Do not include focal length, aperture, feature codes, or generation here.

focalLength:
- Return only the focal length or zoom range.
- Normalize examples to: "50mm", "18-55mm", "70-200mm".
- Do not add spaces around the hyphen.

maxAperture:
- Return only the maximum aperture.
- Normalize examples to: "f/1.8", "f/2.8", "f/3.5-5.6".
- Convert equivalent markings such as "1:1.8" into "f/1.8" when the evidence clearly supports it.

featureModelCodes:
- Return the remaining manufacturer feature/model codes that distinguish the lens, in normal manufacturer naming order.
- Examples: "IS STM", "USM", "VR", "OSS", "G OSS", "DG DN Art", "ED VR".
- Do NOT put a generation marker such as "II" or "III" here when it clearly represents the lens generation.
- If there are no supported feature/model codes, return null.

generation:
- Return only an explicit model generation/revision marker.
- Examples: "II", "III", "G2".
- If no generation is supported, return null.

CRITICAL LENS RULES:
- Do not invent a missing lens component just to make the name look complete.
- If a component is unknown or ambiguous, return null for that field.
- Do not put the word "lens" into any lensIdentity field.
- Do not repeat information across lensIdentity fields.
- The application code, NOT you, will assemble the final lens name in this exact order:
  brand + mountSeries + focalLength + maxAperture + featureModelCodes + generation + "lens"
- Therefore, field placement must be consistent.

Return exactly this JSON structure:

{
  "primaryProducts": [
    {
      "productId": "camera_1",
      "galleryIndex": 1,
      "brand": "Canon",
      "model": "EOS 60D",
      "productType": "camera body",
      "lensIdentity": null
    }
  ],
  "needsGoogleLens": [
    {
      "galleryIndex": 1,
      "productId": "lens_1",
      "reason": "OCR only establishes Canon 18-55mm and does not establish the exact lens revision."
    }
  ]
}

GOOGLE LENS FALLBACK RULE:

For every gallery-visible physical product, decide whether the available
seller evidence + OCR evidence is specific enough to establish the
particular product model.

Add a product to needsGoogleLens ONLY when additional visual
identification is genuinely required.

Do NOT request Google Lens merely because:
- every possible marketing word is not known;
- seller text and OCR already clearly establish an exact camera model;
- a lens identity is already specific enough to distinguish the exact
  resale product.

DO request Google Lens when evidence remains materially ambiguous.

Examples:

Canon + EOS + 60D
→ specific enough
→ do NOT request Lens.

Canon + EOS
→ too vague
→ request Lens.

Canon + 18-55mm
→ normally too vague because many Canon 18-55mm revisions exist
→ request Lens.

Canon + EF-S + 18-55mm + f/3.5-5.6 + IS II
→ specific enough
→ do NOT request Lens.

If Google Lens evidence is already supplied for a product, incorporate
that evidence and do not request another Lens search unless the supplied
Lens evidence itself failed to identify the product.

Requirements:

- primaryProducts must be an array.
- Each physical primary product should appear exactly once.
- productId should reuse gallery product IDs when possible.
- If a seller-explicit product was not successfully mapped to a gallery product, create a stable descriptive ID such as:
  camera_text_1
  lens_text_1
  lens_text_2
- For camera lenses:
  - lensIdentity must be an object.
  - top-level brand must be null.
  - top-level model must be null.
  - Put all supported lens identity information inside lensIdentity.
- For non-lens products:
  - lensIdentity must be null.
  - brand may be null.
  - model may be null.
- productType must be one of:
  "camera body"
  "camera"
  "camera lens"
  "flash"
- Return valid JSON only.
- Do not use Markdown.
- Do not use code fences.
      `.trim();


const response =
  await createLoggedOpenAiResponse({
    step:
      "Step 5 primary product reconciliation",

    request: {
      model:
        "gpt-4o-mini",

      input: [
        {
          role:
            "user",

          content: [
            {
              type:
                "input_text",

              text:
                prompt
            }
          ]
        }
      ]
    }
  });


      const rawText =
        String(
          response.output_text ||
          ""
        ).trim();


      console.log(
        "[STEP 5] Raw reconciliation response:"
      );

      console.log(
        rawText
      );


      let parsed;

      try {
        parsed =
          JSON.parse(
            rawText
          );

      } catch (error) {
        return res
          .status(502)
          .json({
            error:
              "OpenAI returned invalid Step-5 JSON.",

            rawText
          });
      }


      const primaryProducts =
        Array.isArray(
          parsed?.primaryProducts
        )
          ? parsed.primaryProducts
          : [];

          const needsGoogleLens =
  Array.isArray(
    parsed?.needsGoogleLens
  )
    ? parsed.needsGoogleLens
        .map(
          item => ({
            galleryIndex:
              Number(
                item?.galleryIndex
              ) || 1,

            productId:
              String(
                item?.productId ||
                ""
              ).trim(),

            reason:
              String(
                item?.reason ||
                ""
              ).trim()
          })
        )
        .filter(
          item =>
            item.productId
        )
    : [];


      const result = {
  primaryProducts:
    primaryProducts
      .map(
        product => {
          const productId =
  String(
    product?.productId ||
    ""
  ).trim();

const galleryIndex =
  Number(
    product?.galleryIndex
  ) || 1;

const productType =
            String(
              product?.productType ||
              ""
            ).trim();

          const normalizedType =
            productType
              .toLowerCase();

          /*
            Camera lenses use the structured identity
            returned by Step 5.

            The AI does NOT determine the final word
            ordering anymore. JavaScript does.
          */
          if (
            normalizedType ===
            "camera lens"
          ) {
            const lensIdentity =
              normalizeLensIdentity(
                product?.lensIdentity ||
                {}
              );

            const model =
              buildNormalizedLensModel(
                lensIdentity
              );

            return {
  productId,

  galleryIndex,

  brand:
    lensIdentity.brand,

              model:
                model || null,

              productType,

              lensIdentity
            };
          }

          /*
            Cameras, flashes, etc. continue using
            the existing brand/model system.
          */
          return {
  productId,

  galleryIndex,

  brand:
    cleanNullableIdentityField(
      product?.brand
    ),

  model:
    cleanNullableIdentityField(
      product?.model
    ),

  productType,

  lensIdentity:
    null
};
        }
      )
            .filter(
        product =>
          product.productId &&
          product.productType
      ),

  needsGoogleLens
};


      console.log(
        "[STEP 5] Final primary products:"
      );

      console.dir(
        result,
        {
          depth: null
        }
      );


      res.json(
        result
      );

    } catch (error) {
      console.error(
        "[STEP 5] Reconciliation failed:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Final reconciliation failed."
        });
    }
  }
);

function getOpenAiLogFilePath() {
  const date =
    new Date()
      .toISOString()
      .slice(0, 10);

  return path.join(
    OPENAI_LOG_DIRECTORY,
    `openai-api-${date}.jsonl`
  );
}

function appendOpenAiLogEntry(entry) {
  try {
    fs.mkdirSync(
      OPENAI_LOG_DIRECTORY,
      {
        recursive: true
      }
    );

    fs.appendFileSync(
      getOpenAiLogFilePath(),
      `${JSON.stringify(entry)}\n`,
      "utf8"
    );
  } catch (error) {
    console.error(
      "[OPENAI LOG] Could not write API log entry:",
      error
    );
  }
}

/*
  Use this instead of calling openai.responses.create directly.

  It records:
  - Complete request input
  - Complete output
  - Token usage
  - Cached token usage
  - Duration
  - Estimated cost
  - Errors
*/
async function createLoggedOpenAiResponse({
  step,
  request
}) {
  const requestId =
    `openai-${Date.now()}-` +
    Math.random()
      .toString(36)
      .slice(2, 9);

  const startedAt = Date.now();

  const sanitizedRequest =
    sanitizeOpenAiLogValue(request);

  appendOpenAiLogEntry({
    timestamp: new Date().toISOString(),
    event: "request",
    requestId,
    step,
    model: request.model || "",
    input: sanitizedRequest.input ?? null,
    request: sanitizedRequest
  });

  console.log(
    `[OPENAI REQUEST] ${step}`,
    {
      requestId,
      model: request.model || ""
    }
  );

  try {
const response =
  await openai.responses.create(
    request
  );

    const durationMs =
      Date.now() - startedAt;

   const usage = response?.usage || {};

const inputTokens =
  Number(usage.input_tokens || 0);

const cachedTokens =
  Number(
    usage.input_tokens_details?.cached_tokens || 0
  );

const uncachedInputTokens =
  Math.max(
    0,
    inputTokens - cachedTokens
  );

const outputTokens =
  Number(usage.output_tokens || 0);

const totalTokens =
  Number(
    usage.total_tokens ||
    inputTokens + outputTokens
  );

const estimatedCostUsd =
  calculateOpenAiEstimatedCostUsd(
    request.model,
    usage
  );

console.log(
  `[OPENAI USAGE] ${step}`,
  {
    model: request.model,
    inputTokens,
    cachedTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens,
    estimatedCostUsd
  }
);

appendOpenAiLogEntry({
  timestamp:
    new Date().toISOString(),

  event:
    "response",

  requestId,

  step,

  model:
    request.model || "",

  durationMs,

  usage: {
    inputTokens,
    cachedTokens,
    uncachedInputTokens,
    outputTokens,
    totalTokens
  },

  estimatedCostUsd,

  responseId:
    response?.id || "",

  outputText:
    String(
      response?.output_text || ""
    )
});

return response;

  } catch (error) {
    const durationMs =
      Date.now() - startedAt;

    appendOpenAiLogEntry({
      timestamp:
        new Date().toISOString(),

      event:
        "error",

      requestId,

      step,

      model:
        request.model || "",

      durationMs,

      error: {
        name:
          error?.name || "",

        message:
          error?.message ||
          String(error),

        status:
          error?.status ?? null,

        code:
          error?.code ?? null,

        type:
          error?.type ?? null
      }
    });

    console.error(
      `[OPENAI ERROR] ${step}`,
      {
        requestId,
        model:
          request.model || "",
        durationMs,
        error:
          error?.message ||
          String(error)
      }
    );

    throw error;
  }
}

function getGoogleSheetHitDate() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    year: "2-digit"
  }).format(new Date());
}

async function appendSavedDealToGoogleSheet(deal) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || "Main";

  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID.");
  }

  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_OAUTH_REFRESH_TOKEN.");
  }

  const auth = createGoogleOAuthClient();

  auth.setCredentials({
    refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  });

  const sheets = google.sheets({ version: "v4", auth });

  const sheetMeta = await sheets.spreadsheets.get({
    spreadsheetId
  });

  const sheet = sheetMeta.data.sheets.find(
    s => s.properties.title === tabName
  );

  if (!sheet) {
    throw new Error(`Google Sheet tab not found: ${tabName}`);
  }

  const sheetId = sheet.properties.sheetId;

  const primaryItems = Array.isArray(deal.items) && deal.items.length
    ? deal.items.filter(item => item?.isPrimarySellableItem !== false)
    : [];

  const rowItems = primaryItems.length ? primaryItems : [deal];
  const listingRowCount = rowItems.length;

const recommendationText = deal.recommendation || "";

const normalizedRecommendation =
  String(recommendationText)
    .trim()
    .toLowerCase();

const isNegotiate =
  normalizedRecommendation === "negotiate";

const isBuyNow =
  normalizedRecommendation === "buy now";

/*
  Date when this hit was recorded in Google Sheets.
  Example: 8/2/26
*/
const hitRecordedDate = getGoogleSheetHitDate();

const analysisLogUrl =
  String(
    deal.analysisLogUrl ||
    ""
  ).trim();

const rows = rowItems.map((item, index) => {
const analysisLogLink =
  index === 0 &&
  analysisLogUrl
    ? (
        `=HYPERLINK("${analysisLogUrl}","View Log")`
      )
    : "";

    const itemResult = item.result || item.evaluationResult || item;

    // A: use the exact eBay comp search term first
    const itemName =
      item.ebaySearchQuery ||
      item.searchQuery ||
      item.itemName ||
      `${item.brand || ""} ${item.model || ""} ${item.productType || ""}`.replace(/\s+/g, " ").trim() ||
      deal.title ||
      "";

    // Listing-level values
    const facebookUrl = index === 0 ? (deal.facebookUrl || "") : "";
    const decision = index === 0 ? recommendationText : "";
    const askPrice = index === 0 ? (deal.facebookPrice ?? "") : "";

    // Item-level / analytical values
    const estimatedResale =
      itemResult.expectedSalePrice ??
      item.includedExpectedSalePrice ??
      itemResult.estimatedResaleValue ??
      item.estimatedResaleValue ??
      deal.estimatedResaleValue ??
      "";

    const priceStdDev =
      itemResult.priceStandardDeviation ??
      item.priceStandardDeviation ??
      deal.priceStandardDeviation ??
      "";

    // H:Q listing-level columns
    /*
  Threshold Buy is only relevant for Negotiate listings.

  Buy Now, Pass, Scam, and Error rows must remain blank.
*/
const thresholdBuy =
  index === 0 && isNegotiate
    ? (
        deal.maxBuyPrice ??
        itemResult.maxBuyPrice ??
        item.maxBuyPrice ??
        ""
      )
    : "";

/*
  Columns I:P are reserved for manual entry.

  Never copy extension or analysis values into these columns.
*/
const manualColumnJ = "";
const manualColumnK = "";
const manualColumnL = "";
const manualColumnM = "";

/*
  N is listing-level, so only the first row receives the date.
  If the listing contains multiple items, column N is merged later.
*/
const hitDateColumnN =
  index === 0
    ? hitRecordedDate
    : "";

const manualColumnO = "";
const manualColumnP = "";
const relistedYN =
  index === 0
    ? (deal.relisted ?? deal.relistedYN ?? "")
    : "";

   return [
  itemName,        // A
  facebookUrl,     // B
  decision,        // C
  askPrice,        // D
  estimatedResale, // E
  priceStdDev,     // F
  "",              // G — Manual Evaluation
  thresholdBuy,    // H
  analysisLogLink, // I — Analysis Log
  manualColumnJ,   // J
  manualColumnK,   // K
  manualColumnL,   // L
  manualColumnM,   // M
  hitDateColumnN,  // N
  manualColumnO,   // O
  manualColumnP,   // P
  relistedYN       // Q
];
  });

const existingColumnA =
  await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A:A`
  });

const existingRows =
  existingColumnA.data.values || [];

const insertedStartRowNumber =
  Math.max(existingRows.length + 1, 2);

const insertedEndRowNumber =
  insertedStartRowNumber +
  rows.length -
  1;

await sheets.spreadsheets.values.update({
  spreadsheetId,
  range:
    `${tabName}!A${insertedStartRowNumber}:Q${insertedEndRowNumber}`,
  valueInputOption: "USER_ENTERED",
  requestBody: {
    values: rows
  }
});

const startRowIndex =
  insertedStartRowNumber - 1;

const endRowIndex =
  insertedEndRowNumber;

  const requests = [];

const mergedColumns = [
  1, // B Facebook link
  2, // C Decision
  3, // D Ask price
  7, // H Threshold buy
  8, // I Analysis Log
  9, // J
  10, // K
  11, // L
  12, // M
  13, // N
  14, // O
  15, // P
  16  // Q Relisted
];

  if (listingRowCount > 1) {
    for (const columnIndex of mergedColumns) {
      requests.push({
        mergeCells: {
          range: {
            sheetId,
            startRowIndex,
            endRowIndex,
            startColumnIndex: columnIndex,
            endColumnIndex: columnIndex + 1
          },
          mergeType: "MERGE_ALL"
        }
      });
    }
  }

  // Center merged columns vertically/horizontally
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex: 1,
        endColumnIndex: 4
      },
      cell: {
        userEnteredFormat: {
          verticalAlignment: "MIDDLE",
          horizontalAlignment: "CENTER"
        }
      },
      fields: "userEnteredFormat(verticalAlignment,horizontalAlignment)"
    }
  });

  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex: 7,
        endColumnIndex: 16
      },
      cell: {
        userEnteredFormat: {
          verticalAlignment: "MIDDLE",
          horizontalAlignment: "CENTER"
        }
      },
      fields: "userEnteredFormat(verticalAlignment,horizontalAlignment)"
    }
  });

  // Force every newly added cell from A:Q to have a white background.
// This prevents the manual background color from the previous listing
// from carrying into the newly inserted rows.
requests.push({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: 0,
      endColumnIndex: 17
    },
    cell: {
      userEnteredFormat: {
        backgroundColor: {
          red: 1,
          green: 1,
          blue: 1
        }
      }
    },
    fields: "userEnteredFormat.backgroundColor"
  }
});

/*
  Columns I:M and O:P are controlled manually.

  Column N is intentionally excluded because it stores the
  date when the hit was recorded.
*/

// Clear J:M.
// Column I now contains the analysis log link.
requests.push({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: 9,
      endColumnIndex: 13
    },
    cell: {
      userEnteredValue: null
    },
    fields: "userEnteredValue"
  }
});

// Clear O:P.
requests.push({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: 14,
      endColumnIndex: 16
    },
    cell: {
      userEnteredValue: null
    },
    fields: "userEnteredValue"
  }
});

// Make Threshold Buy black if the listing is NOT marked Negotiate.
// This must stay after the white-background request.
if (!isNegotiate) {
  requests.push({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex,
        endRowIndex,
        startColumnIndex: 7,
        endColumnIndex: 8
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: {
            red: 0,
            green: 0,
            blue: 0
          }
        }
      },
      fields: "userEnteredFormat.backgroundColor"
    }
  });
}

// Add the black divider underneath the complete listing from A:Q.
requests.push({
  updateBorders: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: 0,
      endColumnIndex: 17
    },
    bottom: {
      style: "SOLID_MEDIUM",
      color: {
        red: 0,
        green: 0,
        blue: 0
      }
    }
  }
});

// Add a black right-side border to column Q for the complete listing.
requests.push({
  updateBorders: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,
      startColumnIndex: 16,
      endColumnIndex: 17
    },
    right: {
      style: "SOLID_MEDIUM",
      color: {
        red: 0,
        green: 0,
        blue: 0
      }
    }
  }
});

  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests
      }
    });
  }
}

function createGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://localhost:3000/oauth2callback";

  if (!clientId) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID in .env");
  }

  if (!clientSecret) {
    throw new Error("Missing GOOGLE_OAUTH_CLIENT_SECRET in .env");
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    redirectUri
  );
}

app.get("/google-auth-url", (req, res) => {
  try {
    const oauth2Client = createGoogleOAuthClient();

    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    res.send(`<a href="${url}">Authorize Google Sheets</a>`);
  } catch (error) {
    console.error("Google auth URL failed:", error);
    res.status(500).send(error.message);
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const oauth2Client = createGoogleOAuthClient();
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Missing OAuth code.");
    }

    const { tokens } = await oauth2Client.getToken(code);

    console.log("GOOGLE_OAUTH_REFRESH_TOKEN=", tokens.refresh_token);

    res.send(`
      <h2>Google Sheets authorized.</h2>
      <p>Check your server terminal for GOOGLE_OAUTH_REFRESH_TOKEN.</p>
    `);
  } catch (error) {
    console.error("OAuth callback failed:", error);
    res.status(500).send(error.message);
  }
});

function sendServerError(res, error, fallbackMessage) {
  const malformedAiJson =
    error?.code === "MALFORMED_AI_JSON" ||
    error?.name === "MalformedAiJsonError";

  if (malformedAiJson) {
    return res.status(502).json({
      ok: false,
      error: error.message,
      code: "MALFORMED_AI_JSON",
      retryEntireListing: true,
      step: error.step || "unknown",
      originalError: error.originalError || ""
    });
  }

  return res.status(500).json({
    ok: false,
    error: error?.message || fallbackMessage,
    code: "SERVER_ERROR",
    retryEntireListing: false
  });
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString()
  });
});

app.post(
  "/save-deal-to-sheet",
  async (req, res) => {
    try {
      const {
        deal
      } =
        req.body;

      if (!deal) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing deal"
          });
      }

      const analysisRunId =
        sanitizeAnalysisRunId(
          deal.analysisRunId ||
          req.get(
            "X-Analysis-Run-Id"
          )
        );

      if (!analysisRunId) {
        throw new Error(
          "Hit is missing analysisRunId."
        );
      }

      console.log(
        "[HIT LOG] Preparing permanent Supabase log.",
        {
          analysisRunId
        }
      );

      /*
        Upload everything collected during
        this listing analysis.
      */
      const uploadedLog =
        await uploadAnalysisLogToSupabase(
          analysisRunId
        );

      console.log(
        "[HIT LOG] Supabase upload complete.",
        {
          analysisRunId,
          objectPath:
            uploadedLog.objectPath,
          publicUrl:
            uploadedLog.publicUrl
        }
      );

      /*
        Attach the permanent HTTPS link
        before writing the Google Sheet.
      */
      const dealWithLog = {
        ...deal,

        analysisRunId,

        analysisLogUrl:
          uploadedLog.publicUrl
      };

      await appendSavedDealToGoogleSheet(
        dealWithLog
      );

      return res.json({
        ok: true,

        analysisLogUrl:
          uploadedLog.publicUrl
      });

    } catch (error) {
      console.error(
        "Google Sheets / hit-log save failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not save hit."
        });
    }
  }
);


function isWithinLast90Days(soldDate) {
  if (!soldDate) return false;

  const date = new Date(soldDate);
  if (Number.isNaN(date.getTime())) return false;

  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return date.getTime() >= cutoff;
}

function standardDeviation(numbers) {
  if (!Array.isArray(numbers) || numbers.length < 2) return null;

  const validNumbers = numbers
    .map(Number)
    .filter(num => Number.isFinite(num));

  if (validNumbers.length < 2) return null;

  const mean =
    validNumbers.reduce((sum, num) => sum + num, 0) / validNumbers.length;

  const variance =
    validNumbers.reduce((sum, num) => sum + Math.pow(num - mean, 2), 0) /
    validNumbers.length;

  return Number(Math.sqrt(variance).toFixed(2));
}

function median(numbers) {
  if (!numbers.length) return null;

  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2));
  }

  return Number(sorted[mid].toFixed(2));
}

async function updateMarketplaceConversationFollowUpColumn({
  rowNumber,
  followUpDue
}) {
  const cleanRowNumber =
    Number(rowNumber);

  if (
    !Number.isInteger(cleanRowNumber) ||
    cleanRowNumber < 1
  ) {
    return;
  }


  const spreadsheetId =
    process.env
      .GOOGLE_SHEETS_SPREADSHEET_ID;

  const tabName =
    process.env
      .GOOGLE_SHEETS_TAB_NAME ||
    "Main";


  if (!spreadsheetId) {
    throw new Error(
      "Missing GOOGLE_SHEETS_SPREADSHEET_ID."
    );
  }


  if (
    !process.env
      .GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new Error(
      "Missing GOOGLE_OAUTH_REFRESH_TOKEN."
    );
  }


  const auth =
    createGoogleOAuthClient();


  auth.setCredentials({
    refresh_token:
      process.env
        .GOOGLE_OAUTH_REFRESH_TOKEN
  });


  const sheets =
    google.sheets({
      version: "v4",
      auth
    });


  await sheets
    .spreadsheets
    .values
    .update({
      spreadsheetId,

      /*
        Q = Follow Up
      */
      range:
        `${tabName}!Q${cleanRowNumber}`,

      valueInputOption:
        "USER_ENTERED",

      requestBody: {
        values: [
          [
            followUpDue
              ? "Y"
              : ""
          ]
        ]
      }
    });


  console.log(
    "[CONVERSATION TRACKER] Follow-up column updated:",
    {
      rowNumber:
        cleanRowNumber,

      column:
        "Q",

      value:
        followUpDue
          ? "Y"
          : ""
    }
  );
}

function applyExpectedSalePriceBuffer(medianSoldPrice) {
  const price = Number(medianSoldPrice);

  if (!price || Number.isNaN(price)) {
    return null;
  }

  // 10% safety buffer: treat the item as if it sells for 90% of median.
  return Number(price.toFixed(2));
}

class MalformedAiJsonError extends Error {
  constructor(step, rawText, originalError) {
    super(`AI returned malformed JSON during: ${step}`);

    this.name = "MalformedAiJsonError";
    this.code = "MALFORMED_AI_JSON";
    this.step = step;
    this.rawText = String(rawText || "").slice(0, 4000);
    this.originalError = originalError?.message || "";
  }
}

function extractJsonObject(text, step = "AI JSON parsing") {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (
    firstBrace === -1 ||
    lastBrace === -1 ||
    lastBrace <= firstBrace
  ) {
    throw new MalformedAiJsonError(
      step,
      text,
      new Error("No complete JSON object found.")
    );
  }

  const jsonText = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new MalformedAiJsonError(
      step,
      text,
      error
    );
  }
}

async function runAiJsonStep({
  step,
  maxAttempts = 3,
  runRequest
}) {
  let lastRawText = "";
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await runRequest(attempt);

      const rawText = String(response?.output_text || "").trim();
      lastRawText = rawText;

      console.log(
        `[AI JSON] ${step} attempt ${attempt}/${maxAttempts}`
      );
      console.log(rawText);

 return extractJsonObject(rawText, step);
    } catch (error) {
      lastError = error;

      console.error(
        `[AI JSON] ${step} attempt ${attempt}/${maxAttempts} failed:`,
        error.message
      );

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 750 * attempt));
      }
    }
  }

  throw new MalformedAiJsonError(
    step,
    lastRawText,
    lastError
  );
}

async function aiCleanComps({ target, comps }) {
  if (!comps.length) {
    return {
      validIndexes: [],
      invalidComps: []
    };
  }

 const compListText = comps.map((comp, index) => {
  return `${index + 1}. ${comp.title} | $${comp.price} | ${comp.soldDate || "date unknown"}`;
}).join("\n");

let parsed = await runAiJsonStep({
  step: "eBay comp cleanup",
  maxAttempts: 3,

  runRequest: async attempt => {
    return createLoggedOpenAiResponse({
  step:
    `eBay comp cleanup attempt ${attempt}`,

  request: {
    model: "gpt-4.1-mini",
    input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
text: `
You are cleaning eBay sold comps for a reseller.

Target product:
Brand: ${target.brand || ""}
Model: ${target.model || ""}
Product type: ${target.productType || ""}
Condition: already filtered by eBay search; ignore condition during cleanup.
Search query: ${target.ebaySearchQuery || ""}

Candidate sold listings:
${compListText}

Return ONLY raw JSON:
{
  "validIndexes": [1, 2, 3],
  "relatedWrongComps": [
    {
      "index": 4,
      "wrongModelName": "Nikon AF-P 18-55mm",
      "suggestedNegativeTerms": ["AF-P"]
    }
  ],
  "searchPollution": {
    "relatedWrongModelCount": 0,
    "negativeSearchTerms": [],
    "reason": ""
  }
}

Do not return an entry for ordinary invalid listings.

Only include a listing in relatedWrongComps when it is a closely
related but commercially different model that could pollute the search.

Accessories, hoods, caps, manuals, boxes, adapters, unrelated products,
damaged listings, parts-only listings, bundles with the wrong product
type, and other ordinary invalid comps should simply be omitted from
both validIndexes and relatedWrongComps.

Comp matching rules:

- validIndexes must contain only listings for the same commercially distinct product as the target.
- A listing with a genuinely different model, generation, mount, focal length, aperture, or separately sold variant is invalid.
- Minor title formatting differences do not make a listing invalid.
- Missing words in either the target or candidate title do not automatically prove that they are different products.
- Do not assume that an omitted qualifier means the opposite qualifier.
- Count a candidate as a related wrong model only when it is a different but closely related product that is polluting the target search.
- Accessories, hoods, caps, manuals, boxes, adapters, and unrelated products are invalid, but they do not count as related wrong models.
- Damaged or parts-only listings do not count as related wrong models.
- relatedWrongModelCount must count only closely related but commercially different models.
- validExactModelCount must equal the number of listings retained in validIndexes.

Search-pollution rules:

- The minimum required valid-comp count is 7.
- The minimum related-wrong-model count required for pollution is 8.
- A search can only be marked polluted when validExactModelCount is below 7.
- If validExactModelCount is 7 or greater:
  - pollutedByRelatedModels must be false.
  - rerunRecommended must be false.
  - negativeSearchTerms must be [].
  - The search must not be rerun merely because wrong listings also appeared.
- If validExactModelCount is below 7, count the related wrong-model listings.
- Only when validExactModelCount is below 7 and relatedWrongModelCount is at least 8:
  - pollutedByRelatedModels may be true.
  - rerunRecommended may be true.
  - negativeSearchTerms should contain safe exclusions for the dominant wrong related models.
- If validExactModelCount is below 7 but relatedWrongModelCount is below 8:
  - pollutedByRelatedModels must be false.
  - rerunRecommended must be false.
  - negativeSearchTerms must be [].
- Never recommend a negative term that may be part of the target product.
- Never recommend a negative term solely because it is absent from an incomplete target name.
- If the target identity may be incomplete or ambiguous, do not recommend potentially destructive negative terms.

This is JSON generation attempt ${attempt} of 3.
Return exactly one complete valid JSON object.
Do not use Markdown or code fences.
`.trim()
            }
          ]
        }
      ]
  }
    });
  }
});

const validIndexes = Array.isArray(
  parsed.validIndexes
)
  ? parsed.validIndexes
      .map(Number)
      .filter(Number.isFinite)
  : [];

const relatedWrongComps = Array.isArray(
  parsed.relatedWrongComps
)
  ? parsed.relatedWrongComps
  : [];

const rawSearchPollution =
  parsed.searchPollution &&
  typeof parsed.searchPollution === "object"
    ? parsed.searchPollution
    : {};

const MINIMUM_VALID_COMPS = 7;
const MINIMUM_RELATED_WRONG_MODEL_COMPS = 8;

/*
  validExactModelCount must come from the actual
  retained comp indexes, not an AI-estimated count.
*/
const validExactModelCount =
  validIndexes.length;

/*
  Prefer the AI's related-model count because
  relatedWrongComps may also contain accessories,
  damaged listings, and unrelated products.
*/
const relatedWrongModelCount =
  Math.max(
    0,
    Number(
      rawSearchPollution.relatedWrongModelCount ||
      0
    )
  );

const belowMinimumCompThreshold =
  validExactModelCount <
  MINIMUM_VALID_COMPS;

const enoughRelatedWrongModels =
  relatedWrongModelCount >=
  MINIMUM_RELATED_WRONG_MODEL_COMPS;

const pollutedByRelatedModels =
  belowMinimumCompThreshold &&
  enoughRelatedWrongModels;

const safeNegativeSearchTerms =
  pollutedByRelatedModels &&
  Array.isArray(
    rawSearchPollution.negativeSearchTerms
  )
    ? rawSearchPollution.negativeSearchTerms
    : [];

return {
  validIndexes,
  invalidComps: relatedWrongComps,

  searchPollution: {
    pollutedByRelatedModels,

    validExactModelCount,
    relatedWrongModelCount,

    rerunRecommended:
      pollutedByRelatedModels &&
      safeNegativeSearchTerms.length > 0,

    negativeSearchTerms:
      safeNegativeSearchTerms,

    reason:
      pollutedByRelatedModels
        ? String(
            rawSearchPollution.reason ||
            `Only ${validExactModelCount} valid comps were found, below the minimum of ${MINIMUM_VALID_COMPS}, while ${relatedWrongModelCount} related wrong-model comps were found.`
          )
        : validExactModelCount >=
            MINIMUM_VALID_COMPS
          ? `Search retained ${validExactModelCount} valid comps, meeting the minimum of ${MINIMUM_VALID_COMPS}; pollution rerun is not permitted.`
          : `Search retained only ${validExactModelCount} valid comps, but found fewer than ${MINIMUM_RELATED_WRONG_MODEL_COMPS} related wrong-model comps, so it is not classified as polluted.`,

    belowMinimumCompThreshold,
    enoughRelatedWrongModels,

    minimumValidComps:
      MINIMUM_VALID_COMPS,

    minimumRelatedWrongModelComps:
      MINIMUM_RELATED_WRONG_MODEL_COMPS
  }
};
}

function makeDealDecision({ expectedSalePrice, facebookPrice, validSoldCount }) {
  if (!expectedSalePrice || !facebookPrice || !validSoldCount) {
    return {
      recommendation: "Pass",
      reason: "Not enough valid data to calculate a deal."
    };
  }

  const targetProfit = 85;
 const negotiatedPrice15 = Number((facebookPrice * 0.85).toFixed(2));

const marginAtAsk = Number((expectedSalePrice - facebookPrice).toFixed(2));
const marginAt15 = Number((expectedSalePrice - negotiatedPrice15).toFixed(2));

  if (marginAtAsk >= targetProfit) {
    return {
      recommendation: "Buy Now",
      reason: `Meets target using median sold price: ${validSoldCount} valid sold comps in the last 90 days and $${marginAtAsk} spread at asking price.`
    };
  }

  if (marginAt15 >= targetProfit) {
    return {
      recommendation: "Negotiate",
      reason: `Does not meet target at asking price, but reaches $${marginAt15} spread if bought around 15% below ask.`
    };
  }

  return {
    recommendation: "Pass",
    reason: `Using median sold price, this does not meet the $85 spread target.`
  };
}

app.post("/evaluate-comps", async (req, res) => {
  try {
    const { target, listings = [] } = req.body;
    const facebookPrice = target.facebookPrice;

    console.log("Received eBay listings:", listings.length);

    const recentListings = listings
      .filter(item => isWithinLast90Days(item.soldDate))
      .slice(0, 60);

    console.log("Listings within last 90 days:", recentListings.length);
    console.log("Sending all recent listings to AI cleanup. Target:", target.brand, target.model);

const aiCleanup = await aiCleanComps({
  target,
  comps: recentListings
});

const searchPollution = aiCleanup.searchPollution || {
  pollutedByRelatedModels: false,
  validExactModelCount: 0,
  relatedWrongModelCount: 0,
  rerunRecommended: false,
  negativeSearchTerms: [],
  reason: ""
};

const validIndexes = Array.isArray(aiCleanup.validIndexes)
  ? aiCleanup.validIndexes
  : [];
    const validComps = validIndexes
      .map(index => Number(index))
      .map(index => recentListings[index - 1])
      .filter(Boolean)
      .filter(comp => comp.price);

  const validSoldCount = validComps.length;
const minimumRelevantSales90Days = 7;

const medianEligibleComps = validComps.filter(comp => !comp.bestOfferAccepted);
const medianEligibleCount = medianEligibleComps.length;
const prices = medianEligibleComps.map(comp => comp.price);
const medianSoldPrice = median(prices);
const priceStandardDeviation = standardDeviation(prices);
const expectedSalePrice = applyExpectedSalePriceBuffer(medianSoldPrice);
const lowPrice = prices.length ? Math.min(...prices) : null;
const highPrice = prices.length ? Math.max(...prices) : null;
    const bestOfferExcludedCount = validComps.length - medianEligibleCount;
    const removedByAiFilter = recentListings.length - validComps.length;

if (validSoldCount < minimumRelevantSales90Days) {
 return res.json({
  targetProduct: `${target.brand || ""} ${target.model || ""} ${target.productType || ""}`.trim(),
  condition: target.condition,
  facebookPrice,
  validSoldCount,
  medianEligibleCount,
  medianSoldPrice,
  priceStandardDeviation,
  expectedSalePrice: null,
  salePriceBufferPercent: 0,
  lowPrice: prices.length ? Math.min(...prices) : null,
  highPrice: prices.length ? Math.max(...prices) : null,
  maxBuyPrice: null,
  negotiatedPrice15: facebookPrice
    ? Number((facebookPrice * 0.85).toFixed(2))
    : null,
  recommendation: "Pass",
  reason: `Immediate pass: only ${validSoldCount} relevant sold comp(s) in the last 90 days after AI cleanup. Minimum required is ${minimumRelevantSales90Days}.`,
    validComps: validComps.slice(0, 20),
  removedByAiFilter,
  bestOfferExcludedCount,
  aiCleanup,

  searchPollution,
  rerunRecommended: Boolean(searchPollution.rerunRecommended),
  rerunNegativeSearchTerms: searchPollution.negativeSearchTerms || [],
  rerunReason: searchPollution.reason || "",

  debugCounts: {
    scrapedListings: listings.length,
    recentListings: recentListings.length,
    sentToAiCleanup: recentListings.length,
    removedByAiFilter,
    medianEligibleCount,
    bestOfferExcludedCount,
    minimumRelevantSales90Days,
    priceLow: prices.length ? Math.min(...prices) : null,
    priceHigh: prices.length ? Math.max(...prices) : null,
    priceStandardDeviation
  }
});
}

    const maxBuyPrice = expectedSalePrice
      ? Number((expectedSalePrice - 85).toFixed(2))
      : null;

    const negotiatedPrice15 = facebookPrice
      ? Number((facebookPrice * 0.85).toFixed(2))
      : null;

    const decision = makeDealDecision({
      expectedSalePrice,
      facebookPrice,
      validSoldCount
    });

if (
  expectedSalePrice != null &&
  validSoldCount >=
    minimumRelevantSales90Days
) {
  saveProductToDatabase({
    item: target,
    estimatedResalePrice:
      expectedSalePrice
  });
}

  res.json({
  targetProduct: `${target.brand || ""} ${target.model || ""} ${target.productType || ""}`.trim(),
  condition: target.condition,
  facebookPrice,
  validSoldCount,
  medianEligibleCount,
  medianSoldPrice,
  priceStandardDeviation,
  expectedSalePrice,
  salePriceBufferPercent: 0,
  lowPrice,
  highPrice,
  maxBuyPrice,
  negotiatedPrice15,
  recommendation: decision.recommendation,
  reason: decision.reason,
    validComps: validComps.slice(0, 20),
  removedByAiFilter,
  bestOfferExcludedCount,
  aiCleanup,

  searchPollution,
  rerunRecommended: Boolean(searchPollution.rerunRecommended),
  rerunNegativeSearchTerms: searchPollution.negativeSearchTerms || [],
  rerunReason: searchPollution.reason || "",

  debugCounts: {
    scrapedListings: listings.length,
    recentListings: recentListings.length,
    sentToAiCleanup: recentListings.length,
    removedByAiFilter,
    medianEligibleCount,
    bestOfferExcludedCount,
    priceLow: lowPrice,
    priceHigh: highPrice,
    priceStandardDeviation
  }
});
    } catch (error) {
    console.error("Comp evaluation endpoint failed:", error);

    return sendServerError(
      res,
      error,
      "Could not evaluate comps."
    );
  }
});

const MAX_RESALE_TO_ASK_RATIO = 2.5;

function makeLotDecision({
  totalExpectedSalePrice,
  facebookPrice
}) {
  if (!totalExpectedSalePrice || !facebookPrice) {
    return {
      recommendation: "Pass",
      reason:
        "Not enough reliable lot value to calculate a deal.",
      scamFlag: false,
      resaleToAskRatio: null
    };
  }

  const resaleToAskRatio = Number(
    (
      totalExpectedSalePrice /
      facebookPrice
    ).toFixed(2)
  );

  /*
    Scam safeguard:

    If the combined estimated resale value of every
    included item is more than 2x the Facebook asking
    price, prevent the listing from becoming a hit.
  */
  if (
    totalExpectedSalePrice >
    facebookPrice * MAX_RESALE_TO_ASK_RATIO
  ) {
    return {
      recommendation: "Scam",
      reason:
        `Scam risk: the $${totalExpectedSalePrice.toFixed(2)} ` +
        `estimated resale value is ${resaleToAskRatio}x the ` +
        `$${facebookPrice.toFixed(2)} asking price, exceeding ` +
        `the ${MAX_RESALE_TO_ASK_RATIO}x maximum. ` +
        `This listing cannot be marked as a hit.`,
      scamFlag: true,
      resaleToAskRatio
    };
  }

  const targetProfit = 85;

  const negotiatedPrice15 = Number(
    (facebookPrice * 0.85).toFixed(2)
  );

  const profitAtAsk = Number(
    (
      totalExpectedSalePrice -
      facebookPrice
    ).toFixed(2)
  );

  const profitAt15 = Number(
    (
      totalExpectedSalePrice -
      negotiatedPrice15
    ).toFixed(2)
  );

  if (profitAtAsk >= targetProfit) {
    return {
      recommendation: "Buy Now",
      reason:
        `Using median sold price, the lot clears the ` +
        `$85 target at asking price with a $${profitAtAsk} ` +
        `estimated profit.`,
      scamFlag: false,
      resaleToAskRatio
    };
  }

  if (profitAt15 >= targetProfit) {
    return {
      recommendation: "Negotiate",
      reason:
        `Using median sold price, the lot does not clear the ` +
        `$85 target at asking price, but it reaches a ` +
        `$${profitAt15} estimated profit at 15% below ask.`,
      scamFlag: false,
      resaleToAskRatio
    };
  }

  return {
    recommendation: "Pass",
    reason:
      `Using median sold price, even buying 15% below asking ` +
      `price does not clear the $85 target.`,
    scamFlag: false,
    resaleToAskRatio
  };
}

app.post("/evaluate-lot", async (req, res) => {
  try {
    const { context } = req.body;

    const facebookPrice = context.facebookPrice;
    const negotiatedPrice15 = facebookPrice
      ? Number((facebookPrice * 0.85).toFixed(2))
      : null;

    const itemResults = context.results || [];

const items = itemResults.map(entry => {
  const item = entry.item || {};
  const result = entry.result || {};

  const median = result.medianSoldPrice;
const expectedSalePrice = result.expectedSalePrice ?? null;
const validSoldCount = result.validSoldCount || 0;
const minimumRelevantSales90Days = 7;

const fromDatabase =
  result.source === "database";

const include =
  expectedSalePrice != null &&
  (
    fromDatabase ||
    (
      median != null &&
      validSoldCount >=
        minimumRelevantSales90Days
    )
  );

  return {
    ...item,

    result: {
      ...result,
      expectedSalePrice,
      priceStandardDeviation: result.priceStandardDeviation ?? null
    },

    itemName: `${item.brand || ""} ${item.model || ""} ${item.productType || ""}`
      .replace(/\s+/g, " ")
      .trim(),

    condition: item.condition || "",
    searchQuery: item.ebaySearchQuery || "",

    includedMedian: include ? median : null,
    includedExpectedSalePrice: include ? expectedSalePrice : null,
    priceStandardDeviation: result.priceStandardDeviation ?? null,

    validSoldCount,
   status:
  include
    ? fromDatabase
      ? "Included from database"
      : "Included"
    : "Excluded",

reason:
  include
    ? fromDatabase
      ? "Included using stored product database resale value."
      : "Included as a primary sellable item with valid comps."
    : "Excluded because no reliable valid comps were found."
  };
});

    const totalIncludedMedian = Number(
      items
        .filter(item => item.includedMedian != null)
        .reduce((sum, item) => sum + item.includedMedian, 0)
        .toFixed(2)
    );

    const totalExpectedSalePrice = Number(
      items
        .filter(item => item.includedExpectedSalePrice != null)
        .reduce((sum, item) => sum + item.includedExpectedSalePrice, 0)
        .toFixed(2)
    );

    const spreadAtAsk = facebookPrice
      ? Number((totalExpectedSalePrice - facebookPrice).toFixed(2))
      : null;

    const spreadAt15 = facebookPrice && negotiatedPrice15
      ? Number((totalExpectedSalePrice - negotiatedPrice15).toFixed(2))
      : null;

    const maxBuyPrice = totalExpectedSalePrice
      ? Number((totalExpectedSalePrice - 85).toFixed(2))
      : null;

    const decision = makeLotDecision({
      totalExpectedSalePrice,
      facebookPrice
    });

    res.json({
  recommendation: decision.recommendation,
  reason: decision.reason,

  scamFlag: decision.scamFlag === true,

  resaleToAskRatio:
    decision.resaleToAskRatio ?? null,

  maxResaleToAskRatio:
    MAX_RESALE_TO_ASK_RATIO,

  facebookPrice,
      negotiatedPrice15,
      totalExpectedSalePrice,
      profitAtAsk: spreadAtAsk,
      profitAt15: spreadAt15,
      maxBuyPrice,
      items,
      ignoredItems: context.ignoredItems || []
    });
  } catch (error) {
    console.error("Lot evaluation endpoint failed:", error);

    return sendServerError(
      res,
      error,
      "Final lot evaluation failed."
    );
  }
});


app.post(
  "/generate-marketplace-hit-message",
  async (
    req,
    res
  ) => {
    const fallbackMessage =
      String(
        req.body?.templateMessage ||
        "Hi, I’d love to buy this. I’m not local, but I’ll cover the full shipping cost if you're willing."
      ).trim();

    try {
      const listingTitle =
        String(
          req.body?.listingTitle ||
          ""
        ).trim();

      const listingDescription =
        String(
          req.body?.listingDescription ||
          ""
        ).trim();

        const primaryProducts =
  Array.isArray(
    req.body?.primaryProducts
  )
    ? req.body.primaryProducts
    : [];

    const primaryProductsText =
  primaryProducts
    .map(product => {
      const productType =
        String(
          product?.productType || ""
        ).trim();

      /*
        Camera bodies and other products generally use
        normal brand/model fields.
      */
      const brand =
        String(
          product?.brand || ""
        ).trim();

      const model =
        String(
          product?.model || ""
        ).trim();

      /*
        Lenses use the structured lensIdentity fields
        produced by Step 5.
      */
      const lensIdentity =
        product?.lensIdentity &&
        typeof product.lensIdentity === "object"
          ? product.lensIdentity
          : null;

      let productName = "";

      if (
        productType
          .toLowerCase() ===
          "camera lens" &&
        lensIdentity
      ) {
        productName = [
          lensIdentity.brand,
          lensIdentity.mountSeries,
          lensIdentity.focalLength,
          lensIdentity.maxAperture,
          lensIdentity.featureModelCodes,
          lensIdentity.generation
        ]
          .filter(Boolean)
          .map(value =>
            String(value).trim()
          )
          .filter(Boolean)
          .join(" ");

        if (productName) {
          productName += " lens";
        }
      } else {
        productName =
          [brand, model]
            .filter(Boolean)
            .join(" ")
            .trim();
      }

      if (!productName) {
        productName =
          productType ||
          String(
            product?.productId || ""
          ).trim();
      }

      return productType
        ? `${productName} (${productType})`
        : productName;
    })
    .filter(Boolean)
    .join("\n");

     const prompt = `
Write one short, casual Facebook Marketplace message to the seller.

EXISTING MESSAGE TO USE AS THE STYLE/LENGTH TEMPLATE:
${fallbackMessage}

LISTING TITLE:
${listingTitle || "(not available)"}

LISTING DESCRIPTION:
${listingDescription || "(not available)"}

PRIMARY PRODUCTS DETECTED IN THE LISTING:
${primaryProductsText || "(none reliably identified)"}

Requirements:
- Keep it roughly the same length as the existing message.
- Keep the tone casual and natural.
- Naturally reference ONE specific detail about the listing.
- Prefer referencing one of the detected primary products when that can be done naturally.
- You may refer to a product by a natural shortened name rather than repeating its entire technical model name.
- Do not list multiple products robotically.
- Do not sound like you are summarizing the listing.
- Say that I am in California.
- Make clear that I am looking to have the item shipped.
- It is fine to say I will cover shipping.
- Do NOT mention "Buy Now", negotiation, negotiating, offers, offer price, asking price, discounts, profit, resale, or eBay.
- Do NOT invent any product or listing detail.
- Only reference products or details supplied above.
- Do NOT sound overly excited, formal, or robotic.
- Do NOT add a greeting using the seller's name.
- Output only the final message.
- Only use periods and commas for punctuation.
- No quotation marks.
- No em-dashes.
- No markdown.
- One or two sentences maximum.
`.trim();

      const response =
        await createLoggedOpenAiResponse({
          step:
            "Marketplace tailored hit message",

          request: {
            model:
              "gpt-4o-mini",

            input: [
              {
                role:
                  "user",

                content: [
                  {
                    type:
                      "input_text",

                    text:
                      prompt
                  }
                ]
              }
            ],

            max_output_tokens:
              100
          }
        });


      let message =
        String(
          response.output_text ||
          ""
        )
          .replace(
            /^["']|["']$/g,
            ""
          )
          .replace(
            /\s+/g,
            " "
          )
          .trim();


      if (!message) {
        message =
          fallbackMessage;
      }


      console.log(
        "[AUTO MESSAGE AI] Generated:",
        message
      );


      res.json({
        message
      });

    } catch (error) {
      console.error(
        "[AUTO MESSAGE AI] Generation failed:",
        error
      );


      /*
        Don't allow a temporary AI failure to stop
        the scanner from messaging a good listing.
      */
      res.json({
        message:
          fallbackMessage,

        fallback:
          true
      });
    }
  }
);

/*
  ============================================================
  MARKETPLACE CONVERSATION SHEET ELIGIBILITY
  ============================================================
*/

async function getMarketplaceConversationSheetStatus(
  listingId
) {
  const cleanListingId =
    String(
      listingId || ""
    ).trim();

  if (!cleanListingId) {
    return {
      found: false,
      status: "",
      eligible: false,
      rowNumber: null
    };
  }

  const spreadsheetId =
    process.env
      .GOOGLE_SHEETS_SPREADSHEET_ID;

  const tabName =
    process.env
      .GOOGLE_SHEETS_TAB_NAME ||
    "Main";

  if (!spreadsheetId) {
    throw new Error(
      "Missing GOOGLE_SHEETS_SPREADSHEET_ID."
    );
  }

  if (
    !process.env
      .GOOGLE_OAUTH_REFRESH_TOKEN
  ) {
    throw new Error(
      "Missing GOOGLE_OAUTH_REFRESH_TOKEN."
    );
  }

  const auth =
    createGoogleOAuthClient();

  auth.setCredentials({
    refresh_token:
      process.env
        .GOOGLE_OAUTH_REFRESH_TOKEN
  });

  const sheets =
    google.sheets({
      version: "v4",
      auth
    });

  /*
    B = Facebook Marketplace URL
    J = Ongoing Conversation

    Because we're requesting B:J:

    row[0] = B
    row[8] = J
  */
  const response =
    await sheets
      .spreadsheets
      .values
      .get({
        spreadsheetId,

        range:
          `${tabName}!B:J`
      });

  const rows =
    response.data.values ||
    [];

  for (
    let index = 0;
    index < rows.length;
    index++
  ) {
    const row =
      rows[index] ||
      [];

    const facebookUrl =
      String(
        row[0] || ""
      ).trim();

    const ongoingConversation =
      String(
        row[8] || ""
      )
        .trim()
        .toUpperCase();

    const match =
      facebookUrl.match(
        /\/marketplace\/item\/(\d+)/
      );

    if (
      match?.[1] ===
      cleanListingId
    ) {
      return {
        found: true,

        rowNumber:
          index + 1,

        status:
          ongoingConversation,

        eligible:
          ongoingConversation ===
          "P"
      };
    }
  }

  return {
    found: false,
    rowNumber: null,
    status: "",
    eligible: false
  };
}

app.get(
  "/marketplace-conversations",
  async (req, res) => {
    try {
      const {
        data,
        error
      } =
        await supabaseAdmin
          .from(
            "marketplace_conversations"
          )
          .select("*")
          .order(
            "last_message_at",
            {
              ascending:
                false,

              nullsFirst:
                false
            }
          );

      if (error) {
        throw error;
      }


      const conversations =
        [];


      for (
        const conversation of
          data || []
      ) {
        const listingId =
          String(
            conversation
              .listing_id ||
            ""
          ).trim();

        if (!listingId) {
          continue;
        }


        /*
          Re-check J every time.

          This means changing P -> N immediately
          removes the conversation from active results.
        */
        const sheet =
          await getMarketplaceConversationSheetStatus(
            listingId
          );


        if (
          sheet.status !== "P"
        ) {
          continue;
        }


        const status =
          calculateMarketplaceConversationStatus({
            lastMessageSender:
              conversation
                .last_message_sender,

            lastMessageAt:
              conversation
                .last_message_at
          });


        conversations.push({
          ...conversation,

          status,

          sheetStatus:
            "P",

          sheetRow:
            sheet.rowNumber
        });
      }


      return res.json({
        ok: true,

        conversations
      });

    } catch (error) {
      console.error(
        "[CONVERSATION TRACKER] Fetch failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not load conversations."
        });
    }
  }
);

const MARKETPLACE_FOLLOW_UP_MS =
  48 *
  60 *
  60 *
  1000;


function calculateMarketplaceConversationStatus({
  lastMessageSender,
  lastMessageAt
}) {
  const sender =
    String(
      lastMessageSender || ""
    )
      .trim()
      .toLowerCase();

  if (
    sender === "seller"
  ) {
    return "waiting_for_me";
  }

  if (
    sender === "me"
  ) {
    if (lastMessageAt) {
      const timestamp =
        new Date(
          lastMessageAt
        ).getTime();

      if (
        Number.isFinite(
          timestamp
        ) &&
        Date.now() -
          timestamp >=
          MARKETPLACE_FOLLOW_UP_MS
      ) {
        return "follow_up_due";
      }
    }

    return "waiting_for_seller";
  }

  return "unknown";
}


app.post(
  "/marketplace-conversation",
  async (req, res) => {
    try {
      const incoming =
        req.body?.conversation ||
        {};

      const accountId =
        String(
          incoming.accountId ||
          "default"
        ).trim();

      const conversationId =
        String(
          incoming.conversationId ||
          ""
        ).trim();

      if (!conversationId) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing conversationId."
          });
      }


      /*
        First check whether we already know
        this Messenger -> Marketplace mapping.
      */
      const {
        data: existing,
        error: existingError
      } =
        await supabaseAdmin
          .from(
            "marketplace_conversations"
          )
          .select("*")
          .eq(
            "account_id",
            accountId
          )
          .eq(
            "conversation_id",
            conversationId
          )
          .maybeSingle();

      if (existingError) {
        throw existingError;
      }


      /*
        The opened Messenger thread can provide
        the listing ID.

        A later sidebar scan might not, so preserve
        the existing mapping.
      */
      const listingId =
        String(
          incoming.listingId ||
          existing?.listing_id ||
          ""
        ).trim();

      if (!listingId) {
        return res.json({
          ok: true,

          tracked: false,

          reason:
            "Marketplace listing ID has not been mapped yet.",

          conversationId
        });
      }


      /*
        COLUMN J IS THE SOURCE OF TRUTH.

        P     = track
        N     = ignore
        blank = ignore
      */
      const sheet =
        await getMarketplaceConversationSheetStatus(
          listingId
        );


      if (
        sheet.status !== "P"
      ) {
        console.log(
          "[CONVERSATION TRACKER] Ignored because Sheet J is not P:",
          {
            conversationId,
            listingId,
            sheetStatus:
              sheet.status ||
              "(blank)"
          }
        );


        return res.json({
          ok: true,

          tracked: false,

          conversationId,
          listingId,

          sheetStatus:
            sheet.status,

          reason:
            sheet.status === "N"
              ? "Conversation marked N."
              : "Conversation is not marked P."
        });
      }


      function preserveText(
        incomingValue,
        existingValue = null
      ) {
        const clean =
          String(
            incomingValue ||
            ""
          ).trim();

        return (
          clean ||
          existingValue ||
          null
        );
      }


      const listingUrl =
        preserveText(
          incoming.listingUrl,
          existing?.listing_url
        );

      const sellerName =
        preserveText(
          incoming.sellerName,
          existing?.seller_name
        );

      const conversationUrl =
        preserveText(
          incoming.conversationUrl,
          existing
            ?.conversation_url
        );

      const lastMessageText =
        preserveText(
          incoming.lastMessageText,
          existing
            ?.last_message_text
        );


      const incomingSender =
        String(
          incoming.lastMessageSender ||
          ""
        )
          .trim()
          .toLowerCase();

      const lastMessageSender =
        (
          incomingSender === "me" ||
          incomingSender ===
            "seller"
        )
          ? incomingSender
          : (
              existing
                ?.last_message_sender ||
              "unknown"
            );


      let lastMessageAt =
        existing
          ?.last_message_at ||
        null;

      if (
        incoming.lastMessageAt
      ) {
        const parsed =
          new Date(
            incoming.lastMessageAt
          );

        if (
          !Number.isNaN(
            parsed.getTime()
          )
        ) {
          lastMessageAt =
            parsed.toISOString();
        }
      }


      const unread =
        typeof incoming.unread ===
          "boolean"
          ? incoming.unread
          : Boolean(
              existing?.unread
            );


      const status =
        calculateMarketplaceConversationStatus({
          lastMessageSender,
          lastMessageAt
        });


      const now =
        new Date()
          .toISOString();


      const row = {
        account_id:
          accountId,

        conversation_id:
          conversationId,

        listing_id:
          listingId,

        listing_url:
          listingUrl,

        seller_name:
          sellerName,

        conversation_url:
          conversationUrl,

        last_message_text:
          lastMessageText,

        last_message_sender:
          lastMessageSender,

        last_message_at:
          lastMessageAt,

        last_scanned_at:
          now,

        unread,

        status,

        updated_at:
          now
      };


      const {
        data,
        error
      } =
        await supabaseAdmin
          .from(
            "marketplace_conversations"
          )
          .upsert(
            row,
            {
              onConflict:
                "account_id,conversation_id"
            }
          )
          .select()
          .single();


      if (error) {
        throw error;
      }

      await updateMarketplaceConversationFollowUpColumn({
  rowNumber:
    sheet.rowNumber,

  followUpDue:
    status ===
    "follow_up_due"
});


      console.log(
        "[CONVERSATION TRACKER] Tracking:",
        {
          conversationId,
          listingId,
          sellerName,
          lastMessageSender,
          lastMessageAt,
          status,
          sheetStatus:
            "P"
        }
      );


      return res.json({
        ok: true,

        tracked: true,

        sheetStatus:
          "P",

        conversation:
          data
      });

    } catch (error) {
      console.error(
        "[CONVERSATION TRACKER] Update failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Conversation update failed."
        });
    }
  }
);

app.get(
  "/marketplace-conversation-targets",
  async (req, res) => {
    try {
      const spreadsheetId =
        process.env
          .GOOGLE_SHEETS_SPREADSHEET_ID;

      const tabName =
        process.env
          .GOOGLE_SHEETS_TAB_NAME ||
        "Main";


      if (!spreadsheetId) {
        throw new Error(
          "Missing GOOGLE_SHEETS_SPREADSHEET_ID."
        );
      }


      const auth =
        createGoogleOAuthClient();

      auth.setCredentials({
        refresh_token:
          process.env
            .GOOGLE_OAUTH_REFRESH_TOKEN
      });


      const sheets =
        google.sheets({
          version: "v4",
          auth
        });


      /*
        B = Marketplace listing URL
        J = Ongoing Conversation status
      */
      const sheetResponse =
        await sheets
          .spreadsheets
          .values
          .get({
            spreadsheetId,

            range:
              `${tabName}!B:J`
          });


      const rows =
        sheetResponse
          .data
          .values ||
        [];


      const targets =
        [];


      for (
        let index = 0;
        index < rows.length;
        index++
      ) {
        const row =
          rows[index] ||
          [];

        const listingUrl =
          String(
            row[0] ||
            ""
          ).trim();

        const conversationStatus =
          String(
            row[8] ||
            ""
          )
            .trim()
            .toUpperCase();


        /*
          Only P rows participate.
        */
        if (
          conversationStatus !==
          "P"
        ) {
          continue;
        }


        const match =
          listingUrl.match(
            /\/marketplace\/item\/(\d+)/
          );


        if (!match) {
          continue;
        }


        targets.push({
          listingId:
            match[1],

          listingUrl:
            `https://www.facebook.com/marketplace/item/${match[1]}/`,

          sheetRow:
            index + 1
        });
      }


      /*
        If there are no P conversations,
        we're done immediately.
      */
      if (!targets.length) {
        return res.json({
          ok: true,
          count: 0,
          mappedCount: 0,
          unmappedCount: 0,
          targets: []
        });
      }


      const listingIds =
        targets.map(
          target =>
            target.listingId
        );


      /*
        Find known Marketplace listing ->
        Messenger conversation mappings.
      */
      const {
        data: conversations,
        error
      } =
        await supabaseAdmin
          .from(
            "marketplace_conversations"
          )
          .select(
            `
              listing_id,
              conversation_id,
              conversation_url,
              seller_name
            `
          )
          .in(
            "listing_id",
            listingIds
          );


      if (error) {
        throw error;
      }


      const mappingByListingId =
        new Map();


      for (
        const conversation of
          conversations || []
      ) {
        const listingId =
          String(
            conversation
              .listing_id ||
            ""
          ).trim();

        if (
          listingId &&
          !mappingByListingId.has(
            listingId
          )
        ) {
          mappingByListingId.set(
            listingId,
            conversation
          );
        }
      }


      const enrichedTargets =
        targets.map(
          target => {
            const mapping =
              mappingByListingId.get(
                target.listingId
              );


            const conversationId =
              String(
                mapping
                  ?.conversation_id ||
                ""
              ).trim();


            return {
              ...target,

              mapped:
                Boolean(
                  conversationId
                ),

              conversationId,

              conversationUrl:
                conversationId
                  ? `https://www.facebook.com/messages/t/${conversationId}`
                  : "",

              sellerName:
                mapping
                  ?.seller_name ||
                ""
            };
          }
        );


      const mappedCount =
        enrichedTargets
          .filter(
            target =>
              target.mapped
          )
          .length;


      return res.json({
        ok: true,

        count:
          enrichedTargets.length,

        mappedCount,

        unmappedCount:
          enrichedTargets.length -
          mappedCount,

        targets:
          enrichedTargets
      });

    } catch (error) {
      console.error(
        "[CONVERSATION PARSER] Target lookup failed:",
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error?.message ||
            "Could not build conversation target list."
        });
    }
  }
);

app.listen(3000, () => {
  console.log("AI comp server running at http://localhost:3000");
});