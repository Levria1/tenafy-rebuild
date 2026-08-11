/**
 * Inquiry routes — lead capture separate from the contacts/tenant table.
 *
 * An inquiry is a prospective viewer/lead. Staff can either dismiss it,
 * promote it to a contact (tenant row), or schedule a viewing from it.
 *
 * Mounted at: /api/inquiry
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const visionClient = require('../services/visionClient');
const llmClient = require('../services/llmClient');
const {
  pairKey,
  normalizeReservationCode,
  isDuplicateCandidate,
  mergeFieldPlan,
  buildMergedNotes,
} = require('../utils/inquiryDuplicates');

router.use(authenticate);

// Multer setup for the screenshot upload on /parse. Saves to the same uploads
// dir as routes/file.js so the file table + /api/file/preview/:id flow works
// unchanged. 10 MB cap — screenshots from phones are usually under 5 MB.
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const screenshotStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are accepted'), false);
    }
    cb(null, true);
  },
});

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// Derived, never duplicated: this must stay identical to what the public fact API
// is allowed to write, or a human edit to a field missing from this list would not
// drop it from api_set_fields and the API could later overwrite the correction.
const {
  API_WRITABLE_FIELDS: API_WRITABLE_INQUIRY_FIELDS,
  validateFields,
} = require('../utils/inquiryFacts');
const MAX_MERGED_NOTES_BYTES = 60000;

function parseApiSetFields(apiSetFields) {
  if (Array.isArray(apiSetFields)) return apiSetFields.filter(f => typeof f === 'string');
  if (typeof apiSetFields !== 'string' || !apiSetFields.trim()) return [];
  try {
    const parsed = JSON.parse(apiSetFields);
    return Array.isArray(parsed) ? parsed.filter(f => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function snowflakeStringCompare(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return sa.length - sb.length;
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

function collapsePreview(value) {
  return value == null ? '' : String(value).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function normalizeOptionalReservationCode(value) {
  const result = validateFields({ reservation_code: value });
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, value: result.fields.reservation_code };
}

function normalizeLockedInquiryRow(row) {
  if (!row) return null;
  return {
    ...row,
    status: Number(row.status),
  };
}

// ---------------------------------------------------------------------------
// GET /list — paged list with optional search + filters
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      search, status, leadSourceId, source,
      unitId, propertyId, searchNotes,
      desiredStartFrom, desiredStartTo,
    } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let where = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      // When searchNotes=true is passed, broaden the search across notes as
      // well — used by the chatbot's search_inquiries tool to surface
      // prospects whose interest in a unit was captured only in the chat
      // diff log (e.g. "interested in unit B302").
      if (String(searchNotes) === 'true') {
        where += ` AND (i.first_name LIKE ? OR i.last_name LIKE ?
                       OR CONCAT(COALESCE(i.first_name,''),' ',COALESCE(i.last_name,'')) LIKE ?
                       OR i.email LIKE ? OR i.phone LIKE ?
                       OR i.notes LIKE ?)`;
        const s = '%' + search + '%';
        params.push(s, s, s, s, s, s);
      } else {
        where += ` AND (i.first_name LIKE ? OR i.last_name LIKE ?
                       OR CONCAT(COALESCE(i.first_name,''),' ',COALESCE(i.last_name,'')) LIKE ?
                       OR i.email LIKE ? OR i.phone LIKE ?)`;
        const s = '%' + search + '%';
        params.push(s, s, s, s, s);
      }
    }
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND i.status = ?';
      params.push(parseInt(status));
    }
    if (leadSourceId) {
      where += ' AND i.lead_source_id = ?';
      params.push(leadSourceId);
    }
    if (source) {
      where += ' AND i.source = ?';
      params.push(source);
    }
    if (unitId) {
      where += ' AND i.unit_id = ?';
      params.push(unitId);
    }
    if (propertyId) {
      where += ' AND i.property_id = ?';
      params.push(propertyId);
    }
    // Desired-move-in date range. Use this to triage prospects by when they
    // want to move in (e.g. "who's looking to move in July?"). Inclusive on
    // both ends; either bound can be omitted.
    if (desiredStartFrom) {
      where += ' AND i.desired_start_date >= ?';
      params.push(desiredStartFrom);
    }
    if (desiredStartTo) {
      where += ' AND i.desired_start_date <= ?';
      params.push(desiredStartTo);
    }

    const [rows] = await req.pool.execute(
      `SELECT i.*,
              ls.name AS lead_source_name,
              CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) AS created_by_name,
              u.email AS created_by_email,
              p.display_name AS property_name,
              un.name AS unit_name
       FROM inquiry i
       LEFT JOIN lead_source_setting ls ON i.lead_source_id = ls.id
       LEFT JOIN user u ON i.created_by_user_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit un ON i.unit_id = un.id
       WHERE ${where}
       ORDER BY i.inquiry_date DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) AS total FROM inquiry i WHERE ${where}`,
      params
    );

    ok(res, { content: rows, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page });
  } catch (err) {
    console.error('[inquiry] list error:', err);
    fail(res, 'Failed to list inquiries');
  }
});

// ---------------------------------------------------------------------------
// POST /parse — extract structured inquiry fields from free text and/or a
// screenshot. Pipeline:
//   1. If a screenshot was uploaded: save to disk + file table (same flow as
//      /api/file/upload), then run Google Cloud Vision OCR on the bytes.
//   2. Concatenate pasted text + OCR text.
//   3. Send to MiniMax (with OpenRouter fallback) and ask it to return a JSON
//      object with the inquiry form fields. JSON-only system prompt.
//   4. Return { fields: {...}, screenshot_url, raw_text } to the frontend so
//      it can prefill the form and attach the screenshot URL on save.
//
// Multipart fields:
//   - text  (optional, string)
//   - image (optional, file — png/jpg/webp, max 10 MB)
//
// At least one of `text` or `image` must be provided.
// ---------------------------------------------------------------------------
router.post('/parse', (req, res, next) => {
  // Wrap multer so size/MIME errors return a clean 4xx instead of a 500.
  screenshotUpload.single('image')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ code: 413, message: 'Screenshot too large (max 10 MB).' });
    }
    return res.status(400).json({ code: 400, message: err.message || 'Upload failed' });
  });
}, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const pastedText = (req.body && req.body.text ? String(req.body.text) : '').trim();
    const hasImage = !!req.file;

    if (!pastedText && !hasImage) {
      return fail(res, 'Provide either text or an image (or both).', 400);
    }

    // --- 1. If image: save to file table and OCR it ------------------------
    let screenshotUrl = null;
    let ocrText = '';
    if (hasImage) {
      const savedFilename = req.file.filename;
      const originalName  = req.file.originalname;
      const ext           = path.extname(originalName);
      const mimeType      = req.file.mimetype || 'application/octet-stream';
      const fileSize      = req.file.size;
      const fileId        = newId();

      await req.pool.execute(
        'INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [fileId, savedFilename, originalName, ext.replace('.', ''), mimeType.toUpperCase(), fileSize, 'local', orgId]
      );
      screenshotUrl = '/api/file/preview/' + fileId;

      try {
        const bytes = fs.readFileSync(req.file.path);
        ocrText = await visionClient.extractText(bytes);
      } catch (visionErr) {
        console.error('[inquiry/parse] Vision OCR failed:', visionErr.message);
        // Don't fail the whole request — return what we have. If there's no
        // pasted text either, the LLM step will yield empty fields, and we
        // still want the user to get the saved screenshot URL.
      }
    }

    // --- 2. Build the combined source text ----------------------------------
    const combined = [pastedText, ocrText].filter(Boolean).join('\n\n--- OCR FROM SCREENSHOT ---\n');
    if (!combined.trim()) {
      return ok(res, { fields: {}, screenshot_url: screenshotUrl, raw_text: '' });
    }

    // --- 3. Ask the LLM to extract structured fields ------------------------
    // Schema is fixed to what /inquiries/create renders. The LLM is told to
    // return STRICT JSON only — no prose, no markdown fences — so we can
    // JSON.parse the content directly.
    const systemPrompt = [
      'You extract rental-inquiry information from messy chat/screenshot text into JSON.',
      'The text may be in English, Cantonese, Mandarin, or any mix of those.',
      'Return ONLY a JSON object with these keys (omit a key if you cannot find it):',
      '  first_name        (string)',
      '  last_name         (string)',
      '  email             (string, lowercase, validated-looking)',
      '  phone             (string, digits only; strip +852, spaces, dashes)',
      '  budget            (number, HKD per month; infer from "20k", "$25,000/mo", "two five")',
      '  desired_start_date (string, YYYY-MM-DD)',
      '  notes             (string, a short 1-3 sentence summary in English of what the prospect wants)',
      'Do NOT include any other keys. Do NOT include explanatory prose. Output a single JSON object only.',
    ].join('\n');

    let fields = {};
    try {
      const llmResp = await llmClient.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: combined.slice(0, 8000) }, // generous cap to keep token cost predictable
        ],
        null,
        { temperature: 0.1 }
      );
      const raw = (llmResp.message && llmResp.message.content) || '';
      // Strip ```json ... ``` fences if the model added them despite instructions.
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try {
        fields = JSON.parse(cleaned);
      } catch (parseErr) {
        console.warn('[inquiry/parse] LLM did not return valid JSON; raw:', raw.slice(0, 300));
      }
    } catch (llmErr) {
      console.error('[inquiry/parse] LLM call failed:', llmErr.message);
      // Surface partial success — screenshot is still saved, raw OCR is in
      // raw_text, the user can just fill the form by hand.
    }

    ok(res, {
      fields: fields || {},
      screenshot_url: screenshotUrl,
      raw_text: combined,
    });
  } catch (err) {
    console.error('[inquiry] parse error:', err);
    fail(res, 'Failed to parse inquiry');
  }
});

// ---------------------------------------------------------------------------
// GET /:id/possible-duplicates
// ---------------------------------------------------------------------------
router.get('/:id/possible-duplicates', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [subjectRows] = await req.pool.execute(
      `SELECT id, first_name, last_name, unit_id, reservation_code, status, deleted_at
       FROM inquiry
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL
       LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!subjectRows.length) return fail(res, 'Inquiry not found', 404);

    const subject = normalizeLockedInquiryRow(subjectRows[0]);
    const subjectUnitId = subject.unit_id === null || subject.unit_id === undefined || subject.unit_id === ''
      ? null
      : subject.unit_id;
    const subjectReservationCode = normalizeReservationCode(subject.reservation_code) || null;
    if (subjectUnitId === null && subjectReservationCode === null) {
      return ok(res, { candidates: [] });
    }

    const [rows] = await req.pool.execute(
      `SELECT i.id, i.first_name, i.last_name, i.email, i.phone, i.source, i.status,
              i.created_at, i.inquiry_date,
              DATE_FORMAT(i.desired_start_date, '%Y-%m-%d') AS desired_start_date,
              DATE_FORMAT(i.desired_end_date, '%Y-%m-%d') AS desired_end_date,
              i.nightly_rate, i.stay_total, i.unit_id, i.property_id, i.reservation_code, i.notes,
              i.deleted_at,
              un.name AS unit_name,
              p.display_name AS property_name
       FROM inquiry i
       LEFT JOIN unit un ON i.unit_id = un.id
       LEFT JOIN property p ON i.property_id = p.id
       WHERE i.org_id = ?
         AND i.deleted_at IS NULL
         AND i.status = 0
         AND ( (? IS NOT NULL AND i.unit_id = ?)
            OR (? IS NOT NULL AND i.reservation_code = ?) )
         AND i.id <> ?
       ORDER BY i.inquiry_date DESC`,
      [orgId, subjectUnitId, subjectUnitId, subjectReservationCode, subjectReservationCode, req.params.id]
    );

    const candidates = [];
    const pairKeys = rows.map(row => pairKey(subject.id, row.id));
    const dismissedKeys = new Set();
    if (pairKeys.length) {
      const [dismissedRows] = await req.pool.execute(
        `SELECT pair_key
         FROM inquiry_duplicate_dismissal
         WHERE org_id = ? AND pair_key IN (${pairKeys.map(() => '?').join(', ')})`,
        [orgId, ...pairKeys]
      );
      for (const row of dismissedRows) dismissedKeys.add(row.pair_key);
    }

    for (const row of rows) {
      const candidate = normalizeLockedInquiryRow(row);
      const key = pairKey(subject.id, candidate.id);
      if (dismissedKeys.has(key)) continue;
      const duplicateResult = isDuplicateCandidate(subject, candidate);
      if (!duplicateResult.isCandidate) continue;
      const { notes, deleted_at, property_id, ...out } = candidate;
      candidates.push({
        ...out,
        property_id,
        reason: duplicateResult.reason,
        notes_preview: collapsePreview(notes),
      });
    }

    ok(res, { candidates });
  } catch (err) {
    console.error('[inquiry] possible-duplicates error:', err);
    fail(res, 'Failed to load possible duplicates');
  }
});

// ---------------------------------------------------------------------------
// POST /:id/merge
// ---------------------------------------------------------------------------
router.post('/:id/merge', async (req, res) => {
  const survivorId = String(req.params.id);
  const loserId = req.body?.from_inquiry_id != null ? String(req.body.from_inquiry_id) : '';
  if (!loserId) return fail(res, 'from_inquiry_id is required', 400);
  if (loserId === survivorId) return fail(res, 'Cannot merge an inquiry into itself', 400);

  const orgId = req.user.orgId;
  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();

    const locked = new Map();
    const lockOrder = [survivorId, loserId].sort(snowflakeStringCompare);
    for (const inquiryId of lockOrder) {
      const [rows] = await conn.execute(
        `SELECT id, org_id, first_name, last_name, email, phone, notes, unit_id, property_id,
                reservation_code,
                tenant_id, status, deleted_at, budget,
                DATE_FORMAT(desired_start_date, '%Y-%m-%d') AS desired_start_date,
                DATE_FORMAT(desired_end_date, '%Y-%m-%d') AS desired_end_date,
                nightly_rate, stay_total
         FROM inquiry
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL
         LIMIT 1
         FOR UPDATE`,
        [inquiryId, orgId]
      );
      if (rows.length) locked.set(inquiryId, normalizeLockedInquiryRow(rows[0]));
    }

    const survivor = locked.get(survivorId);
    const loser = locked.get(loserId);
    if (!survivor || !loser) {
      await conn.rollback();
      return fail(res, 'Inquiry not found', 404);
    }
    if (survivor.status !== 0 || loser.status !== 0) {
      await conn.rollback();
      return fail(res, 'Both inquiries must be open to merge', 409);
    }
    if (survivor.tenant_id !== null || loser.tenant_id !== null) {
      await conn.rollback();
      return fail(res, 'Converted inquiries cannot be merged', 409);
    }

    const candidate = isDuplicateCandidate(survivor, loser);
    if (!candidate.isCandidate) {
      await conn.rollback();
      return fail(res, `Inquiries are not duplicate candidates: ${candidate.reason}`, 409);
    }

    const [[dateRow]] = await conn.execute("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
    const dateStr = dateRow.today;
    const fieldPlan = mergeFieldPlan(survivor, loser);
    const notesPlan = buildMergedNotes(survivor.notes, loser.notes, loserId, dateStr);
    let notesAppended = false;
    if (notesPlan.appended) {
      if (Buffer.byteLength(notesPlan.notes, 'utf8') <= MAX_MERGED_NOTES_BYTES) {
        fieldPlan.values.notes = notesPlan.notes;
        notesAppended = true;
      } else {
        console.warn(`[inquiry/merge] notes append skipped for ${loserId} into ${survivorId}: merged notes exceed ${MAX_MERGED_NOTES_BYTES} bytes`);
      }
    }

    const survivorSets = Object.keys(fieldPlan.values);
    if (survivorSets.length) {
      await conn.execute(
        `UPDATE inquiry SET ${survivorSets.map(f => `${f} = ?`).join(', ')}
         WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
        [...survivorSets.map(f => fieldPlan.values[f]), survivorId, orgId]
      );
    }

    const [sessionResult] = await conn.execute(
      'UPDATE chat_session SET inquiry_id = ? WHERE inquiry_id = ?',
      [survivorId, loserId]
    );
    const sessionsMoved = sessionResult.affectedRows || 0;

    // Closing the loser is the load-bearing half; the breadcrumb is a nicety. Cap it the
    // same way the survivor's notes are capped, so an inquiry with a full notes column
    // still merges instead of dying on "Data too long" and rolling the whole thing back.
    const loserLine = `Merged into inquiry ${survivorId} on ${dateStr}`;
    const loserNotes = loser.notes == null || loser.notes === ''
      ? loserLine
      : `${String(loser.notes).trimEnd()}\n\n${loserLine}`;
    const loserNotesFit = Buffer.byteLength(loserNotes, 'utf8') <= MAX_MERGED_NOTES_BYTES;
    if (!loserNotesFit) {
      console.warn(`[inquiry/merge] breadcrumb skipped on ${loserId}: notes at capacity`);
    }
    await conn.execute(
      loserNotesFit
        ? `UPDATE inquiry SET status = 2, notes = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
        : `UPDATE inquiry SET status = 2 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      loserNotesFit ? [loserNotes, loserId, orgId] : [loserId, orgId]
    );

    // An explicit shim, not `{ ...req }`: spreading an Express request copies only own
    // enumerable properties, so what logActivity receives depends on Node internals.
    // `conn` rather than the pool keeps the audit row inside the merge transaction.
    await logActivity(
      { pool: conn, user: req.user, headers: req.headers },
      'MERGE',
      'INQUIRY',
      survivorId,
      `Merged inquiry ${loserId} into ${survivorId}`
    );
    await conn.commit();

    ok(res, {
      survivor_id: survivorId,
      merged_from_id: loserId,
      filled_fields: fieldPlan.filled,
      notes_appended: notesAppended,
      sessions_moved: sessionsMoved,
    });
  } catch (err) {
    try { await conn.rollback(); } catch { /* already rolled back */ }
    console.error('[inquiry] merge error:', err);
    fail(res, 'Failed to merge inquiries');
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// POST /:id/dismiss-duplicate
// ---------------------------------------------------------------------------
router.post('/:id/dismiss-duplicate', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const otherId = req.body?.other_inquiry_id != null ? String(req.body.other_inquiry_id) : '';
    if (!otherId) return fail(res, 'other_inquiry_id is required', 400);
    // IN (?, ?) with the same id twice returns one row, which would surface as a
    // confusing 404 rather than the real problem.
    if (otherId === String(req.params.id)) return fail(res, 'Cannot dismiss an inquiry against itself', 400);

    const [rows] = await req.pool.execute(
      `SELECT id
       FROM inquiry
       WHERE org_id = ? AND deleted_at IS NULL AND id IN (?, ?)`,
      [orgId, req.params.id, otherId]
    );
    if (rows.length !== 2) return fail(res, 'Inquiry not found', 404);

    const key = pairKey(req.params.id, otherId);
    await req.pool.execute(
      `INSERT INTO inquiry_duplicate_dismissal
         (id, org_id, pair_key, inquiry_id, other_inquiry_id, dismissed_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [newId(), orgId, key, req.params.id, otherId, req.user.id || null]
    );

    ok(res, { dismissed: true, pair_key: key });
  } catch (err) {
    console.error('[inquiry] dismiss-duplicate error:', err);
    fail(res, 'Failed to dismiss duplicate');
  }
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT i.*,
              ls.name AS lead_source_name,
              CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) AS created_by_name,
              u.email AS created_by_email,
              p.display_name AS property_name,
              un.name AS unit_name
       FROM inquiry i
       LEFT JOIN lead_source_setting ls ON i.lead_source_id = ls.id
       LEFT JOIN user u ON i.created_by_user_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit un ON i.unit_id = un.id
       WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL
       LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!rows.length) return fail(res, 'Inquiry not found', 404);

    // Linked viewings
    const [viewings] = await req.pool.execute(
      `SELECT vb.id, vb.proposed_datetime, vb.duration_minutes, vb.status,
              vb.tenant_decision, vb.employee_decision,
              p.display_name AS property_name, un.name AS unit_name
       FROM viewing_booking vb
       LEFT JOIN property p ON vb.property_id = p.id
       LEFT JOIN unit un ON vb.unit_id = un.id
       WHERE vb.inquiry_id = ?
       ORDER BY vb.proposed_datetime DESC`,
      [req.params.id]
    );

    ok(res, { ...rows[0], viewings });
  } catch (err) {
    console.error('[inquiry] get error:', err);
    fail(res, 'Failed to load inquiry');
  }
});

// ---------------------------------------------------------------------------
// POST / — create an inquiry (manual entry by staff)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const {
      inquiry_date, lead_source_id, first_name, last_name,
      email, phone, notes, unit_id, property_id, source,
      desired_start_date, budget, reminder_date, screenshot_url, reservation_code,
    } = req.body || {};

    if (!first_name && !last_name && !email && !phone) {
      return fail(res, 'At least one of name, email, or phone is required', 400);
    }
    const reservationCodeResult = validateFields({ reservation_code });
    if (!reservationCodeResult.ok) return fail(res, reservationCodeResult.error, 400);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO inquiry
         (id, org_id, inquiry_date, lead_source_id,
          first_name, last_name, email, phone, notes,
          unit_id, property_id, created_by_user_id, source, status,
          desired_start_date, budget, reminder_date, screenshot_url, reservation_code)
       VALUES (?, ?, COALESCE(?, NOW()), ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, 0,  ?, ?, ?, ?, ?)`,
      [
        id, orgId, inquiry_date || null, lead_source_id || null,
        first_name || null, last_name || null,
        email ? String(email).trim().toLowerCase() : null,
        phone || null, notes || null,
        unit_id || null, property_id || null,
        userId, source || 'manual',
        desired_start_date || null,
        budget !== undefined && budget !== '' && budget !== null ? Number(budget) : null,
        reminder_date || null,
        screenshot_url || null,
        reservationCodeResult.fields.reservation_code,
      ]
    );

    logActivity(req, { action: 'CREATE', entityType: 'INQUIRY', entityId: id }).catch(() => {});
    ok(res, { id });
  } catch (err) {
    console.error('[inquiry] create error:', err);
    fail(res, 'Failed to create inquiry');
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — update
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const fields = [
      'inquiry_date', 'lead_source_id', 'first_name', 'last_name',
      'email', 'phone', 'notes', 'unit_id', 'property_id', 'status',
      'reservation_code',
      'desired_start_date', 'desired_end_date', 'budget', 'nightly_rate', 'stay_total',
      'reminder_date', 'screenshot_url',
    ];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = ?`);
        let v = req.body[f];
        if (f === 'email' && v) v = String(v).trim().toLowerCase();
        else if (f === 'reservation_code') {
          const reservationCodeResult = normalizeOptionalReservationCode(v);
          if (!reservationCodeResult.ok) return fail(res, reservationCodeResult.error, 400);
          v = reservationCodeResult.value;
        }
        else if (f === 'budget' && v !== '' && v !== null && v !== undefined) v = Number(v);
        else if (v === '' || v === undefined) v = null;
        params.push(v);
      }
    }
    // If reminder_date changed, clear reminder_sent_at so the new date will fire
    if (req.body.reminder_date !== undefined) {
      sets.push('reminder_sent_at = NULL');
    }
    // A human editing one of the API-writable fields must drop it from
    // api_set_fields permanently, so the API can never overwrite their value.
    //
    // Done with JSON_REMOVE inside the UPDATE rather than SELECT-then-rewrite: the
    // old shape read the column outside any lock and then rewrote it whole, so a
    // /inquiry/facts transaction committing in between had its provenance clobbered
    // — permanently locking the API out of a field the human never touched.
    const humanFields = Object.keys(req.body || {}).filter(f => API_WRITABLE_INQUIRY_FIELDS.has(f));
    if (humanFields.length) {
      let expr = 'api_set_fields';
      for (const field of humanFields) {
        // JSON_SEARCH returns NULL when absent, and JSON_REMOVE(x, NULL) is NULL —
        // so COALESCE back to the untouched value for fields not in the list.
        expr = `COALESCE(JSON_REMOVE(${expr}, JSON_UNQUOTE(JSON_SEARCH(${expr}, 'one', ?))), ${expr})`;
        params.push(field);
      }
      sets.push(`api_set_fields = ${expr}`);
    }
    if (!sets.length) return fail(res, 'No fields to update', 400);
    params.push(req.params.id, orgId);

    const [r] = await req.pool.execute(
      `UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      params
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);

    logActivity(req, { action: 'UPDATE', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { updated: true });
  } catch (err) {
    console.error('[inquiry] update error:', err);
    fail(res, 'Failed to update inquiry');
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [r] = await req.pool.execute(
      'UPDATE inquiry SET deleted_at = NOW() WHERE id = ? AND org_id = ?',
      [req.params.id, orgId]
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);
    logActivity(req, { action: 'DELETE', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { deleted: true });
  } catch (err) {
    console.error('[inquiry] delete error:', err);
    fail(res, 'Failed to delete inquiry');
  }
});

// ---------------------------------------------------------------------------
// POST /:id/link-contact
//
// Links an EXISTING tenant id to this inquiry. Used by the tenant-create
// flow when the inquiry's "Create Contact" button routes to the tenant
// create form (rather than auto-creating a tenant): once the user submits
// the form and the tenant exists, the frontend calls this endpoint to
// stamp the inquiry.tenant_id and flip status to 1 (converted).
//
// Body: { tenant_id }
// ---------------------------------------------------------------------------
router.post('/:id/link-contact', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { tenant_id } = req.body || {};
    if (!tenant_id) return fail(res, 'tenant_id is required', 400);

    // Verify tenant belongs to this org.
    const [t] = await req.pool.execute(
      'SELECT id FROM tenant WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
      [tenant_id, orgId]
    );
    if (!t.length) return fail(res, 'Tenant not found', 404);

    const [r] = await req.pool.execute(
      'UPDATE inquiry SET tenant_id = ?, status = 1 WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [tenant_id, req.params.id, orgId]
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);

    logActivity(req, { action: 'LINK_CONTACT', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { tenant_id: String(tenant_id) });
  } catch (err) {
    console.error('[inquiry] link-contact error:', err);
    fail(res, 'Failed to link contact');
  }
});

module.exports = router;
