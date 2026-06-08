/**
 * Signature stamper — takes the unsigned lease PDF + signature_party rows +
 * the landlord signature, stamps each PNG onto the last page of the PDF,
 * appends a "Certificate of Completion" page with the audit trail, and
 * returns the final PDF buffer.
 *
 * Layout on the last page of the unsigned lease:
 *   Bottom-left:   "TENANT SIGNATURE" + signature image + typed name
 *   Bottom-right:  "LANDLORD SIGNATURE" + signature image + landlord label
 *
 * When there are multiple tenant parties (joint tenants), they're stacked
 * vertically on the left side; the landlord stays bottom-right.
 *
 * If the signatures would overflow the last page, we add a new dedicated
 * "Signatures" page rather than overlapping the lease text.
 *
 * The Certificate of Completion is a final page with: party names + emails
 * + IPs + user agents + timestamps + document SHA-256.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const crypto = require('crypto');

const PAGE_PADDING = 50;
const SIG_WIDTH = 180;
const SIG_HEIGHT = 60;

function stripDataUrl(s) {
  if (!s) return '';
  return String(s).replace(/^data:image\/\w+;base64,/, '');
}

/**
 * Stamp tenant + landlord signatures onto the PDF and append a certificate page.
 *
 * @param {object} opts
 * @param {Buffer} opts.unsignedPdf      — the rendered lease PDF (from Puppeteer)
 * @param {Array}  opts.parties          — signature_party rows (signed status)
 * @param {object} opts.landlordSig      — { label, signature_png }
 * @param {object} opts.request          — signature_request row (for audit metadata)
 * @returns {Promise<Buffer>}            — final stamped PDF
 */
async function stampLease({ unsignedPdf, parties, landlordSig, request }) {
  const pdfDoc = await PDFDocument.load(unsignedPdf);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helv     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Hash the original (unsigned) bytes for the certificate's tamper-evidence
  // claim. The signed-with-signatures bytes differ but the underlying lease
  // content is what staff/courts care about.
  const docHash = crypto.createHash('sha256').update(unsignedPdf).digest('hex');

  // Append a fresh signatures page so we don't fight existing lease layout.
  // pdf-lib's "addPage" defaults to the first page's size — usually A4.
  const sigPage = pdfDoc.addPage();
  const { width, height } = sigPage.getSize();
  let y = height - PAGE_PADDING;

  sigPage.drawText('Signatures', {
    x: PAGE_PADDING, y, size: 18, font: helvBold, color: rgb(0.1, 0.24, 0.56),
  });
  y -= 30;

  sigPage.drawText('This lease was signed electronically by the parties below.', {
    x: PAGE_PADDING, y, size: 10, font: helv, color: rgb(0.3, 0.3, 0.3),
  });
  y -= 30;

  // Tenant signatures (stacked vertically)
  for (const party of parties) {
    if (party.status !== 2 || !party.signature_png) continue;   // must be signed
    sigPage.drawText(party.role === 'landlord' ? 'LANDLORD SIGNATURE' : 'TENANT SIGNATURE', {
      x: PAGE_PADDING, y, size: 9, font: helvBold, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 8;

    try {
      const pngBytes = Buffer.from(stripDataUrl(party.signature_png), 'base64');
      const png = await pdfDoc.embedPng(pngBytes);
      const dims = png.scaleToFit(SIG_WIDTH, SIG_HEIGHT);
      sigPage.drawImage(png, { x: PAGE_PADDING, y: y - dims.height, width: dims.width, height: dims.height });
      y -= dims.height;
    } catch {
      // Bad/empty PNG — skip the image but still log the typed name.
    }
    y -= 8;
    sigPage.drawLine({ start: { x: PAGE_PADDING, y }, end: { x: PAGE_PADDING + SIG_WIDTH, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 14;
    sigPage.drawText(`Name:  ${party.typed_name || party.signer_name}`, {
      x: PAGE_PADDING, y, size: 10, font: helv,
    });
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

  // Landlord auto-stamp (skip if the lease was created without a landlord sig).
  if (landlordSig && landlordSig.signature_png) {
    sigPage.drawText('LANDLORD SIGNATURE', {
      x: PAGE_PADDING, y, size: 9, font: helvBold, color: rgb(0.3, 0.3, 0.3),
    });
    y -= 8;
    try {
      const pngBytes = Buffer.from(stripDataUrl(landlordSig.signature_png), 'base64');
      const png = await pdfDoc.embedPng(pngBytes);
      const dims = png.scaleToFit(SIG_WIDTH, SIG_HEIGHT);
      sigPage.drawImage(png, { x: PAGE_PADDING, y: y - dims.height, width: dims.width, height: dims.height });
      y -= dims.height;
    } catch {}
    y -= 8;
    sigPage.drawLine({ start: { x: PAGE_PADDING, y }, end: { x: PAGE_PADDING + SIG_WIDTH, y }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    y -= 14;
    sigPage.drawText(`Name:  ${landlordSig.label}`, { x: PAGE_PADDING, y, size: 10, font: helv });
    y -= 14;
    sigPage.drawText(`Signed: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC (auto)`, {
      x: PAGE_PADDING, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4),
    });
  }

  // ── Certificate of Completion page ────────────────────────────────────────
  const cert = pdfDoc.addPage();
  let cy = height - PAGE_PADDING;
  cert.drawText('Certificate of Completion', {
    x: PAGE_PADDING, y: cy, size: 18, font: helvBold, color: rgb(0.1, 0.24, 0.56),
  });
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
      const ua = party.signer_ua.slice(0, 90);
      cert.drawText(`    Browser: ${ua}`, { x: PAGE_PADDING, y: cy, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
      cy -= 12;
    }
    cy -= 6;
  }

  if (landlordSig && landlordSig.signature_png) {
    cert.drawText(`• ${landlordSig.label} (Landlord, auto-signed)`, { x: PAGE_PADDING, y: cy, size: 10, font: helvBold });
    cy -= 16;
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

module.exports = { stampLease };
