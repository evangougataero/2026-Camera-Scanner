import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";
import sharp from "sharp";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import {
  randomUUID,
  createHash
} from "crypto";
import vision from "@google-cloud/vision";
import {
  createClient
} from "@supabase/supabase-js";

import {
  AsyncLocalStorage
} from "async_hooks";

import util from "util";


import {
  XMLParser
} from "fast-xml-parser";
import {
  fileURLToPath
} from "url";

/*
  ============================================================
  DATAFORSEO
  ============================================================
*/

const DATAFORSEO_LOGIN =
  String(
    process.env.DATAFORSEO_LOGIN ||
    ""
  ).trim();

const DATAFORSEO_PASSWORD =
  String(
    process.env.DATAFORSEO_PASSWORD ||
    ""
  ).trim();


function getDataForSeoAuthHeader() {
  if (
    !DATAFORSEO_LOGIN ||
    !DATAFORSEO_PASSWORD
  ) {
    throw new Error(
      "Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD in .env"
    );
  }

  return (
    "Basic " +
    Buffer
      .from(
        `${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`
      )
      .toString("base64")
  );
}


function sleepDataForSeo(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}

async function searchDataForSeoByImage(
  imageUrl
) {
  const cleanImageUrl =
    String(
      imageUrl || ""
    ).trim();


  if (
    !/^https?:\/\//i.test(
      cleanImageUrl
    )
  ) {
    throw new Error(
      "DataForSEO requires a public HTTP/HTTPS image URL."
    );
  }


  const authHeader =
    getDataForSeoAuthHeader();


  /*
    ============================================================
    STEP 1 — CREATE SEARCH-BY-IMAGE TASK
    ============================================================
  */

  const createResponse =
    await fetch(
      "https://api.dataforseo.com/v3/serp/google/search_by_image/task_post",
      {
        method:
          "POST",

        headers: {
          Authorization:
            authHeader,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify([
            {
              image_url:
                cleanImageUrl,

              location_code:
                2840,

              language_code:
                "en",

              priority:
                2
            }
          ])
      }
    );


  const createData =
    await createResponse.json();


  const createdTask =
    createData?.tasks?.[0];


  if (
    !createdTask?.id
  ) {
    throw new Error(
      createdTask?.status_message ||
      createData?.status_message ||
      "DataForSEO did not return a task ID."
    );
  }


  const taskId =
    String(
      createdTask.id
    );


  console.log(
    "[DATAFORSEO] Search By Image task created:",
    {
      taskId,

      cost:
        createdTask?.cost
    }
  );


  /*
    ============================================================
    STEP 2 — WAIT FOR COMPLETED RESULT
    ============================================================
  */

  const startedAt =
    Date.now();

  const timeoutMs =
    10 * 60 * 1000;

  const pollIntervalMs =
    5000;


  while (
    Date.now() - startedAt <
    timeoutMs
  ) {
    await sleepDataForSeo(
      pollIntervalMs
    );


    const resultResponse =
      await fetch(
        `https://api.dataforseo.com/v3/serp/google/search_by_image/task_get/advanced/${encodeURIComponent(
          taskId
        )}`,
        {
          method:
            "GET",

          headers: {
            Authorization:
              authHeader,

            "Content-Type":
              "application/json"
          }
        }
      );


    const resultData =
      await resultResponse.json();


    const task =
      resultData?.tasks?.[0];


    /*
      Task still pending.
    */
    if (
      Number(
        task?.status_code
      ) === 40601 ||
      Number(
        task?.status_code
      ) === 40602
    ) {
      console.log(
        "[DATAFORSEO] Task pending:",
        {
          taskId,

          status:
            task?.status_message
        }
      );

      continue;
    }


    const result =
      Array.isArray(
        task?.result
      )
        ? task.result[0]
        : null;


    if (
      Number(
        task?.status_code
      ) === 20000 &&
      result
    ) {
      console.log(
        "[DATAFORSEO] Search By Image complete:",
        {
          taskId,

          itemsCount:
            result?.items_count,

          resultsCount:
            result?.se_results_count
        }
      );


      return {
        taskId,

        cost:
          Number(
            task?.cost ||
            createdTask?.cost ||
            0
          ),

        result
      };
    }


    /*
      Any non-pending non-success state.
    */
    if (
      task?.status_code &&
      Number(
        task.status_code
      ) !== 20000
    ) {
      throw new Error(
        task?.status_message ||
        `DataForSEO task failed with status ${task.status_code}.`
      );
    }
  }


  throw new Error(
    "DataForSEO Search By Image timed out."
  );
}

function extractDataForSeoEvidence(
  dataForSeoResult
) {
  const items =
    Array.isArray(
      dataForSeoResult?.items
    )
      ? dataForSeoResult.items
      : [];


  const organicResults =
    items
      .filter(
        item =>
          item?.type ===
          "organic"
      )
      .slice(
        0,
        25
      )
      .map(
        item => ({
          rank:
            Number(
              item?.rank_absolute ||
              0
            ),

          domain:
            String(
              item?.domain ||
              ""
            ).trim(),

          title:
            String(
              item?.title ||
              ""
            ).trim(),

          description:
            String(
              item?.description ||
              ""
            ).trim(),

          url:
            String(
              item?.url ||
              ""
            ).trim(),

          highlighted:
            Array.isArray(
              item?.highlighted
            )
              ? item.highlighted
              : []
        })
      );


  /*
    DataForSEO also gives us Google's
    "Visual matches" image collection.

    Keep only a limited number of URLs.
  */
  const visualMatchesItem =
    items.find(
      item =>
        item?.type ===
          "images" &&
        Array.isArray(
          item?.items
        )
    );


  const visualMatchUrls =
    Array.isArray(
      visualMatchesItem?.items
    )
      ? visualMatchesItem.items
          .map(
            item =>
              String(
                item?.image_url ||
                ""
              ).trim()
          )
          .filter(Boolean)
          .slice(
            0,
            15
          )
      : [];


  return {
    googleAssociatedKeyword:
      String(
        dataForSeoResult?.keyword ||
        ""
      ).trim() ||
      null,

    organicResults,

    visualMatchUrls
  };
}

async function cleanDataForSeoIdentificationEvidence({
  promptText,
  evidence
}) {
  const prompt = `
You are cleaning Google Lens / Search By Image evidence for a camera-equipment identification system.

You are NOT allowed to blindly choose the most common search result.

The original identification instruction was:

${promptText}

Below are raw Google Search By Image observations.

${JSON.stringify(
  evidence,
  null,
  2
)}

Your job has TWO purposes:

1. Clean and organize the visual-search evidence.
2. Decide whether the evidence is actually strong enough to support the identification requested by the original instruction.

IMPORTANT:

- Google visual-search results are noisy observations, not ground truth.
- Completely unrelated results must be discarded.
- Closely related but commercially different camera/lens models must remain separate.
- Do NOT merge generations such as:
  IS
  IS II
  STM
  USM
  II
  III
  G2

- Repeated appearances of the same exact model across independent relevant results increase support.
- A single high-ranked result does NOT establish identity.
- Generic family agreement is weaker than exact-model agreement.
- If results broadly agree on only a family, but disagree on exact revision, preserve that ambiguity.
- Never pick the most popular/common model simply because it is common.
- Never fill in a missing model suffix from general camera knowledge.
- If the supplied evidence does not reliably distinguish one exact model, return UNKNOWN.
- Respect exclusions or multi-product instructions contained in the original identification instruction.

For a SINGLE-product or EXCLUSION request:
recommendedIdentification must contain ONLY one full exact model name, or exactly UNKNOWN.

For a GROUP request:
recommendedIdentification must contain one model per line.
If a requested product cannot be reliably identified, write UNKNOWN on that line.

Return exactly this JSON:

{
  "recommendedIdentification": "string",
  "confidence": "high" | "medium" | "low",
  "consensus": "strong" | "mixed" | "weak" | "none",
  "candidateModels": [
    {
      "model": "string",
      "support": "strong" | "moderate" | "weak"
    }
  ],
  "discardedAsIrrelevant": [
    "string"
  ],
  "summary": "short explanation of what the Google evidence actually establishes"
}

Return valid JSON only.
Do not use Markdown.
`.trim();


  const response =
    await createLoggedOpenAiResponse({
      step:
        "DataForSEO visual evidence cleaner",

      request: {
        model:
          "gpt-4.1-mini",

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


  let parsed;


  try {
    parsed =
      JSON.parse(
        rawText
      );

  } catch (error) {
    console.error(
      "[DATAFORSEO CLEANER] Invalid JSON:",
      rawText
    );

    throw new Error(
      "DataForSEO evidence cleaner returned invalid JSON."
    );
  }


  const recommendedIdentification =
    String(
      parsed?.recommendedIdentification ||
      "UNKNOWN"
    ).trim() ||
    "UNKNOWN";


  const cleaned = {
    recommendedIdentification,

    confidence:
      [
        "high",
        "medium",
        "low"
      ].includes(
        String(
          parsed?.confidence ||
          ""
        ).toLowerCase()
      )
        ? String(
            parsed.confidence
          ).toLowerCase()
        : "low",

    consensus:
      [
        "strong",
        "mixed",
        "weak",
        "none"
      ].includes(
        String(
          parsed?.consensus ||
          ""
        ).toLowerCase()
      )
        ? String(
            parsed.consensus
          ).toLowerCase()
        : "none",

    candidateModels:
      Array.isArray(
        parsed?.candidateModels
      )
        ? parsed.candidateModels
        : [],

    discardedAsIrrelevant:
      Array.isArray(
        parsed?.discardedAsIrrelevant
      )
        ? parsed.discardedAsIrrelevant
        : [],

    summary:
      String(
        parsed?.summary ||
        ""
      ).trim()
  };


  console.log(
    "[DATAFORSEO CLEANER] Cleaned evidence:",
    cleaned
  );


  return cleaned;
}

const __filename =
  fileURLToPath(
    import.meta.url
  );

const __dirname =
  path.dirname(
    __filename
  );

const LENSFUN_DB_DIRECTORY =
  path.join(
    __dirname,
    "data",
    "lensfun",
    "db"
  );

let lensfunDatabase = {
  lenses: [],
  cameras: [],
  mounts: []
};

function removeLeadingLensBrand(
  model,
  brand
) {
  const cleanModel =
    String(model || "")
      .trim();

  const cleanBrand =
    String(brand || "")
      .trim();

  if (
    !cleanModel ||
    !cleanBrand
  ) {
    return cleanModel;
  }

  const escapedBrand =
    cleanBrand.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  return cleanModel
    .replace(
      new RegExp(
        `^${escapedBrand}\\s+`,
        "i"
      ),
      ""
    )
    .trim();
}

function lensfunArrayify(value) {
  if (value == null) {
    return [];
  }

  return Array.isArray(value)
    ? value
    : [value];
}


function lensfunText(value) {
  if (
    typeof value === "string" ||
    typeof value === "number"
  ) {
    return String(value).trim();
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return String(
      value["#text"] ||
      ""
    ).trim();
  }

  return "";
}


function loadLensfunDatabase() {
  const parser =
    new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text"
    });


  const files =
    fs.readdirSync(
      LENSFUN_DB_DIRECTORY
    )
      .filter(
        fileName =>
          fileName
            .toLowerCase()
            .endsWith(".xml")
      );


  const lenses = [];
  const cameras = [];
  const mounts = [];


  for (
    const fileName of files
  ) {
    const fullPath =
      path.join(
        LENSFUN_DB_DIRECTORY,
        fileName
      );

    try {
      const xml =
        fs.readFileSync(
          fullPath,
          "utf8"
        );

      const parsed =
        parser.parse(xml);

      const root =
        parsed?.lensdatabase;

      if (!root) {
        continue;
      }


      for (
        const lens of
          lensfunArrayify(root.lens)
      ) {
        lenses.push({
          maker:
            lensfunText(
              lens?.maker
            ),

          model:
            lensfunText(
              lens?.model
            ),

          mounts:
            lensfunArrayify(
              lens?.mount
            )
              .map(lensfunText)
              .filter(Boolean),

          cropfactor:
            lens?.cropfactor ?? null,

          focal:
            lens?.focal ?? null,

          aperture:
            lens?.aperture ?? null,

          sourceFile:
            fileName,

          raw:
            lens
        });
      }


      for (
        const camera of
          lensfunArrayify(root.camera)
      ) {
        cameras.push({
          maker:
            lensfunText(
              camera?.maker
            ),

          model:
            lensfunText(
              camera?.model
            ),

          mount:
            lensfunText(
              camera?.mount
            ),

          cropfactor:
            camera?.cropfactor ?? null,

          sourceFile:
            fileName
        });
      }


      for (
        const mount of
          lensfunArrayify(root.mount)
      ) {
        mounts.push({
          name:
            lensfunText(
              mount?.name
            ),

          compat:
            lensfunArrayify(
              mount?.compat
            )
              .map(lensfunText)
              .filter(Boolean),

          sourceFile:
            fileName
        });
      }

    } catch (error) {
      console.error(
        `[LENSFUN] Failed parsing ${fileName}:`,
        error
      );
    }
  }


  lensfunDatabase = {
    lenses,
    cameras,
    mounts
  };


  console.log(
    "[LENSFUN] Loaded:",
    {
      files:
        files.length,

      lenses:
        lenses.length,

      cameras:
        cameras.length,

      mounts:
        mounts.length
    }
  );
}

function normalizeLensfunComparisonText(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}


function extractFocalLengthFromText(
  value
) {
  const text =
    String(value || "")
      .replace(/[–—]/g, "-");


  const match =
    text.match(
      /\b(\d{1,3}(?:\.\d+)?)\s*(?:-\s*(\d{1,3}(?:\.\d+)?))?\s*mm\b/i
    );


  if (!match) {
    return null;
  }


  if (match[2]) {
    return (
      `${match[1]}-${match[2]}mm`
    );
  }


  return `${match[1]}mm`;
}


function extractMaxApertureFromText(
  value
) {
  const text =
    String(value || "")
      .replace(/[–—]/g, "-");


  /*
    Supports:

    1:3.5-6.3
    1:3.5–6.3
    f/3.5-6.3
    F3.5-6.3
    F2.8
  */
  const match =
    text.match(
      /(?:\b1\s*:\s*|\bf\s*\/?\s*)(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i
    );


  if (!match) {
    return null;
  }


  if (match[2]) {
    return (
      `f/${match[1]}-${match[2]}`
    );
  }


  return `f/${match[1]}`;
}


function normalizeApertureForComparison(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(/^f\s*\/?/i, "")
    .replace(/^1\s*:/i, "")
    .replace(/\s+/g, "")
    .replace(/[–—]/g, "-")
    .trim();
}


function normalizeFocalForComparison(
  value
) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[–—]/g, "-")
    .trim();
}

function hasExactObjectiveEvidence(
  text,
  value
) {
  const cleanValue =
    normalizeLensfunComparisonText(
      value
    );

  if (!cleanValue) {
    return false;
  }

  /*
    Single-character mount names such as F/E/Z
    are far too easy to false-match against ordinary
    OCR text such as f/3.5.

    Require stronger context for those later.
  */
  if (cleanValue.length < 2) {
    return false;
  }

  const escaped =
    cleanValue
      .replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      )
      .replace(
        /\s+/g,
        "\\s+"
      );

  const regex =
    new RegExp(
      `(^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`,
      "i"
    );

  return regex.test(
    normalizeLensfunComparisonText(
      text
    )
  );
}

function collectObjectiveLensEvidence({
  product,
  productOcrResults,
  listingTitle,
  listingDescription,
  listingScreenshotOcr,
  explicitFacts
}) {
  const productId =
    String(
      product?.productId || ""
    ).trim();


  /*
    IMPORTANT:

    Lensfun lookup fields come ONLY from the
    normalized + server-validated Step-5 structure.

    Raw OCR remains available below strictly for
    debugging/audit purposes.
  */
  const normalizedIdentity =
    normalizeLensIdentity(
      product?.lensIdentity ||
      {}
    );


  const matchingOcrEntries =
    (productOcrResults || [])
      .filter(
        item =>
          String(
            item?.productId || ""
          ).trim() ===
          productId
      );


  const productOcrText =
    matchingOcrEntries
      .map(
        item =>
          String(
            item?.ocrText || ""
          ).trim()
      )
      .filter(Boolean)
      .join("\n");


  const sellerEvidence =
    [
      listingTitle,
      listingDescription,

      ...(
        Array.isArray(
          explicitFacts?.explicitlyIncluded
        )
          ? explicitFacts.explicitlyIncluded
          : []
      ),

      ...(
        Array.isArray(
          explicitFacts?.listingNotes
        )
          ? explicitFacts.listingNotes
          : []
      )
    ]
      .filter(Boolean)
      .join("\n");


  return {
    productId,

    /*
      THESE are the Lensfun query fields.
    */
    brand:
      normalizedIdentity.brand,

    focalLength:
      normalizedIdentity.focalLength,

    maxAperture:
      normalizedIdentity.maxAperture,

    modelCodes:
      normalizedIdentity.modelCodes,

    generation:
      normalizedIdentity.generation,

    explicitMount:
      normalizedIdentity.mountSeries,

    extractedEvidence:
      normalizeStringArray(
        product?.extracted_evidence
      ),

    /*
      Audit/debug fields only.
      findLensfunCandidates() must not re-parse these.
    */
    productOcrText,

    sellerEvidence,

    listingScreenshotOcr:
      String(
        listingScreenshotOcr || ""
      ).trim()
  };
}

function expandLensfunCandidateVariants(
  lens
) {
  const mounts =
    Array.isArray(
      lens?.mounts
    )
      ? lens.mounts
          .map(
            value =>
              String(
                value || ""
              ).trim()
          )
          .filter(Boolean)
      : [];


  /*
    A record with no mount still gets represented,
    but its mount remains unknown.
  */
  const variants =
    mounts.length
      ? mounts
      : [null];


  return variants.map(
    (mount, index) => ({
      candidateId:
        [
          String(
            lens?.sourceFile || ""
          ),

          String(
            lens?.maker || ""
          ),

          String(
            lens?.model || ""
          ),

          String(
            mount || "unknown"
          ),

          String(index)
        ]
          .join("|")
          .toLowerCase(),

      maker:
        String(
          lens?.maker || ""
        ).trim(),

      model:
        String(
          lens?.model || ""
        ).trim(),

      mount,

      sourceFile:
        String(
          lens?.sourceFile || ""
        ).trim()
    })
  );
}

function findLensfunCandidates(
  evidence
) {
  const brand =
    normalizeLensfunComparisonText(
      evidence?.brand
    );

  const focal =
    normalizeFocalForComparison(
      evidence?.focalLength
    );

  const aperture =
    normalizeApertureForComparison(
      evidence?.maxAperture
    );

  const explicitMount =
    normalizeLensfunComparisonText(
      evidence?.explicitMount
    );


  /*
    We need at least something useful.

    Searching all 1,564 lenses with no evidence
    would accomplish nothing.
  */
  if (
    !brand &&
    !focal
  ) {
    return [];
  }


  const scoredRecords =
    lensfunDatabase.lenses
      .map(
        lens => {
          const makerText =
            normalizeLensfunComparisonText(
              lens?.maker
            );

          const modelText =
            normalizeLensfunComparisonText(
              lens?.model
            );

          const compactModel =
            modelText
              .replace(/\s+/g, "");


          let score = 0;


          /*
            Manufacturer is strong evidence.
          */
          if (brand) {
            if (
              makerText === brand ||
              makerText.includes(
                brand
              ) ||
              brand.includes(
                makerText
              )
            ) {
              score += 10;
            } else {
              /*
                If we confidently know Sigma,
                don't return Canon lenses.
              */
              return null;
            }
          }


          /*
            Exact focal range is extremely strong.
          */
          if (focal) {
            const compactFocal =
              focal
                .replace(/\s+/g, "");


            if (
              compactModel.includes(
                compactFocal
              )
            ) {
              score += 12;
            } else {
              return null;
            }
          }


          /*
            Aperture further narrows revisions.

            We don't require it because Lensfun naming
            conventions are not perfectly uniform.
          */
          if (aperture) {
  const candidateAperture =
    normalizeApertureForComparison(
      extractMaxApertureFromText(
        lens?.model
      )
    );


  /*
    If both Marketplace evidence and Lensfun
    explicitly state an aperture and they disagree,
    this cannot be the same exact lens.
  */
  if (
    candidateAperture &&
    candidateAperture !==
      aperture
  ) {
    return null;
  }


  if (
    candidateAperture ===
    aperture
  ) {
    score += 8;
  }
}


          return {
            lens,
            score
          };
        }
      )
      .filter(Boolean);


  /*
    Expand records by physical mount.
  */
  let candidates =
    scoredRecords
      .flatMap(
        entry =>
          expandLensfunCandidateVariants(
            entry.lens
          )
            .map(
              candidate => ({
                ...candidate,
                score:
                  entry.score
              })
            )
      );


  /*
    If OCR literally established a mount,
    use it as a hard narrowing signal.
  */
  if (explicitMount) {
   const mountFiltered =
  candidates.filter(
    candidate => {
      const candidateMount =
        normalizeLensfunComparisonText(
          candidate?.mount
        );

      if (!candidateMount) {
        return false;
      }

      return (
        candidateMount ===
          explicitMount ||

        candidateMount.includes(
          explicitMount
        ) ||

        explicitMount.includes(
          candidateMount
        )
      );
    }
  );


    if (mountFiltered.length) {
      candidates =
        mountFiltered;
    }
  }


  /*
    De-duplicate identical Lensfun entries.
  */
  const unique =
    new Map();


  for (
    const candidate of candidates
  ) {
    const key =
      [
        candidate.maker,
        candidate.model,
        candidate.mount
      ]
        .map(
          value =>
            normalizeLensfunComparisonText(
              value
            )
        )
        .join("|");


    if (!unique.has(key)) {
      unique.set(
        key,
        candidate
      );
    }
  }


  candidates =
    Array.from(
      unique.values()
    );


  candidates.sort(
    (a, b) =>
      Number(
        b.score || 0
      ) -
      Number(
        a.score || 0
      )
  );


  /*
    Only retain the strongest reasonable set.
  */
  if (candidates.length) {
    const bestScore =
      Number(
        candidates[0].score ||
        0
      );


    candidates =
      candidates.filter(
        candidate =>
          Number(
            candidate.score || 0
          ) >=
            bestScore - 2
      );
  }


  return candidates;
}



function lensfunCandidateToIdentity(
  candidate
) {
  if (!candidate) {
    return null;
  }


  const focalLength =
    extractFocalLengthFromText(
      candidate.model
    );


  const maxAperture =
    extractMaxApertureFromText(
      candidate.model
    );


  return {
    brand:
      cleanNullableIdentityField(
        candidate.maker
      ),

    canonicalModel:
      cleanNullableIdentityField(
        candidate.model
      ),

    mountSeries:
      cleanNullableIdentityField(
        candidate.mount
      ),

    focalLength,

    maxAperture,

    featureModelCodes:
      null,

    generation:
      null,

    lensfunCandidateId:
      candidate.candidateId,

    lensfunSourceFile:
      candidate.sourceFile,

    resolutionMode:
      "lensfun"
  };
}

function hasEnoughEvidenceForLensfun(
  evidence
) {
  const brand =
    String(
      evidence?.brand ||
      ""
    ).trim();

  const focalLength =
    String(
      evidence?.focalLength ||
      ""
    ).trim();

  /*
    Deterministic replacement for the old AI gate.

    Minimum Lensfun requirement:
      1. known manufacturer
      2. known focal length/range

    Examples:
      Canon + 18-55mm → yes
      Nikon + 50mm → yes

      Canon only → no
      EF-S only → no
  */
  return Boolean(
    brand &&
    focalLength
  );
}

async function resolveCanonicalLens({
  product,
  productOcrResults,
  listingTitle,
  listingDescription,
  listingScreenshotOcr,
  explicitFacts,
  cameraContext
}) {
  const evidence =
    collectObjectiveLensEvidence({
      product,
      productOcrResults,
      listingTitle,
      listingDescription,
      listingScreenshotOcr,
      explicitFacts
    });


  console.log(
    "[LENS RESOLVER] Objective evidence:",
    evidence
  );


  /*
    ============================================================
    DETERMINISTIC LENSFUN ELIGIBILITY
    ============================================================
  */

  if (
    !hasEnoughEvidenceForLensfun(
      evidence
    )
  ) {
    console.log(
      "[LENS RESOLVER] Missing maker or focal length. Routing directly to visual fallback:",
      {
        productId:
          evidence.productId,

        brand:
          evidence.brand,

        focalLength:
          evidence.focalLength
      }
    );


    return {
      evidence,

      identity:
        null,

      candidates:
        [],

      mode:
        "needs-google-lens",

      reason:
        "Lensfun requires both manufacturer and focal length."
    };
  }


  /*
    ============================================================
    DETERMINISTIC LENSFUN LOOKUP
    ============================================================
  */

  const candidates =
    findLensfunCandidates(
      evidence
    );


  console.log(
    "[LENS RESOLVER] Lensfun candidates:",
    {
      productId:
        evidence.productId,

      count:
        candidates.length,

      candidates:
        candidates.map(
          candidate => ({
            candidateId:
              candidate.candidateId,

            maker:
              candidate.maker,

            model:
              candidate.model,

            mount:
              candidate.mount,

            score:
              candidate.score
          })
        )
    }
  );


  /*
    ZERO CANDIDATES

    Lensfun cannot resolve it.
    Go directly to cropped visual search.
  */
  if (
    candidates.length === 0
  ) {
    console.log(
      "[LENS RESOLVER] No Lensfun candidates. Routing to visual fallback:",
      evidence.productId
    );


    return {
      evidence,

      identity:
        null,

      candidates:
        [],

      mode:
        "needs-google-lens",

      reason:
        "Lensfun returned zero matching candidates."
    };
  }


  /*
    EXACTLY ONE CANDIDATE

    Deterministic exact identity.
    No DataForSEO required.
  */
  if (
    candidates.length === 1
  ) {
    console.log(
      "[LENS RESOLVER] Exactly one Lensfun candidate. Accepting deterministically:",
      {
        productId:
          evidence.productId,

        model:
          candidates[0]
            ?.model
      }
    );


    return {
      evidence,

      identity:
        lensfunCandidateToIdentity(
          candidates[0]
        ),

      candidates,

      mode:
        "lensfun-single",

      reason:
        "Exactly one Lensfun candidate remained."
    };
  }


  /*
    TWO OR MORE CANDIDATES

    DO NOT ask AI to choose.

    Preserve all candidates as a hard candidate set
    and route the product to cropped DataForSEO.
  */
  console.log(
    "[LENS RESOLVER] Multiple Lensfun candidates. Routing to visual fallback:",
    {
      productId:
        evidence.productId,

      count:
        candidates.length
    }
  );


  return {
    evidence,

    identity:
      null,

    candidates,

    mode:
      "lensfun-multiple",

    reason:
      "Multiple Lensfun candidates remain; visual identification is required."
  };
}

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

app.post(
  "/prepare-dataforseo-crops",
  async (
    req,
    res
  ) => {
    try {
      const targets =
        Array.isArray(
          req.body?.targets
        )
          ? req.body.targets
          : [];


      if (!targets.length) {
        return res
          .status(400)
          .json({
            ok:
              false,

            error:
              "No DataForSEO crop targets were supplied."
          });
      }


      /*
        Group by ORIGINAL Marketplace image.

        If lens_1 and lens_2 both chose Image 3,
        Image 3 is sent to the localizer once,
        with both requested products.
      */
      const targetsByImage =
        new Map();


      for (
        const target of targets
      ) {
        const imageUrl =
          String(
            target?.imageUrl ||
            ""
          ).trim();


        if (
          !imageUrl ||
          !target?.productId
        ) {
          continue;
        }


        if (
          !targetsByImage.has(
            imageUrl
          )
        ) {
          targetsByImage.set(
            imageUrl,
            []
          );
        }


        targetsByImage
          .get(
            imageUrl
          )
          .push(
            target
          );
      }


      const preparedTargets =
        [];


      for (
        const [
          imageUrl,
          imageTargets
        ] of targetsByImage
      ) {
        try {
          const prepared =
            await prepareDataForSeoCropsForImage({
              imageUrl,
              targets:
                imageTargets
            });


          preparedTargets.push(
            ...prepared
          );

        } catch (error) {
          console.error(
            "[DATAFORSEO CROP] Image localization failed:",
            {
              imageUrl,

              error:
                error?.message ||
                String(error)
            }
          );


          /*
            Do not destroy all other crop targets
            because one source image failed.
          */
          preparedTargets.push(
            ...imageTargets.map(
              target => ({
                ...target,

                cropPrepared:
                  false,

                dataForSeoImageUrl:
                  "",

                dataForSeoCropObjectPath:
                  "",

                cropBoundingBox:
                  null,

                cropError:
                  error?.message ||
                  "Crop preparation failed."
              })
            )
          );
        }
      }


      return res.json({
        ok:
          true,

        targets:
          preparedTargets
      });

    } catch (error) {
      console.error(
        "[DATAFORSEO CROP] Endpoint failed:",
        error
      );


      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ||
            "Could not prepare DataForSEO crops."
        });
    }
  }
);

app.post(
  "/dataforseo-identify-image",
  async (
    req,
    res
  ) => {
      const cropObjectPath =
      String(
        req.body
          ?.cropObjectPath ||
        ""
      ).trim();
    try {
      const imageUrl =
        String(
          req.body?.imageUrl ||
          ""
        ).trim();

      const promptText =
        String(
          req.body?.promptText ||
          ""
        ).trim();


      if (!imageUrl) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing imageUrl."
          });
      }


      if (!promptText) {
        return res
          .status(400)
          .json({
            ok: false,
            error:
              "Missing promptText."
          });
      }


      /*
        ============================================================
        A — GOOGLE SEARCH BY IMAGE
        ============================================================
      */

      const search =
        await searchDataForSeoByImage(
          imageUrl
        );


      /*
        ============================================================
        B — DETERMINISTIC REDUCTION
        ============================================================
      */

      const evidence =
        extractDataForSeoEvidence(
          search.result
        );


      console.log(
        "[DATAFORSEO] Reduced evidence:",
        evidence
      );


      /*
        ============================================================
        C — AI EVIDENCE CLEANER
        ============================================================
      */

      const cleaned =
        await cleanDataForSeoIdentificationEvidence({
          promptText,
          evidence
        });


      const found =
        Boolean(
          cleaned
            .recommendedIdentification &&
          cleaned
            .recommendedIdentification
            .trim()
            .toLowerCase() !==
              "unknown"
        );


      return res.json({
        ok:
          true,

        found,

        identification:
          cleaned
            .recommendedIdentification,

        cleanedEvidence:
          cleaned,

        dataForSeoTaskId:
          search.taskId,

        dataForSeoCost:
          search.cost
      });

    } catch (error) {
      console.error(
        "[DATAFORSEO] Identification failed:",
        error
      );


      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ||
            "DataForSEO identification failed."
        });
    }
    finally {
  if (cropObjectPath) {
    await deleteDataForSeoCrop(
      cropObjectPath
    );
  }
}
  }
);

const EBAY_DELETION_VERIFICATION_TOKEN =
  String(
    process.env.EBAY_DELETION_VERIFICATION_TOKEN ||
    ""
  ).trim();

const EBAY_DELETION_ENDPOINT =
  String(
    process.env.EBAY_DELETION_ENDPOINT ||
    ""
  ).trim();

if (
  !EBAY_DELETION_VERIFICATION_TOKEN
) {
  console.warn(
    "[EBAY DELETION] Verification token is not configured."
  );
}

if (
  !EBAY_DELETION_ENDPOINT
) {
  console.warn(
    "[EBAY DELETION] Public endpoint URL is not configured."
  );
}

app.get(
  "/ebay/account-deletion",
  (req, res) => {
    try {
      const challengeCode =
        String(
          req.query?.challenge_code ||
          ""
        ).trim();

      if (!challengeCode) {
        return res
          .status(400)
          .json({
            error:
              "Missing challenge_code."
          });
      }

      if (
        !EBAY_DELETION_VERIFICATION_TOKEN ||
        !EBAY_DELETION_ENDPOINT
      ) {
        return res
          .status(500)
          .json({
            error:
              "eBay account deletion verification is not configured."
          });
      }

      const challengeResponse =
        createHash("sha256")
          .update(
            challengeCode +
            EBAY_DELETION_VERIFICATION_TOKEN +
            EBAY_DELETION_ENDPOINT
          )
          .digest("hex");

      console.log(
        "[EBAY DELETION] Verification challenge received."
      );

      return res
        .status(200)
        .json({
          challengeResponse
        });

    } catch (error) {
      console.error(
        "[EBAY DELETION] Verification failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Verification failed."
        });
    }
  }
);

app.post(
  "/ebay/account-deletion",
  async (req, res) => {
    try {
      const payload =
        req.body || {};

      console.log(
        "[EBAY DELETION] Notification received:",
        {
          topic:
            payload?.metadata?.topic ||
            "",

          notificationId:
            payload
              ?.notification
              ?.notificationId ||
            "",

          userId:
            payload
              ?.notification
              ?.data
              ?.userId ||
            "",

          username:
            payload
              ?.notification
              ?.data
              ?.username ||
            ""
        }
      );

      /*
        IMPORTANT:

        If your application stores records tied to
        this eBay user, delete/anonymize those records here.
      */

      return res
        .status(204)
        .send();

    } catch (error) {
      console.error(
        "[EBAY DELETION] Notification processing failed:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            "Could not process deletion notification."
        });
    }
  }
);

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

const SUPABASE_DATAFORSEO_CROP_BUCKET =
  String(
    process.env
      .SUPABASE_DATAFORSEO_CROP_BUCKET ||
    "marketplace-dataforseo-crops"
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

/*
  ============================================================
  DATAFORSEO TARGET CROPPING
  ============================================================
*/

const DATAFORSEO_CROP_PADDING_RATIO =
  0.12;


function clampNumber(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(
      min,
      Number(value)
    )
  );
}

function normalizeStringArray(
  value
) {
  const values =
    Array.isArray(value)
      ? value
      : value == null
        ? []
        : [value];

  return [
    ...new Set(
      values
        .map(
          item =>
            String(
              item || ""
            ).trim()
        )
        .filter(Boolean)
    )
  ];
}


function getStep5GroundingSources({
  productId,
  productOcrResults,
  listingTitle,
  listingDescription,
  explicitFacts
}) {
  const matchingProductOcr =
    (productOcrResults || [])
      .filter(
        item =>
          String(
            item?.productId || ""
          ).trim() ===
          String(
            productId || ""
          ).trim()
      )
      .map(
        item =>
          String(
            item?.ocrText || ""
          ).trim()
      )
      .filter(Boolean);


  const sellerSources = [
    String(
      listingTitle || ""
    ).trim(),

    String(
      listingDescription || ""
    ).trim(),

    ...(
      Array.isArray(
        explicitFacts?.explicitlyIncluded
      )
        ? explicitFacts.explicitlyIncluded
        : []
    ),

    ...(
      Array.isArray(
        explicitFacts?.listingNotes
      )
        ? explicitFacts.listingNotes
        : []
    )
  ]
    .map(
      value =>
        String(
          value || ""
        ).trim()
    )
    .filter(Boolean);


  return [
    ...matchingProductOcr,
    ...sellerSources
  ];
}


function keepOnlyVerbatimEvidence(
  extractedEvidence,
  groundingSources
) {
  return normalizeStringArray(
    extractedEvidence
  ).filter(
    evidence =>
      groundingSources.some(
        source =>
          String(source)
            .includes(
              evidence
            )
      )
  );
}


function evidenceSupportsLiteral(
  value,
  evidence
) {
  const cleanValue =
    String(
      value || ""
    ).trim();

  if (!cleanValue) {
    return false;
  }


  return evidence.some(
    text =>
      hasExactObjectiveEvidence(
        text,
        cleanValue
      )
  );
}


function evidenceSupportsFocalLength(
  value,
  evidence
) {
  const target =
    normalizeFocalForComparison(
      value
    );

  if (!target) {
    return false;
  }


  return evidence.some(
    text => {
      const extracted =
        extractFocalLengthFromText(
          text
        );

      return (
        normalizeFocalForComparison(
          extracted
        ) ===
        target
      );
    }
  );
}


function evidenceSupportsAperture(
  value,
  evidence
) {
  const target =
    normalizeApertureForComparison(
      value
    );

  if (!target) {
    return false;
  }


  return evidence.some(
    text => {
      const extracted =
        extractMaxApertureFromText(
          text
        );

      return (
        normalizeApertureForComparison(
          extracted
        ) ===
        target
      );
    }
  );
}

function normalizeLocalizerBoundingBox(
  boundingBox
) {
  if (!boundingBox) {
    return null;
  }


  let xMin =
    Number(
      boundingBox.xMin
    );

  let yMin =
    Number(
      boundingBox.yMin
    );

  let xMax =
    Number(
      boundingBox.xMax
    );

  let yMax =
    Number(
      boundingBox.yMax
    );


  if (
    !Number.isFinite(xMin) ||
    !Number.isFinite(yMin) ||
    !Number.isFinite(xMax) ||
    !Number.isFinite(yMax)
  ) {
    return null;
  }


  xMin =
    clampNumber(
      xMin,
      0,
      1000
    );

  yMin =
    clampNumber(
      yMin,
      0,
      1000
    );

  xMax =
    clampNumber(
      xMax,
      0,
      1000
    );

  yMax =
    clampNumber(
      yMax,
      0,
      1000
    );


  if (
    xMax <= xMin ||
    yMax <= yMin
  ) {
    return null;
  }


  /*
    Reject obviously broken microscopic boxes.
  */
  if (
    xMax - xMin < 20 ||
    yMax - yMin < 20
  ) {
    return null;
  }


  return {
    xMin,
    yMin,
    xMax,
    yMax
  };
}


function addPaddingToBoundingBox(
  boundingBox,
  paddingRatio =
    DATAFORSEO_CROP_PADDING_RATIO
) {
  const width =
    boundingBox.xMax -
    boundingBox.xMin;

  const height =
    boundingBox.yMax -
    boundingBox.yMin;


  const padX =
    width *
    paddingRatio;

  const padY =
    height *
    paddingRatio;


  return {
    xMin:
      clampNumber(
        boundingBox.xMin -
          padX,
        0,
        1000
      ),

    yMin:
      clampNumber(
        boundingBox.yMin -
          padY,
        0,
        1000
      ),

    xMax:
      clampNumber(
        boundingBox.xMax +
          padX,
        0,
        1000
      ),

    yMax:
      clampNumber(
        boundingBox.yMax +
          padY,
        0,
        1000
      )
  };
}

async function localizeDataForSeoTargets({
  normalizedImageBuffer,
  imageIndex,
  targets
}) {
  const localizationTargets =
    targets.map(
      target => ({
        productId:
          String(
            target?.productId ||
            ""
          ).trim(),

        productType:
          String(
            target?.productType ||
            ""
          ).trim(),

        knownProduct:
          target?.knownProduct ||
          null,

        ocrText:
          String(
            target?.ocrText ||
            ""
          )
            .trim()
            .slice(
              0,
              1200
            )
      })
    );


  const prompt = `
You are a PRODUCT LOCALIZATION system.

You are looking at ONE ORIGINAL Facebook Marketplace photograph.

THIS IS NOT A COLLAGE.

All coordinates you return must be relative ONLY to the single supplied image.

Your only job is to locate the requested PHYSICAL PRIMARY PRODUCTS.

Do NOT attempt to determine their exact model.
Do NOT add products that were not requested.
Do NOT return bounding boxes for accessories.

REQUESTED TARGETS:

${JSON.stringify(
  localizationTargets,
  null,
  2
)}

The partial identity information above is provided only so that you can
distinguish the requested physical products from other objects in the image.

BOUNDING BOX RULES:

- Return coordinates from 0 to 1000.
- xMin = left edge.
- yMin = top edge.
- xMax = right edge.
- yMax = bottom edge.
- The coordinates refer to THIS ORIGINAL IMAGE only.
- Make the box reasonably tight around the entire physical product.
- Include the complete product whenever possible.
- Exclude other primary products as much as possible.
- For a camera lens attached to a body, box the lens itself rather than
  the entire camera-and-lens combination.
- For a camera body, avoid including attached lenses when possible.
- If two lenses are present, use the supplied evidence to associate the
  correct physical lens with the requested productId.
- If you cannot confidently locate a requested product, set found=false
  and boundingBox=null.
- Return exactly one result for every requested productId.

Return exactly:

{
  "targets": [
    {
      "productId": "lens_1",
      "found": true,
      "boundingBox": {
        "xMin": 100,
        "yMin": 200,
        "xMax": 700,
        "yMax": 800
      }
    }
  ]
}

Return valid JSON only.
Do not use Markdown.
`.trim();


  const imageDataUrl =
    `data:image/jpeg;base64,${normalizedImageBuffer.toString(
      "base64"
    )}`;


  const parsed =
    await runAiJsonStep({
      step:
        `DataForSEO crop localizer image ${imageIndex}`,

      maxAttempts:
        2,

      runRequest:
        async () =>
          await createLoggedOpenAiResponse({
            step:
              `DataForSEO crop localizer image ${imageIndex}`,

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
                        imageDataUrl,

                      detail:
                        "high"
                    }
                  ]
                }
              ]
            }
          })
    });


  return Array.isArray(
    parsed?.targets
  )
    ? parsed.targets
    : [];
}

async function uploadDataForSeoCrop({
  productId,
  cropBuffer
}) {
  const safeProductId =
    String(
      productId ||
      "product"
    )
      .trim()
      .replace(
        /[^a-zA-Z0-9_-]/g,
        "_"
      );


  const objectPath =
    (
      "dataforseo-crops/" +
      `${Date.now()}-` +
      `${randomUUID()}-` +
      `${safeProductId}.jpg`
    );


  const {
    error:
      uploadError
  } =
    await supabaseAdmin
      .storage
      .from(
        SUPABASE_DATAFORSEO_CROP_BUCKET
      )
      .upload(
        objectPath,
        cropBuffer,
        {
          contentType:
            "image/jpeg",

          cacheControl:
            "300",

          upsert:
            false
        }
      );


  if (uploadError) {
    throw new Error(
      `Could not upload DataForSEO crop: ${
        uploadError.message ||
        String(uploadError)
      }`
    );
  }


  const {
    data:
      publicUrlData
  } =
    supabaseAdmin
      .storage
      .from(
        SUPABASE_DATAFORSEO_CROP_BUCKET
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
      "Supabase did not return a public crop URL."
    );
  }


  return {
    objectPath,
    publicUrl
  };
}


async function deleteDataForSeoCrop(
  objectPath
) {
  const cleanPath =
    String(
      objectPath || ""
    ).trim();


  /*
    Never permit arbitrary Supabase deletion
    from this endpoint.
  */
  if (
    !cleanPath.startsWith(
      "dataforseo-crops/"
    )
  ) {
    return;
  }


  try {
    const {
      error
    } =
      await supabaseAdmin
        .storage
        .from(
          SUPABASE_DATAFORSEO_CROP_BUCKET
        )
        .remove([
          cleanPath
        ]);


    if (error) {
      console.warn(
        "[DATAFORSEO CROP] Cleanup failed:",
        {
          objectPath:
            cleanPath,

          error:
            error.message
        }
      );
    }

  } catch (error) {
    console.warn(
      "[DATAFORSEO CROP] Cleanup threw:",
      error?.message ||
      String(error)
    );
  }
}

async function prepareDataForSeoCropsForImage({
  imageUrl,
  targets
}) {
  /*
    Download the ORIGINAL Marketplace image.
  */
  const originalBuffer =
    await downloadImageBuffer(
      imageUrl
    );


  /*
    IMPORTANT:

    Normalize orientation FIRST.

    The AI localizer sees this exact buffer,
    and Sharp also crops this exact buffer.

    Therefore their coordinate systems are
    guaranteed to match.
  */
  const normalizedImageBuffer =
    await sharp(
      originalBuffer
    )
      .rotate()
      .jpeg({
        quality:
          95
      })
      .toBuffer();


  const metadata =
    await sharp(
      normalizedImageBuffer
    )
      .metadata();


  const imageWidth =
    Number(
      metadata.width
    );

  const imageHeight =
    Number(
      metadata.height
    );


  if (
    !imageWidth ||
    !imageHeight
  ) {
    throw new Error(
      "Could not determine normalized image dimensions."
    );
  }


  const imageIndex =
    Number(
      targets?.[0]
        ?.bestImageIndex
    ) || 0;


  const localizedTargets =
    await localizeDataForSeoTargets({
      normalizedImageBuffer,
      imageIndex,
      targets
    });


  const localizedByProductId =
    new Map(
      localizedTargets.map(
        item => [
          String(
            item?.productId ||
            ""
          ).trim(),

          item
        ]
      )
    );


  const results =
    [];


  for (
    const target of targets
  ) {
    const productId =
      String(
        target?.productId ||
        ""
      ).trim();


    const localization =
      localizedByProductId.get(
        productId
      );


    if (
      !localization ||
      localization.found !== true
    ) {
      results.push({
        ...target,

        cropPrepared:
          false,

        dataForSeoImageUrl:
          "",

        dataForSeoCropObjectPath:
          "",

        cropBoundingBox:
          null,

        cropError:
          "Product localizer could not confidently locate this physical product."
      });

      continue;
    }


    const rawBoundingBox =
      normalizeLocalizerBoundingBox(
        localization
          .boundingBox
      );


    if (!rawBoundingBox) {
      results.push({
        ...target,

        cropPrepared:
          false,

        dataForSeoImageUrl:
          "",

        dataForSeoCropObjectPath:
          "",

        cropBoundingBox:
          null,

        cropError:
          "Product localizer returned an invalid bounding box."
      });

      continue;
    }


    const paddedBoundingBox =
      addPaddingToBoundingBox(
        rawBoundingBox
      );


    const left =
      Math.max(
        0,
        Math.floor(
          (
            paddedBoundingBox
              .xMin /
            1000
          ) *
          imageWidth
        )
      );


    const top =
      Math.max(
        0,
        Math.floor(
          (
            paddedBoundingBox
              .yMin /
            1000
          ) *
          imageHeight
        )
      );


    const right =
      Math.min(
        imageWidth,
        Math.ceil(
          (
            paddedBoundingBox
              .xMax /
            1000
          ) *
          imageWidth
        )
      );


    const bottom =
      Math.min(
        imageHeight,
        Math.ceil(
          (
            paddedBoundingBox
              .yMax /
            1000
          ) *
          imageHeight
        )
      );


    const cropWidth =
      right -
      left;

    const cropHeight =
      bottom -
      top;


    if (
      cropWidth < 40 ||
      cropHeight < 40
    ) {
      results.push({
        ...target,

        cropPrepared:
          false,

        dataForSeoImageUrl:
          "",

        dataForSeoCropObjectPath:
          "",

        cropBoundingBox:
          null,

        cropError:
          "Calculated product crop was too small."
      });

      continue;
    }


    const cropBuffer =
      await sharp(
        normalizedImageBuffer
      )
        .extract({
          left,
          top,
          width:
            cropWidth,
          height:
            cropHeight
        })
        .jpeg({
          quality:
            95
        })
        .toBuffer();


    const uploaded =
      await uploadDataForSeoCrop({
        productId,
        cropBuffer
      });


    console.log(
      "[DATAFORSEO CROP] Prepared:",
      {
        productId,
        imageIndex,

        sourceDimensions:
          `${imageWidth}x${imageHeight}`,

        cropPixels: {
          left,
          top,
          width:
            cropWidth,
          height:
            cropHeight
        },

        rawBoundingBox,

        paddedBoundingBox,

        publicUrl:
          uploaded.publicUrl
      }
    );


    results.push({
      ...target,

      cropPrepared:
        true,

      dataForSeoImageUrl:
        uploaded.publicUrl,

      dataForSeoCropObjectPath:
        uploaded.objectPath,

      cropBoundingBox: {
        raw:
          rawBoundingBox,

        padded:
          paddedBoundingBox,

        pixels: {
          left,
          top,
          width:
            cropWidth,
          height:
            cropHeight
        }
      },

      cropError:
        ""
    });
  }


  return results;
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

  /*
  ============================================================
  PURCHASE CHECKLIST
  ============================================================

  EDIT YOUR CHECKLIST ITEMS HERE.

  key:
    Permanent internal ID.
    Do NOT change it after you've started using the item.

  label:
    Text displayed to you.
    This CAN be changed whenever you want.

  enabled:
    true  = show item
    false = hide item
*/

const DEAL_CHECKLIST_ITEMS = [
  {
    key: "everything_functional",
    label: "Everything functional",
    enabled: true
  },

  {
    key: "seller_profile_ok",
    label: "Nothing sketchy about seller profile / reviews",
    enabled: true
  },

  {
    key: "analysis_verified",
    label: "Product analysis is correct",
    enabled: true
  },

  {
    key: "tradeshield_confirmation_sent",
    label: "TradeShield confirmation sent",
    enabled: true
  },

  {
    key: "manual_estimate_complete",
    label: "Listing manually estimated",
    enabled: true
  }
];


const DEAL_CHECKLIST_PUBLIC_BASE_URL =
  String(
    process.env.DEAL_CHECKLIST_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  )
    .trim()
    .replace(/\/+$/, "");


function getEnabledDealChecklistItems() {
  return DEAL_CHECKLIST_ITEMS.filter(
    item =>
      item.enabled !== false
  );
}


function getMarketplaceListingIdFromUrl(
  value
) {
  const match =
    String(
      value || ""
    ).match(
      /\/marketplace\/item\/(\d+)/
    );

  return match?.[1] || "";
}


function getDealChecklistPublicUrl(
  token
) {
  return (
    `${DEAL_CHECKLIST_PUBLIC_BASE_URL}/` +
    encodeURIComponent(
      token
    )
  );
}


async function findDealChecklistBySourceKey(
  sourceKey
) {
  const {
    data,
    error
  } =
    await supabaseAdmin
      .from(
        "deal_checklists"
      )
      .select("*")
      .eq(
        "source_key",
        sourceKey
      )
      .maybeSingle();


  if (error) {
    throw error;
  }


  return data || null;
}


async function createOrGetDealChecklist({
  deal,
  analysisRunId
}) {
  const listingUrl =
    String(
      deal?.facebookUrl ||
      ""
    ).trim();


  const listingId =
    getMarketplaceListingIdFromUrl(
      listingUrl
    );


  /*
    Prefer Facebook listing ID.

    That makes retries of the same listing
    reuse the SAME checklist.
  */
  const sourceKey =
    listingId
      ? `facebook:${listingId}`
      : `analysis:${analysisRunId}`;


  let checklist =
    await findDealChecklistBySourceKey(
      sourceKey
    );


  if (!checklist) {
    const newChecklist = {
      id:
        randomUUID(),

      token:
        randomUUID(),

      source_key:
        sourceKey,

      analysis_run_id:
        analysisRunId,

      listing_id:
        listingId ||
        null,

      listing_url:
        listingUrl ||
        null,

      title:
        String(
          deal?.title ||
          ""
        ).trim() ||
        null,

      updated_at:
        new Date()
          .toISOString()
    };


    const {
      data,
      error
    } =
      await supabaseAdmin
        .from(
          "deal_checklists"
        )
        .insert(
          newChecklist
        )
        .select("*")
        .single();


    /*
      23505 = duplicate unique key.

      This can happen if the same listing
      gets saved twice at almost exactly
      the same time.
    */
    if (error) {
      if (
        String(
          error.code ||
          ""
        ) === "23505"
      ) {
        checklist =
          await findDealChecklistBySourceKey(
            sourceKey
          );

      } else {
        throw error;
      }

    } else {
      checklist =
        data;
    }
  }


  if (!checklist) {
    throw new Error(
      "Could not create purchase checklist."
    );
  }


  return {
    ...checklist,

    url:
      getDealChecklistPublicUrl(
        checklist.token
      )
  };
}


async function loadDealChecklistByToken(
  rawToken
) {
  const token =
    String(
      rawToken ||
      ""
    ).trim();


  const {
    data:
      checklist,

    error:
      checklistError
  } =
    await supabaseAdmin
      .from(
        "deal_checklists"
      )
      .select("*")
      .eq(
        "token",
        token
      )
      .maybeSingle();


  if (checklistError) {
    throw checklistError;
  }


  if (!checklist) {
    return null;
  }


  const {
    data:
      savedStates,

    error:
      statesError
  } =
    await supabaseAdmin
      .from(
        "deal_checklist_states"
      )
      .select(
        "item_key, checked"
      )
      .eq(
        "checklist_id",
        checklist.id
      );


  if (statesError) {
    throw statesError;
  }


  const stateMap =
    new Map(
      (
        savedStates ||
        []
      ).map(
        row => [
          row.item_key,
          row.checked === true
        ]
      )
    );


  return {
    ...checklist,

    items:
      getEnabledDealChecklistItems()
        .map(
          item => ({
            key:
              item.key,

            label:
              item.label,

            checked:
              stateMap.get(
                item.key
              ) === true
          })
        )
  };
}


function escapeChecklistHtml(
  value
) {
  return String(
    value ?? ""
  )
    .replace(
      /&/g,
      "&amp;"
    )
    .replace(
      /</g,
      "&lt;"
    )
    .replace(
      />/g,
      "&gt;"
    )
    .replace(
      /"/g,
      "&quot;"
    )
    .replace(
      /'/g,
      "&#039;"
    );
}


function renderDealChecklistPage(
  checklist
) {
  const title =
    escapeChecklistHtml(
      checklist.title ||
      "Marketplace Purchase"
    );


  const listingUrl =
    escapeChecklistHtml(
      checklist.listing_url ||
      ""
    );


  const checklistHtml =
    checklist.items
      .map(
        item => `
          <label class="check-row">

            <input
              type="checkbox"
              data-item-key="${escapeChecklistHtml(
                item.key
              )}"
              ${item.checked ? "checked" : ""}
            >

            <span>
              ${escapeChecklistHtml(
                item.label
              )}
            </span>

          </label>
        `
      )
      .join("");


  return `
<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>${title}</title>

<style>

body {
  margin: 0;
  background: #f5f5f5;
  font-family: Arial, sans-serif;
  color: #222;
}

.container {
  max-width: 650px;
  margin: 40px auto;
  padding: 20px;
}

.card {
  background: white;
  border-radius: 14px;
  padding: 26px;
  box-shadow:
    0 4px 20px
    rgba(0, 0, 0, 0.08);
}

h1 {
  margin-top: 0;
  margin-bottom: 5px;
}

.subtitle {
  color: #777;
  margin-bottom: 22px;
}

.listing-link {
  display: inline-block;
  margin-bottom: 22px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 14px;

  padding: 15px;
  margin-bottom: 10px;

  border:
    1px solid
    #ddd;

  border-radius: 9px;

  cursor: pointer;
}

.check-row:hover {
  background: #fafafa;
}

.check-row input {
  width: 21px;
  height: 21px;
}

.status {
  margin-top: 18px;
  font-size: 13px;
  color: #666;
}

.progress {
  font-weight: bold;
  margin-bottom: 15px;
}

</style>

</head>


<body>

<div class="container">

<div class="card">

<h1>
  ${title}
</h1>

<div class="subtitle">
  Pre-purchase checklist
</div>

${
  listingUrl
    ? `
      <a
        class="listing-link"
        href="${listingUrl}"
        target="_blank"
      >
        Open Marketplace Listing
      </a>
    `
    : ""
}

<div
  class="progress"
  id="progress"
></div>


<div>
  ${checklistHtml}
</div>


<div
  class="status"
  id="status"
>
  Saved
</div>

</div>

</div>


<script>

const checklistToken =
  ${JSON.stringify(
    checklist.token
  )};


const boxes =
  Array.from(
    document.querySelectorAll(
      "input[data-item-key]"
    )
  );


const statusElement =
  document.getElementById(
    "status"
  );


const progressElement =
  document.getElementById(
    "progress"
  );


function updateProgress() {
  const completed =
    boxes.filter(
      box =>
        box.checked
    ).length;


  progressElement.textContent =
    completed +
    " / " +
    boxes.length +
    " complete";
}


for (
  const box of boxes
) {
  box.addEventListener(
    "change",

    async () => {
      const intendedState =
        box.checked;


      updateProgress();


      statusElement.textContent =
        "Saving...";


      box.disabled =
        true;


      try {
        const response =
          await fetch(
            "/api/deal-checklists/" +
            encodeURIComponent(
              checklistToken
            ) +
            "/item",
            {
              method:
                "PATCH",

              headers: {
                "Content-Type":
                  "application/json"
              },

              body:
                JSON.stringify({
                  itemKey:
                    box.dataset.itemKey,

                  checked:
                    intendedState
                })
            }
          );


        const data =
          await response.json();


        if (
          !response.ok ||
          data.ok !== true
        ) {
          throw new Error(
            data.error ||
            "Could not save."
          );
        }


        statusElement.textContent =
          "Saved";


      } catch (error) {
        /*
          Put the checkbox back if saving fails.
        */
        box.checked =
          !intendedState;


        updateProgress();


        statusElement.textContent =
          "Save failed: " +
          (
            error.message ||
            "Unknown error"
          );


      } finally {
        box.disabled =
          false;
      }
    }
  );
}


updateProgress();

</script>

</body>

</html>
  `;
}


/*
  ============================================================
  PURCHASE CHECKLIST PAGE
  ============================================================
*/

app.get(
  "/deal-checklist/:token",

  async (
    req,
    res
  ) => {
    try {
      const checklist =
        await loadDealChecklistByToken(
          req.params.token
        );


      if (!checklist) {
        return res
          .status(404)
          .send(
            "Checklist not found."
          );
      }


      return res
        .type("html")
        .send(
          renderDealChecklistPage(
            checklist
          )
        );


    } catch (error) {
      console.error(
        "[DEAL CHECKLIST] Load failed:",
        error
      );


      return res
        .status(500)
        .send(
          "Could not load checklist."
        );
    }
  }
);


/*
  ============================================================
  PURCHASE CHECKLIST STATE UPDATE
  ============================================================
*/

app.patch(
  "/api/deal-checklists/:token/item",

  async (
    req,
    res
  ) => {
    try {
      const itemKey =
        String(
          req.body?.itemKey ||
          ""
        ).trim();


      const itemExists =
        DEAL_CHECKLIST_ITEMS.some(
          item =>
            item.key ===
            itemKey
        );


      if (!itemExists) {
        return res
          .status(400)
          .json({
            ok:
              false,

            error:
              "Unknown checklist item."
          });
      }


      const checklist =
        await loadDealChecklistByToken(
          req.params.token
        );


      if (!checklist) {
        return res
          .status(404)
          .json({
            ok:
              false,

            error:
              "Checklist not found."
          });
      }


      const checked =
        req.body?.checked ===
        true;


      const {
        error
      } =
        await supabaseAdmin
          .from(
            "deal_checklist_states"
          )
          .upsert(
            {
              checklist_id:
                checklist.id,

              item_key:
                itemKey,

              checked,

              updated_at:
                new Date()
                  .toISOString()
            },
            {
              onConflict:
                "checklist_id,item_key"
            }
          );


      if (error) {
        throw error;
      }


      return res.json({
        ok:
          true,

        itemKey,

        checked
      });


    } catch (error) {
      console.error(
        "[DEAL CHECKLIST] Save failed:",
        error
      );


      return res
        .status(500)
        .json({
          ok:
            false,

          error:
            error?.message ||
            "Could not save checklist."
        });
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

console.log(
  "[PRODUCT DATABASE] Using global Supabase camera_products table."
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

function normalizeLensModelCodes(
  value
) {
  return normalizeStringArray(
    value
  );
}

function normalizeLensIdentity(
  lensIdentity = {}
) {
  return {
    brand:
      cleanNullableIdentityField(
        lensIdentity?.brand
      ),

    canonicalModel:
      cleanNullableIdentityField(
        lensIdentity?.canonicalModel
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

    modelCodes:
      normalizeLensModelCodes(
        lensIdentity?.modelCodes ??
        lensIdentity?.featureModelCodes
      ),

    generation:
      cleanNullableIdentityField(
        lensIdentity?.generation
      ),

    resolutionMode:
      cleanNullableIdentityField(
        lensIdentity?.resolutionMode
      )
  };
}

function normalizeCanonicalLensModelForComparison(
  value
) {
  return String(
    value || ""
  )
    .toLowerCase()
    .replace(
      /\bf\s*\/?\s*/g,
      "f"
    )
    .replace(
      /[^a-z0-9.]+/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();
}


function findMatchingLensfunCandidate(
  model,
  candidates
) {
  const normalizedModel =
    normalizeCanonicalLensModelForComparison(
      model
    );


  if (
    !normalizedModel ||
    !Array.isArray(
      candidates
    )
  ) {
    return null;
  }


  return (
    candidates.find(
      candidate =>
        normalizeCanonicalLensModelForComparison(
          candidate?.model
        ) ===
        normalizedModel
    ) ||
    null
  );
}

function buildNormalizedLensModel(
  lensIdentity = {}
) {
  const normalized =
    normalizeLensIdentity(
      lensIdentity
    );


  /*
    Once Lensfun/Serper has given us a canonical model,
    preserve that model instead of reconstructing it.
  */
if (
  normalized.canonicalModel
) {
  const modelWithoutBrand =
    removeLeadingLensBrand(
      normalized.canonicalModel,
      normalized.brand
    );


  const cleanMount =
    String(
      normalized.mountSeries || ""
    ).trim();


  const brandKey =
    normalizeLensfunComparisonText(
      normalized.brand
    );

  const mountKey =
    normalizeLensfunComparisonText(
      cleanMount
    );


  /*
    Canon lens:
      Canon + Canon EF + EF 50mm...
    should not become:
      Canon Canon EF Canon EF...

    Third-party lens:
      Sigma + Canon EF + 18-250mm...
    DOES need Canon EF preserved.
  */
  const mountIsSameManufacturer =
    brandKey &&
    mountKey &&
    (
      mountKey ===
        brandKey ||

      mountKey.startsWith(
        `${brandKey} `
      )
    );


  const mountForModel =
    mountIsSameManufacturer
      ? null
      : cleanMount;


  return [
    mountForModel,
    modelWithoutBrand
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}


  /*
    Legacy/objective-evidence fallback.
  */
return [
  normalized.mountSeries,
  normalized.focalLength,
  normalized.maxAperture,
  ...normalized.modelCodes,
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

async function findProductInDatabase(item) {
  const canonicalName =
    getCanonicalNameForItem(item);

  if (!canonicalName) {
    return null;
  }

  const {
    data,
    error
  } =
    await supabaseAdmin
      .from(
        "camera_products"
      )
      .select(`
        canonical_name,
        brand,
        model,
        product_type,
        estimated_resale_price
      `)
      .eq(
        "canonical_name",
        canonicalName
      )
      .maybeSingle();

  if (error) {
    throw new Error(
      `Supabase product lookup failed for "${canonicalName}": ${
        error.message ||
        String(error)
      }`
    );
  }

  return data || null;
}

async function saveProductToDatabase({
  item,
  estimatedResalePrice
}) {
  const canonicalName =
    getCanonicalNameForItem(item);

  const price =
    Number(
      estimatedResalePrice
    );

  if (
    !canonicalName ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return false;
  }

  const {
    error
  } =
    await supabaseAdmin
      .from(
        "camera_products"
      )
      .upsert(
        {
          canonical_name:
            canonicalName,

          brand:
            String(
              item.brand || ""
            ).trim(),

          model:
            String(
              item.model || ""
            ).trim(),

          product_type:
            String(
              item.productType || ""
            ).trim(),

          estimated_resale_price:
            price,

          updated_at:
            new Date()
              .toISOString()
        },
        {
          onConflict:
            "canonical_name"
        }
      );

  if (error) {
    throw new Error(
      `Supabase product save failed for "${canonicalName}": ${
        error.message ||
        String(error)
      }`
    );
  }

  console.log(
    "[PRODUCT DATABASE] Saved globally to Supabase:",
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
  },

  "gpt-5-mini": {
    input: 0.25,
    cachedInput: 0.025,
    output: 2.00
  },

  "gpt-5.6-luna": {
    input: 0.20,
    cachedInput: 0.02,
    output: 1.20
  }
};


app.post(
  "/lookup-product-values",
  async (req, res) => {
    try {
      const items =
        Array.isArray(
          req.body?.items
        )
          ? req.body.items
          : [];

      const results =
        await Promise.all(
          items.map(
            async (
              item,
              index
            ) => {

              /*
  Do not value unresolved physical products
  using a generic database identity.
*/
if (
  item?.exactIdentityResolved ===
  false
) {
  return {
    index,

    found:
      false,

    skipped:
      true,

    reason:
      "unresolved_exact_identity",

    canonicalName:
      ""
  };
}
              const databaseProduct =
                await findProductInDatabase(
                  item
                );

              if (!databaseProduct) {
                return {
                  index,

                  found:
                    false,

                  canonicalName:
                    getCanonicalNameForItem(
                      item
                    )
                };
              }

              return {
                index,

                found:
                  true,

                canonicalName:
                  databaseProduct
                    .canonical_name,

                estimatedResalePrice:
                  Number(
                    databaseProduct
                      .estimated_resale_price
                  )
              };
            }
          )
        );

      console.log(
        "[PRODUCT DATABASE] Supabase lookup results:",
        results
      );

      res.json({
        results
      });

    } catch (error) {
      console.error(
        "Global product database lookup failed:",
        error
      );

      res
        .status(500)
        .json({
          error:
            "Global product database lookup failed."
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

CRITICAL — IGNORE TEXT INSIDE SELLER-UPLOADED SCREENSHOTS:

The Marketplace seller may upload screenshots as listing photos.

Those screenshots may show:
- another website's product listing;
- Amazon, eBay, Google, Canon, Nikon, or another store page;
- a product advertisement;
- a search result;
- a product specification/reference page;
- another camera or lens model;
- prices, ratings, reviews, or product names from another website.

Do NOT treat information appearing inside one of those screenshots as
seller-written evidence about what is actually included in the Marketplace listing.

For example, if the OCR contains:

"Visit the Canon Store"
"Sponsored"
"Canon EOS Rebel T6 DSLR Camera"
"$749.95"
"Price history"

but the actual Marketplace listing is for a Canon EOS Rebel T6i,
IGNORE the T6 information.

Only use information that belongs to the actual Facebook Marketplace:
- listing title;
- seller-written description;
- Details section;
- explicit included/excluded item statements.

A screenshot uploaded by the seller is reference material, not seller-written listing evidence.

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
const priorGallerySummary =
  galleryResults.map(
    gallery => ({
      galleryIndex:
        gallery.galleryIndex,

      startingImageIndex:
        gallery.startingImageIndex,

      endingImageIndex:
        gallery.endingImageIndex,

      galleryAnalysis:
        gallery.galleryAnalysis
    })
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

YOUR JOB:

Determine which PHYSICAL PRIMARY PRODUCTS appear in each image.

PRODUCT IDS ARE GLOBAL ACROSS THE ENTIRE MARKETPLACE LISTING.

You may be analyzing Gallery 2, Gallery 3, etc., but product numbering does NOT restart for each gallery.

A product ID such as:

camera_1
camera_2
lens_1
lens_2
flash_1

refers to one specific physical object across ALL galleries in this listing.

If a physical product in the CURRENT gallery is the same physical object previously assigned an ID in an earlier gallery, you MUST reuse that exact product ID.

Example:

Gallery 1:
camera_1 appears in Images 1-6.

Gallery 2:
the same physical camera appears again in Image 7.

Correct:
Image 7 -> camera_1

Incorrect:
Image 7 -> a newly created camera_1 with separate meaning
Image 7 -> camera_2

camera_2 should ONLY be created when the current gallery contains a second physical camera that is visually distinct from the existing camera_1.

Likewise:

lens_1 always refers to the same physical lens across galleries.
lens_2 means a different physical lens.
flash_1 always refers to the same physical flash across galleries.

Never restart product numbering when a new gallery begins.

PREVIOUS GALLERY PRODUCT REGISTRY:

${JSON.stringify(
  priorGallerySummary,
  null,
  2
)}

The previous gallery registry represents product IDs that have already been assigned.

Treat those IDs as persistent.

When analyzing the current gallery:

- Reuse an existing ID when the product is the same physical object.
- Create a new ID only when there is sufficient visual evidence of a different physical object.
- Never assign an existing product ID to a different physical object.
- Never renumber an existing product.
- Continue numbering from existing products.

Example:

If previous galleries already contain:

camera_1
lens_1
lens_2

and the current gallery contains:
- the same camera
- the same first lens
- one completely different lens

then use:

camera_1
lens_1
lens_3

Do NOT restart at lens_1.

CRITICAL — PRODUCTS SHOWN INSIDE SCREENSHOTS ARE NOT PHYSICAL PRODUCTS:

Some Marketplace gallery images may themselves be screenshots.

For example, an uploaded image may show:
- an Amazon product page;
- an eBay listing;
- another website's camera listing;
- a Google search result;
- an advertisement;
- a manufacturer's product page;
- a reference/specification page.

A camera or lens shown INSIDE such a screenshot is NOT a physical
Marketplace product.

Do NOT create camera_*, lens_*, flash_*, or any other productId for
products that exist only as images inside screenshots, webpages,
advertisements, packaging artwork, manuals, or reference material.

Only create a productId when the Marketplace photograph directly shows
the actual physical object being sold.

Strong indications that the image is a screenshot/reference page include:
- browser or website UI;
- "Sponsored";
- "Visit the ... Store";
- star ratings or review counts;
- "Price history";
- web prices;
- search bars;
- Buy/Add to Cart controls;
- product-page layouts.

If an entire Marketplace image is just such a screenshot, return:

"visibleProducts": []

for that image.

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
- Product IDs are GLOBAL across the entire listing.
- Product numbering must NEVER restart for a later gallery.
- The same physical product must use the same productId in every gallery where it appears.
- A new productId may only be created for a genuinely different physical product.
- Products from previous galleries that are NOT visible in the current gallery should NOT be repeated in the current gallery's products array.
- modelReadabilityScore must be an integer from 1 through 10.
- Do not return exact model names.
- Do not guess model names.
- Do not include secondary accessories as primary products.
- Do not use Markdown.
- Do not use code fences.
- Return valid JSON only.
        `.trim();

const priorGalleryImageContent =
  [];

for (
  const priorGallery of galleryResults
) {
  if (
    !priorGallery
      ?.debugCollageDataUrl
  ) {
    continue;
  }

  priorGalleryImageContent.push(
    {
      type:
        "input_text",

      text:
        `REFERENCE ONLY — Prior Gallery ${priorGallery.galleryIndex}, Marketplace Images ${priorGallery.startingImageIndex}-${priorGallery.endingImageIndex}. Use this image only to determine whether products in the CURRENT gallery are the same physical products previously assigned IDs.`
    },
    {
      type:
        "input_image",

      image_url:
        priorGallery
          .debugCollageDataUrl,

      detail:
        "high"
    }
  );
}

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

  ...priorGalleryImageContent,

  {
    type:
      "input_text",

    text:
      `CURRENT GALLERY ${groupIndex + 1}: Marketplace Images ${startingImageIndex}-${endingImageIndex}. Analyze THIS gallery and return products/images for THIS gallery only. Prior gallery images above are reference material for maintaining global physical-product IDs.`
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

const STEP5_RECONCILIATION_SCHEMA = {
  type: "object",
  additionalProperties: false,

  properties: {
    primaryProducts: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          productId: {
            type: "string"
          },

          galleryIndex: {
            type: "integer"
          },

          productType: {
            type: "string",
            enum: [
              "camera body",
              "camera",
              "camera lens",
              "flash"
            ]
          },

          /*
            Non-lens models still need a model-name field,
            but it is isolated from lens extraction.
          */
          nonLensIdentity: {
            type: [
              "object",
              "null"
            ],

            additionalProperties: false,

            properties: {
              brand: {
                type: [
                  "string",
                  "null"
                ]
              },

              modelName: {
                type: [
                  "string",
                  "null"
                ]
              }
            },

            required: [
              "brand",
              "modelName"
            ]
          },

          /*
            IMPORTANT:

            There is intentionally NO:
              model
              canonicalModel

            inside the LLM-controlled lens structure.
          */
          lensIdentity: {
            type: [
              "object",
              "null"
            ],

            additionalProperties: false,

            properties: {
              brand: {
                type: [
                  "string",
                  "null"
                ]
              },

              mountSeries: {
                type: [
                  "string",
                  "null"
                ]
              },

              focalLength: {
                type: [
                  "string",
                  "null"
                ]
              },

              maxAperture: {
                type: [
                  "string",
                  "null"
                ]
              },

              /*
                Actual literal markings / model codes only.

                Examples:
                  H-FS14140
                  H-FSA14140
                  A006

                Empty array if absent.
              */
              modelCodes: {
                type: "array",
                items: {
                  type: "string"
                }
              },

              generation: {
                type: [
                  "string",
                  "null"
                ]
              }
            },

            required: [
              "brand",
              "mountSeries",
              "focalLength",
              "maxAperture",
              "modelCodes",
              "generation"
            ]
          },

          /*
            These must be literal substrings copied from
            the supplied Marketplace/OCR source.
          */
          extracted_evidence: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },

        required: [
          "productId",
          "galleryIndex",
          "productType",
          "nonLensIdentity",
          "lensIdentity",
          "extracted_evidence"
        ]
      }
    },

    needsGoogleLens: {
      type: "array",

      items: {
        type: "object",
        additionalProperties: false,

        properties: {
          galleryIndex: {
            type: "integer"
          },

          productId: {
            type: "string"
          },

          reason: {
            type: "string"
          }
        },

        required: [
          "galleryIndex",
          "productId",
          "reason"
        ]
      }
    }
  },

  required: [
    "primaryProducts",
    "needsGoogleLens"
  ]
};

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

          const preDataForSeoLensfunCandidates =
  Array.isArray(
    req.body
      ?.preDataForSeoLensfunCandidates
  )
    ? req.body
        .preDataForSeoLensfunCandidates
    : [];


function getPreDataForSeoLensfunCandidates(
  productId
) {
  const cleanProductId =
    String(
      productId ||
      ""
    ).trim();


  const entry =
    preDataForSeoLensfunCandidates.find(
      item =>
        String(
          item?.productId ||
          ""
        ).trim() ===
        cleanProductId
    );


  return Array.isArray(
    entry?.candidates
  )
    ? entry.candidates
    : [];
}

const preDataForSeoPrimaryProducts =
  Array.isArray(
    req.body
      ?.preDataForSeoPrimaryProducts
  )
    ? req.body
        .preDataForSeoPrimaryProducts
    : [];

      const googleLensResults =
        Array.isArray(
          req.body?.googleLensResults
        )
          ? req.body.googleLensResults
          : [];

          /*
  ============================================================
  VISUAL FALLBACK ATTEMPT TRACKING

  Once DataForSEO has already been attempted for a physical
  product during this reconciliation run, do not ask the caller
  to run the visual fallback again.

  Group results count as an attempt for every same-type product
  represented by that result.
  ============================================================
*/

function getDataForSeoResultForProduct(
  productId
) {
  const cleanProductId =
    String(
      productId || ""
    ).trim();


  if (!cleanProductId) {
    return null;
  }


  return (
    googleLensResults.find(
      result =>
        String(
          result?.targetProductId ||
          ""
        ).trim() ===
          cleanProductId &&

        result?.identificationMode !==
          "group" &&

        result?.ambiguityResolved !==
          false
    ) ||
    null
  );
}


function getStrongDataForSeoIdentity(
  productId
) {
  const result =
    getDataForSeoResultForProduct(
      productId
    );


  if (!result) {
    return "";
  }


  const confidence =
    String(
      result
        ?.dataForSeoEvidence
        ?.confidence ||
      ""
    )
      .trim()
      .toLowerCase();


  const consensus =
    String(
      result
        ?.dataForSeoEvidence
        ?.consensus ||
      ""
    )
      .trim()
      .toLowerCase();


  /*
    BOTH conditions are required.
  */
/*
  Accepted DataForSEO confidence levels:

  HIGH + STRONG
    → authoritative

  MEDIUM + MIXED
    → also authoritative for the scanner

  Anything weaker
    → unresolved / retain fallback behavior
*/
const acceptedDataForSeoIdentity =
  (
    confidence === "high" &&
    consensus === "strong"
  );

if (
  !acceptedDataForSeoIdentity
) {
  return "";
}


  const recommendedIdentification =
    String(
      result
        ?.dataForSeoEvidence
        ?.recommendedIdentification ||
      result?.identifiedModel ||
      ""
    ).trim();


  if (
    !recommendedIdentification ||
    recommendedIdentification
      .toLowerCase() ===
        "unknown"
  ) {
    return "";
  }


  return recommendedIdentification;
}

function getLensfunCorroboratedDataForSeoCandidate(
  productId
) {
  const dataForSeoResult =
    getDataForSeoResultForProduct(
      productId
    );


  if (!dataForSeoResult) {
    return null;
  }


  /*
    HIGH + STRONG is handled by the existing
    authoritative DataForSEO path.

    This helper is specifically for weaker results.
  */
  const confidence =
    String(
      dataForSeoResult
        ?.dataForSeoEvidence
        ?.confidence ||
      ""
    )
      .trim()
      .toLowerCase();


  const consensus =
    String(
      dataForSeoResult
        ?.dataForSeoEvidence
        ?.consensus ||
      ""
    )
      .trim()
      .toLowerCase();


const isAuthoritativeDataForSeo =
  (
    confidence === "high" &&
    consensus === "strong"
  );

if (
  isAuthoritativeDataForSeo
) {
  return null;
}


  const recommendedIdentification =
    String(
      dataForSeoResult
        ?.dataForSeoEvidence
        ?.recommendedIdentification ||
      dataForSeoResult?.identifiedModel ||
      ""
    ).trim();


  if (
    !recommendedIdentification ||
    recommendedIdentification
      .toLowerCase() ===
        "unknown"
  ) {
    return null;
  }


  const lensfunCandidates =
    getPreDataForSeoLensfunCandidates(
      productId
    );


  /*
    This rule only matters when Lensfun had
    multiple possible exact models.
  */
  if (
    !Array.isArray(
      lensfunCandidates
    ) ||
    lensfunCandidates.length < 2
  ) {
    return null;
  }


  const matchingCandidate =
    findMatchingLensfunCandidate(
      recommendedIdentification,
      lensfunCandidates
    );


  if (!matchingCandidate) {
    console.log(
      "[DATAFORSEO + LENSFUN] Weak visual result did not match Lensfun candidate set:",
      {
        productId,

        recommendedIdentification,

        confidence,

        consensus,

        allowedModels:
          lensfunCandidates.map(
            candidate =>
              candidate?.model
          )
      }
    );

    return null;
  }


  console.log(
    "[DATAFORSEO + LENSFUN] Weak visual result corroborated a Lensfun candidate:",
    {
      productId,

      recommendedIdentification,

      matchedLensfunModel:
        matchingCandidate.model,

      confidence,

      consensus
    }
  );


  return matchingCandidate;
}


function getPreDataForSeoProduct(
  productId
) {
  const cleanProductId =
    String(
      productId || ""
    ).trim();


  return (
    preDataForSeoPrimaryProducts.find(
      product =>
        String(
          product?.productId ||
          ""
        ).trim() ===
        cleanProductId
    ) ||
    null
  );
}

function wasVisualFallbackAttemptedForProduct(
  productId
) {
  const cleanProductId =
    String(
      productId || ""
    ).trim();

  if (
    !cleanProductId ||
    !Array.isArray(
      googleLensResults
    )
  ) {
    return false;
  }


  return googleLensResults.some(
    result => {
      const targetProductId =
        String(
          result?.targetProductId ||
          ""
        ).trim();


      if (
        targetProductId ===
        cleanProductId
      ) {
        return true;
      }


      const sameTypeProductIds =
        Array.isArray(
          result?.sameTypeProductIds
        )
          ? result.sameTypeProductIds
              .map(
                value =>
                  String(
                    value || ""
                  ).trim()
              )
              .filter(Boolean)
          : [];


      return (
        sameTypeProductIds.includes(
          cleanProductId
        )
      );
    }
  );
}


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

IMPORTANT GLOBAL PRODUCT-ID RULE:

Gallery product IDs are GLOBAL across the entire Marketplace listing.

The same productId always represents the same physical product regardless
of which gallery contains it.

For example:

Gallery 1 camera_1
Gallery 2 camera_1

are the SAME physical camera.

They must produce exactly ONE final primary product.

Gallery numbers indicate which collage contained an observation.
They are NOT part of the product's identity.

Do NOT create separate final products because the same productId appears
in multiple gallery batches.

camera_2, lens_2, etc. represent genuinely separate physical products
that were assigned those distinct IDs during gallery analysis.

==================================================
CRITICAL PHYSICAL PRODUCT PRESERVATION RULE
==================================================

Every distinct physical primary product represented by a unique gallery
productId must remain a distinct final primary product unless there is
strong evidence that the seller explicitly excludes that physical item.

Examples:

camera_1 + lens_1
means TWO physical primary products.

Even if lens_1 is physically mounted on camera_1, lens_1 is still a
separate sellable primary product and MUST appear separately in
primaryProducts.

Correct:

camera_1 -> Canon EOS Rebel T3 camera body
lens_1   -> Sigma 18-250mm camera lens

Incorrect:

camera_1 -> Canon EOS Rebel T3 with the Sigma lens identity embedded
inside camera_1

Incorrect:

camera_1 only, with lens_1 omitted

A mounted lens does NOT become part of the camera-body product identity.

Likewise:

camera_1
lens_1
lens_2

must normally produce THREE final primaryProducts.

For every unique gallery productId:

- preserve that productId in primaryProducts exactly once;
- identify THAT physical product using the evidence associated with it;
- never transfer the identity of one productId into another productId;
- never delete a gallery-visible lens merely because it is attached to a camera;
- never place lensIdentity on a camera body or camera;
- lensIdentity belongs ONLY to a product whose productType is "camera lens".

The only reasons a gallery product may be omitted are:

1. seller evidence explicitly states that physical product is NOT included; or
2. the gallery clearly misclassified a non-primary accessory as a primary product.

Uncertainty about exact model identity is NOT a reason to remove the
physical product.

If the exact model cannot be established, preserve the physical product
with null identity fields and add it to needsGoogleLens.

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
- Combine OCR markings only when those markings are actually present in the
  supplied evidence. Do not add missing components merely because they would
  form a known or common product identity.
- Do NOT invent missing model components.
- A highly readable OCR result such as:
  "Canon / EOS / 60D"
  is sufficient evidence for Canon EOS 60D.
- Lens OCR such as:
  "Canon / EF-S / 18-55mm / 1:3.5-5.6 / IS II"
  can support the normalized Canon EF-S 18-55mm f/3.5-5.6 IS II identity.

==================================================
SOURCE E — GOOGLE SEARCH-BY-IMAGE / DATAFORSEO EVIDENCE
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
DATAFORSEO CLEANING RULES:

- dataForSeoEvidence is an intermediary AI-cleaned summary of raw Google
  Search By Image results.

- DataForSEO may ESTABLISH a new exact commercially-distinct model ONLY when:

  confidence = "high"

  AND

  consensus = "strong"

- BOTH conditions are mandatory.

- If confidence is medium or low, DataForSEO is supporting evidence only.

- If consensus is mixed, weak, or none, DataForSEO is supporting evidence only.

- Supporting DataForSEO evidence MUST NOT change a previously supported
  specification such as:
  focal length,
  aperture,
  stabilization designation,
  mount series,
  generation,
  STM,
  USM,
  IS,
  VR,
  II,
  III,
  G2,
  or other commercially meaningful suffixes.

- In particular, do NOT replace an existing seller/OCR-supported fact merely
  because a medium-confidence or mixed-consensus Search By Image result
  contains a different specification.

- When DataForSEO confidence = high AND consensus = strong, its exact model
  may be used as strong evidence for the targeted physical product.

- candidateModels remain observations and do not themselves establish identity.

- Seller evidence, product OCR, and other objective evidence can still reject
  a high/strong DataForSEO result if there is a direct contradiction.

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

LENS EXTRACTION — STRICT GROUNDING CONTRACT:

For camera lenses, this step is an EXTRACTION step only.

You are NOT identifying a canonical commercial lens model.
You are NOT choosing the most likely revision.
You are NOT allowed to complete a partial lens identity using camera knowledge.

The dedicated Lensfun / visual-resolution pipeline runs AFTER this step.

For every camera lens:

- nonLensIdentity MUST be null.
- lensIdentity MUST contain only attributes supported by Marketplace source evidence.
- extracted_evidence MUST contain exact verbatim substrings copied from the supplied source material.

AUTHORIZED SOURCES FOR extracted_evidence:

1. Marketplace listing title.
2. Marketplace listing description / seller-written text.
3. OCR from the physical Marketplace product image.
4. Explicit seller-written facts extracted from those sources.

Google Search By Image / DataForSEO evidence is NOT an authorized source
for lensIdentity fields in this extraction step.

DataForSEO may be used later by the dedicated resolver, but must never
be used here to rewrite or complete the structured Marketplace extraction.

EXTRACTED EVIDENCE RULE:

Every string in extracted_evidence must be copied VERBATIM.

Do not paraphrase it.
Do not normalize it.
Do not correct OCR inside extracted_evidence.
Do not manufacture a supporting quote.

Example:

Source:
"PANASONIC LUMIX G Vario Lens, 14-140MM, F3.5-5.6"

Valid extracted_evidence:
[
  "PANASONIC LUMIX G Vario",
  "14-140MM",
  "F3.5-5.6"
]

Invalid extracted_evidence:
[
  "Panasonic H-FSA14140",
  "Mark II",
  "Version 2"
]

because none of those strings occur in the supplied Marketplace source.

ATTRIBUTE RULES:

brand:
Populate only if manufacturer/brand wording is directly supported.

mountSeries:
Populate only if the mount/series is directly stated.

focalLength:
You may normalize directly stated text.

Example:
"14-140MM"
may become:
"14-140mm"

maxAperture:
You may normalize directly stated aperture notation.

Example:
"F3.5-5.6"
or
"1:3.5-5.6"

may become:
"f/3.5-5.6"

modelCodes:
Contains ONLY literal manufacturer model / SKU codes directly present
in the Marketplace source.

Examples:
"H-FS14140"
"H-FSA14140"
"A006"

Do NOT infer a model code from focal length, aperture, appearance,
camera compatibility, product family, or general knowledge.

generation:
Populate ONLY if the generation/revision is explicitly present.

Examples:
"II"
"III"
"Mark II"
"G2"

If no generation is explicitly stated:
generation MUST be null.

Absence of "II" does NOT establish generation I.

Do NOT assume:
- the oldest version;
- the newest version;
- the most common version.

Example source:

"PANASONIC LUMIX G Vario Lens, 14-140MM, F3.5-5.6 ASPH"
"Micro Four Thirds"

Correct lensIdentity:

{
  "brand": "Panasonic",
  "mountSeries": "Micro Four Thirds",
  "focalLength": "14-140mm",
  "maxAperture": "f/3.5-5.6",
  "modelCodes": [],
  "generation": null
}

It is FORBIDDEN to output:

"H-FSA14140"
"II"
"Mark II"

unless those distinguishing facts are explicitly supported by the
Marketplace source.

UNKNOWN INFORMATION MUST REMAIN UNKNOWN.

The dedicated resolver owns canonical lens identification.

Return objects matching this structure:

{
  "primaryProducts": [
    {
      "productId": "camera_1",
      "galleryIndex": 1,
      "productType": "camera body",
      "nonLensIdentity": {
        "brand": "Canon",
        "modelName": "EOS 60D"
      },
      "lensIdentity": null,
      "extracted_evidence": [
        "Canon EOS 60D"
      ]
    },
    {
      "productId": "lens_1",
      "galleryIndex": 1,
      "productType": "camera lens",
      "nonLensIdentity": null,
      "lensIdentity": {
        "brand": "Panasonic",
        "mountSeries": "Micro Four Thirds",
        "focalLength": "14-140mm",
        "maxAperture": "f/3.5-5.6",
        "modelCodes": [],
        "generation": null
      },
      "extracted_evidence": [
        "PANASONIC LUMIX G Vario",
        "14-140MM",
        "F3.5-5.6",
        "Micro Four Thirds"
      ]
    }
  ],

  "needsGoogleLens": []
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

For camera lenses:
- nonLensIdentity MUST be null.
- lensIdentity MUST be an object.
- Do not output a free-form model name.
- Do not output canonicalModel.
- Use modelCodes only for explicitly visible model/SKU codes.
- extracted_evidence must contain verbatim Marketplace-source substrings.

For non-lens products:
- lensIdentity MUST be null.
- nonLensIdentity contains brand and modelName.

productType must be one of:
"camera body"
"camera"
"camera lens"
"flash"

CRITICAL:

A camera body may NEVER contain information about an attached lens in
its lensIdentity field.

For example, this is INVALID:

{
  "productId": "camera_1",
  "productType": "camera body",
  "brand": "Canon",
  "model": "EOS Rebel T3",
  "lensIdentity": {
    "brand": "Sigma",
    "focalLength": "18-250mm"
  }
}

The correct representation is TWO objects:

camera_1 = Canon EOS Rebel T3 camera body
lens_1   = Sigma 18-250mm camera lens
      `.trim();


const response =
  await createLoggedOpenAiResponse({
    step:
      "Step 5 primary product reconciliation",

    request: {
  model:
    "gpt-4o-mini",

  text: {
    format: {
      type:
        "json_schema",

      name:
        "step5_primary_product_reconciliation",

      strict:
        true,

      schema:
        STEP5_RECONCILIATION_SCHEMA
    }
  },

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

function sanitizeStep5Product(
  rawProduct
) {
  const productId =
    String(
      rawProduct?.productId || ""
    ).trim();

  const productType =
    String(
      rawProduct?.productType || ""
    ).trim();

  const normalizedType =
    productType.toLowerCase();

  const galleryIndex =
    Number(
      rawProduct?.galleryIndex
    ) || 1;


  const groundingSources =
    getStep5GroundingSources({
      productId,
      productOcrResults,
      listingTitle,
      listingDescription,
      explicitFacts
    });


  /*
    Never trust the model's claimed citations until
    they have been proven to occur literally in source.
  */
  const extractedEvidence =
    keepOnlyVerbatimEvidence(
      rawProduct?.extracted_evidence,
      groundingSources
    );


  if (
    normalizedType ===
    "camera lens"
  ) {
    const rawIdentity =
      rawProduct?.lensIdentity &&
      typeof rawProduct.lensIdentity ===
        "object"
        ? rawProduct.lensIdentity
        : {};


    const brand =
      evidenceSupportsLiteral(
        rawIdentity?.brand,
        extractedEvidence
      )
        ? cleanNullableIdentityField(
            rawIdentity.brand
          )
        : null;


    const mountSeries =
      evidenceSupportsLiteral(
        rawIdentity?.mountSeries,
        extractedEvidence
      )
        ? cleanNullableIdentityField(
            rawIdentity.mountSeries
          )
        : null;


    const focalLength =
      evidenceSupportsFocalLength(
        rawIdentity?.focalLength,
        extractedEvidence
      )
        ? cleanNullableIdentityField(
            rawIdentity.focalLength
          )
        : null;


    const maxAperture =
      evidenceSupportsAperture(
        rawIdentity?.maxAperture,
        extractedEvidence
      )
        ? cleanNullableIdentityField(
            rawIdentity.maxAperture
          )
        : null;


    const modelCodes =
      normalizeStringArray(
        rawIdentity?.modelCodes
      ).filter(
        code =>
          evidenceSupportsLiteral(
            code,
            extractedEvidence
          )
      );


    const generation =
      evidenceSupportsLiteral(
        rawIdentity?.generation,
        extractedEvidence
      )
        ? cleanNullableIdentityField(
            rawIdentity.generation
          )
        : null;


    return {
      productId,
      galleryIndex,

      /*
        Step 5 cannot freely create a lens model.
        The resolver does that later.
      */
      brand:
        null,

      model:
        null,

      productType,

      lensIdentity: {
        brand,

        canonicalModel:
          null,

        mountSeries,
        focalLength,
        maxAperture,
        modelCodes,
        generation,

        resolutionMode:
          null
      },

      extracted_evidence:
        extractedEvidence
    };
  }


  const nonLensIdentity =
    rawProduct?.nonLensIdentity &&
    typeof rawProduct.nonLensIdentity ===
      "object"
      ? rawProduct.nonLensIdentity
      : {};


  return {
    productId,
    galleryIndex,

    brand:
      cleanNullableIdentityField(
        nonLensIdentity?.brand
      ),

    model:
      cleanNullableIdentityField(
        nonLensIdentity?.modelName
      ),

    productType,

    lensIdentity:
      null,

    extracted_evidence:
      extractedEvidence
  };
}

/*
  ============================================================
  STEP 5 STRUCTURAL VALIDATION
  ============================================================

  Gallery product IDs represent physical primary products.

  Do not silently allow reconciliation to:
  - drop a gallery product;
  - merge a lens into a camera;
  - attach lensIdentity to a non-lens product.
*/

const galleryPhysicalProducts =
  [];

for (
  const gallery of galleryResults
) {
  const products =
    Array.isArray(
      gallery?.galleryAnalysis?.products
    )
      ? gallery.galleryAnalysis.products
      : [];

  for (
    const product of products
  ) {
    const productId =
      String(
        product?.productId || ""
      ).trim();

    const productType =
      String(
        product?.productType || ""
      ).trim();

    if (
      !productId ||
      !productType
    ) {
      continue;
    }

    /*
      IDs are global across galleries now,
      so only keep one registry entry per productId.
    */
    if (
      galleryPhysicalProducts.some(
        existing =>
          existing.productId ===
          productId
      )
    ) {
      continue;
    }

    galleryPhysicalProducts.push({
      productId,
      productType
    });
  }
}


const parsedPrimaryProducts =
  Array.isArray(
    parsed?.primaryProducts
  )
    ? parsed.primaryProducts
        .map(
          sanitizeStep5Product
        )
    : [];


/*
  Detect gallery-visible physical products
  that vanished during reconciliation.
*/
const missingGalleryProducts =
  galleryPhysicalProducts.filter(
    galleryProduct =>
      !parsedPrimaryProducts.some(
        finalProduct =>
          String(
            finalProduct?.productId || ""
          ).trim() ===
            galleryProduct.productId
      )
  );


/*
  Detect lens identity incorrectly attached
  to a camera body / camera / flash.
*/
const invalidLensIdentityProducts =
  parsedPrimaryProducts.filter(
    product => {
      const productType =
        String(
          product?.productType || ""
        )
          .trim()
          .toLowerCase();

      return (
        productType !==
          "camera lens" &&
        product?.lensIdentity &&
        typeof product.lensIdentity ===
          "object"
      );
    }
  );


/*
  ============================================================
  STEP 5 PHYSICAL PRODUCT RECOVERY
  ============================================================

  Step 5 is allowed to organize / refine identities.

  It is NOT allowed to make a physical product that the
  gallery already detected disappear.

  Previously this condition returned HTTP 502 and caused the
  entire Marketplace listing analysis to fail/retry.

  Instead:

    1. preserve every gallery product ID;
    2. restore a missing product from the pre-DataForSEO
       baseline when available;
    3. otherwise create a minimal unresolved physical-product
       placeholder from the gallery registry;
    4. strip invalid lensIdentity objects from non-lens items.

  Identity can remain unresolved. Physical existence cannot.
*/
if (
  missingGalleryProducts.length ||
  invalidLensIdentityProducts.length
) {
  console.warn(
    "[STEP 5] Reconciliation structure required recovery:",
    {
      missingGalleryProducts,

      invalidLensIdentityProducts:
        invalidLensIdentityProducts.map(
          product => ({
            productId:
              product?.productId,

            productType:
              product?.productType
          })
        )
    }
  );
}


/*
  Work from a mutable recovered copy rather than rejecting
  the entire Step-5 response.
*/
let recoveredPrimaryProducts =
  parsedPrimaryProducts.map(
    product => {
      const productType =
        String(
          product?.productType ||
          ""
        )
          .trim()
          .toLowerCase();

      /*
        lensIdentity is only legal on physical camera lenses.
      */
      if (
        productType !==
          "camera lens" &&
        product?.lensIdentity
      ) {
        console.warn(
          "[STEP 5 RECOVERY] Removing invalid lensIdentity from non-lens product:",
          {
            productId:
              product?.productId,

            productType:
              product?.productType
          }
        );

        return {
          ...product,

          lensIdentity:
            null
        };
      }

      return product;
    }
  );


/*
  Restore every physical gallery product that Step 5 dropped.
*/
for (
  const missingProduct of
    missingGalleryProducts
) {
  const productId =
    String(
      missingProduct?.productId ||
      ""
    ).trim();

  const productType =
    String(
      missingProduct?.productType ||
      ""
    ).trim();


  if (!productId) {
    continue;
  }


  /*
    On the second reconciliation pass, this is the ideal
    recovery source because it contains the exact state
    immediately before DataForSEO was introduced.
  */
  const baseline =
    preDataForSeoPrimaryProducts.find(
      product =>
        String(
          product?.productId ||
          ""
        ).trim() ===
          productId
    );


  if (baseline) {
    console.warn(
      "[STEP 5 RECOVERY] Restoring missing product from pre-DataForSEO baseline:",
      {
        productId,
        productType
      }
    );

    recoveredPrimaryProducts.push(
      JSON.parse(
        JSON.stringify(
          baseline
        )
      )
    );

    continue;
  }


  /*
    First-pass fallback:

    We may not yet have a richer identity baseline.

    Preserve the physical product as unresolved rather than
    inventing an exact model or failing the listing.
  */
  console.warn(
    "[STEP 5 RECOVERY] Restoring missing gallery product as unresolved:",
    {
      productId,
      productType
    }
  );


  recoveredPrimaryProducts.push({
    productId,

    galleryIndex:
      null,

    brand:
      null,

    model:
      null,

    productType,

    lensIdentity:
      productType
        .toLowerCase() ===
          "camera lens"
        ? {
            brand:
              null,

            canonicalModel:
              null,

            mountSeries:
              null,

            focalLength:
              null,

            maxAperture:
              null,

            modelCodes:
  [],

            generation:
              null,

            resolutionMode:
              null
          }
        : null
  });
}

    let primaryProducts =
  recoveredPrimaryProducts;

          /*
  ============================================================
  DATAFORSEO EVIDENCE GATE

  If DataForSEO was attempted for a product but did NOT reach
  high confidence + strong consensus, restore that product to
  its exact pre-DataForSEO state.

  The second Step-5 call exists only because DataForSEO added
  new evidence. Weak evidence must therefore not rewrite facts
  already established by the first reconciliation.
  ============================================================
*/

if (
  googleLensResults.length &&
  preDataForSeoPrimaryProducts.length
) {
  primaryProducts =
    primaryProducts.map(
      product => {
        const productId =
          String(
            product?.productId ||
            ""
          ).trim();


        if (!productId) {
          return product;
        }


        const dataForSeoResult =
          getDataForSeoResultForProduct(
            productId
          );


        /*
          DataForSEO wasn't used on this product.
        */
        if (!dataForSeoResult) {
          return product;
        }


        /*
          HIGH + STRONG is handled later by the
          authoritative DataForSEO lock.
        */
        const strongIdentity =
          getStrongDataForSeoIdentity(
            productId
          );


        if (strongIdentity) {
          return product;
        }


        /*
          ========================================================
          WEAKER DATAFORSEO + LENSFUN CORROBORATION
          ========================================================

          DataForSEO itself isn't strong enough to establish
          an arbitrary exact model.

          But if its exact recommended model is one of the
          deterministic Lensfun candidates, accept the actual
          Lensfun candidate as canonical.
        */

        const corroboratedCandidate =
          getLensfunCorroboratedDataForSeoCandidate(
            productId
          );


        if (corroboratedCandidate) {
          const canonicalIdentity =
            lensfunCandidateToIdentity(
              corroboratedCandidate
            );


          canonicalIdentity
            .resolutionMode =
            "lensfun-dataforseo-corroborated";


          console.log(
            "[DATAFORSEO GATE] Accepting Lensfun candidate corroborated by weaker visual search:",
            {
              productId,

              canonicalModel:
                canonicalIdentity
                  ?.canonicalModel
            }
          );


          return {
            ...product,

            brand:
              canonicalIdentity.brand ||
              product?.brand ||
              null,

            lensIdentity:
              canonicalIdentity
          };
        }


        /*
          Otherwise DataForSEO was not authoritative
          and did not corroborate one exact Lensfun candidate.

          Restore the exact state from before DataForSEO.
        */
        const baseline =
          getPreDataForSeoProduct(
            productId
          );


        if (!baseline) {
          return product;
        }


        console.log(
          "[DATAFORSEO GATE] Restoring pre-DataForSEO identity:",
          {
            productId,

            confidence:
              dataForSeoResult
                ?.dataForSeoEvidence
                ?.confidence,

            consensus:
              dataForSeoResult
                ?.dataForSeoEvidence
                ?.consensus,

            recommendedIdentification:
              dataForSeoResult
                ?.dataForSeoEvidence
                ?.recommendedIdentification
          }
        );


        return JSON.parse(
          JSON.stringify(
            baseline
          )
        );
      }
    );
}

          let needsGoogleLens =
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

/*
  ============================================================
  DEDICATED LENS SPECIFICATION RESOLUTION
  ============================================================
*/

const cameraContext =
  primaryProducts
    .filter(
      product =>
        String(
          product?.productType || ""
        )
          .trim()
          .toLowerCase() !==
        "camera lens"
    )
    .map(
      product => ({
        productId:
          String(
            product?.productId || ""
          ).trim(),

        productType:
          String(
            product?.productType || ""
          ).trim(),

        brand:
          cleanNullableIdentityField(
            product?.brand
          ),

        model:
          cleanNullableIdentityField(
            product?.model
          )
      })
    );

    const isPostDataForSeoPass =
  Array.isArray(
    googleLensResults
  ) &&
  googleLensResults.length > 0;

const lensfunCandidatesByProductId =
  new Map(
    preDataForSeoLensfunCandidates.map(
      entry => [
        String(
          entry?.productId ||
          ""
        ).trim(),

        Array.isArray(
          entry?.candidates
        )
          ? entry.candidates
          : []
      ]
    )
  );

for (
  const product of primaryProducts
) {
  const productType =
    String(
      product?.productType || ""
    )
      .trim()
      .toLowerCase();


  if (
    productType !==
    "camera lens"
  ) {
    continue;
  }

  /*
  ============================================================
  AUTHORITATIVE CROPPED DATAFORSEO RESULT
  ============================================================
*/

const strongDataForSeoIdentity =
  getStrongDataForSeoIdentity(
    product?.productId
  );


if (strongDataForSeoIdentity) {
  const baseline =
    getPreDataForSeoProduct(
      product?.productId
    );


  const existingLensIdentity =
    normalizeLensIdentity(
      baseline?.lensIdentity ||
      product?.lensIdentity ||
      {}
    );


  /*
    Preserve the ACTUAL DataForSEO confidence metadata.

    getStrongDataForSeoIdentity() now means
    "accepted / authoritative", not necessarily literally
    high + strong.
  */
  const dataForSeoResult =
    getDataForSeoResultForProduct(
      product?.productId
    );


  const actualConfidence =
    String(
      dataForSeoResult
        ?.dataForSeoEvidence
        ?.confidence ||
      ""
    )
      .trim()
      .toLowerCase();


  const actualConsensus =
    String(
      dataForSeoResult
        ?.dataForSeoEvidence
        ?.consensus ||
      ""
    )
      .trim()
      .toLowerCase();


  const resolutionMode =
    actualConfidence === "high" &&
    actualConsensus === "strong"
      ? "dataforseo-high-strong"
      : actualConfidence === "medium" &&
        actualConsensus === "mixed"
        ? "dataforseo-medium-mixed"
        : "dataforseo-accepted";


  product.lensIdentity = {
    ...existingLensIdentity,

    brand:
      existingLensIdentity
        .brand ||
      cleanNullableIdentityField(
        product?.brand
      ),

    canonicalModel:
      strongDataForSeoIdentity,

    resolutionMode
  };


  console.log(
    "[DATAFORSEO GATE] Exact lens identity accepted:",
    {
      productId:
        product?.productId,

      canonicalModel:
        strongDataForSeoIdentity,

      confidence:
        actualConfidence,

      consensus:
        actualConsensus,

      resolutionMode
    }
  );


  /*
    This identity is final for this pass.
    Do NOT send it through Lensfun again.
  */
  needsGoogleLens =
    needsGoogleLens.filter(
      item =>
        String(
          item?.productId ||
          ""
        ).trim() !==
        String(
          product?.productId ||
          ""
        ).trim()
    );


  continue;
}

/*
  ============================================================
  SECOND PASS

  Lensfun was already executed before DataForSEO.

  The weak-result candidate constraint / baseline restoration
  has already happened above.

  Do NOT query Lensfun again.
  ============================================================
*/
if (isPostDataForSeoPass) {
  continue;
}

  try {
    const resolution =
      await resolveCanonicalLens({
        product,

        productOcrResults,

        listingTitle,

        listingDescription,

        listingScreenshotOcr,

        explicitFacts,

        cameraContext
      });

      const resolvedProductId =
  String(
    product?.productId ||
    ""
  ).trim();


if (
  resolvedProductId &&
  Array.isArray(
    resolution?.candidates
  )
) {
  lensfunCandidatesByProductId.set(
    resolvedProductId,

    resolution.candidates.map(
      candidate => ({
        candidateId:
          String(
            candidate
              ?.candidateId ||
            ""
          ).trim(),

        maker:
          String(
            candidate
              ?.maker ||
            ""
          ).trim(),

        model:
          String(
            candidate
              ?.model ||
            ""
          ).trim(),

        mount:
          String(
            candidate
              ?.mount ||
            ""
          ).trim()
      })
    )
  );
}


    console.log(
      "[LENS RESOLVER] Complete:",
      {
        productId:
          product?.productId,

        mode:
          resolution?.mode,

        identity:
          resolution?.identity
      }
    );


    if (
      resolution?.identity
    ) {
      /*
        Overwrite Step-5's provisional evidence identity
        with the canonical dedicated-resolver identity.
      */
      product.lensIdentity =
        resolution.identity;


      /*
        This lens no longer needs the old
        Serper Images fallback.
      */
      needsGoogleLens =
        needsGoogleLens.filter(
          item =>
            String(
              item?.productId || ""
            ).trim() !==
            String(
              product?.productId || ""
            ).trim()
        );
    } else {
      /*
        Dedicated resolution failed.

        Keep it eligible for the existing
        visual Serper fallback as a final safety net.
      */
      const alreadyQueued =
        needsGoogleLens.some(
          item =>
            String(
              item?.productId || ""
            ).trim() ===
            String(
              product?.productId || ""
            ).trim()
        );


      if (!alreadyQueued) {
        needsGoogleLens.push({
          galleryIndex:
            Number(
              product?.galleryIndex
            ) || 1,

          productId:
            String(
              product?.productId || ""
            ).trim(),

         reason:
  "OCR/Lensfun resolution could not establish a canonical lens identity, so Google Lens identification is required."
        });
      }
    }

  } catch (error) {
    console.warn(
      "[LENS RESOLVER] Failed:",
      {
        productId:
          product?.productId,

        error:
          error?.message ||
          String(error)
      }
    );


    /*
      Don't crash the entire Marketplace analysis.
      Existing visual Serper fallback can still try.
    */
    const alreadyQueued =
      needsGoogleLens.some(
        item =>
          String(
            item?.productId || ""
          ).trim() ===
          String(
            product?.productId || ""
          ).trim()
      );


    if (!alreadyQueued) {
      needsGoogleLens.push({
        galleryIndex:
          Number(
            product?.galleryIndex
          ) || 1,

        productId:
          String(
            product?.productId || ""
          ).trim(),

        reason:
          "Dedicated lens resolver failed and visual fallback is required."
      });
    }
  }
}

/*
  ============================================================
  REMOVE ALREADY-ATTEMPTED VISUAL FALLBACKS

  DataForSEO is the final visual-search attempt for this run.
  If it did not establish an exact model, preserve the unresolved
  product instead of requesting DataForSEO again.
  ============================================================
*/

needsGoogleLens =
  needsGoogleLens.filter(
    item =>
      !wasVisualFallbackAttemptedForProduct(
        item?.productId
      )
  );

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
            Camera lenses use structured identity.
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
            Cameras, flashes, etc.
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

  needsGoogleLens,

  lensfunCandidateConstraints:
    Array.from(
      lensfunCandidatesByProductId
        .entries()
    ).map(
      (
        [
          productId,
          candidates
        ]
      ) => ({
        productId,

        candidates:
          candidates.map(
            candidate => ({
              candidateId:
                candidate.candidateId,

              maker:
                candidate.maker,

              model:
                candidate.model,

              mount:
                candidate.mount
            })
          )
      })
    )
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

function hasEnoughIdentityForEbaySearch(
  item
) {
if (
  item?.exactIdentityResolved ===
  false
) {
  return false;
}

  const brand =
    String(
      item?.brand || ""
    ).trim();

  const model =
    String(
      item?.model || ""
    ).trim();

  const productType =
    String(
      item?.productType || ""
    ).trim();


  return Boolean(
    brand &&
    model &&
    productType
  );
}
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

  /*
    ============================================================
    GOOGLE SHEETS APPEND PREPARATION
    ============================================================

    ORDER MATTERS:

    1. Clear any active basic column filter.
    2. Later determine the next row.
    3. If the sheet is physically out of rows, add rows.
    4. Write the hit.
  */

  let sheetRowCount =
    Number(
      sheet.properties?.gridProperties?.rowCount ||
      0
    );

  /*
    A normal Google Sheets column filter, like the green
    filter icon shown in the screenshot, is represented
    by sheet.basicFilter.

    Remove it BEFORE calculating/writing the new hit rows.
  */
  if (sheet.basicFilter) {
    console.log(
      "[GOOGLE SHEETS] Active column filter detected. Clearing before hit append."
    );

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,

      requestBody: {
        requests: [
          {
            clearBasicFilter: {
              sheetId
            }
          }
        ]
      }
    });

    console.log(
      "[GOOGLE SHEETS] Column filter cleared."
    );
  }

  const primaryItems = Array.isArray(deal.items) && deal.items.length
    ? deal.items.filter(item => item?.isPrimarySellableItem !== false)
    : [];

  const rowItems =
  primaryItems.length
    ? primaryItems
    : [deal];

const listingRowCount =
  rowItems.length;

/*
  True when this is the normal multi-product / itemized
  lot-result format.

  Listing-level resale/std-dev values must NEVER be used
  as fallback values for individual rows in this case.
*/
const hasItemizedRows =
  Array.isArray(
    deal.items
  ) &&
  deal.items.length >
    0;

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


const checklistUrl =
  String(
    deal.checklistUrl ||
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

    const checklistLink =
  index === 0 &&
  checklistUrl
    ? (
        `=HYPERLINK("${checklistUrl}","Checklist")`
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
      /*
      ============================================================
      ITEM-LEVEL ANALYTICAL VALUES
      ============================================================

      An excluded/invalid comp is still a real primary product,
      so we keep its row in the Sheet.

      However, it must NOT inherit the resale value or standard
      deviation from another valid item in the listing.
    */

    const itemIsExcluded =
      String(
        item.status ||
        ""
      )
        .trim()
        .toLowerCase() ===
      "excluded";


    let estimatedResale =
      "";

    let priceStdDev =
      "";


    if (!itemIsExcluded) {
      /*
        Prefer the value that /evaluate-lot explicitly
        approved for inclusion.

        Then use this item's own analytical values.

        Only fall back to deal-level values for the old
        non-itemized single-product format.
      */
      estimatedResale =
        item.includedExpectedSalePrice ??
        itemResult.expectedSalePrice ??
        itemResult.estimatedResaleValue ??
        item.estimatedResaleValue ??
        (
          !hasItemizedRows
            ? deal.estimatedResaleValue
            : null
        ) ??
        "";


      priceStdDev =
        itemResult.priceStandardDeviation ??
        item.priceStandardDeviation ??
        (
          !hasItemizedRows
            ? deal.priceStandardDeviation
            : null
        ) ??
        "";
    }

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
  checklistColumnM, // M — Purchase Checklist
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


/*
  ============================================================
  MAKE SURE THE SHEET HAS ENOUGH PHYSICAL ROWS
  ============================================================

  This happens AFTER the filter has been cleared.

  Example:

  Sheet currently contains rows 1-1119.
  New listing requires rows 1120-1121.

  sheetRowCount = 1119
  insertedEndRowNumber = 1121

  Therefore add 2 new rows before trying to write.
*/
if (
  insertedEndRowNumber >
  sheetRowCount
) {
  const rowsToAdd =
    insertedEndRowNumber -
    sheetRowCount;

  console.log(
    "[GOOGLE SHEETS] Sheet is out of rows. Adding rows:",
    {
      currentRowCount:
        sheetRowCount,

      requiredEndRow:
        insertedEndRowNumber,

      rowsToAdd
    }
  );

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,

    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,

              dimension:
                "ROWS",

              /*
                Google Sheets API indexes are zero-based.

                sheetRowCount is therefore exactly the
                insertion point immediately after the
                existing final row.
              */
              startIndex:
                sheetRowCount,

              endIndex:
                sheetRowCount +
                rowsToAdd
            },

            /*
              Preserve formatting/data-validation behavior
              from the previous bottom row.
            */
            inheritFromBefore:
              true
          }
        }
      ]
    }
  });

  sheetRowCount +=
    rowsToAdd;

  console.log(
    "[GOOGLE SHEETS] Rows added successfully. New row count:",
    sheetRowCount
  );
}


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

/*
  Clear J:L.

  Column I = Analysis Log
  Column M = Purchase Checklist
*/

requests.push({
  repeatCell: {
    range: {
      sheetId,
      startRowIndex,
      endRowIndex,

      startColumnIndex:
        9,

      endColumnIndex:
        12
    },

    cell: {
      userEnteredValue:
        null
    },

    fields:
      "userEnteredValue"
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
  Create/recover a persistent purchase checklist.

  Same Facebook listing = same checklist.
*/

const checklist =
  await createOrGetDealChecklist({
    deal,
    analysisRunId
  });


console.log(
  "[DEAL CHECKLIST] Ready:",
  {
    analysisRunId,

    checklistUrl:
      checklist.url
  }
);


/*
  Attach both permanent URLs
  before writing the Google Sheet.
*/

const dealWithLog = {
  ...deal,

  analysisRunId,

  analysisLogUrl:
    uploadedLog.publicUrl,

  checklistUrl:
    checklist.url
};


await appendSavedDealToGoogleSheet(
  dealWithLog
);


return res.json({
  ok:
    true,

  analysisLogUrl:
    uploadedLog.publicUrl,

  checklistUrl:
    checklist.url
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

function mean(numbers) {
  const values =
    numbers
      .map(Number)
      .filter(
        Number.isFinite
      );


  if (!values.length) {
    return null;
  }


  return Number(
    (
      values.reduce(
        (
          sum,
          value
        ) =>
          sum + value,
        0
      ) /
      values.length
    ).toFixed(2)
  );
}


function percentile(
  numbers,
  percentileValue
) {
  const values =
    numbers
      .map(Number)
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );


  if (!values.length) {
    return null;
  }


  if (
    values.length === 1
  ) {
    return Number(
      values[0].toFixed(2)
    );
  }


  const position =
    (
      percentileValue /
      100
    ) *
    (
      values.length -
      1
    );


  const lower =
    Math.floor(
      position
    );

  const upper =
    Math.ceil(
      position
    );

  const weight =
    position -
    lower;


  const value =
    values[lower] *
      (1 - weight) +
    values[upper] *
      weight;


  return Number(
    value.toFixed(2)
  );
}


function coefficientOfVariation(
  numbers
) {
  const avg =
    mean(numbers);

  const std =
    standardDeviation(
      numbers
    );


  if (
    avg == null ||
    std == null ||
    avg === 0
  ) {
    return null;
  }


  return Number(
    (
      std /
      avg
    ).toFixed(6)
  );
}


function medianOfCheapestFraction(
  numbers,
  fraction
) {
  const sorted =
    numbers
      .map(Number)
      .filter(
        Number.isFinite
      )
      .sort(
        (a, b) =>
          a - b
      );


  if (!sorted.length) {
    return null;
  }


  const count =
    Math.max(
      1,

      Math.ceil(
        sorted.length *
        fraction
      )
    );


  return median(
    sorted.slice(
      0,
      count
    )
  );
}

function calculatePriceFeatures(
  listings
) {
  const prices =
    listings
      .map(
        listing =>
          Number(
            listing.price
          )
      )
      .filter(
        price =>
          Number.isFinite(
            price
          ) &&
          price > 0
      );


  if (!prices.length) {
    return {
      count: 0
    };
  }


  const p25 =
    percentile(
      prices,
      25
    );

  const p75 =
    percentile(
      prices,
      75
    );


  return {
    count:
      prices.length,

    mean:
      mean(prices),

    median:
      median(prices),

    p10:
      percentile(
        prices,
        10
      ),

    p20:
      percentile(
        prices,
        20
      ),

    p25,

    p30:
      percentile(
        prices,
        30
      ),

    p40:
      percentile(
        prices,
        40
      ),

    p75,

    p90:
      percentile(
        prices,
        90
      ),

    stdDev:
      standardDeviation(
        prices
      ),

    cv:
      coefficientOfVariation(
        prices
      ),

    iqr:
      (
        p25 != null &&
        p75 != null
      )
        ? Number(
            (
              p75 -
              p25
            ).toFixed(2)
          )
        : null,

    low:
      Math.min(
        ...prices
      ),

    high:
      Math.max(
        ...prices
      ),

    cheapest20Median:
      medianOfCheapestFraction(
        prices,
        0.20
      ),

    cheapest30Median:
      medianOfCheapestFraction(
        prices,
        0.30
      )
  };
}

async function saveEbayTrainingData({
  analysisRunId,

  target,

  soldValidListings,

  soldMedian,
  soldStdDev,
  expectedSalePrice,

  activeSearch,
  validActiveListings
}) {
  const activeFeatures =
    calculatePriceFeatures(
      validActiveListings
    );


  const soldFeatures =
    calculatePriceFeatures(
      soldValidListings
    );


  const activeMedian =
    activeFeatures
      .median;


  const soldToActiveMedianRatio =
    (
      expectedSalePrice != null &&
      activeMedian != null &&
      activeMedian > 0
    )
      ? Number(
          (
            Number(
              expectedSalePrice
            ) /
            activeMedian
          ).toFixed(6)
        )
      : null;


  /*
    This doesn't discard weak observations.
    It merely marks which records have a strong
    enough sold-side target to eventually train on.
  */
  const trainingEligible =
    (
      soldValidListings
        .length >= 7 &&
      expectedSalePrice != null &&
      validActiveListings
        .length >= 5
    );


  const canonicalName =
    getCanonicalNameForItem(
      target
    );


  const {
    error
  } =
    await supabaseAdmin
      .from(
        "ebay_active_training_data"
      )
      .insert({
        analysis_run_id:
          analysisRunId ||
          null,

        canonical_name:
          canonicalName ||
          null,

        ebay_search_query:
          String(
            target
              ?.ebaySearchQuery ||
            ""
          ).trim(),

        condition:
          String(
            target
              ?.condition ||
            ""
          ).trim(),

        product_type:
          String(
            target
              ?.productType ||
            ""
          ).trim(),

        brand:
          String(
            target
              ?.brand ||
            ""
          ).trim(),

        model:
          String(
            target
              ?.model ||
            ""
          ).trim(),

        negative_search_terms:
          normalizeTrainingNegativeTerms(
            target
              ?.negativeSearchTerms
          ),


        /*
          SOLD
        */
        sold_valid_count:
          soldValidListings
            .length,

        sold_median:
          soldMedian,

        sold_mean:
          soldFeatures.mean,

        sold_std_dev:
          soldStdDev,

        sold_cv:
          soldFeatures.cv,

        sold_p25:
          soldFeatures.p25,

        sold_p75:
          soldFeatures.p75,

        sold_low:
          soldFeatures.low,

        sold_high:
          soldFeatures.high,

        expected_sale_price:
          expectedSalePrice,


        /*
          ACTIVE
        */
        active_raw_count:
          activeSearch
            .rawCount,

        active_valid_count:
          validActiveListings
            .length,

        active_mean:
          activeFeatures.mean,

        active_median:
          activeFeatures.median,

        active_p10:
          activeFeatures.p10,

        active_p20:
          activeFeatures.p20,

        active_p25:
          activeFeatures.p25,

        active_p30:
          activeFeatures.p30,

        active_p40:
          activeFeatures.p40,

        active_p75:
          activeFeatures.p75,

        active_p90:
          activeFeatures.p90,

        active_std_dev:
          activeFeatures.stdDev,

        active_cv:
          activeFeatures.cv,

        active_iqr:
          activeFeatures.iqr,

        active_low:
          activeFeatures.low,

        active_high:
          activeFeatures.high,

        active_cheapest_20_median:
          activeFeatures
            .cheapest20Median,

        active_cheapest_30_median:
          activeFeatures
            .cheapest30Median,

        sold_to_active_median_ratio:
          soldToActiveMedianRatio,

        training_eligible:
          trainingEligible,

        active_api_total:
          activeSearch
            .apiTotal,

        active_valid_listings:
          validActiveListings,

        sold_valid_listings:
          soldValidListings
      });


  if (error) {
    throw new Error(
      `Could not save eBay training data: ${
        error.message ||
        String(error)
      }`
    );
  }


  console.log(
    "[EBAY TRAINING] Saved:",
    {
      canonicalName,

      soldCount:
        soldValidListings
          .length,

      soldEstimate:
        expectedSalePrice,

      activeCount:
        validActiveListings
          .length,

      activeMedian:
        activeFeatures
          .median,

      ratio:
        soldToActiveMedianRatio,

      trainingEligible
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

async function aiCleanComps({
  target,
  comps,
  compMode = "sold"
}) {

  const isActive =
  compMode ===
  "active";

const compLabel =
  isActive
    ? "active listings"
    : "sold listings";

  if (!comps.length) {
    return {
      validIndexes: [],
      invalidComps: []
    };
  }

const compListText =
  comps
    .map(
      (
        comp,
        index
      ) => {
        return (
          `${index + 1}. ` +
          `${comp.title} | ` +
          `$${comp.price}`
        );
      }
    )
    .join("\n");

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
You are cleaning eBay ${compLabel} for a reseller.

Target product:
Brand: ${target.brand || ""}
Model: ${target.model || ""}
Product type: ${target.productType || ""}
Condition: already filtered by eBay search; ignore condition during cleanup.
Search query: ${target.ebaySearchQuery || ""}

Candidate ${compLabel}:
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

function makeDealDecision({
  expectedSalePrice,
  facebookPrice,
  validCompCount,
  valuationLabel =
    "comp-based resale estimate"
}) {
  if (
    !expectedSalePrice ||
    !facebookPrice ||
    !validCompCount
  ) {
    return {
      recommendation:
        "Pass",

      reason:
        "Not enough valid data to calculate a deal."
    };
  }


  const targetProfit =
    85;

  const negotiatedPrice15 =
    Number(
      (
        facebookPrice *
        0.85
      ).toFixed(
        2
      )
    );


  const marginAtAsk =
    Number(
      (
        expectedSalePrice -
        facebookPrice
      ).toFixed(
        2
      )
    );


  const marginAt15 =
    Number(
      (
        expectedSalePrice -
        negotiatedPrice15
      ).toFixed(
        2
      )
    );


  if (
    marginAtAsk >=
    targetProfit
  ) {
    return {
      recommendation:
        "Buy Now",

      reason:
        `Meets target using ${valuationLabel}: ` +
        `${validCompCount} valid comps and ` +
        `$${marginAtAsk} spread at asking price.`
    };
  }


  if (
    marginAt15 >=
    targetProfit
  ) {
    return {
      recommendation:
        "Negotiate",

      reason:
        `Using ${valuationLabel}, the listing reaches ` +
        `$${marginAt15} spread at 15% below ask.`
    };
  }


  return {
    recommendation:
      "Pass",

    reason:
      `Using ${valuationLabel}, this does not meet the $85 spread target.`
  };
}

/*
  ============================================================
  EBAY OFFICIAL API — ACTIVE LISTING TRAINING DATA
  ============================================================
*/

const EBAY_CLIENT_ID =
  String(
    process.env.EBAY_CLIENT_ID ||
    ""
  ).trim();

const EBAY_CLIENT_SECRET =
  String(
    process.env.EBAY_CLIENT_SECRET ||
    ""
  ).trim();


let ebayApplicationToken = null;
let ebayApplicationTokenExpiresAt = 0;


async function getEbayApplicationToken() {
  /*
    Re-use the existing token until shortly before
    expiration instead of requesting one for every search.
  */
  if (
    ebayApplicationToken &&
    Date.now() <
      ebayApplicationTokenExpiresAt -
        60 * 1000
  ) {
    return ebayApplicationToken;
  }


  if (
    !EBAY_CLIENT_ID ||
    !EBAY_CLIENT_SECRET
  ) {
    throw new Error(
      "Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET."
    );
  }


  const basicAuth =
    Buffer
      .from(
        `${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`
      )
      .toString("base64");


  const response =
    await fetch(
      "https://api.ebay.com/identity/v1/oauth2/token",
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Basic ${basicAuth}`,

          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        body:
          new URLSearchParams({
            grant_type:
              "client_credentials",

            scope:
              "https://api.ebay.com/oauth/api_scope"
          })
      }
    );


  const data =
    await response.json();


  if (
    !response.ok ||
    !data?.access_token
  ) {
    throw new Error(
      `Could not get eBay application token: ${
        JSON.stringify(data)
      }`
    );
  }


  ebayApplicationToken =
    data.access_token;

  ebayApplicationTokenExpiresAt =
    Date.now() +
    Number(
      data.expires_in || 7200
    ) * 1000;


  return ebayApplicationToken;
}

function normalizeConditionForEbayApi(
  condition
) {
  const c =
    String(
      condition || ""
    ).toLowerCase();


  if (
    c.includes(
      "open box"
    )
  ) {
    return "1500";
  }


  if (
    c.includes(
      "new"
    )
  ) {
    return "1000";
  }


  if (
    c.includes("parts") ||
    c.includes("repair")
  ) {
    return "7000";
  }


  if (
    c.includes(
      "used"
    )
  ) {
    return "3000";
  }


  return "3000";
}

function normalizeTrainingNegativeTerms(
  terms
) {
  if (
    !Array.isArray(
      terms
    )
  ) {
    return [];
  }


  return [
    ...new Set(
      terms
        .map(term =>
          String(
            term || ""
          ).trim()
        )
        .filter(Boolean)
    )
  ];
}


function buildEbayApiTrainingQuery(
  query,
  negativeSearchTerms = []
) {
  const cleanQuery =
    String(
      query || ""
    ).trim();


  const negatives =
    normalizeTrainingNegativeTerms(
      negativeSearchTerms
    )
      .map(term => {
        /*
          Same basic syntax as your browser search.
        */
        if (
          /\s/.test(term)
        ) {
          return `-"${term.replaceAll(
            '"',
            ""
          )}"`;
        }

        return `-${term}`;
      });


  return [
    cleanQuery,
    ...negatives
  ]
    .filter(Boolean)
    .join(" ");
}

async function searchEbayActiveListings({
  query,
  condition,
  negativeSearchTerms = []
}) {
  const token =
    await getEbayApplicationToken();


const finalQuery =
  buildEbayApiTrainingQuery(
    query,
    negativeSearchTerms
  );


  const conditionId =
    normalizeConditionForEbayApi(
      condition
    );


  const params =
    new URLSearchParams();

  params.set(
    "q",
    finalQuery
  );

  /*
    Pull a fairly large sample.

    One search call can return many listings, so there
    is no reason to train on only 10 results.
  */
  params.set(
    "limit",
    "100"
  );

  params.set(
    "filter",
    `conditionIds:{${conditionId}}`
  );


  const url =
    "https://api.ebay.com/buy/browse/v1/item_summary/search?" +
    params.toString();


  console.log(
    "[EBAY ACTIVE TRAINING] Searching:",
    {
      query,
      finalQuery,
      condition,
      conditionId
    }
  );


  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${token}`,

          "X-EBAY-C-MARKETPLACE-ID":
            "EBAY_US"
        }
      }
    );


  const data =
    await response.json();


  if (!response.ok) {
    throw new Error(
      `eBay Browse API failed ${response.status}: ${
        JSON.stringify(data)
      }`
    );
  }


  const rawItems =
    Array.isArray(
      data.itemSummaries
    )
      ? data.itemSummaries
      : [];


  const listings =
    rawItems
      .map(item => {
        const price =
          Number(
            item?.price?.value
          );


        return {
          title:
            String(
              item?.title ||
              ""
            ).trim(),

          price:
            Number.isFinite(price)
              ? price
              : null,

          currency:
            item?.price?.currency ||
            "USD",

          condition:
            item?.condition ||
            "",

          conditionId:
            item?.conditionId ||
            "",

          itemId:
            item?.itemId ||
            "",

          url:
            item?.itemWebUrl ||
            "",

          buyingOptions:
            Array.isArray(
              item?.buyingOptions
            )
              ? item.buyingOptions
              : [],

          seller:
            item?.seller ||
            null,

          itemEndDate:
            item?.itemEndDate ||
            null
        };
      })
      /*
        A live auction's current bid is NOT equivalent
        to an asking/listed price.

        Keep fixed-price and Best Offer inventory.
      */
      .filter(item => {
        const options =
          new Set(
            item.buyingOptions
          );


        return (
          options.has(
            "FIXED_PRICE"
          ) ||
          options.has(
            "BEST_OFFER"
          )
        );
      })
      .filter(item =>
        Number.isFinite(
          item.price
        ) &&
        item.price > 0
      );


  console.log(
    "[EBAY ACTIVE TRAINING] Results:",
    {
      apiTotal:
        Number(
          data.total || 0
        ),

      returned:
        rawItems.length,

      usablePriceListings:
        listings.length
    }
  );


  return {
    query:
      finalQuery,

    apiTotal:
      Number(
        data.total || 0
      ),

    rawCount:
      rawItems.length,

    listings
  };
}

app.post(
  "/evaluate-active-comps",
  async (
    req,
    res
  ) => {
    try {
      const target =
        req.body?.target ||
        {};

      /*
        Same hard identity gate as sold comps.
      */
      if (
        !hasEnoughIdentityForEbaySearch(
          target
        )
      ) {
        return res.json({
          ok:
            true,

          skipped:
            true,

          source:
            "active-p15",

          expectedSalePrice:
            null,

          activeP15:
            null,

          validActiveCount:
            0,

          validSoldCount:
            0,

          medianSoldPrice:
            null,

          reason:
            "Product was not identified specifically enough for an eBay search."
        });
      }


      const facebookPrice =
        target.facebookPrice;


      /*
        Start with any existing exclusions.
      */
      let negativeSearchTerms =
        normalizeTrainingNegativeTerms(
          target
            .negativeSearchTerms ||
          []
        );


      let activeSearch =
        null;

      let activeCleanup =
        null;

      let validActiveListings =
        [];


      /*
        Maximum two attempts:
          1. normal query
          2. pollution-cleaned query
      */
      for (
        let attempt = 0;
        attempt < 2;
        attempt += 1
      ) {
        activeSearch =
          await searchEbayActiveListings({
            query:
              target
                .ebaySearchQuery,

            condition:
              target.condition,

            negativeSearchTerms
          });


        activeCleanup =
          await aiCleanComps({
            target,

            comps:
              activeSearch
                .listings,

            compMode:
              "active"
          });


        const validIndexes =
          Array.isArray(
            activeCleanup
              ?.validIndexes
          )
            ? activeCleanup
                .validIndexes
            : [];


        validActiveListings =
          validIndexes
            .map(Number)
            .map(
              index =>
                activeSearch
                  .listings[
                    index - 1
                  ]
            )
            .filter(Boolean)
            .filter(
              listing =>
                Number.isFinite(
                  Number(
                    listing.price
                  )
                ) &&
                Number(
                  listing.price
                ) > 0
            );


        const rerunTerms =
          Array.isArray(
            activeCleanup
              ?.searchPollution
              ?.negativeSearchTerms
          )
            ? activeCleanup
                .searchPollution
                .negativeSearchTerms
            : [];


        const shouldRerun =
          attempt === 0 &&
          activeCleanup
            ?.searchPollution
            ?.rerunRecommended ===
            true &&
          rerunTerms.length > 0;


        if (
          !shouldRerun
        ) {
          break;
        }


        negativeSearchTerms =
          normalizeTrainingNegativeTerms([
            ...negativeSearchTerms,
            ...rerunTerms
          ]);


        console.log(
          "[ACTIVE EBAY] Rerunning polluted search with exclusions:",
          negativeSearchTerms
        );
      }


      const activePrices =
        validActiveListings
          .map(
            listing =>
              Number(
                listing.price
              )
          )
          .filter(
            price =>
              Number.isFinite(
                price
              ) &&
              price > 0
          );


      const validActiveCount =
        activePrices.length;

      const minimumValidActiveListings =
        7;


      /*
        New production estimator.

        Dataset testing showed approximately
        9.6% MAPE using direct active-market P15.
      */
      const activeP15 =
        percentile(
          activePrices,
          15
        );


      const priceStandardDeviation =
        standardDeviation(
          activePrices
        );


      if (
        validActiveCount <
          minimumValidActiveListings ||
        activeP15 == null
      ) {
        return res.json({
          source:
            "active-p15",

          targetProduct:
            `${target.brand || ""} ${target.model || ""} ${target.productType || ""}`
              .trim(),

          condition:
            target.condition,

          facebookPrice,

          validActiveCount,

          validSoldCount:
            0,

          medianSoldPrice:
            null,

          activeP15,

          expectedSalePrice:
            null,

          priceStandardDeviation,

          recommendation:
            "Pass",

          reason:
            `Only ${validActiveCount} reliable active eBay comp(s) remained after cleanup. Minimum required is ${minimumValidActiveListings}.`,

          validComps:
            validActiveListings
              .slice(
                0,
                20
              ),

          searchPollution:
            activeCleanup
              ?.searchPollution ||
            null,

          negativeSearchTerms
        });
      }


      /*
        Direct P15.

        No additional multiplier.
      */
      const expectedSalePrice =
        Number(
          activeP15.toFixed(
            2
          )
        );


      const maxBuyPrice =
        Number(
          (
            expectedSalePrice -
            85
          ).toFixed(
            2
          )
        );


      const negotiatedPrice15 =
        facebookPrice
          ? Number(
              (
                facebookPrice *
                0.85
              ).toFixed(
                2
              )
            )
          : null;


      const decision =
        makeDealDecision({
          expectedSalePrice,

          facebookPrice,

          validCompCount:
            validActiveCount,

          valuationLabel:
            "active-listing 15th percentile"
        });


      /*
        PRODUCTION MODE ONLY reaches this endpoint.

        Save/update this newly learned resale value
        in the global product database.
      */
      await saveProductToDatabase({
        item:
          target,

        estimatedResalePrice:
          expectedSalePrice
      });


      return res.json({
        source:
          "active-p15",

        targetProduct:
          `${target.brand || ""} ${target.model || ""} ${target.productType || ""}`
            .trim(),

        condition:
          target.condition,

        facebookPrice,

        validActiveCount,

        /*
          Compatibility with existing UI/context.
        */
        validSoldCount:
          0,

        medianSoldPrice:
          null,

        activeP15,

        expectedSalePrice,

        priceStandardDeviation,

        lowPrice:
          activePrices.length
            ? Math.min(
                ...activePrices
              )
            : null,

        highPrice:
          activePrices.length
            ? Math.max(
                ...activePrices
              )
            : null,

        maxBuyPrice,

        negotiatedPrice15,

        recommendation:
          decision.recommendation,

        reason:
          decision.reason,

        validComps:
          validActiveListings
            .slice(
              0,
              20
            ),

        searchPollution:
          activeCleanup
            ?.searchPollution ||
          null,

        negativeSearchTerms
      });

    } catch (error) {
      console.error(
        "[ACTIVE EBAY] Evaluation failed:",
        error
      );

      return sendServerError(
        res,
        error,
        "Could not evaluate active eBay comps."
      );
    }
  }
);

app.post("/evaluate-comps", async (req, res) => {
  try {
    const {
      target,
      listings = []
    } = req.body;


    /*
      HARD SAFETY CHECK

      Never evaluate or run downstream eBay logic for
      a product that lacks a specific identity.
    */
    if (
      !hasEnoughIdentityForEbaySearch(
        target
      )
    ) {
      console.warn(
        "[EBAY] Skipping insufficiently identified product:",
        {
          productId:
            target?.productId ||
            null,

          brand:
            target?.brand ||
            null,

          model:
            target?.model ||
            null,

          productType:
            target?.productType ||
            null
        }
      );


      return res.json({
        ok:
          true,

        skipped:
          true,

        reason:
          "Product was not identified specifically enough for an eBay search.",

        expectedSalePrice:
          null,

        estimatedResaleValue:
          null,

        median:
          null,

        priceStandardDeviation:
          null,

        validSoldCount:
          0,

        searchPollution: {
          pollutedByRelatedModels:
            false,

          validExactModelCount:
            0,

          relatedWrongModelCount:
            0,

          rerunRecommended:
            false,

          negativeSearchTerms:
            [],

          reason:
            ""
        }
      });
    }


    const facebookPrice =
      target.facebookPrice;


    console.log(
      "Received eBay listings:",
      listings.length
    );

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

    /*
  ============================================================
  ACTIVE EBAY TRAINING COLLECTION

  Only collect/save the FINAL search variant.

  If the sold search is about to be rerun because of
  related-model pollution, that rerun will come back through
  /evaluate-comps again with the improved negative terms.
  ============================================================
*/

if (
  !searchPollution
    .rerunRecommended
) {
  try {
    const activeSearch =
      await searchEbayActiveListings({
        query:
          target
            .ebaySearchQuery,

        condition:
          target
            .condition,

        negativeSearchTerms:
          target
            .negativeSearchTerms ||
          []
      });


    const activeCleanup =
      await aiCleanComps({
        target,

        comps:
          activeSearch
            .listings,

        compMode:
          "active"
      });


    const activeValidIndexes =
      Array.isArray(
        activeCleanup
          .validIndexes
      )
        ? activeCleanup
            .validIndexes
        : [];


    const validActiveListings =
      activeValidIndexes
        .map(Number)
        .map(
          index =>
            activeSearch
              .listings[
                index - 1
            ]
        )
        .filter(Boolean)
        .filter(
          listing =>
            Number.isFinite(
              Number(
                listing.price
              )
            )
        );


    await saveEbayTrainingData({
      analysisRunId:
        String(
          req.get(
            "X-Analysis-Run-Id"
          ) ||
          ""
        ).trim(),

      target,

      soldValidListings:
        medianEligibleComps,

      soldMedian:
        medianSoldPrice,

      soldStdDev:
        priceStandardDeviation,

      expectedSalePrice,

      activeSearch,

      validActiveListings
    });


  } catch (error) {
    /*
      TRAINING COLLECTION MUST NEVER BREAK
      THE REAL SCANNER.
    */
    console.error(
      "[EBAY TRAINING] Collection failed:",
      error
    );
  }
}

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

const decision =
  makeDealDecision({
    expectedSalePrice,

    facebookPrice,

    validCompCount:
      validSoldCount,

    valuationLabel:
      "median sold price"
  });

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
        `Using the estimated resale values, the lot clears the ` +
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
        `Using the estimated resale values, the lot does not clear the ` +
        `$85 target at asking price, but it reaches a ` +
        `$${profitAt15} estimated profit at 15% below ask.`,
      scamFlag: false,
      resaleToAskRatio
    };
  }

  return {
    recommendation: "Pass",
    reason:
      `Using the estimated resale values, even buying 15% below asking ` +
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
const median =
  result.medianSoldPrice;

const expectedSalePrice =
  result.expectedSalePrice ??
  null;

const validSoldCount =
  Number(
    result.validSoldCount ||
    0
  );

const validActiveCount =
  Number(
    result.validActiveCount ||
    0
  );

const minimumReliableComps =
  7;

const fromDatabase =
  result.source ===
  "database";

const fromActiveP15 =
  result.source ===
  "active-p15";

const fromSoldComps =
  !fromDatabase &&
  !fromActiveP15;


const include =
  expectedSalePrice != null &&
  (
    fromDatabase ||

    (
      fromActiveP15 &&
      validActiveCount >=
        minimumReliableComps
    ) ||

    (
      fromSoldComps &&
      median != null &&
      validSoldCount >=
        minimumReliableComps
    )
  );

  return {
    ...item,

validActiveCount,

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
      : fromActiveP15
        ? "Included from active P15"
        : "Included from sold comps"
    : "Excluded",

reason:
  include
    ? fromDatabase
      ? "Included using stored global product resale value."
      : fromActiveP15
        ? "Included using the 15th percentile of cleaned active eBay listings."
        : "Included using valid sold comps."
    : "Excluded because no reliable resale estimate was available."
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
- Make clear that I will pay the seller before they ship the item.
- Make clear that I will also cover the shipping cost.
- Phrase the payment point casually and naturally, such as "I can pay upfront", "I can pay before you ship it", or equivalent wording.
- Do not imply that the seller needs to ship before receiving payment.
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

loadLensfunDatabase();

app.listen(3000, () => {
  console.log(
    "AI comp server running at http://localhost:3000"
  );
});