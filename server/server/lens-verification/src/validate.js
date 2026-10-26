// Validation of AI output, deterministic guardrails (only ever DOWNGRADE unsupported flags), aggregation, summaries.
const OUTCOMES = ['PASS', 'REVIEW', 'MISMATCH'];
const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n));
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);

export class AiOutputError extends Error { constructor(msg) { super(msg); this.name = 'AiOutputError'; this.code = 'AI_BAD_OUTPUT'; this.retriable = true; } }

export function parseJsonLenient(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  try { return JSON.parse(t); } catch (e) { /* try to cut to the outer braces */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fallthrough */ } }
  throw new AiOutputError('Model returned text that is not valid JSON.');
}

export function validatePass1(raw) {
  if (!isObj(raw) || !Array.isArray(raw.lenses)) throw new AiOutputError('Pass 1: "lenses" array missing.');
  return {
    imageUsable: raw.imageUsable !== false, imageNote: clip(raw.imageNote, 300),
    lenses: raw.lenses.slice(0, 6).map((l) => ({
      location: clip(l?.location, 160) || '', brand: clip(l?.brand, 60), modelName: clip(l?.modelName, 120), mount: clip(l?.mount, 60), focalLength: clip(l?.focalLength, 40),
      maxAperture: clip(l?.maxAperture, 40), features: (Array.isArray(l?.features) ? l.features : []).slice(0, 10).map(x => clip(x, 30)), generationOrVersion: clip(l?.generationOrVersion, 60),
      fullIdentification: clip(l?.fullIdentification, 200), readableMarkings: (Array.isArray(l?.readableMarkings) ? l.readableMarkings : []).slice(0, 15).map(x => clip(x, 80)),
      evidence: (Array.isArray(l?.evidence) ? l.evidence : []).slice(0, 12).map(e => ({ claim: clip(e?.claim, 200), source: ['visual', 'seller', 'inference', 'unresolved'].includes(e?.source) ? e.source : 'inference', detail: clip(e?.detail, 240) })),
      alternatives: (Array.isArray(l?.alternatives) ? l.alternatives : []).slice(0, 3).map(a => ({ model: clip(a?.model, 140), whyConfusable: clip(a?.whyConfusable, 240) })),
      unresolved: (Array.isArray(l?.unresolved) ? l.unresolved : []).slice(0, 6).map(u => ({ topic: clip(u?.topic, 100), detail: clip(u?.detail, 240), couldAffectValue: !!u?.couldAffectValue }))
    }))
  };
}

export function validatePass2(raw, pass1LensCount = 0) {
  if (!isObj(raw)) throw new AiOutputError('Pass 2: not an object.');
  const outcome = String(raw.outcome || '').toUpperCase();
  if (!OUTCOMES.includes(outcome)) throw new AiOutputError('Pass 2: outcome must be PASS, REVIEW or MISMATCH.');
  let m = raw.matchedPass1Lens; m = Number.isInteger(m) && m >= 0 && m < pass1LensCount ? m : null;
  const lvl = ['none', 'minor', 'material'].includes(raw.valueImpact?.level) ? raw.valueImpact.level : 'none';
  return {
    matchedPass1Lens: m, agreement: ['agrees', 'partially_agrees', 'disagrees', 'cannot_compare'].includes(raw.agreement) ? raw.agreement : 'cannot_compare',
    outcome, evidenceLimited: !!raw.evidenceLimited, independentIdentification: clip(raw.independentIdentification, 220) || '',
    alternatives: (Array.isArray(raw.alternatives) ? raw.alternatives : []).slice(0, 2).map(a => ({ model: clip(a?.model, 140), plausibility: ['low', 'medium', 'high'].includes(a?.plausibility) ? a.plausibility : 'low', whyConfusable: clip(a?.whyConfusable, 240) })).filter(a => a.model),
    contradictions: (Array.isArray(raw.contradictions) ? raw.contradictions : []).slice(0, 5).map(c => ({ description: clip(c?.description, 260), source: ['visible_marking', 'seller_text', 'listing_inconsistency'].includes(c?.source) ? c.source : 'listing_inconsistency', directness: c?.directness === 'direct' ? 'direct' : 'indirect' })).filter(c => c.description),
    findingSummary: clip(raw.findingSummary, 320) || '', valueImpact: { level: lvl, description: clip(raw.valueImpact?.description, 260) }, recommendedManualCheck: clip(raw.recommendedManualCheck, 260)
  };
}

/**
 * Guardrails keep the second opinion honest and quiet:
 *  - MISMATCH needs a DIRECT contradiction from readable markings (and a disagreement). Otherwise it is downgraded.
 *  - REVIEW needs a concrete alternative, a MATERIAL value impact and a concrete thing to check. Otherwise it becomes PASS.
 * Guardrails never upgrade. The raw model outcome is always kept for audit.
 */
export function applyGuardrails(p2) {
  const raw = p2.outcome;
  const hasAlt = p2.alternatives.length > 0, material = p2.valueImpact.level === 'material', hasCheck = !!p2.recommendedManualCheck;
  const directMarking = p2.contradictions.some(c => c.directness === 'direct' && c.source === 'visible_marking');
  let outcome = raw, reason = null;
  if (outcome === 'MISMATCH' && !(directMarking && p2.agreement === 'disagrees')) {
    outcome = 'REVIEW'; reason = 'Mismatch downgraded: no direct contradiction from readable markings.';
  }
  if (outcome === 'REVIEW' && !(hasAlt && material && hasCheck)) {
    outcome = 'PASS';
    reason = (reason ? reason + ' ' : '') + 'Review downgraded: ' + (!hasAlt ? 'no concrete alternative model' : !material ? 'no material resale-value difference' : 'no concrete manual check') + '.';
  }
  return { ...p2, outcome, rawOutcome: raw, guardrail: reason ? { applied: true, reason } : { applied: false, reason: null } };
}

export const VERDICT_RANK = { MISMATCH: 3, REVIEW: 2, ERROR: 1, PASS: 0 };

/** lens results: [{status:'done'|'error', outcome?, ...}] -> listing verdict. */
export function aggregate(lenses) {
  if (!lenses.length) return { verdict: 'NO_LENSES', incomplete: false, counts: { PASS: 0, REVIEW: 0, MISMATCH: 0, ERROR: 0 } };
  const counts = { PASS: 0, REVIEW: 0, MISMATCH: 0, ERROR: 0 };
  for (const l of lenses) counts[l.status === 'done' ? l.outcome : 'ERROR']++;
  const verdict = counts.MISMATCH ? 'MISMATCH' : counts.REVIEW ? 'REVIEW' : counts.ERROR ? 'ERROR' : 'PASS';
  return { verdict, incomplete: counts.ERROR > 0, counts };
}

export function summarize(lenses, agg) {
  if (agg.verdict === 'NO_LENSES') return 'No lenses found among the scanner\'s products — nothing to verify.';
  const flagged = lenses.filter(l => l.status === 'done' && l.outcome !== 'PASS');
  const errs = lenses.filter(l => l.status === 'error');
  const parts = [];
  if (agg.verdict === 'PASS') parts.push(lenses.length === 1 ? 'Lens identification looks consistent. No manual action needed.' : `All ${lenses.length} lenses look consistent. No manual action needed.`);
  for (const l of flagged.slice(0, 3)) parts.push(`${l.outcome} — ${l.scannerName}: ${l.finding || ''}${l.recommendedCheck ? ' Check: ' + l.recommendedCheck : ''}`.trim());
  if (flagged.length > 3) parts.push(`+${flagged.length - 3} more flagged lens(es) in the report.`);
  if (errs.length) parts.push(`${errs.length} lens(es) could not be verified (${[...new Set(errs.map(e => e.errorCode))].join(', ')}).`);
  return parts.join(' ').slice(0, 900);
}
