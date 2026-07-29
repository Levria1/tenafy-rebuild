/**
 * Signature stamper — takes the unsigned lease PDF + signature_party rows +
 * the landlord signature, stamps signatures + initials, appends a Certificate
 * of Completion, and returns the final PDF buffer.
 *
 * Placement strategy (two modes, auto-selected):
 *
 *   1. ANCHORED (preferred) — if the template embedded signature anchors
 *      ({{SIGNATURE_TENANT}}, {{SIGNATURE_LANDLORD}}, ...), those render as
 *      invisible markers in the PDF text layer. We locate them with
 *      pdfAnchorFinder and draw each signature image exactly there — so the
 *      signature lands right above the author's "Tenant Signature" line no
 *      matter how long the body text is.
 *
 *   2. APPENDED (fallback) — for any party whose anchor wasn't found (older
 *      templates, or staff didn't add the anchor), we fall back to a dedicated
 *      "Signatures" page appended at the end, exactly as before. So every
 *      existing template keeps working.
 *
 * INITIALS — every content page gets each signer's initials stamped in a fixed
 * bottom-right corner (from signature_party.initials_png; landlord reuses its
 * signature image scaled down). Skipped silently for any party without an
 * initials image.
 *
 * The Certificate of Completion is always the final page: party names + emails
 * + IPs + user agents + timestamps + document SHA-256.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');
const { findAnchors } = require('./pdfAnchorFinder');
const { SIGNATURE_MARKERS } = require('./leaseTemplateVariables');

const PAGE_PADDING = 50;
const SIG_WIDTH = 160;
const SIG_HEIGHT = 50;

// Per-page initials box (bottom-right corner).
const INITIAL_W = 48;
const INITIAL_H = 22;
const INITIAL_GAP = 4;
const INITIAL_MARGIN = 24;

// How far above the anchor baseline the signature image bottom sits.
const ANCHOR_LIFT = 2;

function stripDataUrl(s) {
  if (!s) return '';
  return String(s).replace(/^data:image\/[\w.+-]+;base64,/i, '');
}

// Embed a signature image whether it's a PNG or a JPEG. Signatures captured in
// the browser are PNG, but an uploaded landlord signature can be a JPEG — and
// pdf-lib's embedPng throws on JPEG bytes, which is why such signatures came out
// blank. Detect the format (magic bytes / data-URL mime) and use the right
// embedder, falling back to the other on error.
async function embedImageSafe(pdfDoc, dataUrlOrB64) {
  const raw = String(dataUrlOrB64 || '');
  const bytes = Buffer.from(stripDataUrl(raw), 'base64');
  if (!bytes.length) return null;
  const isJpg = (bytes[0] === 0xFF && bytes[1] === 0xD8) || /^data:image\/jpe?g/i.test(raw);
  try {
    return isJpg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
  } catch {
    try { return isJpg ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes); }
    catch {
      // Unsupported format (GIF/WebP/HEIC/…) — log so the next gap is diagnosable
      // in logs rather than by a blank signature.
      console.warn('[stamper] could not embed signature image (%d bytes, magic %s) — leaving blank',
        bytes.length, bytes.slice(0, 4).toString('hex'));
      return null;
    }
  }
}

/**
 * @param {object} opts
 * @param {Buffer} opts.unsignedPdf  — the rendered lease PDF (from Puppeteer)
 * @param {Array}  opts.parties      — signature_party rows (signed status)
 * @param {object} opts.landlordSig  — { label, signature_png } | null
 * @param {object} opts.request      — signature_request row (audit metadata)
 * @returns {Promise<Buffer>}
 */
async function stampLease({ unsignedPdf, parties, landlordSig, request }) {
  const pdfDoc = await PDFDocument.load(unsignedPdf);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helv     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Content pages = everything present before we append anything. Initials go
  // on these only (not the appended signatures/certificate pages).
  const contentPages = pdfDoc.getPages();
  const contentPageCount = contentPages.length;

  const docHash = crypto.createHash('sha256').update(unsignedPdf).digest('hex');

  // ── Map each signature target → its marker token ─────────────────────────
  // Tenants (role != landlord) in sort_order → TENANT_1/2/3. Landlord (the
  // auto sig, or a party flagged role=landlord) → LANDLORD.
  const tenantParties = parties
    .filter(p => p.role !== 'landlord')
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const tenantMarkers = [SIGNATURE_MARKERS.TENANT_1, SIGNATURE_MARKERS.TENANT_2, SIGNATURE_MARKERS.TENANT_3];

  // ── Locate anchors in the unsigned PDF ───────────────────────────────────
  const wantedMarkers = [
    ...tenantParties.slice(0, 3).map((_, i) => tenantMarkers[i]),
  ];
  if (landlordSig && landlordSig.signature_png) wantedMarkers.push(SIGNATURE_MARKERS.LANDLORD);

  let anchors = [];
  try {
    anchors = await findAnchors(unsignedPdf, wantedMarkers);
  } catch (e) {
    console.error('[stamper] anchor find failed, using appended page:', e.message);
  }
  const anchorByToken = Object.fromEntries(anchors.map(a => [a.token, a]));

  // ── Draw a signature image at an anchor position ─────────────────────────
  const placedTenantIdx = new Set();
  let landlordPlacedAtAnchor = false;

  async function drawSigAtAnchor(anchor, pngData) {
    const png = await embedImageSafe(pdfDoc, pngData);
    if (!png) return false;
    const page = contentPages[anchor.page];
    if (!page) return false;
    const dims = png.scaleToFit(SIG_WIDTH, SIG_HEIGHT);
    page.drawImage(png, {
      x: anchor.x,
      y: anchor.y + ANCHOR_LIFT,
      width: dims.width,
      height: dims.height,
    });
    return true;
  }

  // Tenant signatures at their anchors
  for (let i = 0; i < tenantParties.length && i < 3; i++) {
    const p = tenantParties[i];
    if (p.status !== 2 || !p.signature_png) continue;
    const anchor = anchorByToken[tenantMarkers[i]];
    if (anchor) {
      const ok = await drawSigAtAnchor(anchor, p.signature_png);
      if (ok) placedTenantIdx.add(i);
    }
  }

  // Landlord signature at its anchor
  if (landlordSig && landlordSig.signature_png && anchorByToken[SIGNATURE_MARKERS.LANDLORD]) {
    const ok = await drawSigAtAnchor(anchorByToken[SIGNATURE_MARKERS.LANDLORD], landlordSig.signature_png);
    landlordPlacedAtAnchor = ok;
  }

  // ── Initials on every content page (bottom-right, stacked) ───────────────
  // Build the list of (image) initials once, then stamp on each page.
  const initialImgs = [];
  for (const p of tenantParties) {
    if (p.status !== 2) continue;
    const src = p.initials_png || null;   // dedicated initials, if captured
    if (!src) continue;
    const png = await embedImageSafe(pdfDoc, src);
    if (png) initialImgs.push(png);
  }
  // Landlord initials — reuse its signature image scaled into the small box.
  if (landlordSig && landlordSig.signature_png) {
    const png = await embedImageSafe(pdfDoc, landlordSig.signature_png);
    if (png) initialImgs.push(png);
  }

  if (initialImgs.length) {
    for (const page of contentPages) {
      const { width } = page.getSize();
      let iy = INITIAL_MARGIN;
      for (const png of initialImgs) {
        const dims = png.scaleToFit(INITIAL_W, INITIAL_H);
        page.drawImage(png, {
          x: width - INITIAL_MARGIN - dims.width,
          y: iy,
          width: dims.width,
          height: dims.height,
        });
        iy += dims.height + INITIAL_GAP;
      }
    }
  }

  // ── Appended "Signatures" page for anything not placed at an anchor ───────
  const unplacedTenants = tenantParties
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p.status === 2 && p.signature_png && !placedTenantIdx.has(i))
    .map(({ p }) => p);
  const landlordNeedsAppend = landlordSig && landlordSig.signature_png && !landlordPlacedAtAnchor;

  if (unplacedTenants.length || landlordNeedsAppend) {
    const sigPage = pdfDoc.addPage();
    const { height } = sigPage.getSize();
    let y = height - PAGE_PADDING;

    sigPage.drawText('Signatures', { x: PAGE_PADDING, y, size: 18, font: helvBold, color: rgb(0.1, 0.24, 0.56) });
    y -= 30;
    sigPage.drawText('This lease was signed electronically by the parties below.', {
      x: PAGE_PADDING, y, size: 10, font: helv, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 30;

    for (const party of unplacedTenants) {
      sigPage.drawText('TENANT SIGNATURE', { x: PAGE_PADDING, y, size: 9, font: helvBold, color: rgb(0.3, 0.3, 0.3) });
      y -= 8;
      const png = await embedImageSafe(pdfDoc, party.signature_png);
      if (png) {
        const dims = png.scaleToFit(SIG_WIDTH, SIG_HEIGHT);
        sigPage.drawImage(png, { x: PAGE_PADDING, y: y - dims.height, width: dims.width, height: dims.height });
        y -= dims.height;
      }
      y -= 8;
      sigPage.drawLine({ start: { x: PAGE_PADDING, y }, end: { x: PAGE_PADDING + SIG_WIDTH, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
      y -= 14;
      sigPage.drawText(`Name:  ${party.typed_name || party.signer_name}`, { x: PAGE_PADDING, y, size: 10, font: helv });
      y -= 14;
      if (party.signer_email) {
        sigPage.drawText(`Email: ${party.signer_email}`, { x: PAGE_PADDING, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
        y -= 14;
      }
      if (party.signed_at) {
        sigPage.drawText(`Signed: ${new Date(party.signed_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`, {
          x: PAGE_PADDING, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4),
        });
        y -= 24;
      }
    }

    if (landlordNeedsAppend) {
      sigPage.drawText('LANDLORD SIGNATURE', { x: PAGE_PADDING, y, size: 9, font: helvBold, color: rgb(0.3, 0.3, 0.3) });
      y -= 8;
      const png = await embedImageSafe(pdfDoc, landlordSig.signature_png);
      if (png) {
        const dims = png.scaleToFit(SIG_WIDTH, SIG_HEIGHT);
        sigPage.drawImage(png, { x: PAGE_PADDING, y: y - dims.height, width: dims.width, height: dims.height });
        y -= dims.height;
      }
      y -= 8;
      sigPage.drawLine({ start: { x: PAGE_PADDING, y }, end: { x: PAGE_PADDING + SIG_WIDTH, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
      y -= 14;
      sigPage.drawText(`Name:  ${landlordSig.label}`, { x: PAGE_PADDING, y, size: 10, font: helv });
      y -= 14;
      sigPage.drawText(`Signed: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`, {
        x: PAGE_PADDING, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4),
      });
    }
  }

  // ── Certificate of Completion (always appended) ──────────────────────────
  const cert = pdfDoc.addPage();
  const { height: certH } = cert.getSize();
  let cy = certH - PAGE_PADDING;
  cert.drawText('Certificate of Completion', { x: PAGE_PADDING, y: cy, size: 18, font: helvBold, color: rgb(0.1, 0.24, 0.56) });
  cy -= 30;
  cert.drawText('This certificate documents the electronic signing of this lease.', {
    x: PAGE_PADDING, y: cy, size: 10, font: helv, color: rgb(0.3, 0.3, 0.3),
  });
  cy -= 30;

  const writeKV = (k, v) => {
    cert.drawText(k, { x: PAGE_PADDING, y: cy, size: 9, font: helvBold, color: rgb(0.3, 0.3, 0.3) });
    cert.drawText(String(v ?? ''), { x: PAGE_PADDING + 130, y: cy, size: 9, font: helv });
    cy -= 14;
  };
  writeKV('Request ID:', String(request.id));
  writeKV('Sent:',      request.sent_at ? new Date(request.sent_at).toISOString() : '—');
  writeKV('Completed:', new Date().toISOString());
  writeKV('Document SHA-256:', docHash);
  cy -= 10;

  cert.drawText('Signers', { x: PAGE_PADDING, y: cy, size: 12, font: helvBold });
  cy -= 16;
  for (const party of parties) {
    cert.drawText(`• ${party.signer_name}${party.signer_email ? ` <${party.signer_email}>` : ''}`, {
      x: PAGE_PADDING, y: cy, size: 10, font: helvBold,
    });
    cy -= 14;
    if (party.viewed_at) {
      cert.drawText(`    Viewed:  ${new Date(party.viewed_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`, { x: PAGE_PADDING, y: cy, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      cy -= 12;
    }
    if (party.signed_at) {
      cert.drawText(`    Signed:  ${new Date(party.signed_at).toISOString().replace('T', ' ').slice(0, 19)} UTC`, { x: PAGE_PADDING, y: cy, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      cy -= 12;
    }
    if (party.signer_ip) {
      cert.drawText(`    IP:      ${party.signer_ip}`, { x: PAGE_PADDING, y: cy, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      cy -= 12;
    }
    if (party.signer_ua) {
      cert.drawText(`    Browser: ${party.signer_ua.slice(0, 90)}`, { x: PAGE_PADDING, y: cy, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      cy -= 12;
    }
    cy -= 6;
  }
  if (landlordSig && landlordSig.signature_png) {
    cert.drawText(`• ${landlordSig.label} (Landlord)`, { x: PAGE_PADDING, y: cy, size: 10, font: helvBold });
    cy -= 16;
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { stampLease };
