/**
 * Helpers over a lease's signature_request ledger — one row per period of the
 * tenancy, whether e-signed or recorded as signed on paper.
 *
 * Pure, and deliberately NOT inside routes/signature.js: that module requires
 * leasePdfRenderer, which requires puppeteer at load time and so cannot be
 * imported by the unit tests.
 */

/**
 * The lease's signature_status implied by its ledger.
 *
 * Cancelling a request used to hardcode 'none', which was fine when a lease had
 * a single document — but with a document per period that would erase "signed"
 * from a lease whose earlier period genuinely is signed.
 *
 * @param {Array} rows  [{ status }] — signature_request.status values
 * @returns {'signed'|'pending'|'none'}
 */
function nextSignatureStatus(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.some(r => Number(r.status) === 3)) return 'signed';
  if (list.some(r => Number(r.status) === 1 || Number(r.status) === 2)) return 'pending';
  return 'none';
}

module.exports = { nextSignatureStatus };
