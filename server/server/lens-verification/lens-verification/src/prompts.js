// Prompts + strict JSON schemas for the two passes. Pass 1 NEVER receives the scanner's conclusion.

const PRINCIPLES = `
You are a second-opinion checker for used camera LENS model identification. You are NOT doing condition analysis (ignore scratches, fungus, haze, wear, dust) and NOT making a purchase recommendation or pricing anything.

The only question: is there a realistic chance this lens is a different, similar-looking model, generation, mount or variant with a meaningfully different resale value?

EVIDENCE RULES
- Distinguish four kinds of evidence and label each claim: "visual" (text/markings you can actually read in the image), "seller" (stated in the listing title/description), "inference" (deduced from appearance/design), "unresolved".
- Never invent or "complete" text. If a marking is not clearly readable, do not report it as read.
- Seller statements count as evidence but can be wrong. A seller claim that conflicts with readable markings is a contradiction.
- A marking that is merely not visible (angle, crop, facing away) is NOT a contradiction. Absence of evidence is not evidence of a different model.
- If the listing text already establishes a detail and nothing contradicts it, accept it provisionally; do not demand photographic confirmation of everything.
- Be precise about terminology: for example "AF-S" names Nikon's in-lens focus-motor design, not by itself the physical mount or lens line; do not treat a term as proof of a specification it does not establish.
- Consider only realistic confusions a used-gear buyer could make (VR/non-VR, IS/non-IS, USM/STM/micro-motor, OSS, generation I/II/III, different max apertures, similarly named optical versions, different mounts such as EF vs EF-S vs RF, DX vs FX). Prefer one or two strong alternatives over a long speculative list.
- Do not manufacture ambiguity. If the model is unambiguous and the listing is consistent, say so.
- Do not state resale prices or price differences. Describe value impact qualitatively only.
- Use no confidence percentages.`.trim();

export function pass1Prompt({ title, description, ocrText, lensNumber, lensCount }) {
  return `${PRINCIPLES}

TASK (PASS 1 — INDEPENDENT IDENTIFICATION)
Identify the lens(es) visible in the attached photograph as specifically as the evidence allows. You are NOT given anyone else's conclusion. The listing contains ${lensCount} lens(es) in total and this photograph was chosen as showing lens #${lensNumber} well; it may show other lenses or cameras too. List every distinct LENS you can see (ignore cameras, flashes, accessories) and describe where each is in the photo so it can be told apart.

For each lens: give your best identification (leave fields null when not supported), list the exact markings you can really read, label each supporting claim by evidence kind, name realistic confusable alternatives, and list unresolved ambiguities that could change resale value (not trivia).

LISTING TITLE:
${title || '(none)'}

LISTING DESCRIPTION:
${description || '(none)'}

MACHINE OCR OF THIS PHOTO (raw, may be wrong or belong to another product; treat as a weak hint only):
${ocrText || '(none)'}

Return JSON only.`;
}

export function pass2Prompt({ title, description, scannerName, scannerIdentity, scannerResale, pass1, lensNumber, lensCount, scannerNotes }) {
  return `${PRINCIPLES}

TASK (PASS 2 — ADVERSARIAL COMPARISON)
An automated scanner concluded that lens #${lensNumber} of ${lensCount} in this listing is:
  "${scannerName}"
${scannerIdentity ? `Scanner's structured identity fields: ${JSON.stringify(scannerIdentity)}\n` : ''}${scannerResale != null ? `Existing scanner estimate (context only, not verified, do not restate as a market fact): about $${scannerResale}\n` : ''}${scannerNotes && scannerNotes.length ? `The scanner's own resolution trail for this lens (its reasoning and the sources IT consulted, taken from its log; this is NOT independent evidence):\n${scannerNotes.map(n => '  - ' + n).join('\n')}\n` : ''}
The scanner's conclusion is a HYPOTHESIS you are trying to break, not supporting evidence. A separate, independent pass looked at the photo WITHOUT knowing this conclusion and reported:
${JSON.stringify(pass1, null, 1)}

Decide:
1. Which lens in the independent report (by index, starting at 0) corresponds to the scanner's lens #${lensNumber}? Use focal length, size, position, brand cues. If you cannot tell, say so (null) and explain; do not guess.
2. Does the independent identification agree with the scanner?
3. Is there SPECIFIC evidence contradicting the scanner (readable markings, seller text, listing inconsistencies)?
4. Could the scanner have confused a similar model, generation, variant (VR/IS/OSS/VC/STM/USM/AF motor/aperture), or mount? Is the claimed mount consistent with the evidence?
5. Is an alternative plausible enough, with a MATERIAL resale-value difference, to justify a manual check before buying?

OUTCOMES
- PASS: evidence supports the scanner; no credible contradiction; no plausible alternative worth a manual check. A pass does not need every spec visible in the photo.
- REVIEW: a plausible alternative with material value implications, an unresolved critical designation, or a legitimate seller-vs-visual question. Give exactly what to check.
- MISMATCH: strong direct evidence (readable markings) contradicts the scanner's exact model, variant or generation. Never use MISMATCH just because something is not visible.
Optimize for useful flags, not many flags. If seller text and photo are consistent and no credible alternative needs attention, return PASS and keep findings short.
Set evidenceLimited=true only if the evidence was thin but you still reached a conclusion (for example photo angle) — not as a substitute for a flag.

LISTING TITLE:
${title || '(none)'}

LISTING DESCRIPTION:
${description || '(none)'}

Return JSON only. Keep findingSummary under 280 characters.`;
}

const S = { type: 'string' }, SN = { type: ['string', 'null'] }, B = { type: 'boolean' };
const arr = (items) => ({ type: 'array', items });
const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
const EV_SOURCE = { type: 'string', enum: ['visual', 'seller', 'inference', 'unresolved'] };

export const PASS1_SCHEMA = obj({
  imageUsable: B,
  imageNote: SN,
  lenses: arr(obj({
    location: S,
    brand: SN, modelName: SN, mount: SN, focalLength: SN, maxAperture: SN, features: arr(S), generationOrVersion: SN, fullIdentification: SN,
    readableMarkings: arr(S),
    evidence: arr(obj({ claim: S, source: EV_SOURCE, detail: S })),
    alternatives: arr(obj({ model: S, whyConfusable: S })),
    unresolved: arr(obj({ topic: S, detail: S, couldAffectValue: B }))
  }))
});

export const PASS2_SCHEMA = obj({
  matchedPass1Lens: { type: ['integer', 'null'] },
  agreement: { type: 'string', enum: ['agrees', 'partially_agrees', 'disagrees', 'cannot_compare'] },
  outcome: { type: 'string', enum: ['PASS', 'REVIEW', 'MISMATCH'] },
  evidenceLimited: B,
  independentIdentification: S,
  alternatives: arr(obj({ model: S, plausibility: { type: 'string', enum: ['low', 'medium', 'high'] }, whyConfusable: S })),
  contradictions: arr(obj({ description: S, source: { type: 'string', enum: ['visible_marking', 'seller_text', 'listing_inconsistency'] }, directness: { type: 'string', enum: ['direct', 'indirect'] } })),
  findingSummary: S,
  valueImpact: obj({ level: { type: 'string', enum: ['none', 'minor', 'material'] }, description: SN }),
  recommendedManualCheck: SN
});

export const schemaFormat = (name, schema) => ({ format: { type: 'json_schema', name, strict: true, schema } });
