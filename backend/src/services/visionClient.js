/**
 * Google Cloud Vision OCR client.
 *
 * Used by /api/inquiry/parse to extract text from screenshots before the LLM
 * pulls structured fields out of it.
 *
 * Feature: DOCUMENT_TEXT_DETECTION — better than plain TEXT_DETECTION for
 * screenshot-style dense text (WhatsApp/Telegram message blocks, chat dumps,
 * mixed CJK + emoji). Language hints cover English + Traditional/Simplified
 * Chinese, which matches our HK tenant base.
 *
 * Auth: API key in env var GOOGLE_VISION_API_KEY. Restrict the key in the GCP
 * console to "Cloud Vision API" only so it can't be abused if leaked.
 *
 * Pricing: first 1000 requests/month free, then $1.50/1000.
 */

const https = require('https');
const { URL } = require('url');

// A missing key, a 401/403, a disabled API or a project with billing switched off
// is an ACCOUNT problem: no image will ever succeed until someone fixes it in the
// GCP console. A malformed image or a timeout is a problem with that one request.
//
// Callers must be able to tell these apart. On 7 Sep 2026 billing lapsed on the
// Vision project and every extraction returned no fields, so the tenant form told
// people their screenshot was unclear and to try a clearer one. The screenshots
// were fine; OCR had never run. Blaming the user for an unpaid invoice wastes
// their time and hides the one thing an admin needed to see.
const OCR_UNAVAILABLE = 'OCR_UNAVAILABLE';
const OCR_UNAVAILABLE_MESSAGE =
  'Screenshot reading is unavailable — the Google Cloud Vision account needs updating. ' +
  'Type the details in, or paste them as text, until it is restored.';

const ACCOUNT_PROBLEM = /billing|permission_denied|has not been used|is disabled|api key|not configured|quota|exceeded/i;

// PERMISSION_DENIED is 7 and RESOURCE_EXHAUSTED is 8 in the google.rpc.Code enum
// that the per-image `error` object uses, rather than an HTTP status.
const ACCOUNT_RPC_CODES = new Set([7, 8, 16]);

function markUnavailable(err) {
  err.code = OCR_UNAVAILABLE;
  err.unavailable = true;
  err.userMessage = OCR_UNAVAILABLE_MESSAGE;
  return err;
}

function classify(err) {
  if (err.status === 401 || err.status === 403 || err.status === 429) return markUnavailable(err);
  if (ACCOUNT_RPC_CODES.has(err.status)) return markUnavailable(err);
  if (ACCOUNT_PROBLEM.test(err.message || '')) return markUnavailable(err);
  return err;
}

// True when OCR is down for everyone, not just for this image.
function isUnavailable(err) {
  return !!(err && (err.unavailable || err.code === OCR_UNAVAILABLE));
}

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = raw ? JSON.parse(raw) : {};
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Vision ${res.statusCode}: ${raw.slice(0, 500)}`);
            err.status = res.statusCode;
            err.body = parsed;
            return reject(err);
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`Vision non-JSON response: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Vision request timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Extract text from an image using Google Cloud Vision.
 *
 * @param {Buffer} imageBuffer  Raw image bytes (PNG, JPEG, WEBP, etc.)
 * @returns {Promise<string>}   OCR text, newline-separated. Empty string if no
 *                              text was detected.
 */
async function extractText(imageBuffer) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw markUnavailable(new Error('GOOGLE_VISION_API_KEY not configured'));
  if (!imageBuffer || !imageBuffer.length) throw new Error('Empty image buffer');

  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: [{
      image: { content: imageBuffer.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['en', 'zh-Hant', 'zh-Hans'] },
    }],
  };

  let resp;
  try {
    resp = await postJson(url, body);
  } catch (err) {
    throw classify(err);
  }
  const r = resp.responses && resp.responses[0];
  if (!r) return '';
  if (r.error) {
    const err = new Error(`Vision API error: ${r.error.message}`);
    err.status = r.error.code;
    throw classify(err);
  }
  return (r.fullTextAnnotation && r.fullTextAnnotation.text) || '';
}

async function extractPdfText(buffer) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw markUnavailable(new Error('GOOGLE_VISION_API_KEY not configured'));
  const url = `https://vision.googleapis.com/v1/files:annotate?key=${encodeURIComponent(apiKey)}`;
  try {
    const result = await postJson(url, { requests: [{
      inputConfig: { content: buffer.toString('base64'), mimeType: 'application/pdf' },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
    }] });
    const file = result.responses?.[0];
    if (!file || file.error || file.responses?.some(page => page.error)) throw new Error('PDF OCR failed');
    // Online file OCR reads at most the first five pages. Staff verify the fields.
    return (file.responses || []).map(page => page.fullTextAnnotation?.text || '').join('\n');
  } catch (error) { throw classify(error); }
}

module.exports = { extractText, extractPdfText, isUnavailable, OCR_UNAVAILABLE, OCR_UNAVAILABLE_MESSAGE };
