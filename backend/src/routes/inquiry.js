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

// ---------------------------------------------------------------------------
// GET /list — paged list with optional search + filters
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      search, status, leadSourceId, source,
      unitId, propertyId, searchNotes,
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
      desired_start_date, budget, reminder_date, screenshot_url,
    } = req.body || {};

    if (!first_name && !last_name && !email && !phone) {
      return fail(res, 'At least one of name, email, or phone is required', 400);
    }

    const id = newId();
    await req.pool.execute(
      `INSERT INTO inquiry
         (id, org_id, inquiry_date, lead_source_id,
          first_name, last_name, email, phone, notes,
          unit_id, property_id, created_by_user_id, source, status,
          desired_start_date, budget, reminder_date, screenshot_url)
       VALUES (?, ?, COALESCE(?, NOW()), ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, 0,  ?, ?, ?, ?)`,
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
      'desired_start_date', 'budget', 'reminder_date', 'screenshot_url',
    ];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = ?`);
        let v = req.body[f];
        if (f === 'email' && v) v = String(v).trim().toLowerCase();
        else if (f === 'budget' && v !== '' && v !== null && v !== undefined) v = Number(v);
        else if (v === '' || v === undefined) v = null;
        params.push(v);
      }
    }
    // If reminder_date changed, clear reminder_sent_at so the new date will fire
    if (req.body.reminder_date !== undefined) {
      sets.push('reminder_sent_at = NULL');
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
