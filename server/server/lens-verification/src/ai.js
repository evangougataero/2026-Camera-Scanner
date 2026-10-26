import { createHash } from 'node:crypto';
import { pass1Prompt, pass2Prompt, PASS1_SCHEMA, PASS2_SCHEMA, schemaFormat } from './prompts.js';
import { AiOutputError, parseJsonLenient, validatePass1, validatePass2 } from './validate.js';

export class VerifyError extends Error {
  constructor(code, message, { retriable = false } = {}) { super(message); this.name = 'VerifyError'; this.code = code; this.retriable = retriable; }
}

/** Maps any thrown error to {code, retriable, message}. 429/5xx/timeouts/network/bad-JSON are retriable; auth and bad requests are not. */
export function classifyError(e) {
  if (e instanceof VerifyError) return { code: e.code, retriable: e.retriable, message: e.message };
  if (e instanceof AiOutputError) return { code: 'AI_BAD_OUTPUT', retriable: true, message: e.message };
  const status = Number(e?.status ?? e?.response?.status);
  const msg = String(e?.message || e);
  if (status === 429) return { code: 'AI_RATE_LIMITED', retriable: true, message: msg };
  if (status === 401 || status === 403) return { code: 'AI_AUTH', retriable: false, message: msg };
  if (status === 400 || status === 404 || status === 422) return { code: 'AI_REJECTED_INPUT', retriable: false, message: msg };
  if (status >= 500 || status === 408) return { code: 'AI_SERVER_ERROR', retriable: true, message: msg };
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|aborted|socket/i.test(msg)) return { code: 'NETWORK', retriable: true, message: msg };
  return { code: 'UNEXPECTED', retriable: false, message: msg };
}

/** Downloads + normalizes ONE image to a JPEG data URL. Failure is reported, never replaced with another photo. */
export async function prepareImage(url, { fetchImpl = globalThis.fetch, sharp = null, timeoutMs = 20000, maxBytes = 15 * 1024 * 1024, maxEdge = 1568 } = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new VerifyError('IMAGE_UNAVAILABLE', 'Image URL missing or not http(s).');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try { res = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'image/*' } }); }
  catch (e) { throw new VerifyError('IMAGE_FETCH_FAILED', `Image download failed: ${e?.message || e}`, { retriable: true }); }
  finally { clearTimeout(timer); }
  if (!res.ok) {
    const gone = [400, 401, 403, 404, 410].includes(res.status);
    throw new VerifyError(gone ? 'IMAGE_UNAVAILABLE' : 'IMAGE_FETCH_FAILED', `Image request returned HTTP ${res.status}${gone ? ' (link expired or removed)' : ''}.`, { retriable: !gone });
  }
  const type = String(res.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
  if (!/^image\//.test(type)) throw new VerifyError('IMAGE_UNUSABLE', `Expected an image but got ${type}.`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length || buf.length > maxBytes) throw new VerifyError('IMAGE_UNUSABLE', `Image size unusable (${buf.length} bytes).`);
  let mime = type;
  if (sharp) {
    try { buf = await sharp(buf).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer(); mime = 'image/jpeg'; }
    catch (e) { throw new VerifyError('IMAGE_UNUSABLE', `Image could not be decoded: ${e?.message || e}`); }
  }
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16), sourceUrl: url };
}

/** callOpenAI(step, request) -> response with .output_text   (wraps the scanner's createLoggedOpenAiResponse) */
export function createAi({ callOpenAI, cfg }) {
  async function structured(step, prompt, image, schemaName, schema, validate) {
    const content = [{ type: 'input_text', text: prompt }];
    if (image) content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'high' });
    const request = { model: cfg.model, text: schemaFormat(schemaName, schema), input: [{ role: 'user', content }] };
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {                      // one immediate re-ask for malformed output; transport errors bubble up to the job-level retry
      const resp = await callOpenAI(attempt ? `${step} (re-ask)` : step, request);
      try { return validate(parseJsonLenient(resp?.output_text)); } catch (e) { if (!(e instanceof AiOutputError)) throw e; lastErr = e; }
    }
    throw lastErr;
  }
  return {
    pass1: (a) => structured(`Lens verify pass 1 (lens ${a.lensNumber}/${a.lensCount})`, pass1Prompt(a), a.image, 'lens_verify_pass1_independent_identification', PASS1_SCHEMA, validatePass1),
    pass2: (a) => structured(`Lens verify pass 2 (lens ${a.lensNumber}/${a.lensCount})`, pass2Prompt(a), cfg.pass2SendsImage ? a.image : null, 'lens_verify_pass2_adversarial_comparison', PASS2_SCHEMA, (raw) => validatePass2(raw, a.pass1.lenses.length))
  };
}
