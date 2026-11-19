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
const {validateSigners}=require('../services/leaseTenants');
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
const { sendTemplateEmail, loadTemplate } = require('../services/emailService');
const config = require('../config');
const { nextSignatureStatus } = require('../utils/signatureLedger');
const {
  isExpiredRequest,
  periodOf,
  findOverlappingLive,
} = require('../utils/signatureOverlap');

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

function formatPeriodDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

function overlapResponse(res, conflicts, lease) {
  const covered = periodOf(conflicts[0], lease);
  const label = covered && covered.start && covered.end
    ? ` covering ${formatPeriodDate(covered.start)} \u2013 ${formatPeriodDate(covered.end)}`
    : '';
  return res.status(409).json({
    code: 409,
    message: `This lease already has a document out for signature${label}. Cancel it first, or choose to replace it.`,
    data: {
      reason: 'overlapping_request',
      conflicts: conflicts.map(({ id, term_start, term_end, sent_at, expires_at }) => ({
        id: String(id), term_start, term_end, sent_at, expires_at,
      })),
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Signature emails — use the editable email template if the org created one
// (types: Lease-Signature-Request / Lease-Signed), otherwise fall back to the
// built-in plain HTML so signing keeps working before any template is set up.
// ─────────────────────────────────────────────────────────────────────────────

// Invite (or resend) — sent per signer with their personal link.
async function sendSignatureInvite(pool, orgId, { leaseId, party, link, message, expiryDays }) {
  // Callers validate this upfront (POST /request rejects email-less signers), so
  // reaching here means a party slipped through — log it rather than vanishing.
  if (!party.signer_email) {
    console.error(`[signature] cannot send invite for party ${party.id || '?'} (${party.signer_name || 'unnamed'}) on lease ${leaseId}: no signer_email`);
    return;
  }
  const expiryLabel = `${expiryDays || 14} days`;
  const extraVariables = {
    '%Signer Name%': party.signer_name || 'Signer',
    '%Signing Link%': link,
    '%Sign Expiry%': expiryLabel,
    '%Signature Message%': message || '',
  };

  let tpl = null;
  try { tpl = await loadTemplate(pool, orgId, 'Lease-Signature-Request'); } catch { /* ignore */ }
  // Only use the org template if it actually renders the signing link. A template
  // without %Signing Link% would email the signer with NO way to sign — so in
  // that case we skip it and use the built-in fallback (which always includes the
  // Review & Sign button).
  // Normalize &nbsp; before checking: the rich-text editor stores spaces inside
  // variables as non-breaking spaces (e.g. %Signing&nbsp;Link%). substituteVariables
  // already renders the &nbsp; form, so this gate must recognize it too — otherwise
  // a valid template is wrongly rejected and the built-in fallback is used.
  if (tpl && String(tpl.template_content || '').replace(/&nbsp;/gi, ' ').includes('%Signing Link%')) {
    try {
      const sent = await sendTemplateEmail(pool, orgId, {
        templateType: 'Lease-Signature-Request',
        leaseId: leaseId || null,
        toOverride: party.signer_email,
        extraVariables,
      });
      if (sent) return;
    } catch (e) {
      console.error('[signature] template invite failed, using fallback:', e.message);
    }
  } else if (tpl) {
    console.warn('[signature] Lease-Signature-Request template is missing %Signing Link% — using built-in fallback so the signer gets a working link.');
  }

  // Built-in fallback
  sendMail({
    to: party.signer_email,
    subject: 'Lease signature requested — please sign',
    html: `
      <p>Hi ${party.signer_name || 'there'},</p>
      <p>You have a lease awaiting your signature.</p>
      ${message ? `<p>${String(message).replace(/</g, '&lt;')}</p>` : ''}
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#1677ff;color:#fff;text-decoration:none;border-radius:4px">Review &amp; Sign</a></p>
      <p style="color:#666;font-size:12px">Or copy this link into your browser:<br>${link}</p>
      <p style="color:#999;font-size:11px">Link expires in ${expiryLabel}.</p>
    `,
  }).catch(err => console.error('[signature] invite email send failed:', err.message));
}

// Completion — signed PDF to all signing parties (not staff/creators).
async function sendSignedCopy(pool, orgId, { leaseId, recipients, link, finalPdf }) {
  if (!recipients || !recipients.length) return;
  const attachments = [{ filename: 'signed-lease.pdf', content: finalPdf, contentType: 'application/pdf' }];
  const extraVariables = { '%Signed Document Link%': link };

  let tpl = null;
  try { tpl = await loadTemplate(pool, orgId, 'Lease-Signed'); } catch { /* ignore */ }
  if (tpl) {
    try {
      const sent = await sendTemplateEmail(pool, orgId, {
        templateType: 'Lease-Signed',
        leaseId: leaseId || null,
        toOverride: recipients.join(','),
        extraVariables,
        attachments,
      });
      if (sent) return;
    } catch (e) {
      console.error('[signature] template completion failed, using fallback:', e.message);
    }
  }

  sendMail({
    to: recipients.join(','),
    subject: 'Lease signed — copy attached',
    html: `<p>The lease has been signed by all parties.</p>
           <p>The fully-signed PDF (with all signatures and the certificate of completion) is attached.</p>
           <p><a href="${link}">View online</a></p>`,
    attachments,
  }).catch(err => console.error('[signature] completion email failed:', err.message));
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
            parties: submittedParties, message, expires_in_days,
            term_start, term_end, term_stamp_end } = req.body || {};
    if (!lease_id || !template_id) return fail(res, 'lease_id and template_id are required', 400);
    if (!Array.isArray(submittedParties) || submittedParties.length === 0) return fail(res, 'At least one signer is required', 400);

    // Every signer needs an email — the invite is delivered ONLY by email. Without
    // this the request is created and the invite silently no-ops (sendSignatureInvite
    // returns early on a missing signer_email), leaving a lease that looks "sent"
    // but that nobody was ever asked to sign. Fail loudly instead.
    const unreachable = submittedParties.filter(p => !p || !String(p.signer_email || '').trim());
    if (unreachable.length) {
      const names = unreachable.map((p, i) => (p && p.signer_name) || `Signer ${i + 1}`).join(', ');
      return fail(
        res,
        `${names} ${unreachable.length > 1 ? 'have' : 'has'} no email address, so the signing link can't be sent. Add an email to the contact first.`,
        400
      );
    }

    // The period this document covers. Optional — a whole-lease document sends
    // none — but if given it must be coherent, or the contract prints nonsense.
    const termStart = (term_start || '').slice(0, 10) || null;
    const termEnd = (term_end || '').slice(0, 10) || null;
    const termStampEnd = (term_stamp_end || '').slice(0, 10) || null;
    if ((termStart && !termEnd) || (termEnd && !termStart)) {
      return fail(res, 'A document period needs both a start and an end date', 400);
    }
    if (termStart && termEnd && termEnd < termStart) {
      return fail(res, 'The period end cannot be before its start', 400);
    }

    const [[lease]] = await req.pool.execute(
      `SELECT l.id,
              DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date
         FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL LIMIT 1`,
      [lease_id, orgId]
    );
    if (!lease) return fail(res, 'Lease not found', 404);
    const context=await renderer.loadLeaseContext(req.pool,orgId,lease_id);
    const parties=validateSigners(context.tenants,submittedParties);
    // The PDF and signer rows use this same snapshot; editing a contact later
    // cannot change the original PDF or the recipient/name on this request.
    const [openRequests] = await req.pool.execute(
      `SELECT id, status, expires_at, sent_at,
              DATE_FORMAT(term_start, '%Y-%m-%d') AS term_start,
              DATE_FORMAT(term_end, '%Y-%m-%d') AS term_end
         FROM signature_request
        WHERE lease_id = ? AND org_id = ? AND status IN (1,2)`,
      [lease_id, orgId]
    );
    const conflicts = findOverlappingLive(
      openRequests,
      { start: termStart, end: termEnd },
      lease
    );
    if (conflicts.length && req.body?.replace_overlapping !== true) {
      return overlapResponse(res, conflicts, lease);
    }

    // Render the unsigned lease PDF using the template + lease data. Store it
    // in the file table so we can re-serve it for the signer (no auth needed
    // since the file is gated by the unique party token).
    const { pdfBuffer, templateId, version } = await renderer.renderFromTemplate({
      pool: req.pool, orgId, leaseId: lease_id, templateId: template_id,
      context, requireAllTenants:true,expectedSnapshot:req.body.document_snapshot,
      term: termStart && termEnd
        ? { start_date: termStart, end_date: termEnd, stamp_end_date: termStampEnd }
        : null,
    });

    // Save PDF to uploads + file row
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const savedName = uuidv4() + '.pdf';
    fs.writeFileSync(path.join(UPLOADS_DIR, savedName), pdfBuffer);
    const fileId = newId();
    await req.pool.execute(
      `INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, is_private, created_at)
       VALUES (?, ?, ?, 'pdf', 'APPLICATION/PDF', ?, 'local', ?, 1, NOW())`,
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
          landlord_signature_id, token, status, message, expires_at, sent_at, created_by,
          term_start, term_end, term_stamp_end, signature_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), ?, ?, ?, ?, 'esign')`,
      [requestId, orgId, lease_id, templateId, version, fileId,
       resolvedLandlordSigId, token, message || null, expiresAt, userId || null,
       termStart, termEnd, termStampEnd]
    );

    // Insert signature_party rows
    const inserted = [];
    for (let i = 0; i < parties.length; i++) {
      const p = parties[i];
      const partyId = newId();
      const partyToken = newToken();
      await req.pool.execute(
        `INSERT INTO signature_party
           (id, request_id, party_token, signer_name, signer_email, role, sort_order, status,tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0,?)`,
        [partyId, requestId, partyToken,
         String(p.signer_name || '').trim() || 'Signer',
         (p.signer_email || '').trim().toLowerCase() || null,
         p.role || 'tenant', i,p.tenant_id]
      );
      inserted.push({ id: partyId, party_token: partyToken, signer_name: p.signer_name, signer_email: p.signer_email });
    }

    if (conflicts.length) {
      await cancelSuperseded(req.pool, orgId, conflicts, requestId);
    }

    await recomputeLeaseSignatureStatus(req.pool, orgId, lease_id);

    // Audit event
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, ip, user_agent, metadata)
       VALUES (?, ?, 'sent', ?, ?, ?)`,
      [newId(), requestId, req.ip || null, (req.headers['user-agent'] || '').slice(0, 500),
       JSON.stringify({ parties: inserted.length, expires_at: expiresAt })]
    );

    // Fire email to each party (fire-and-forget). Uses the editable
    // Lease-Signature-Request template if the org created one; otherwise the
    // built-in fallback inside sendSignatureInvite.
    for (const p of inserted) {
      if (!p.signer_email) continue;
      const link = `${config.frontendUrl}/sign/${p.party_token}`;
      sendSignatureInvite(req.pool, orgId, {
        leaseId: lease_id,
        party: p,
        link,
        message,
        expiryDays: expires_in_days,
      }).catch(err => console.error('[signature] invite dispatch failed:', err.message));
    }

    logActivity(req, { action: 'CREATE', entityType: 'SIGNATURE_REQUEST', entityId: requestId }).catch(() => {});
    ok(res, { id: requestId, token, parties: inserted });
  } catch (err) {
    console.error('[signature] create request error:', err);
    fail(res, err.message || 'Failed to create signature request',err.status||500);
  }
});

async function cancelSuperseded(pool, orgId, conflicts, supersededBy) {
  for (const conflict of conflicts) {
    await pool.execute(
      `UPDATE signature_request SET status = 6, updated_at = NOW()
        WHERE id = ? AND org_id = ? AND status IN (1,2)`,
      [conflict.id, orgId]
    );
    await pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, metadata)
       VALUES (?, ?, 'cancelled', ?)`,
      [newId(), conflict.id, JSON.stringify({ superseded_by: String(supersededBy) })]
    );
  }
}

async function recomputeLeaseSignatureStatus(pool, orgId, leaseId) {
  const [requests] = await pool.execute(
    `SELECT status FROM signature_request WHERE lease_id = ? AND org_id = ?`,
    [leaseId, orgId]
  );
  await pool.execute(
    `UPDATE leasing SET signature_status = ? WHERE id = ?`,
    [nextSignatureStatus(requests), leaseId]
  );
}

// POST /api/signature/record-paper — record a lease signed in ink, not e-signed.
//
// Declared BEFORE the /request/:id routes (static before dynamic).
//
// Without this the only option was "Cancel Request", which resets the lease to
// signature_status='none' — making an ink-signed lease indistinguishable from
// one nobody ever sent, with no scan stored anywhere.
//
// Creates a fully-signed ledger row with NO signature_party rows. That is safe:
// the public signing URL resolves by PARTY token (resolveTokenContext joins on
// sp.party_token), so a party-less request has no reachable signing link.
router.post('/record-paper', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const { lease_id, term_start, term_end, term_stamp_end,
            file_id, signed_at, template_id, note } = req.body || {};

    if (!lease_id) return fail(res, 'lease_id is required', 400);
    const termStart = (term_start || '').slice(0, 10) || null;
    const termEnd = (term_end || '').slice(0, 10) || null;
    if (!termStart || !termEnd) {
      return fail(res, 'The period this document covers is required', 400);
    }
    if (termEnd < termStart) {
      return fail(res, 'The period end cannot be before its start', 400);
    }
    const signedAt = (signed_at || '').slice(0, 10) || null;
    if (!signedAt) return fail(res, 'The date it was signed is required', 400);

    // Org-scope the lease. leasing has no org_id — scope via unit -> property.
    const [[lease]] = await req.pool.execute(
      `SELECT l.id FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL LIMIT 1`,
      [lease_id, orgId]
    );
    if (!lease) return fail(res, 'Lease not found', 404);

    // The scan is optional, but if given it must belong to this org — a file_id
    // is caller-supplied and must never be trusted across tenants.
    const fileId = file_id || null;
    if (fileId) {
      const [[f]] = await req.pool.execute(
        `SELECT id FROM file WHERE id = ? AND org_id = ? LIMIT 1`, [fileId, orgId]
      );
      if (!f) return fail(res, 'That file was not found', 400);
    }

    // Any in-flight request for this same period is moot now. Match on BOTH
    // boundaries — two periods can share an end date, and cancelling the wrong
    // one would strand a document still legitimately out for signature.
    await req.pool.execute(
      `UPDATE signature_request SET status = 6, updated_at = NOW()
        WHERE lease_id = ? AND org_id = ? AND status IN (1, 2)
          AND ((term_start IS NULL AND term_end IS NULL)
               OR (term_start = ? AND term_end = ?))`,
      [lease_id, orgId, termStart, termEnd]
    );

    const requestId = newId();
    await req.pool.execute(
      `INSERT INTO signature_request
         (id, org_id, lease_id, template_id, original_file_id, signed_file_id,
          token, status, signature_method, message,
          term_start, term_end, term_stamp_end, completed_at, created_by)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 3, 'paper', ?, ?, ?, ?, ?, ?)`,
      [requestId, orgId, lease_id, template_id || null, fileId,
       newToken(), note || null, termStart, termEnd,
       (term_stamp_end || '').slice(0, 10) || null, signedAt, userId || null]
    );

    // The audit trail must never imply an e-signature took place.
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, ip, user_agent, metadata)
       VALUES (?, ?, 'completed', ?, ?, ?)`,
      [newId(), requestId, req.ip || null,
       (req.headers['user-agent'] || '').slice(0, 500),
       JSON.stringify({ recorded_manually: true, method: 'paper', signed_at: signedAt })]
    );

    // Keep the lease's own pointer on the most recent signed document, matching
    // what finalizeRequest does for the e-sign path. The lease is org-verified
    // above, so updating by id here is safe.
    await req.pool.execute(
      `UPDATE leasing SET signature_status = 'signed',
              signed_file_id = COALESCE(?, signed_file_id), signed_at = ?
        WHERE id = ?`,
      [fileId, signedAt, lease_id]
    );

    logActivity(req, { action: 'CREATE', entityType: 'SIGNATURE_REQUEST', entityId: requestId }).catch(() => {});
    ok(res, { id: requestId });
  } catch (err) {
    console.error('[signature] record-paper error:', err);
    fail(res, err.message || 'Failed to record the signed document');
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
      `SELECT id, signer_name, signer_email, role, status, viewed_at, signed_at, declined_at, party_token,tenant_id
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
              sr.original_file_id, sr.signed_file_id, sr.template_id,
              sr.signature_method,
              DATE_FORMAT(sr.term_start, '%Y-%m-%d')     AS term_start,
              DATE_FORMAT(sr.term_end, '%Y-%m-%d')       AS term_end,
              DATE_FORMAT(sr.term_stamp_end, '%Y-%m-%d') AS term_stamp_end,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id) AS party_count,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id AND status = 2) AS signed_count
         FROM signature_request sr
        WHERE sr.lease_id = ? AND sr.org_id = ?
        ORDER BY sr.term_start IS NULL, sr.term_start ASC, sr.created_at ASC`,
      [req.params.leaseId, orgId]
    );
    ok(res, rows.map(row => ({ ...row, is_expired: isExpiredRequest(row) })));
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
    // Number() is insurance only — bigNumberStrings applies to BIGINT/DECIMAL,
    // not TINYINT, so this arrives as a number today.
    if (Number(r.status) === 3) return fail(res, 'Already fully signed — cannot cancel', 400);
    await req.pool.execute(
      `UPDATE signature_request SET status = 6, updated_at = NOW() WHERE id = ?`,
      [req.params.id]
    );
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type) VALUES (?, ?, 'cancelled')`,
      [newId(), req.params.id]
    );
    // Recompute the lease's status from the WHOLE ledger rather than assuming
    // 'none'. With a document per period, an earlier period may be legitimately
    // signed — forcing 'none' here used to erase that.
    const [siblings] = await req.pool.execute(
      `SELECT status FROM signature_request
        WHERE lease_id = ? AND org_id = ? AND id != ?`,
      [r.lease_id, orgId, req.params.id]
    );
    await req.pool.execute(
      `UPDATE leasing SET signature_status = ? WHERE id = ?`,
      [nextSignatureStatus(siblings), r.lease_id]
    );
    await logActivity(req, 'CANCEL', 'signature_request', req.params.id,
      `Cancelled signature request ${req.params.id} on lease ${r.lease_id}`);

    ok(res, { cancelled: true });
  } catch (err) {
    console.error('[signature] cancel error:', err);
    fail(res, 'Failed to cancel');
  }
});

// POST /api/signature/request/:id/finalize — re-run stamping for a request
// every party has signed but that never completed (finalisation failed after
// the last signature was saved).
router.post('/request/:id/finalize', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[r]] = await req.pool.execute(
      `SELECT id, lease_id, status FROM signature_request WHERE id = ? AND org_id = ? LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!r) return fail(res, 'Not found', 404);
    if (Number(r.status) === 3) return fail(res, 'Already completed', 400);
    if (Number(r.status) === 6) return fail(res, 'This signing request was cancelled.', 400);

    const [[counts]] = await req.pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS signed_count
         FROM signature_party WHERE request_id = ?`,
      [r.id]
    );
    if (!Number(counts.total) || Number(counts.total) !== Number(counts.signed_count)) {
      return fail(res, 'Not every party has signed yet', 400);
    }

    await finalizeRequest(req.pool, orgId, r.id);
    await logActivity(req, 'UPDATE', 'signature_request', r.id,
      `Completed signature request ${r.id} on lease ${r.lease_id} (finalisation re-run)`);
    ok(res, { completed: true });
  } catch (err) {
    console.error('[signature] finalize error:', err);
    fail(res, 'Failed to complete the signed document');
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
    if (Number(r.status) !== 1 && Number(r.status) !== 2) return fail(res, 'Can only resend a sent/viewed request', 400);

    const [[lease]] = await req.pool.execute(
      `SELECT l.id,
              DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date
         FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL LIMIT 1`,
      [r.lease_id, orgId]
    );
    if (!lease) return fail(res, 'Lease not found', 404);
    const [otherRequests] = await req.pool.execute(
      `SELECT id, status, expires_at, sent_at,
              DATE_FORMAT(term_start, '%Y-%m-%d') AS term_start,
              DATE_FORMAT(term_end, '%Y-%m-%d') AS term_end
         FROM signature_request
        WHERE lease_id = ? AND org_id = ? AND status IN (1,2)`,
      [r.lease_id, orgId]
    );
    const requestPeriod = periodOf(r, lease);
    const conflicts = findOverlappingLive(otherRequests, requestPeriod, lease, { excludeId: r.id });
    if (conflicts.length && req.body?.replace_overlapping !== true) {
      return overlapResponse(res, conflicts, lease);
    }

    // Extend (or reset) the expiry so a resend REVIVES the link — even if the
    // original 14-day window already lapsed. Without this, resending an expired
    // request just re-emails a dead link. Default a fresh 14 days; the caller
    // may pass expires_in_days to control it.
    const extendDays = Number(req.body?.expires_in_days) > 0 ? Number(req.body.expires_in_days) : 14;
    const newExpiry = new Date(Date.now() + extendDays * 86400000);
    await req.pool.execute(
      `UPDATE signature_request SET expires_at = ?, status = 1, updated_at = NOW() WHERE id = ?`,
      [newExpiry, req.params.id]
    );
    if (conflicts.length) {
      await cancelSuperseded(req.pool, orgId, conflicts, r.id);
    }
    await recomputeLeaseSignatureStatus(req.pool, orgId, r.lease_id);

    const [parties] = await req.pool.execute(
      `SELECT party_token, signer_name, signer_email FROM signature_party
        WHERE request_id = ? AND status IN (0, 1) AND signer_email IS NOT NULL`,
      [req.params.id]
    );
    for (const p of parties) {
      const link = `${config.frontendUrl}/sign/${p.party_token}`;
      sendSignatureInvite(req.pool, orgId, {
        leaseId: r.lease_id,
        party: p,
        link,
        message: r.message,
        expiryDays: extendDays,
      }).catch(err => console.error('[signature] resend dispatch failed:', err.message));
    }
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, metadata) VALUES (?, ?, 'resent', ?)`,
      [newId(), req.params.id, JSON.stringify({ new_expires_at: newExpiry, parties: parties.length })]
    );
    await logActivity(req, 'RESEND', 'signature_request', req.params.id,
      `Resent signature request ${req.params.id} to ${parties.length} part${parties.length === 1 ? 'y' : 'ies'}`);

    ok(res, { resent: parties.length, expires_at: newExpiry });
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

    // Fully signed → don't dead-end the signer. Return a "completed" payload so
    // the page can offer a download of their signed copy. This works even after
    // the original signing window lapsed (the doc is done; re-download is fine).
    if (party.request_status === 3) {
      const [[doneLease]] = await pool.execute(
        `SELECT l.lease_no, l.start_date, l.end_date, l.amount, l.deposit,
                p.display_name AS property_name, u.name AS unit_name
           FROM leasing l
           LEFT JOIN unit u ON l.unit_id = u.id
           LEFT JOIN property p ON u.property_id = p.id
          WHERE l.id = ? LIMIT 1`,
        [party.lease_id]
      );
      return ok(res, {
        completed: true,
        signed_available: !!party.signed_file_id,
        pdf_url: `/api/signature/public/${req.params.token}/pdf`,
        lease: doneLease || null,
        party: {
          signer_name: party.signer_name,
          signer_email: party.signer_email,
          signed_at: party.signed_at,
        },
      });
    }

    // Expiry only blocks signing that hasn't completed yet.
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

    const { signature_png, typed_name, initials_png } = req.body || {};
    if (!signature_png) return fail(res, 'Signature is required', 400);
    if (!typed_name || !String(typed_name).trim()) return fail(res, 'Typed full name is required', 400);

    // initials_png is optional — only used when the template needs per-page
    // initials. Stored as a base64 data URL like signature_png.
    await pool.execute(
      `UPDATE signature_party
          SET status = 2, signed_at = NOW(),
              signature_png = ?, initials_png = ?, typed_name = ?,
              signer_ip = ?, signer_ua = ?
        WHERE id = ?`,
      [signature_png, initials_png || null, String(typed_name).trim(),
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

    // The signature is already saved, so a stamping failure must not reach the
    // signer: a 500 here used to be followed by "Already signed." on retry,
    // with the request stuck unfinalised. Staff re-run it via /finalize.
    if (Number(counts.total) === Number(counts.signed_count)) {
      try {
        await finalizeRequest(pool, orgId, party.request_id);
      } catch (finalizeErr) {
        console.error('[signature/public] finalize failed after signing, request %s:',
          party.request_id, finalizeErr);
      }
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
    `INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, is_private, created_at)
     VALUES (?, ?, ?, 'pdf', 'APPLICATION/PDF', ?, 'local', ?, 1, NOW())`,
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

  // Email signed PDF to the signing parties only.
  // NOTE: the lease creator (a staff/user account) is intentionally NOT added
  // here — staff should not be CC'd on the tenant-facing signed copy.
  const recipients = parties.filter(p => p.signer_email).map(p => p.signer_email);

  if (recipients.length) {
    const link = `${config.frontendUrl}/sign/${parties[0].party_token}`;
    // Uses the editable Lease-Signed template if the org created one; otherwise
    // the built-in fallback inside sendSignedCopy.
    await sendSignedCopy(pool, orgId, {
      leaseId: r.lease_id,
      recipients,
      link,
      finalPdf,
    }).catch(err => console.error('[signature] completion dispatch failed:', err.message));
  }
}

module.exports = router;
