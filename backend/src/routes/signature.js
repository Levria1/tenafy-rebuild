/**
 * E-signature routes. Mounted at /api/signature.
 *
 * Two surfaces:
 *   - Authenticated admin routes for staff (create/list/get/cancel/resend +
 *     landlord-signature CRUD).
 *   - Public token-routes under /public/* for signers (no auth) — let signers
 *     view the PDF and submit their signature without logging in.
 *
 * Stamping + email sending happens in services/signatureStamper.js and the
 * mailer; this file orchestrates the state machine.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate } = require('../middleware/auth');
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const { logActivity } = require('../utils/activityLog');
const renderer = require('../services/leasePdfRenderer');
const stamper = require('../services/signatureStamper');
const { sendMail } = require('../config/mailer');
const config = require('../config');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDLORD SIGNATURES (Settings → Landlord Signatures)
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/signature/landlord-signatures
router.get('/landlord-signatures', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT id, label, signature_png, is_default, created_at
         FROM landlord_signature
        WHERE org_id = ? AND deleted_at IS NULL AND status = 1
        ORDER BY is_default DESC, created_at DESC`,
      [orgId]
    );
    ok(res, rows);
  } catch (err) {
    console.error('[signature/landlord-sig] list error:', err);
    fail(res, 'Failed to load landlord signatures');
  }
});

// POST /api/signature/landlord-signatures
//   body: { label, signature_png, is_default? }
//   signature_png expected as base64 data URL ("data:image/png;base64,...")
router.post('/landlord-signatures', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const { label, signature_png, is_default } = req.body || {};
    if (!label || !label.trim()) return fail(res, 'Label is required', 400);
    if (!signature_png) return fail(res, 'Signature image is required', 400);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO landlord_signature (id, org_id, label, signature_png, is_default, status, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, orgId, label.trim(), signature_png, is_default ? 1 : 0, userId || null]
    );
    if (is_default) {
      await req.pool.execute(
        `UPDATE landlord_signature SET is_default = 0
          WHERE org_id = ? AND id != ? AND deleted_at IS NULL`,
        [orgId, id]
      );
    }
    ok(res, { id });
  } catch (err) {
    console.error('[signature/landlord-sig] create error:', err);
    fail(res, 'Failed to save signature');
  }
});

// PUT /api/signature/landlord-signatures/:id — update label and/or is_default
router.put('/landlord-signatures/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { id } = req.params;
    const { label, is_default, signature_png } = req.body || {};
    const sets = [];
    const params = [];
    if (label !== undefined) { sets.push('label = ?'); params.push(String(label).trim()); }
    if (signature_png !== undefined) { sets.push('signature_png = ?'); params.push(signature_png); }
    if (is_default !== undefined) { sets.push('is_default = ?'); params.push(is_default ? 1 : 0); }
    if (!sets.length) return fail(res, 'No fields to update', 400);
    params.push(id, orgId);
    await req.pool.execute(
      `UPDATE landlord_signature SET ${sets.join(', ')} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      params
    );
    if (is_default) {
      await req.pool.execute(
        `UPDATE landlord_signature SET is_default = 0
          WHERE org_id = ? AND id != ? AND deleted_at IS NULL`,
        [orgId, id]
      );
    }
    ok(res, { updated: true });
  } catch (err) {
    console.error('[signature/landlord-sig] update error:', err);
    fail(res, 'Failed to update signature');
  }
});

// DELETE /api/signature/landlord-signatures/:id — soft delete
router.delete('/landlord-signatures/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    await req.pool.execute(
      `UPDATE landlord_signature SET deleted_at = NOW(), status = 0
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [req.params.id, orgId]
    );
    ok(res, { deleted: true });
  } catch (err) {
    console.error('[signature/landlord-sig] delete error:', err);
    fail(res, 'Failed to delete signature');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SIGNATURE REQUESTS — admin
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/signature/request — create a request for a lease + send emails
//   body: {
//     lease_id, template_id, landlord_signature_id?,
//     parties: [{ signer_name, signer_email, role? }],
//     message?, expires_in_days?
//   }
router.post('/request', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const { lease_id, template_id, landlord_signature_id,
            parties, message, expires_in_days } = req.body || {};
    if (!lease_id || !template_id) return fail(res, 'lease_id and template_id are required', 400);
    if (!Array.isArray(parties) || parties.length === 0) return fail(res, 'At least one signer is required', 400);

    // Render the unsigned lease PDF using the template + lease data. Store it
    // in the file table so we can re-serve it for the signer (no auth needed
    // since the file is gated by the unique party token).
    const { pdfBuffer, templateId, version } = await renderer.renderFromTemplate({
      pool: req.pool, orgId, leaseId: lease_id, templateId: template_id,
    });

    // Save PDF to uploads + file row
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const savedName = uuidv4() + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedName), pdfBuffer);
    const fileId = newId();
    await req.pool.execute(
      `INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at)
       VALUES (?, ?, ?, 'pdf', 'APPLICATION/PDF', ?, 'local', ?, NOW())`,
      [fileId, savedName, `lease-for-signing-${lease_id}.pdf`, pdfBuffer.length, orgId]
    );

    // Resolve landlord signature: explicit > property default > org default.
    let resolvedLandlordSigId = landlord_signature_id || null;
    if (!resolvedLandlordSigId) {
      const [[lease]] = await req.pool.execute(
        `SELECT u.property_id, p.default_landlord_signature_id
           FROM leasing l JOIN unit u ON l.unit_id = u.id
           JOIN property p ON u.property_id = p.id
          WHERE l.id = ? LIMIT 1`,
        [lease_id]
      );
      resolvedLandlordSigId = (lease && lease.default_landlord_signature_id) || null;
    }
    if (!resolvedLandlordSigId) {
      const [[def]] = await req.pool.execute(
        `SELECT id FROM landlord_signature
          WHERE org_id = ? AND is_default = 1 AND deleted_at IS NULL LIMIT 1`,
        [orgId]
      );
      resolvedLandlordSigId = def ? def.id : null;
    }

    // Insert the signature_request
    const requestId = newId();
    const token = newToken();
    const expiresAt = expires_in_days
      ? new Date(Date.now() + Number(expires_in_days) * 86400000)
      : new Date(Date.now() + 14 * 86400000);

    await req.pool.execute(
      `INSERT INTO signature_request
         (id, org_id, lease_id, template_id, template_version, original_file_id,
          landlord_signature_id, token, status, message, expires_at, sent_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), ?)`,
      [requestId, orgId, lease_id, templateId, version, fileId,
       resolvedLandlordSigId, token, message || null, expiresAt, userId || null]
    );

    // Insert signature_party rows
    const inserted = [];
    for (let i = 0; i < parties.length; i++) {
      const p = parties[i];
      const partyId = newId();
      const partyToken = newToken();
      await req.pool.execute(
        `INSERT INTO signature_party
           (id, request_id, party_token, signer_name, signer_email, role, sort_order, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [partyId, requestId, partyToken,
         String(p.signer_name || '').trim() || 'Signer',
         (p.signer_email || '').trim().toLowerCase() || null,
         p.role || 'tenant', i]
      );
      inserted.push({ id: partyId, party_token: partyToken, signer_name: p.signer_name, signer_email: p.signer_email });
    }

    // Update lease.signature_status = 'pending'
    await req.pool.execute(
      `UPDATE leasing SET signature_status = 'pending' WHERE id = ?`,
      [lease_id]
    );

    // Audit event
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, ip, user_agent, metadata)
       VALUES (?, ?, 'sent', ?, ?, ?)`,
      [newId(), requestId, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500),
       JSON.stringify({ parties: inserted.length, expires_at: expiresAt })]
    );

    // Fire email to each party (fire-and-forget)
    for (const p of inserted) {
      if (!p.signer_email) continue;
      const link = `${config.frontendUrl}/sign/${p.party_token}`;
      sendMail({
        to: p.signer_email,
        subject: `Lease signature requested — please sign`,
        html: `
          <p>Hi ${p.signer_name},</p>
          <p>You have a lease awaiting your signature.</p>
          ${message ? `<p>${String(message).replace(/</g, '&lt;')}</p>` : ''}
          <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1677ff;color:#fff;text-decoration:none;border-radius:4px">Review &amp; Sign</a></p>
          <p style="color:#666;font-size:12px">Or copy this link into your browser:<br>${link}</p>
          <p style="color:#999;font-size:11px">Link expires in 14 days.</p>
        `,
      }).catch(err => console.error('[signature] email send failed:', err.message));
    }

    logActivity(req, { action: 'CREATE', entityType: 'SIGNATURE_REQUEST', entityId: requestId }).catch(() => {});
    ok(res, { id: requestId, token, parties: inserted });
  } catch (err) {
    console.error('[signature] create request error:', err);
    fail(res, err.message || 'Failed to create signature request');
  }
});

// GET /api/signature/request/:id — detail (admin view)
router.get('/request/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[r]] = await req.pool.execute(
      `SELECT * FROM signature_request WHERE id = ? AND org_id = ? LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!r) return fail(res, 'Not found', 404);
    const [parties] = await req.pool.execute(
      `SELECT id, signer_name, signer_email, role, status, viewed_at, signed_at, declined_at, party_token
         FROM signature_party WHERE request_id = ? ORDER BY sort_order ASC`,
      [req.params.id]
    );
    const [events] = await req.pool.execute(
      `SELECT id, event_type, party_id, ip, user_agent, created_at
         FROM signature_event WHERE request_id = ? ORDER BY created_at ASC`,
      [req.params.id]
    );
    ok(res, { ...r, parties, events });
  } catch (err) {
    console.error('[signature] get error:', err);
    fail(res, 'Failed to load signature request');
  }
});

// GET /api/signature/lease/:leaseId — list requests for a lease
router.get('/lease/:leaseId', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT sr.id, sr.status, sr.sent_at, sr.completed_at, sr.expires_at, sr.token,
              sr.original_file_id, sr.signed_file_id,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id) AS party_count,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id AND status = 2) AS signed_count
         FROM signature_request sr
        WHERE sr.lease_id = ? AND sr.org_id = ?
        ORDER BY sr.created_at DESC`,
      [req.params.leaseId, orgId]
    );
    ok(res, rows);
  } catch (err) {
    console.error('[signature] lease list error:', err);
    fail(res, 'Failed to load lease signatures');
  }
});

// POST /api/signature/request/:id/cancel
router.post('/request/:id/cancel', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[r]] = await req.pool.execute(
      `SELECT id, lease_id, status FROM signature_request WHERE id = ? AND org_id = ? LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!r) return fail(res, 'Not found', 404);
    if (r.status === 3) return fail(res, 'Already fully signed — cannot cancel', 400);
    await req.pool.execute(
      `UPDATE signature_request SET status = 6, updated_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type) VALUES (?, ?, 'cancelled')`,
      [newId(), req.params.id]
    );
    // Reset the lease's signature_status if there's no other in-flight request
    await req.pool.execute(
      `UPDATE leasing SET signature_status = 'none' WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM signature_request
            WHERE lease_id = ? AND status IN (1, 2) AND id != ?
         )`,
      [r.lease_id, r.lease_id, req.params.id]
    );
    ok(res, { cancelled: true });
  } catch (err) {
    console.error('[signature] cancel error:', err);
    fail(res, 'Failed to cancel');
  }
});

// POST /api/signature/request/:id/resend — re-email pending parties
router.post('/request/:id/resend', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[r]] = await req.pool.execute(
      `SELECT * FROM signature_request WHERE id = ? AND org_id = ? LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!r) return fail(res, 'Not found', 404);
    if (r.status !== 1 && r.status !== 2) return fail(res, 'Can only resend a sent/viewed request', 400);

    const [parties] = await req.pool.execute(
      `SELECT party_token, signer_name, signer_email FROM signature_party
        WHERE request_id = ? AND status IN (0, 1) AND signer_email IS NOT NULL`,
      [req.params.id]
    );
    for (const p of parties) {
      const link = `${config.frontendUrl}/sign/${p.party_token}`;
      sendMail({
        to: p.signer_email,
        subject: `Reminder: lease signature required`,
        html: `<p>Hi ${p.signer_name},</p>
               <p>This is a reminder to sign the lease sent to you earlier.</p>
               <p><a href="${link}">Review &amp; Sign</a></p>`,
      }).catch(err => console.error('[signature] resend email failed:', err.message));
    }
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type) VALUES (?, ?, 'resent')`,
      [newId(), req.params.id]
    );
    ok(res, { resent: parties.length });
  } catch (err) {
    console.error('[signature] resend error:', err);
    fail(res, 'Failed to resend');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC SIGNER ROUTES — no auth required, gated by party_token
// ─────────────────────────────────────────────────────────────────────────────

// Helper: resolve a party_token → party + request + the org pool. Returns null
// if the token is invalid, the request is expired/cancelled, or the party
// already signed.
async function resolveTokenContext(req) {
  // Public routes don't have req.pool yet (no auth ran). We need to look up
  // the party across all org DBs. Use the master pool to find which org the
  // token belongs to, then switch to that org's pool.
  const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
  const master = getMasterPool();
  const [orgs] = await master.execute('SELECT id, db_name FROM organizations WHERE status = 1');
  for (const o of orgs) {
    const pool = await getOrgPool(o.id);
    try {
      const [[party]] = await pool.execute(
        `SELECT sp.*, sr.id AS request_id, sr.status AS request_status,
                sr.original_file_id, sr.signed_file_id, sr.expires_at,
                sr.lease_id, sr.org_id
           FROM signature_party sp
           JOIN signature_request sr ON sp.request_id = sr.id
          WHERE sp.party_token = ? LIMIT 1`,
        [req.params.token]
      );
      if (party) return { party, pool, orgId: o.id };
    } catch { /* table may not exist on this org — skip */ }
  }
  return null;
}

// GET /api/signature/public/:token — fetch signing context (PDF + party + lease)
router.get('/public/:token', async (req, res) => {
  try {
    const ctx = await resolveTokenContext(req);
    if (!ctx) return fail(res, 'Invalid or expired link', 404);
    const { party, pool } = ctx;

    if (party.request_status === 6) return fail(res, 'This signing request was cancelled.', 410);
    if (party.request_status === 3) return fail(res, 'This lease has already been fully signed.', 410);
    if (party.expires_at && new Date(party.expires_at) < new Date()) {
      return fail(res, 'This link has expired.', 410);
    }

    // Mark as viewed if first time
    if (party.status === 0) {
      await pool.execute(
        `UPDATE signature_party SET status = 1, viewed_at = NOW(),
                                    signer_ip = ?, signer_ua = ?
          WHERE id = ?`,
        [req.ip || null, (req.headers['user-agent'] || '').slice(0, 500), party.id]
      );
      await pool.execute(
        `UPDATE signature_request SET status = GREATEST(status, 2) WHERE id = ? AND status < 3`,
        [party.request_id]
      );
      await pool.execute(
        `INSERT INTO signature_event (id, request_id, party_id, event_type, ip, user_agent)
         VALUES (?, ?, ?, 'viewed', ?, ?)`,
        [newId(), party.request_id, party.id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)]
      );
    }

    // Return PDF URL (the /public/:token/pdf endpoint streams it)
    const pdfUrl = `/api/signature/public/${req.params.token}/pdf`;

    // Get lease summary for context display
    const [[lease]] = await pool.execute(
      `SELECT l.lease_no, l.start_date, l.end_date, l.amount, l.deposit,
              p.display_name AS property_name, u.name AS unit_name
         FROM leasing l
         LEFT JOIN unit u ON l.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
        WHERE l.id = ? LIMIT 1`,
      [party.lease_id]
    );

    ok(res, {
      party: {
        id: String(party.id),
        signer_name: party.signer_name,
        signer_email: party.signer_email,
        status: party.status,
        signed_at: party.signed_at,
      },
      pdf_url: pdfUrl,
      lease,
      already_signed: party.status === 2,
      declined: party.status === 3,
    });
  } catch (err) {
    console.error('[signature/public] resolve error:', err);
    fail(res, 'Failed to load signing page');
  }
});

// GET /api/signature/public/:token/pdf — stream the PDF
router.get('/public/:token/pdf', async (req, res) => {
  try {
    const ctx = await resolveTokenContext(req);
    if (!ctx) return res.status(404).send('Not found');
    const { party, pool } = ctx;

    // Once fully signed, serve the signed PDF; otherwise the unsigned original.
    const fileId = party.request_status === 3 && party.signed_file_id
      ? party.signed_file_id
      : party.original_file_id;
    if (!fileId) return res.status(404).send('No PDF');
    const [[file]] = await pool.execute(
      `SELECT filename, item_name FROM file WHERE id = ? LIMIT 1`,
      [fileId]
    );
    if (!file) return res.status(404).send('PDF not found');
    const filePath = path.join(UPLOADS_DIR, file.item_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('PDF file missing on disk');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename || 'lease.pdf'}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[signature/public] pdf error:', err);
    res.status(500).send('Failed to load PDF');
  }
});

// POST /api/signature/public/:token/sign — submit a signature
//   body: { signature_png (data URL base64), typed_name }
router.post('/public/:token/sign', async (req, res) => {
  try {
    const ctx = await resolveTokenContext(req);
    if (!ctx) return fail(res, 'Invalid or expired link', 404);
    const { party, pool, orgId } = ctx;
    if (party.status === 2) return fail(res, 'Already signed.', 400);
    if (party.status === 3) return fail(res, 'You declined this request.', 400);

    const { signature_png, typed_name } = req.body || {};
    if (!signature_png) return fail(res, 'Signature is required', 400);
    if (!typed_name || !String(typed_name).trim()) return fail(res, 'Typed full name is required', 400);

    await pool.execute(
      `UPDATE signature_party
          SET status = 2, signed_at = NOW(),
              signature_png = ?, typed_name = ?,
              signer_ip = ?, signer_ua = ?
        WHERE id = ?`,
      [signature_png, String(typed_name).trim(),
       req.ip || null, (req.headers['user-agent'] || '').slice(0, 500), party.id]
    );
    await pool.execute(
      `INSERT INTO signature_event (id, request_id, party_id, event_type, ip, user_agent)
       VALUES (?, ?, ?, 'signed', ?, ?)`,
      [newId(), party.request_id, party.id, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500)]
    );

    // Are ALL parties now signed? If so, run the stamping pipeline.
    const [[counts]] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS signed_count
         FROM signature_party WHERE request_id = ?`,
      [party.request_id]
    );

    if (Number(counts.total) === Number(counts.signed_count)) {
      await finalizeRequest(pool, orgId, party.request_id);
    }

    ok(res, { signed: true });
  } catch (err) {
    console.error('[signature/public] sign error:', err);
    fail(res, err.message || 'Failed to sign');
  }
});

// POST /api/signature/public/:token/decline
router.post('/public/:token/decline', async (req, res) => {
  try {
    const ctx = await resolveTokenContext(req);
    if (!ctx) return fail(res, 'Invalid or expired link', 404);
    const { party, pool } = ctx;
    if (party.status === 2) return fail(res, 'Already signed — cannot decline.', 400);
    const { reason } = req.body || {};
    await pool.execute(
      `UPDATE signature_party
          SET status = 3, declined_at = NOW(), decline_reason = ?,
              signer_ip = ?, signer_ua = ?
        WHERE id = ?`,
      [reason || null, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500), party.id]
    );
    await pool.execute(
      `UPDATE signature_request SET status = 4, updated_at = NOW() WHERE id = ?`,
      [party.request_id]
    );
    await pool.execute(
      `UPDATE leasing SET signature_status = 'declined' WHERE id = ?`,
      [party.lease_id]
    );
    await pool.execute(
      `INSERT INTO signature_event (id, request_id, party_id, event_type, ip, user_agent, metadata)
       VALUES (?, ?, ?, 'declined', ?, ?, ?)`,
      [newId(), party.request_id, party.id, req.ip || null,
       (req.headers['user-agent'] || '').slice(0, 500),
       reason ? JSON.stringify({ reason }) : null]
    );
    ok(res, { declined: true });
  } catch (err) {
    console.error('[signature/public] decline error:', err);
    fail(res, 'Failed to decline');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Finalize: stamp the PDF, email it to everyone, mark request complete.
// ─────────────────────────────────────────────────────────────────────────────
async function finalizeRequest(pool, orgId, requestId) {
  const [[r]] = await pool.execute(
    `SELECT * FROM signature_request WHERE id = ? LIMIT 1`, [requestId]
  );
  if (!r) return;

  const [parties] = await pool.execute(
    `SELECT * FROM signature_party WHERE request_id = ? ORDER BY sort_order ASC`,
    [requestId]
  );

  // Load original PDF bytes
  const [[origFile]] = await pool.execute(
    `SELECT item_name, filename FROM file WHERE id = ?`, [r.original_file_id]
  );
  if (!origFile) throw new Error('Original PDF missing');
  const origPath = path.join(UPLOADS_DIR, origFile.item_name);
  const origBytes = fs.readFileSync(origPath);

  // Load landlord signature (if any)
  let landlordSig = null;
  if (r.landlord_signature_id) {
    const [[ls]] = await pool.execute(
      `SELECT label, signature_png FROM landlord_signature WHERE id = ? LIMIT 1`,
      [r.landlord_signature_id]
    );
    if (ls) landlordSig = ls;
  }

  // Stamp
  const finalPdf = await stamper.stampLease({
    unsignedPdf: origBytes,
    parties,
    landlordSig,
    request: r,
  });

  // Save the signed PDF as a new file
  const signedName = uuidv4() + '.pdf';
  fs.writeFileSync(path.join(UPLOADS_DIR, signedName), finalPdf);
  const signedFileId = newId();
  await pool.execute(
    `INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at)
     VALUES (?, ?, ?, 'pdf', 'APPLICATION/PDF', ?, 'local', ?, NOW())`,
    [signedFileId, signedName, `signed-lease-${r.lease_id}.pdf`, finalPdf.length, orgId]
  );

  // Update signature_request + lease
  await pool.execute(
    `UPDATE signature_request SET status = 3, signed_file_id = ?, completed_at = NOW() WHERE id = ?`,
    [signedFileId, requestId]
  );
  await pool.execute(
    `UPDATE leasing SET signature_status = 'signed', signed_file_id = ?, signed_at = NOW() WHERE id = ?`,
    [signedFileId, r.lease_id]
  );
  await pool.execute(
    `INSERT INTO signature_event (id, request_id, event_type) VALUES (?, ?, 'completed')`,
    [newId(), requestId]
  );

  // Email signed PDF to all parties + the creator
  const recipients = parties.filter(p => p.signer_email).map(p => p.signer_email);
  if (r.created_by) {
    const [[creator]] = await pool.execute(
      `SELECT email FROM user WHERE id = ? LIMIT 1`, [r.created_by]
    );
    if (creator && creator.email && !recipients.includes(creator.email)) recipients.push(creator.email);
  }

  if (recipients.length) {
    const link = `${config.frontendUrl}/sign/${parties[0].party_token}`;
    sendMail({
      to: recipients.join(','),
      subject: 'Lease signed — copy attached',
      html: `<p>The lease has been signed by all parties.</p>
             <p>The fully-signed PDF (with all signatures and the certificate of completion) is attached.</p>
             <p><a href="${link}">View online</a></p>`,
      attachments: [{
        filename: `signed-lease.pdf`,
        content: finalPdf,
        contentType: 'application/pdf',
      }],
    }).catch(err => console.error('[signature] completion email failed:', err.message));
  }
}

module.exports = router;
