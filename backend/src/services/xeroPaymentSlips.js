const { createHash, randomUUID } = require('node:crypto');
const vision = require('./visionClient');
const { currencyDigits, decimalMinor } = require('./xeroBrowserLookup');

const MAX_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fieldsSql = `s.id,s.file_name,s.mime_type,s.source_channel,s.source_reference,s.ocr_state,
  s.currency,s.amount_minor,DATE_FORMAT(s.transfer_date,'%Y-%m-%d') AS transfer_date,
  s.payer,s.transfer_reference,s.verified_at`;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function clean(value, max) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

function fileType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return ['image/png', 'png'];
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return ['image/jpeg', 'jpg'];
  if (bytes.subarray(0, 5).toString() === '%PDF-') return ['application/pdf', 'pdf'];
  fail('Choose a PNG, JPEG or PDF deposit slip.', 415);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return date.getUTCFullYear() >= 2000 && date.getUTCFullYear() < 2100 && date.toISOString().slice(0, 10) === value;
}

function suggestions(text) {
  // Leave unreadable or ambiguous values blank. OCR never verifies a payment.
  const unique = regex => {
    const matches = [...new Set([...text.matchAll(regex)].map(match => match[1].trim()))];
    return matches.length === 1 ? matches[0] : null;
  };
  const currency = unique(/\b(HKD|USD|EUR|GBP|SGD|JPY|CNY|AUD|CAD|CHF|NZD)\b/gi)?.toUpperCase() || null;
  const rawAmount = unique(/^\s*(?:transfer amount|payment amount|amount paid|amount)\s*[:：]?\s*(?:[A-Z]{3}|HK\$|\$)?\s*([0-9][0-9,.]*)\s*(?:[A-Z]{3})?\s*$/gim);
  const date = unique(/^\s*(?:transfer date|payment date|transaction date|date)\s*[:：]?\s*(\d{4}-\d{2}-\d{2})\s*$/gim);
  let amount = null;
  if (currency && rawAmount && /^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(rawAmount)) {
    try { amount = decimalMinor(rawAmount.replaceAll(',', ''), currencyDigits(currency)); } catch { /* Manual review. */ }
  }
  return {
    currency, amount_minor: amount, transfer_date: validDate(date) ? date : null,
    payer: clean(unique(/^\s*(?:payer|sender|remitter)\s*[:：]\s*([^\r\n]+)$/gim), 180) || null,
    transfer_reference: clean(unique(/^\s*(?:transaction reference|transfer reference|reference)\s*[:：]\s*([^\r\n]+)$/gim), 180) || null,
  };
}

function verifiedFields(body) {
  if (!body || body.confirmed !== true) fail('Confirm the details against the original slip.');
  const currency = String(body.currency || '').toUpperCase();
  const digits = currencyDigits(currency);
  const raw = body.amount;
  if (typeof raw !== 'string' || !/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) fail('Enter the exact transfer amount.');
  const amount = decimalMinor(raw.replaceAll(',', ''), digits);
  if (!amount || amount > 99999999999999 || !validDate(body.transfer_date)) fail('Enter a valid transfer amount and date.');
  return [currency, amount, body.transfer_date, clean(body.payer, 180) || null, clean(body.transfer_reference, 180) || null];
}

async function getSlip(pool, org, id, includeOcr = false) {
  if (!UUID.test(id)) fail('Invalid slip ID.');
  const [[row]] = await pool.execute(`SELECT ${fieldsSql}${includeOcr ? ',s.ocr_text' : ''}
    FROM xero_payment_slip s WHERE s.org_id=? AND s.id=?`, [org,id]);
  if (!row) fail('Slip not found.', 404);
  return row;
}

async function importSlip(pool, org, user, file, body, ocr = vision) {
  const bytes = file?.buffer;
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > MAX_BYTES) fail('Upload one file up to 5 MB.');
  const [mime, ext] = fileType(bytes);
  if (file.mimetype && file.mimetype !== mime && file.mimetype !== 'application/octet-stream') fail('File content does not match its type.', 415);
  const channel = body?.source_channel;
  if (!['email', 'whatsapp', 'other'].includes(channel)) fail('Choose the slip source.');
  const hash = createHash('sha256').update(bytes).digest();
  const id = randomUUID();
  const name = clean(file.originalname, 150).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9 _.-]/g, '_') || 'payment-slip';
  const [insert] = await pool.execute(`INSERT INTO xero_payment_slip
      (id,org_id,sha256,file_name,mime_type,original,source_channel,source_reference,imported_by)
    VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,
  [id,org,hash,`${name}.${ext}`,mime,bytes,channel,clean(body.source_reference,255)||null,user]);
  const [[saved]] = await pool.execute('SELECT id FROM xero_payment_slip WHERE org_id=? AND sha256=?',[org,hash]);
  if (insert.affectedRows === 1 && saved.id === id) {
    let text = '';
    try { text = String(await (mime === 'application/pdf' ? ocr.extractPdfText(bytes) : ocr.extractText(bytes)) || '').trim().slice(0,12000); }
    catch { /* Preserve the original for staff to review. */ }
    const draft = suggestions(text);
    await pool.execute(`UPDATE xero_payment_slip SET ocr_state=?,ocr_text=?,currency=?,amount_minor=?,
      transfer_date=?,payer=?,transfer_reference=? WHERE org_id=? AND id=? AND verified_at IS NULL`,
    [text ? 'extracted' : 'needs_review',text||null,draft.currency,draft.amount_minor,draft.transfer_date,
      draft.payer,draft.transfer_reference,org,id]);
  }
  return getSlip(pool,org,saved.id,true);
}

async function verify(pool, org, id, user, body) {
  await getSlip(pool,org,id);
  const [result] = await pool.execute(`UPDATE xero_payment_slip SET currency=?,amount_minor=?,transfer_date=?,
    payer=?,transfer_reference=?,verified_by=?,verified_at=NOW() WHERE org_id=? AND id=? AND verified_at IS NULL`,
  [...verifiedFields(body), user, org,id]);
  if (result.affectedRows !== 1) fail('This slip has already been verified.',409);
  return getSlip(pool,org,id);
}

async function candidates(pool, org, mapping, statement) {
  const [rows] = await pool.execute(`SELECT ${fieldsSql},r.invoice_id,r.reviewed_at
    FROM xero_payment_slip s LEFT JOIN xero_payment_slip_review r ON r.org_id=s.org_id AND r.slip_id=s.id
    WHERE s.org_id=? AND s.verified_at IS NOT NULL AND s.currency=? AND s.amount_minor=?
    AND s.transfer_date BETWEEN DATE_SUB(?,INTERVAL 7 DAY) AND DATE_ADD(?,INTERVAL 7 DAY)
    AND (r.slip_id IS NULL OR (r.xero_account_id=? AND r.statement_id=?))
    ORDER BY ABS(DATEDIFF(s.transfer_date,?)),s.id LIMIT 10`,
  [org,statement.currency,statement.amount_minor,statement.date,statement.date,mapping.xero_account_id,statement.id_suffix,statement.date]);
  return rows;
}

async function original(pool,org,id) {
  if (!UUID.test(id)) fail('Invalid slip ID.');
  const [[file]] = await pool.execute(`SELECT file_name AS name,mime_type AS type,original AS bytes,HEX(sha256) AS hash
    FROM xero_payment_slip WHERE org_id=? AND id=?`,[org,id]);
  if (!file) fail('Slip not found.',404);
  if (createHash('sha256').update(file.bytes).digest('hex') !== file.hash.toLowerCase()) fail('Slip data could not be verified.',409);
  return file;
}

async function approve(pool, org, user, id, mapping, statement, invoiceId) {
  const list = await candidates(pool,org,mapping,statement);
  if (!list.some(slip=>slip.id===id)) fail('This slip does not match this bank line or has already been used.',409);
  await pool.execute(`INSERT INTO xero_payment_slip_review
    (org_id,slip_id,xero_account_id,statement_id,invoice_id,reviewed_by)
    VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE slip_id=slip_id`,
  [org,id,mapping.xero_account_id,statement.id_suffix,invoiceId,user]);
  const [[review]] = await pool.execute(`SELECT xero_account_id,statement_id,invoice_id
    FROM xero_payment_slip_review WHERE org_id=? AND slip_id=?`,[org,id]);
  if (review?.xero_account_id!==mapping.xero_account_id || review.statement_id!==statement.id_suffix ||
      String(review.invoice_id)!==String(invoiceId)) fail('This slip is already confirmed for a different match.',409);
  return original(pool,org,id);
}

module.exports = { MAX_BYTES, importSlip, getSlip, verify, candidates, original, approve, suggestions };
