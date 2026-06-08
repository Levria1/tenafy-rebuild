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
  if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY not configured');
  if (!imageBuffer || !imageBuffer.length) throw new Error('Empty image buffer');

  const url = `https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(apiKey)}`;
  const body = {
    requests: [{
      image: { content: imageBuffer.toString('base64') },
      features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      imageContext: { languageHints: ['en', 'zh-Hant', 'zh-Hans'] },
    }],
  };

  const resp = await postJson(url, body);
  const r = resp.responses && resp.responses[0];
  if (!r) return '';
  if (r.error) {
    const err = new Error(`Vision API error: ${r.error.message}`);
    err.status = r.error.code;
    throw err;
  }
  return (r.fullTextAnnotation && r.fullTextAnnotation.text) || '';
}

module.exports = { extractText };
