/**
 * pdfAnchorFinder — locate invisible marker tokens in a rendered PDF so the
 * stamper can place signatures exactly where the template author wanted them
 * (e.g. right above a "Tenant Signature" line) regardless of how the body text
 * reflowed.
 *
 * The lease template embeds markers as invisible white text via the signature
 * anchor variables in leaseTemplateVariables.js (e.g. "SIGANCHORTENANT1"). We
 * scan the PDF's text layer with pdfjs-dist, find each marker, and return its
 * page index + (x, y) in PDF coordinate space (bottom-left origin — same as
 * pdf-lib, so the stamper can use the numbers directly).
 *
 * Returns [] if pdfjs can't load the doc or no markers are found — callers
 * fall back to the appended signatures page, so this is always non-fatal.
 */

// pdfjs-dist legacy build is CommonJS-friendly and runs in Node without a
// browser worker.
//
// NOTE: on first load pdfjs may log "Cannot polyfill DOMMatrix/Path2D
// (Cannot find module 'canvas')". This is HARMLESS for us — those polyfills
// are only needed to RENDER pages to a canvas, which we never do. We only call
// getTextContent() to read text positions, which works without the canvas
// native module. Installing `canvas` would silence the warning but it's a
// heavy native dependency we don't need.
let pdfjsLib = null;
function getPdfjs() {
  if (!pdfjsLib) {
    // eslint-disable-next-line global-require
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  }
  return pdfjsLib;
}

/**
 * @param {Buffer} pdfBuffer
 * @param {string[]} markers  — exact token strings to locate (e.g. ['SIGANCHORTENANT1'])
 * @returns {Promise<Array<{ token: string, page: number, x: number, y: number }>>}
 *          page is 0-based; x/y are PDF points from the bottom-left of that page.
 */
async function findAnchors(pdfBuffer, markers) {
  if (!pdfBuffer || !Array.isArray(markers) || markers.length === 0) return [];

  let doc;
  try {
    const pdfjs = getPdfjs();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      // Keep pdfjs quiet + lightweight in a server context.
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
    });
    doc = await loadingTask.promise;
  } catch (err) {
    console.error('[pdfAnchorFinder] failed to load PDF:', err.message);
    return [];
  }

  const found = [];
  const remaining = new Set(markers);

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (remaining.size === 0) break;
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        const str = (item.str || '').trim();
        if (!str) continue;
        for (const marker of Array.from(remaining)) {
          if (str === marker || str.includes(marker)) {
            // item.transform = [a, b, c, d, e, f]; e=x, f=y in PDF user space
            // (bottom-left origin). This matches pdf-lib's coordinate system.
            const x = item.transform[4];
            const y = item.transform[5];
            found.push({ token: marker, page: pageNum - 1, x, y });
            remaining.delete(marker);
          }
        }
      }
    }
  } catch (err) {
    console.error('[pdfAnchorFinder] text scan error:', err.message);
  } finally {
    try { await doc.cleanup(); await doc.destroy(); } catch { /* ignore */ }
  }

  return found;
}

module.exports = { findAnchors };
