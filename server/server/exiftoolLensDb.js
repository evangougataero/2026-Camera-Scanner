/*
  ============================================================
  EXIFTOOL LENS DATABASE (parallel to Lensfun)

  ExifTool ships its lens knowledge inside its Perl modules as
  big lookup hashes, e.g.

    Image/ExifTool/Nikon.pm   %nikonLensIDs
    Image/ExifTool/Canon.pm   %canonLensTypes
    Image/ExifTool/Sony.pm    %sonyLensTypes
    ...

  This module reads those hashes straight out of the .pm files
  at startup (no perl process, no exiftool process, no per-scan
  cost) and exposes them as plain candidate objects with the
  SAME shape as the Lensfun candidates:

    { candidateId, maker, model, mount, sourceFile, score }

  plus a few extra fields (sources, exiftoolIds, ...).

  Public API:
    loadExifToolLensDatabase()
    findExifToolLensCandidates(evidence)
    mergeLensCandidateSources({ lensfunCandidates, exifToolCandidates })

  Where to find the ExifTool .pm files (first hit wins):
    1. env EXIFTOOL_LIB_DIR  (folder that CONTAINS Nikon.pm)
    2. ./data/exiftool/ExifTool
    3. ./node_modules/exiftool-vendored.pl/bin/lib/Image/ExifTool
    4. ./node_modules/exiftool-vendored.pl/bin/Image/ExifTool
    5. `perl -MImage::ExifTool` (a system-installed ExifTool)
  ============================================================
*/

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let exifToolLensRecords = [];

/*
  Per-module defaults used when a ExifTool lens name does not
  start with a manufacturer ("AF-S Nikkor 50mm f/1.8G") and for
  a mount hint. Mount hints are only a LAST resort - the lens
  name itself ("EF-S", "RF") wins when it states a mount.
*/
const MODULE_DEFAULTS = {
  "Nikon.pm": { maker: "Nikon", mountHint: "Nikon F" },
  "Canon.pm": { maker: "Canon", mountHint: "Canon EF" },
  "Sony.pm": { maker: "Sony", mountHint: null },
  "Minolta.pm": { maker: "Minolta", mountHint: null },
  "Pentax.pm": { maker: "Pentax", mountHint: "Pentax K" },
  "Olympus.pm": { maker: "Olympus", mountHint: null },
  "Panasonic.pm": { maker: "Panasonic", mountHint: null },
  "Sigma.pm": { maker: "Sigma", mountHint: null },
  "Samsung.pm": { maker: "Samsung", mountHint: null },
  "Samyang.pm": { maker: "Samyang", mountHint: null },
  "FujiFilm.pm": { maker: "Fujifilm", mountHint: null }
};

const KNOWN_MAKERS = [
  "Nikon", "Canon", "Sony", "Minolta", "Konica Minolta", "Pentax",
  "Olympus", "Panasonic", "Leica", "Fujifilm", "Fuji", "Sigma",
  "Tamron", "Tokina", "Samyang", "Rokinon", "Zeiss", "Carl Zeiss",
  "Voigtlander", "Voigtländer", "Samsung", "Kodak", "Cosina",
  "Vivitar", "Yongnuo", "Laowa", "Viltrox", "Meike", "7artisans",
  "Mitakon", "Zhongyi", "TTArtisan", "Irix", "SLR Magic", "Soligor",
  "Sunpak", "Quantaray", "Promaster", "Kenko"
];

/* ---------- locating ExifTool ---------- */

function dirHasLensModules(dir) {
  try {
    return (
      dir &&
      fs.existsSync(path.join(dir, "Nikon.pm")) &&
      fs.existsSync(path.join(dir, "Canon.pm"))
    );
  } catch {
    return false;
  }
}

function locateExifToolModuleDir() {
  const candidates = [
    process.env.EXIFTOOL_LIB_DIR,
    path.join(__dirname, "data", "exiftool", "ExifTool"),
    path.join(__dirname, "data", "exiftool", "Image", "ExifTool"),
    path.join(__dirname, "node_modules", "exiftool-vendored.pl", "bin", "lib", "Image", "ExifTool"),
    path.join(__dirname, "node_modules", "exiftool-vendored.pl", "bin", "Image", "ExifTool")
  ].filter(Boolean);

  for (const dir of candidates) {
    if (dirHasLensModules(dir)) {
      return dir;
    }
  }

  try {
    const pmPath = execFileSync(
      "perl",
      ["-MImage::ExifTool", "-e", 'print $INC{"Image/ExifTool.pm"}'],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();

    if (pmPath) {
      const dir = path.join(path.dirname(pmPath), "ExifTool");
      if (dirHasLensModules(dir)) {
        return dir;
      }
    }
  } catch {
    /* perl or ExifTool not installed - fall through */
  }

  return null;
}

/* ---------- parsing the Perl hashes ---------- */

/*
  Matches the START of a lens lookup hash, e.g.
    my %nikonLensIDs = (
    %Image::ExifTool::Canon::canonLensTypes = (
    our %sonyLensTypes = (
*/
const LENS_HASH_START =
  /^\s*(?:my\s+|our\s+)?%(?:[\w:]*::)?(\w*lens(?:ids?|types?)\w*)\s*=\s*\(/i;

/* One entry:  'key' => 'Lens name',   or   123 => "Lens name", */
const HASH_ENTRY =
  /^\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([\w.]+))\s*=>\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,/;

function unescapePerl(value) {
  return String(value || "").replace(/\\(['"\\])/g, "$1");
}

function parseLensHashesFromPerlSource(source, moduleFileName) {
  const lines = source.split(/\r?\n/);
  const entries = [];
  const hashesFound = new Map();

  let currentHash = null;

  for (const line of lines) {
    if (!currentHash) {
      const start = line.match(LENS_HASH_START);
      if (start) {
        currentHash = start[1];
        hashesFound.set(currentHash, 0);
      }
      continue;
    }

    /* End of the hash: a lone ");" */
    if (/^\s*\)\s*;/.test(line)) {
      currentHash = null;
      continue;
    }

    const entry = line.match(HASH_ENTRY);
    if (!entry) {
      continue;
    }

    const id = unescapePerl(entry[1] ?? entry[2] ?? entry[3]);
    const name = unescapePerl(entry[4] ?? entry[5]).trim();

    if (!name) {
      continue;
    }

    entries.push({
      id,
      name,
      hash: currentHash,
      moduleFileName
    });

    hashesFound.set(currentHash, hashesFound.get(currentHash) + 1);
  }

  return { entries, hashesFound };
}

/* ---------- turning raw names into candidates ---------- */

function inferMaker(name, moduleFileName) {
  const lowered = name.toLowerCase();

  const known = KNOWN_MAKERS
    .slice()
    .sort((a, b) => b.length - a.length)
    .find(maker => lowered.startsWith(maker.toLowerCase() + " "));

  if (known) {
    return known === "Fuji" ? "Fujifilm" : known;
  }

  return MODULE_DEFAULTS[moduleFileName]?.maker || "";
}

function inferMountFromName(name) {
  const text = String(name || "");

  /* Most specific first so EF-S never becomes EF. */
  const tokens = [
    [/\bRF-S\b/, "RF-S"],
    [/\bEF-S\b/, "EF-S"],
    [/\bEF-M\b/, "EF-M"],
    [/\bRF\b/, "RF"],
    [/\bEF\b/, "EF"],
    [/\bFD\b/, "FD"]
  ];

  for (const [pattern, mount] of tokens) {
    if (pattern.test(text)) {
      return mount;
    }
  }

  return null;
}

function recordKey(maker, model) {
  return canonicalLensKey(maker, model);
}

export function loadExifToolLensDatabase() {
  const dir = locateExifToolModuleDir();

  if (!dir) {
    console.warn(
      "[EXIFTOOL] Could not find ExifTool's Perl modules (Nikon.pm / Canon.pm). " +
      "Continuing with Lensfun only. Set EXIFTOOL_LIB_DIR or install " +
      "exiftool-vendored (see exiftoolLensDb.js header)."
    );
    exifToolLensRecords = [];
    return exifToolLensRecords;
  }

  const files = fs
    .readdirSync(dir)
    .filter(fileName => fileName.toLowerCase().endsWith(".pm"));

  const byKey = new Map();
  const perHashCounts = {};

  for (const fileName of files) {
    let source;

    try {
      source = fs.readFileSync(path.join(dir, fileName), "utf8");
    } catch (error) {
      console.warn(`[EXIFTOOL] Could not read ${fileName}:`, error?.message);
      continue;
    }

    /* Cheap pre-check so we don't regex-scan all ~150 modules line by line. */
    if (!/lens(?:ids?|types?)\w*\s*=\s*\(/i.test(source)) {
      continue;
    }

    const { entries, hashesFound } = parseLensHashesFromPerlSource(source, fileName);

    for (const [hashName, count] of hashesFound) {
      perHashCounts[`${fileName}:${hashName}`] = count;
    }

    const defaults = MODULE_DEFAULTS[fileName] || { maker: "", mountHint: null };

    for (const entry of entries) {
      /*
        ExifTool uses "A or B" when a lens ID is shared by several
        physical lenses ("Canon EF 35-105mm f/3.5-4.5 or Sigma ...").
        Each alternative is its own candidate; fragments without a
        focal length (e.g. "Sigma Lens") can never pass the exact
        focal filter later, so they fall away naturally.
      */
      const alternatives = entry.name
        .split(/\s+or\s+/i)
        .map(part => part.trim())
        .filter(Boolean);

      for (const alternative of alternatives) {
        const maker = inferMaker(alternative, fileName);
        /*
          Keep the manufacturer in the model string (like Lensfun does) so
          exact-match comparisons against SerpApi answers such as
          "Nikon AF-P DX Nikkor 70-300mm f/4.5-6.3G ED" still work.
        */
        const model =
          !maker || alternative.toLowerCase().startsWith(maker.toLowerCase() + " ")
            ? alternative
            : `${maker} ${alternative}`;
        const key = recordKey(maker, model);

        if (!key) {
          continue;
        }

        const existing = byKey.get(key);

        if (existing) {
          if (!existing.exiftoolIds.includes(entry.id)) {
            existing.exiftoolIds.push(entry.id);
          }
          continue;
        }

        byKey.set(key, {
          maker,
          model,
          fullName: alternative,
          mountFromName: inferMountFromName(alternative),
          mountHint: defaults.mountHint,
          sourceFile: `exiftool:${fileName}`,
          exiftoolHash: entry.hash,
          exiftoolIds: [entry.id]
        });
      }
    }
  }

  exifToolLensRecords = Array.from(byKey.values());

  console.log("[EXIFTOOL] Loaded:", {
    directory: dir,
    lenses: exifToolLensRecords.length,
    hashes: perHashCounts
  });

  if (!exifToolLensRecords.length) {
    console.warn(
      "[EXIFTOOL] Found the Perl modules but parsed 0 lens names. " +
      "The hash names or layout may differ in this ExifTool version."
    );
  }

  return exifToolLensRecords;
}

/* ---------- evidence helpers (self-contained copies) ---------- */

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function toStringArray(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item || "").trim()).filter(Boolean);
  }
  return [];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractFocal(text) {
  const match = String(text || "")
    .replace(/[–—]/g, "-")
    .match(/\b(\d{1,3}(?:\.\d+)?)\s*(?:-\s*(\d{1,3}(?:\.\d+)?))?\s*mm\b/i);

  if (!match) {
    return "";
  }

  return (match[2] ? `${match[1]}-${match[2]}mm` : `${match[1]}mm`).toLowerCase();
}

function extractAperture(text) {
  const match = String(text || "")
    .replace(/[–—]/g, "-")
    .match(/(?:\b1\s*:\s*|\bf\s*\/?\s*)(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/i);

  if (!match) {
    return "";
  }

  return match[2] ? `${match[1]}-${match[2]}` : `${match[1]}`;
}

function normalizeEvidenceAperture(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^f\s*\/?/i, "")
    .replace(/^1\s*:/i, "")
    .replace(/\s+/g, "")
    .replace(/[–—]/g, "-")
    .trim();
}

function normalizeEvidenceFocal(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[–—]/g, "-")
    .trim();
}

/* ---------- candidate search ---------- */

function isLegacyManualMount(explicitMount) {
  const key = String(explicitMount || "")
    .toLowerCase()
    .replace(/\b(mount|bayonet)\b/g, " ")
    .replace(/\b(minolta|olympus|pentax|yashica|contax|exakta|konica|canon)\b/g, " ")
    .replace(/[^a-z0-9/]+/g, "");

  return new Set([
    "md", "mc", "md/mc", "mc/md", "sr", "m42", "om", "fd", "fl",
    "c/y", "exakta", "t", "t2", "c"
  ]).has(key);
}

/*
  Same hard filters and score weights as findLensfunCandidates()
  in server.js, applied to ExifTool's names:

    maker  must match when evidence has a brand      (+10)
    focal  must match EXACTLY                        (+12)
    aperture must match when both sides state one    (+8)
    every feature token must appear                  (+4 each)
    generation marker must appear                    (+6)
    model codes are a soft boost                     (+4 each)
*/
export function findExifToolLensCandidates(evidence) {
  if (!exifToolLensRecords.length) {
    return [];
  }

  const brand = norm(evidence?.brand);
  const focal = normalizeEvidenceFocal(evidence?.focalLength);
  const aperture = normalizeEvidenceAperture(evidence?.maxAperture);
  const explicitMount = norm(evidence?.explicitMount);
  const generation = norm(evidence?.generation);
  const featureTokens = toStringArray(evidence?.featureTokens).map(norm).filter(Boolean);
  const modelCodes = toStringArray(evidence?.modelCodes).map(norm).filter(Boolean);

  if (!brand && !focal) {
    return [];
  }

  const wordMatch = (token, text) =>
    new RegExp(`(^|[^a-z0-9])${escapeRegex(token)}(?=$|[^a-z0-9])`, "i").test(text);

  let candidates = [];

  exifToolLensRecords.forEach((record, index) => {
    const makerText = norm(record.maker);
    const modelText = norm(record.model);
    const fullText = norm(record.fullName);

    let score = 0;

    if (brand) {
      if (
        makerText &&
        (makerText === brand || makerText.includes(brand) || brand.includes(makerText))
      ) {
        score += 10;
      } else {
        return;
      }
    }

    if (focal) {
      if (extractFocal(record.model) !== focal) {
        return;
      }
      score += 12;
    }

    if (aperture) {
      const candidateAperture = extractAperture(record.model);

      if (candidateAperture && candidateAperture !== aperture) {
        return;
      }
      if (candidateAperture === aperture) {
        score += 8;
      }
    }

    if (featureTokens.length) {
      if (!featureTokens.every(token => wordMatch(token, fullText))) {
        return;
      }
      score += featureTokens.length * 4;
    }

    if (generation) {
      if (!wordMatch(generation, fullText)) {
        return;
      }
      score += 6;
    }

    if (modelCodes.length) {
      score += modelCodes.filter(code => wordMatch(code, fullText)).length * 4;
    }

    candidates.push({
      candidateId: [
        record.sourceFile,
        record.maker,
        record.model,
        record.mountFromName || record.mountHint || "unknown",
        String(index)
      ].join("|").toLowerCase(),
      maker: record.maker,
      model: record.model,
      mount: record.mountFromName || record.mountHint || null,
      mountIsInferred: !record.mountFromName,
      sourceFile: record.sourceFile,
      exiftoolIds: record.exiftoolIds,
      score
    });
  });

  /*
    Explicit mount narrowing - mirrors the Lensfun rule, except that
    ExifTool often cannot tell us a mount at all, so an UNKNOWN
    mount is kept rather than dropped.
  */
  if (explicitMount) {
    const mountFiltered = candidates.filter(candidate => {
      const candidateMount = norm(candidate.mount);

      if (!candidateMount) {
        return true;
      }

      return (
        candidateMount === explicitMount ||
        candidateMount.includes(explicitMount) ||
        explicitMount.includes(candidateMount)
      );
    });

    if (mountFiltered.length) {
      candidates = mountFiltered;
    } else if (isLegacyManualMount(explicitMount)) {
      console.log(
        "[EXIFTOOL] Explicit legacy mount has no ExifTool entries; returning no candidates:",
        explicitMount
      );
      candidates = [];
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length) {
    const best = candidates[0].score;
    candidates = candidates.filter(candidate => candidate.score >= best - 2);
  }

  return candidates;
}

/* ---------- merging Lensfun + ExifTool ---------- */

/*
  Canonical identity key used ONLY to decide "is this Lensfun entry
  the same physical lens as that ExifTool entry". Deliberately strict
  on anything that distinguishes products (VR, II, AF-P vs AF-S, IS,
  USM, STM...) and lenient only on pure formatting/branding noise:

    - maker word ("Nikon", "Canon", ...) and "Nikkor"/"Zoom"/"Lens"
    - aperture notation: "1:3.5-5.6" / "f/3.5-5.6" / "F3.5-5.6" -> f3.5-5.6
    - Sigma line names: Art/Contemporary/Sports -> A/C/S
    - parenthetical Tamron-style model codes: "(A005)"
    - token ORDER

  Token SUBSETS are NOT treated as equal on purpose:
  "70-300mm f/4.5-6.3G ED" must never merge into "... ED VR".
*/
const NOISE_TOKENS = new Set([
  "lens", "nikkor", "zoom", "mm",
  ...KNOWN_MAKERS.flatMap(maker => maker.toLowerCase().split(/\s+/))
]);

const LINE_ALIASES = new Map([
  ["art", "a"],
  ["contemporary", "c"],
  ["sports", "s"],
  ["sport", "s"]
]);

export function canonicalLensKey(maker, model) {
  const text = `${model || ""}`
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/\(\s*[a-z]?\d{3}[a-z]?\s*\)/g, " ")
    .replace(
      /\b1\s*:\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/g,
      (m, low, high) => ` f${low}${high ? `-${high}` : ""} `
    )
    .replace(
      /\bf\s*\/?\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/g,
      (m, low, high) => ` f${low}${high ? `-${high}` : ""} `
    )
    .replace(/(\d)\s*mm\b/g, "$1mm");

  const tokens = text
    .split(/[^a-z0-9.]+/)
    .map(token => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .map(token => LINE_ALIASES.get(token) || token)
    .filter(token => !NOISE_TOKENS.has(token));

  return tokens.sort().join(" ");
}

/*
  Union of the two sources, de-duplicated by canonical identity:

    - Both sources know the lens          -> ONE merged candidate
                                             (Lensfun's record wins for
                                             maker/model/mount).
    - Only one source knows a variant     -> kept as a supplementary
                                             candidate.

  So Lensfun [VR] + ExifTool [VR, non-VR] => [VR (both), non-VR (exiftool)].
*/
export function mergeLensCandidateSources({
  lensfunCandidates = [],
  exifToolCandidates = []
} = {}) {
  const merged = new Map();

  for (const candidate of lensfunCandidates) {
    const key = `${norm(candidate.maker)}|${canonicalLensKey(candidate.maker, candidate.model)}|${norm(candidate.mount)}`;

    if (merged.has(key)) {
      continue;
    }

    merged.set(key, {
      ...candidate,
      sources: ["lensfun"]
    });
  }

  for (const candidate of exifToolCandidates) {
    const modelKey = canonicalLensKey(candidate.maker, candidate.model);

    /*
      Find a Lensfun entry for the same lens. ExifTool often has no mount,
      so compare on maker + canonical model and only require mount
      agreement when ExifTool's mount came from the lens NAME itself.
    */
    let matchedKey = null;

    for (const [key, existing] of merged) {
      if (!existing.sources.includes("lensfun")) {
        continue;
      }

      const sameMaker =
        norm(existing.maker) === norm(candidate.maker) ||
        norm(existing.maker).includes(norm(candidate.maker)) ||
        norm(candidate.maker).includes(norm(existing.maker));

      if (!sameMaker) {
        continue;
      }

      if (canonicalLensKey(existing.maker, existing.model) !== modelKey) {
        continue;
      }

      if (
        candidate.mount &&
        !candidate.mountIsInferred &&
        existing.mount &&
        norm(existing.mount) !== norm(candidate.mount) &&
        !norm(existing.mount).includes(norm(candidate.mount)) &&
        !norm(candidate.mount).includes(norm(existing.mount))
      ) {
        continue;
      }

      matchedKey = key;
      break;
    }

    if (matchedKey) {
      const existing = merged.get(matchedKey);

      if (!existing.sources.includes("exiftool")) {
        existing.sources.push("exiftool");
      }

      existing.exiftoolModel = candidate.model;
      existing.exiftoolIds = candidate.exiftoolIds;
      existing.score = Math.max(Number(existing.score || 0), Number(candidate.score || 0));
      continue;
    }

    const orphanKey = `exiftool|${norm(candidate.maker)}|${modelKey}|${norm(candidate.mount)}`;

    if (merged.has(orphanKey)) {
      continue;
    }

    merged.set(orphanKey, {
      ...candidate,
      sources: ["exiftool"]
    });
  }

  let list = Array.from(merged.values());

  list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  if (list.length) {
    const best = Number(list[0].score || 0);
    list = list.filter(candidate => Number(candidate.score || 0) >= best - 2);
  }

  return list;
}
