/**
 * Tenant portal API.
 *
 * Every route below is either public (register / verify / login, all rate limited) or
 * behind `authenticateTenant`. None of them use the staff `authenticate`, and none of
 * them set `req.user`. See middleware/tenantAuth.js for why that separation is absolute.
 *
 * Two access rules, applied in different places and easy to confuse:
 *   read  -> has held a lease at any point   (utils/tenantPortalAccess.isEligibleToRegister)
 *   write -> holds a CURRENT ACTIVE lease    (utils/tenantPortalAccess.currentLeaseUnits)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const config = require('../config');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const { sendMail, accountSender } = require('../config/mailer');
const { orgTodaySql } = require('../utils/orgTime');
const { generateSequenceCode } = require('../utils/sequenceCode');
const {
  authenticateTenant, tenantPortalEnabled, issueTenantSession, clearTenantSession,
} = require('../middleware/tenantAuth');
const {
  isEligibleToRegister, currentLeaseUnits, loadActiveAccount,
} = require('../utils/tenantPortalAccess');
const {
  TOKEN_TTL_MINUTES, sha256, createRegistrationToken, parseRegistrationToken,
  passwordProblem, normaliseEmail,
} = require('../utils/tenantPortalRegistration');
const { registrationEmail } = require('../utils/registrationEmail');
const { createNotification } = require('../utils/notify');

const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// ── rate limits ─────────────────────────────────────────────────────────────
// Tighter than the staff side. These endpoints are reachable by anyone on the internet
// and two of them tell you something about an email address if you can measure them.

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: 'Too many requests. Please try again later.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: 'Too many attempts. Please try again later.' },
});

// A real bcrypt hash of a value nobody can supply, used so the "no such account" path
// costs the same as the real one. Generated once at load; the plaintext is irrelevant.
const DUMMY_HASH = bcrypt.hashSync('tenant-portal-timing-equaliser', 10);

// ── photo uploads ───────────────────────────────────────────────────────────
// Far stricter than the staff uploader (which allows 500 MB of any type): a tenant is
// attaching a phone snap of a leaking pipe, not a lease video.

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']);
const MAX_PHOTOS = 5;

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname || '')),
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: MAX_PHOTOS },
  fileFilter: (req, file, cb) => {
    if (!PHOTO_MIME.has(file.mimetype)) return cb(new Error('Photos must be JPEG, PNG, HEIC or WebP.'));
    cb(null, true);
  },
});

function photos(field) {
  return (req, res, next) => {
    photoUpload.array(field, MAX_PHOTOS)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ code: 413, message: 'Each photo must be 15 MB or smaller.' });
      if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ code: 400, message: `Please attach at most ${MAX_PHOTOS} photos.` });
      return res.status(400).json({ code: 400, message: err.message || 'Upload failed' });
    });
  };
}

// Best-effort cleanup so a rejected submission does not leave files on disk.
function discard(files) {
  for (const f of files || []) {
    try { fs.unlinkSync(f.path); } catch (e) { /* already gone */ }
  }
}

// ── org resolution ──────────────────────────────────────────────────────────

/**
 * Which org holds a COMPLETED account for this email. One master lookup, exactly like
 * staff login's `org_user_map`.
 */
async function orgForLogin(email) {
  const [rows] = await getMasterPool().execute(
    'SELECT org_id FROM tenant_portal_map WHERE email = ?', [email]
  );
  if (!rows.length) return null;
  return String(rows[0].org_id);
}

/**
 * Which org holds an eligible tenant with this email, for someone who has not registered
 * yet and therefore is not in the map.
 *
 * Scans active orgs. Three exist, and this endpoint is rate limited to 5 per quarter hour,
 * so the cost is irrelevant today. It would need an index if the org count ever grew into
 * the hundreds, which is worth knowing before that happens.
 */
async function orgForRegistration(email) {
  const [orgs] = await getMasterPool().execute(
    'SELECT id, display_name FROM organizations WHERE status = 1 ORDER BY created_at'
  );
  const matches = [];
  for (const org of orgs) {
    try {
      const pool = await getOrgPool(String(org.id));
      if (await isEligibleToRegister(pool, String(org.id), email)) {
        matches.push({ orgId: String(org.id), pool, orgName: org.display_name || '' });
      }
    } catch (e) {
      // One unreachable org database must not stop the others being checked.
      console.error(`[tenant-portal] org ${org.id} unavailable during registration lookup:`, e.message);
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    // `tenant_portal_map` keys on email alone, so one address cannot hold accounts in two
    // orgs. Silently taking the first would give the person an account for an org they
    // may not have meant and make the other permanently unreachable. Refuse and let a
    // human sort it out; this cannot be resolved from an email address alone.
    console.warn(`[tenant-portal] ambiguous registration: ${matches.length} orgs claim this email`);
    return { ambiguous: true };
  }
  return matches[0];
}

// The same body whatever happened. Registration must not become an oracle that reveals
// which of 1,846 addresses belongs to a tenant, so "no such tenant", "already registered"
// and "email sent" are indistinguishable from outside.
const REGISTER_ACK = {
  code: 200,
  message: 'If that email belongs to a tenant of ours, we have sent it a link to set a password.',
};

// ── POST /register ──────────────────────────────────────────────────────────

router.post('/register', registerLimiter, async (req, res) => {
  if (!tenantPortalEnabled()) return res.status(503).json({ code: 503, message: 'Tenant portal is not configured' });
  const email = normaliseEmail(req.body?.email);
  if (!email) return res.json(REGISTER_ACK);   // not even a shape complaint; see REGISTER_ACK

  try {
    const found = await orgForRegistration(email);
    if (!found || found.ambiguous) return res.json(REGISTER_ACK);
    const { orgId, pool, orgName } = found;

    const { token, secretHash } = createRegistrationToken(orgId);
    const expires = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000);

    // Update-then-insert, NOT `INSERT ... ON DUPLICATE KEY UPDATE`.
    //
    // ODKU fires on ANY unique clash, including the PRIMARY KEY. This insert supplies a
    // fresh Snowflake id, and two ids generated in the same millisecond collide with
    // probability 1e-6. On such a collision ODKU would have written this registration's
    // token onto SOMEONE ELSE'S account row, and the link mailed to whoever asked would
    // then set that stranger's password. Rare, and an account takeover, so it is worth
    // the extra statement to make the match explicitly on (org_id, email).
    //
    // Re-registering an already-active account is how "I forgot my password" is served,
    // so an existing row must be updated rather than refused.
    const [upd] = await pool.execute(
      `UPDATE tenant_portal_account
          SET verify_token_hash = ?, verify_expires_at = ?
        WHERE org_id = ? AND email = ?`,
      [secretHash, expires, orgId, email]
    );
    if (upd.affectedRows === 0) {
      try {
        await pool.execute(
          `INSERT INTO tenant_portal_account (id, org_id, email, status, verify_token_hash, verify_expires_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
          [newId(), orgId, email, secretHash, expires]
        );
      } catch (insertErr) {
        // Another request created the row between the UPDATE and the INSERT. The unique
        // key on (org_id, email) is what caught it; apply the token to that row instead.
        if (insertErr.code !== 'ER_DUP_ENTRY') throw insertErr;
        await pool.execute(
          `UPDATE tenant_portal_account SET verify_token_hash = ?, verify_expires_at = ?
            WHERE org_id = ? AND email = ?`,
          [secretHash, expires, orgId, email]
        );
      }
    }

    const link = `${config.appUrl}/tenant-portal/set-password?token=${encodeURIComponent(token)}`;
    // The org's own name, from master. NOT a literal: three orgs share this codebase and
    // hardcoding one customer's name would sign every other customer's email as them.
    const { subject, text: bodyText, html: bodyHtml } =
      registrationEmail({ brand: orgName, link });
    // NOT awaited. Sending mail takes far longer than the "no such tenant" path, and an
    // identical response body does not hide a second of difference from anyone timing
    // the endpoint. Returning before the send makes the two outcomes look alike.
    // Failures are logged, never surfaced, for the same reason.
    sendMail({
      to: email,
      from: accountSender(),
      subject,
      text: bodyText,
      html: bodyHtml,
    }).catch(err => console.error('[tenant-portal] registration email failed:', err));

    return res.json(REGISTER_ACK);
  } catch (error) {
    // Even a failure returns the same body: a 500 here would still distinguish a real
    // address from a stranger's. Logged loudly instead.
    console.error('[tenant-portal] register failed:', error);
    return res.json(REGISTER_ACK);
  }
});

// ── POST /register/complete ─────────────────────────────────────────────────

router.post('/register/complete', registerLimiter, async (req, res) => {
  if (!tenantPortalEnabled()) return res.status(503).json({ code: 503, message: 'Tenant portal is not configured' });

  const parsed = parseRegistrationToken(req.body?.token);
  const badLink = { code: 400, message: 'That link is invalid or has expired. Please request a new one.' };
  if (!parsed) return res.status(400).json(badLink);

  const problem = passwordProblem(req.body?.password);
  if (problem) return res.status(400).json({ code: 400, message: problem });

  try {
    const pool = await getOrgPool(parsed.orgId);
    const [[row]] = await pool.execute(
      `SELECT id, email FROM tenant_portal_account
        WHERE org_id = ? AND verify_token_hash = ? AND verify_expires_at > NOW() LIMIT 1`,
      [parsed.orgId, parsed.secretHash]
    );
    if (!row) return res.status(400).json(badLink);

    // Re-checked at completion, not just at registration: a lease can be deleted between
    // the email being sent and the link being clicked.
    if (!(await isEligibleToRegister(pool, parsed.orgId, row.email))) {
      return res.status(403).json({ code: 403, message: 'This email is no longer linked to a tenancy.' });
    }

    const hash = await bcrypt.hash(req.body.password, 10);
    // The UPDATE re-states the token condition rather than trusting the SELECT above.
    // bcrypt takes long enough for a second request to land in between, and without this
    // an OLD link could finish after a NEWER one replaced the token, setting its own
    // password and wiping the newer token. Two uses of one link could both win, last
    // write taking effect. affectedRows is the proof that this request held the token.
    const [result] = await pool.execute(
      `UPDATE tenant_portal_account
          SET password_hash = ?, status = 1, verify_token_hash = NULL, verify_expires_at = NULL,
              token_version = token_version + 1
        WHERE id = ? AND org_id = ? AND verify_token_hash = ? AND verify_expires_at > NOW()`,
      [hash, String(row.id), parsed.orgId, parsed.secretHash]
    );
    if (result.affectedRows !== 1) return res.status(400).json(badLink);

    // The map means "has a usable account", so it is written now rather than at register.
    const [[org]] = await getMasterPool().execute('SELECT db_name FROM organizations WHERE id = ? LIMIT 1', [parsed.orgId]);
    await getMasterPool().execute(
      `INSERT INTO tenant_portal_map (email, org_id, db_name) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE org_id = VALUES(org_id), db_name = VALUES(db_name)`,
      [row.email, parsed.orgId, org?.db_name || '']
    );

    return res.json({ code: 200, message: 'Password set. You can now sign in.' });
  } catch (error) {
    console.error('[tenant-portal] register/complete failed:', error);
    return res.status(500).json({ code: 500, message: 'Could not set your password. Please try again.' });
  }
});

// ── POST /login ─────────────────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res) => {
  if (!tenantPortalEnabled()) return res.status(503).json({ code: 503, message: 'Tenant portal is not configured' });

  const email = normaliseEmail(req.body?.email);
  const password = req.body?.password;
  const denied = { code: 401, message: 'Invalid email or password' };
  if (!email || typeof password !== 'string' || !password) return res.status(401).json(denied);

  try {
    const orgId = await orgForLogin(email);
    let row = null;
    if (orgId) {
      const pool = await getOrgPool(orgId);
      const [[found]] = await pool.execute(
        `SELECT id, email, password_hash, status, token_version FROM tenant_portal_account
          WHERE org_id = ? AND email = ? LIMIT 1`,
        [orgId, email]
      );
      row = found || null;
    }

    // Every path pays for one bcrypt comparison. Returning early on an unknown address
    // answers in a millisecond while a real one costs ~100ms, which sorts the ~1,721
    // tenant addresses out of a candidate list by stopwatch alone. Unverified, disabled
    // and unknown then all answer identically, in identical time.
    const usable = row && Number(row.status) === 1 && row.password_hash;
    const hashToCheck = usable ? row.password_hash : DUMMY_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCheck);
    if (!usable || !passwordMatches) return res.status(401).json(denied);

    const pool = await getOrgPool(orgId);
    issueTenantSession(res, { email, orgId, tokenVersion: Number(row.token_version) || 0 });
    await pool.execute('UPDATE tenant_portal_account SET last_login_at = NOW() WHERE id = ?', [String(row.id)]);

    return res.json({ code: 200, message: 'Login successful' });
  } catch (error) {
    console.error('[tenant-portal] login failed:', error);
    return res.status(500).json({ code: 500, message: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  clearTenantSession(res);
  res.json({ code: 200, message: 'Signed out' });
});

// ── everything below requires a tenant session ──────────────────────────────

// Bound placeholders for `tenant_id IN (...)`, built from the middleware's resolved set.
const idsIn = (req) => req.tenantPortal.tenantIds.map(() => '?').join(',');

// A lease is theirs if they are the named tenant OR an additional tenant on it. The
// eligibility and repair rules already worked this way; without it here a spouse who
// appears only in `leasing_additional_tenant` could log in and raise a repair while
// being told they have no leases.
const leaseIsTheirs = (ph) => `(
  l.tenant_id IN (${ph})
  OR EXISTS (SELECT 1 FROM leasing_additional_tenant lat
              WHERE lat.leasing_id = l.id AND lat.tenant_id IN (${ph}))
)`;

router.get('/dashboard', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const ph = idsIn(req);

    // `l.status = 1` matches the repair rule. Without it the dashboard would claim an
    // active lease for an archived one whose dates still span today, while the repair
    // form correctly refused to open. Two screens disagreeing is worse than either.
    const [[{ activeLeases }]] = await req.pool.execute(
      `SELECT COUNT(*) AS activeLeases
         FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE ${leaseIsTheirs(ph)} AND p.org_id = ? AND l.deleted_at IS NULL
          AND l.status = 1
          AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)`,
      [...tenantIds, ...tenantIds, orgId]
    );

    const [[invoiceSummary]] = await req.pool.execute(
      `SELECT COUNT(*) AS unpaidInvoices, COALESCE(SUM(amount), 0) AS outstandingAmount,
              MIN(due_on) AS nextDueDate
         FROM invoice
        WHERE tenant_id IN (${ph}) AND org_id = ? AND status = 0 AND deleted_at IS NULL`,
      [...tenantIds, orgId]
    );

    let nextDueAmount = null;
    if (invoiceSummary.nextDueDate) {
      const [[nextInvoice]] = await req.pool.execute(
        `SELECT amount FROM invoice
          WHERE tenant_id IN (${ph}) AND org_id = ? AND status = 0 AND deleted_at IS NULL AND due_on = ?
          LIMIT 1`,
        [...tenantIds, orgId, invoiceSummary.nextDueDate]
      );
      nextDueAmount = nextInvoice ? nextInvoice.amount : null;
    }

    const [[{ openRepairs }]] = await req.pool.execute(
      `SELECT COUNT(*) AS openRepairs FROM service
        WHERE org_id = ? AND reported_by IN (${ph}) AND deleted_at IS NULL AND status IN (0, 1)`,
      [orgId, ...tenantIds]
    );

    res.json({
      code: 200,
      data: {
        activeLeases: activeLeases || 0,
        unpaidInvoices: invoiceSummary.unpaidInvoices || 0,
        outstandingAmount: invoiceSummary.outstandingAmount || 0,
        nextDueDate: invoiceSummary.nextDueDate || null,
        nextDueAmount: nextDueAmount || 0,
        openRepairs: openRepairs || 0,
      },
    });
  } catch (error) {
    console.error('[tenant-portal] dashboard error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load dashboard' });
  }
});

router.get('/leases', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const [leases] = await req.pool.execute(
      `SELECT DISTINCT l.id, l.lease_no, l.start_date, l.end_date, l.price, l.status,
              p.display_name AS property_name, u.name AS unit_name
         FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE ${leaseIsTheirs(idsIn(req))} AND p.org_id = ? AND l.deleted_at IS NULL
        ORDER BY l.start_date DESC`,
      [...tenantIds, ...tenantIds, orgId]
    );
    res.json({ code: 200, data: leases });
  } catch (error) {
    console.error('[tenant-portal] leases error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load leases' });
  }
});

router.get('/invoices', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const ph = idsIn(req);
    // Bounded. The previous version interpolated an unbounded parseInt straight into
    // LIMIT/OFFSET, so `?limit=9999999` was a free table scan for anyone with an account.
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const [invoices] = await req.pool.execute(
      `SELECT id, invoice_code, note, amount, due_on, status, created_at
         FROM invoice
        WHERE tenant_id IN (${ph}) AND org_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [...tenantIds, orgId, String(limit), String(offset)]
    );
    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) AS total FROM invoice
        WHERE tenant_id IN (${ph}) AND org_id = ? AND deleted_at IS NULL`,
      [...tenantIds, orgId]
    );

    res.json({
      code: 200,
      data: { content: invoices, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page },
    });
  } catch (error) {
    console.error('[tenant-portal] invoices error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load invoices' });
  }
});

router.get('/profile', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const [rows] = await req.pool.execute(
      `SELECT id, first_name, last_name, email, phone, status, created_at
         FROM tenant WHERE id IN (${idsIn(req)}) AND org_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [...tenantIds, orgId]
    );
    if (!rows.length) return res.status(404).json({ code: 404, message: 'Tenant profile not found' });
    res.json({ code: 200, data: rows[0] });
  } catch (error) {
    console.error('[tenant-portal] profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load profile' });
  }
});

router.put('/profile', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const phone = req.body?.phone;
    if (phone != null && String(phone).length > 64) {
      return res.status(400).json({ code: 400, message: 'Phone number is too long.' });
    }
    // Applies to every row this person owns, so the rows do not drift apart. Email is
    // NOT editable here: it is the identity the account resolves through, so changing it
    // is a staff action, not a self-service one.
    await req.pool.execute(
      `UPDATE tenant SET phone = ?, updated_at = NOW()
        WHERE id IN (${idsIn(req)}) AND org_id = ?`,
      [phone || null, ...tenantIds, orgId]
    );
    res.json({ code: 200, message: 'Profile updated successfully' });
  } catch (error) {
    console.error('[tenant-portal] update profile error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update profile' });
  }
});

// ── repairs ─────────────────────────────────────────────────────────────────

// A fixed list. Tenants pick, they do not type: `service.category` is a staff-facing
// field that feeds their filters and reports, and free text from 1,721 people would
// turn it into noise within a month. Values mirror the categories already in use.
const REPAIR_CATEGORIES = [
  'appliances: air conditioner',
  'appliances: water heater',
  'appliances: other',
  'interior: bathroom',
  'interior: toilet',
  'interior: kitchen',
  'interior: electrical',
  'interior: door',
  'interior: window',
  'interior: walls',
  'interior: ceiling',
  'interior: furniture',
  'interior: cabinets',
  'other',
];

router.get('/service/options', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const units = await currentLeaseUnits(req.pool, orgId, tenantIds);
    res.json({
      code: 200,
      data: {
        categories: REPAIR_CATEGORIES,
        units,
        // The frontend uses this to explain WHY the form is unavailable, instead of
        // showing a submit button that always fails.
        can_raise: units.length > 0,
        max_photos: MAX_PHOTOS,
      },
    });
  } catch (error) {
    console.error('[tenant-portal] service options error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load options' });
  }
});

router.get('/service', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const ph = idsIn(req);
    // Column list is an allow-list, not a `SELECT *`. `note` (staff internal), assignee,
    // vendor and priority must never be selected here; tenant_note is the one field
    // staff write FOR the tenant.
    const [rows] = await req.pool.execute(
      `SELECT s.id, s.code, s.category, s.additional_info, s.status,
              s.tenant_note, s.created_at,
              s.preferred_date_first_start, s.preferred_date_first_end,
              s.preferred_date_second_start, s.preferred_date_second_end,
              s.service_date_start, s.service_date_end,
              u.name AS unit_name, p.display_name AS property_name
         FROM service s
         JOIN unit u ON s.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE s.org_id = ? AND s.reported_by IN (${ph}) AND s.deleted_at IS NULL
        ORDER BY s.created_at DESC
        LIMIT 200`,
      [orgId, ...tenantIds]
    );

    const ids = rows.map(r => String(r.id));
    let filesByService = new Map();
    if (ids.length) {
      const fph = ids.map(() => '?').join(',');
      // `source = 'tenant'` is the whole point. A service request accumulates staff
      // attachments too (vendor quotes, inspection photos, files whose names identify
      // the assignee); returning every linked file would undo the rule that a tenant
      // never sees vendor or internal material. Org is re-checked on the file itself.
      const [files] = await req.pool.execute(
        // Aliased `objf`, never `of`: OF is a reserved word in MySQL 8 and
        // `object_file of` is a syntax error. This query only runs once the tenant has
        // at least one repair, so with an empty list it never executed and the fault
        // stayed invisible until the first real submission. service.js aliases `of2`
        // for the same reason.
        `SELECT objf.object_id, f.id AS file_id, f.item_name
           FROM object_file objf JOIN file f ON f.id = objf.file_id
          WHERE objf.object_id IN (${fph}) AND objf.source = 'tenant' AND f.org_id = ?`,
        [...ids, orgId]
      );
      for (const f of files) {
        const key = String(f.object_id);
        if (!filesByService.has(key)) filesByService.set(key, []);
        filesByService.get(key).push({ id: String(f.file_id), item_name: f.item_name });
      }
    }

    // The tenant's own follow-ups, and ONLY theirs. service_activity is the staff
    // timeline: it carries vendor quotes, pricing and assignee chatter. `source` is what
    // separates the two, and NULL (every pre-existing row, and every staff row) stays on
    // the staff side of it.
    let notesByService = new Map();
    if (ids.length) {
      const nph = ids.map(() => '?').join(',');
      const [notes] = await req.pool.execute(
        `SELECT sa.id, sa.service_id, sa.note, sa.created_at
           FROM service_activity sa
          WHERE sa.service_id IN (${nph}) AND sa.org_id = ? AND sa.source = 'tenant'
          ORDER BY sa.created_at ASC`,
        [...ids, orgId]
      );
      for (const n of notes) {
        const key = String(n.service_id);
        if (!notesByService.has(key)) notesByService.set(key, []);
        notesByService.get(key).push({ id: String(n.id), note: n.note, created_at: n.created_at });
      }
    }

    res.json({
      code: 200,
      data: rows.map(r => ({
        ...r,
        id: String(r.id),
        photos: filesByService.get(String(r.id)) || [],
        notes: notesByService.get(String(r.id)) || [],
        // Computed server-side so the two sides cannot disagree about what is allowed.
        // Withdrawing work that is already underway is a conversation, not a button.
        can_cancel: Number(r.status) === 0,
        // Still open to a follow-up unless it has been withdrawn. Deliberately allowed on
        // a completed request: "it is still leaking" is the most useful thing a tenant
        // can tell you, and the alternative is them filing a duplicate.
        can_comment: Number(r.status) !== 3,
      })),
    });
  } catch (error) {
    console.error('[tenant-portal] service list error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load repair requests' });
  }
});

/**
 * Authorise BEFORE multer touches the disk.
 *
 * Ordered deliberately. With `photos()` first, five 15 MB files were written and then
 * deleted on every rejected request, so anyone holding a portal account for a lease that
 * ended years ago could push 75 MB of write-then-delete per call at no cost to themselves.
 * The cheap check goes first and the expensive one only runs for someone entitled to it.
 */
async function requireCurrentLease(req, res, next) {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    // `today` is not passed: currentLeaseUnits reads the org clock itself, so a request
    // cannot nominate a date inside an expired tenancy.
    const allowed = await currentLeaseUnits(req.pool, orgId, tenantIds);
    if (allowed.length === 0) {
      return res.status(403).json({
        code: 403,
        message: 'Repair requests can only be raised on a current tenancy. Please contact us directly.',
      });
    }
    req.allowedUnits = allowed;
    next();
  } catch (error) {
    console.error('[tenant-portal] current lease check failed:', error);
    res.status(500).json({ code: 500, message: 'Failed to submit repair request' });
  }
}

router.post('/service', authenticateTenant, requireCurrentLease, photos('photos'), async (req, res) => {
  const uploaded = req.files || [];
  try {
    const { orgId } = req.tenantPortal;
    // Established by requireCurrentLease, which ran before a single byte was written.
    // This is the ONLY source of a unit id.
    const allowed = req.allowedUnits;

    const requestedUnit = req.body?.unit_id != null ? String(req.body.unit_id) : null;
    let unit;
    if (requestedUnit) {
      unit = allowed.find(u => u.unit_id === requestedUnit);
      if (!unit) {
        // Membership is re-validated rather than trusted. This is the request that would
        // otherwise let anyone file work against any flat in the portfolio.
        discard(uploaded);
        return res.status(403).json({ code: 403, message: 'That unit is not on your current tenancy.' });
      }
    } else if (allowed.length === 1) {
      unit = allowed[0];
    } else {
      discard(uploaded);
      return res.status(400).json({ code: 400, message: 'Please choose which unit this repair is for.' });
    }

    const category = String(req.body?.category || '');
    if (!REPAIR_CATEGORIES.includes(category)) {
      discard(uploaded);
      return res.status(400).json({ code: 400, message: 'Please choose a category from the list.' });
    }

    const description = String(req.body?.additional_info || '').trim();
    if (description.length < 10) {
      discard(uploaded);
      return res.status(400).json({ code: 400, message: 'Please describe the problem in a little more detail.' });
    }
    if (description.length > 5000) {
      discard(uploaded);
      return res.status(400).json({ code: 400, message: 'Description must be 5000 characters or fewer.' });
    }

    const contactPhone = req.body?.contact_phone ? String(req.body.contact_phone).slice(0, 64) : null;
    const dateOrNull = (v) => {
      const s = v == null ? '' : String(v).trim();
      return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s) ? s.replace('T', ' ') : null;
    };

    const serviceId = newId();
    let code;
    try {
      code = await generateSequenceCode(req.pool, orgId, 'service_code');
    } catch (seqErr) {
      console.error('[tenant-portal] sequence lookup failed, using fallback code:', seqErr.message);
      code = 'S' + Date.now();
    }

    // One transaction. Previously the service row, each file row and each link were
    // separate autocommit statements, so a failure part-way left a visible repair with
    // broken attachments while the caller saw a 500 and submitted again, producing a
    // duplicate. Either the whole request exists or none of it does.
    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();

      // `reported_by` is the tenant row that actually holds THIS lease, not whichever id
      // sorted first: a person can have an old row and a newer one, and filing a repair
      // against the wrong tenancy misleads whoever picks the job up.
      // `created_by` is NULL because there is no staff user. Status 0 puts it in the
      // Pending queue staff already work, with no separate inbox to remember.
      await conn.execute(
        `INSERT INTO service (id, org_id, code, unit_id, category, additional_info,
           status, created_by, reported_by, contact_phone,
           preferred_date_first_start, preferred_date_first_end,
           preferred_date_second_start, preferred_date_second_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, NOW())`,
        [serviceId, orgId, code, unit.unit_id, category, description,
         unit.lease_tenant_id || req.tenantPortal.tenantIds[0], contactPhone,
         dateOrNull(req.body?.preferred_date_first_start), dateOrNull(req.body?.preferred_date_first_end),
         dateOrNull(req.body?.preferred_date_second_start), dateOrNull(req.body?.preferred_date_second_end)]
      );

      for (const f of uploaded) {
        const fileId = newId();
        // is_private = 1, not the column default.
        //
        // /api/file/preview serves ANY image to an anonymous caller by design, because
        // it backs the public listings site. These are photos of the inside of
        // someone's home, sent to report a fault, and a file id is a timestamp-based
        // Snowflake rather than a secret. Without this flag every repair photo any
        // tenant ever uploads is fetchable by anyone who can guess an id. The flag is
        // checked before the is-it-an-image rule, so it wins.
        await conn.execute(
          `INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, is_private, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'local', ?, 1, NOW())`,
          [fileId, f.filename, f.originalname || f.filename, path.extname(f.originalname || '').replace('.', ''),
           f.mimetype, f.size, orgId]
        );
        // 'tenant' is what makes this file visible back to them in GET /service. A staff
        // attachment added later has a NULL source and stays internal.
        await conn.execute(
          "INSERT INTO object_file (object_id, file_id, source) VALUES (?, ?, 'tenant')",
          [serviceId, fileId]
        );
      }

      await conn.commit();
    } catch (txErr) {
      await conn.rollback().catch(() => {});
      throw txErr;
    } finally {
      conn.release();
    }

    // Raised AFTER the commit, never inside it. A notification is a courtesy; failing to
    // record one must not roll back a repair the tenant has been told was submitted.
    // createNotification swallows its own errors for the same reason.
    await createNotification(req.pool, {
      orgId,
      type: 'info',
      title: `New repair request ${code}`,
      message: `${unit.property_name || ''} ${unit.unit_name || ''}`.trim() + ` - ${category}`,
      link: `/services/${serviceId}/detail`,
    });

    res.status(201).json({ code: 200, message: 'Repair request submitted', data: { id: serviceId, code } });
  } catch (error) {
    console.error('[tenant-portal] service create error:', error);
    discard(uploaded);
    res.status(500).json({ code: 500, message: 'Failed to submit repair request' });
  }
});

/**
 * Resolve one of the tenant's OWN repair requests, or answer 404.
 *
 * Shared by the follow-up and cancel routes so the ownership rule is written once. A
 * request that is not theirs, is deleted, or does not exist all produce the same answer:
 * anything else confirms that a given id belongs to somebody.
 */
async function loadOwnRequest(req, serviceId) {
  if (!/^\d+$/.test(String(serviceId || ''))) return null;
  const { orgId, tenantIds } = req.tenantPortal;
  const [[row]] = await req.pool.execute(
    `SELECT s.id, s.code, s.status, s.unit_id, s.reported_by
       FROM service s
      WHERE s.id = ? AND s.org_id = ? AND s.reported_by IN (${idsIn(req)}) AND s.deleted_at IS NULL
      LIMIT 1`,
    [String(serviceId), orgId, ...tenantIds]
  );
  return row || null;
}

const MAX_NOTE_LENGTH = 2000;

/**
 * POST /service/:id/note — the tenant adds to a request without rewriting it.
 *
 * Append-only on purpose. See migrations-org/079 for why there is no edit: once a vendor
 * is booked against a description, silently changing that description sends them to the
 * wrong job.
 */
router.post('/service/:id/note', authenticateTenant, async (req, res) => {
  try {
    const { orgId } = req.tenantPortal;
    const request = await loadOwnRequest(req, req.params.id);
    if (!request) return res.status(404).json({ code: 404, message: 'Repair request not found' });

    // 3 = Cancelled. Adding to a withdrawn request would put a note somewhere nobody is
    // looking; a new request is the right move and the frontend says so.
    if (Number(request.status) === 3) {
      return res.status(409).json({
        code: 409,
        message: 'This request was cancelled. Please report a new one if the problem is still there.',
      });
    }

    const note = String(req.body?.note || '').trim();
    if (note.length < 2) return res.status(400).json({ code: 400, message: 'Please write your update first.' });
    if (note.length > MAX_NOTE_LENGTH) {
      return res.status(400).json({ code: 400, message: `Updates must be ${MAX_NOTE_LENGTH} characters or fewer.` });
    }

    // created_by is NULL because there is no staff user, and status is NULL because a
    // tenant note is not a status change. `source` is what keeps it out of nothing and
    // makes it visible to them; see 079.
    const noteId = newId();
    await req.pool.execute(
      `INSERT INTO service_activity
         (id, org_id, service_id, status, activity_date, note, created_by, source, created_by_tenant, created_at)
       VALUES (?, ?, ?, NULL, NOW(), ?, NULL, 'tenant', ?, NOW())`,
      [noteId, orgId, String(request.id), note, String(request.reported_by)]
    );

    await createNotification(req.pool, {
      orgId,
      type: 'info',
      title: `Tenant update on repair ${request.code}`,
      message: note.length > 140 ? note.slice(0, 140) + '...' : note,
      link: `/services/${String(request.id)}/detail`,
    });

    res.status(201).json({ code: 200, message: 'Update added', data: { id: noteId } });
  } catch (error) {
    console.error('[tenant-portal] service note error:', error);
    res.status(500).json({ code: 500, message: 'Failed to add your update' });
  }
});

/**
 * POST /service/:id/cancel — withdraw a request nobody has started.
 *
 * Only from Received. Anything further along means someone has scheduled work, and
 * unpicking that is a phone call.
 */
router.post('/service/:id/cancel', authenticateTenant, async (req, res) => {
  try {
    const { orgId } = req.tenantPortal;
    const request = await loadOwnRequest(req, req.params.id);
    if (!request) return res.status(404).json({ code: 404, message: 'Repair request not found' });
    if (Number(request.status) !== 0) {
      return res.status(409).json({
        code: 409,
        message: 'This request is already being dealt with. Please contact us to withdraw it.',
      });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, MAX_NOTE_LENGTH);

    // status = 0 is restated in the UPDATE rather than trusted from the SELECT above. A
    // staff member can pick the job up in the moment between the two, and affectedRows is
    // the proof that this request won.
    const [result] = await req.pool.execute(
      `UPDATE service SET status = 3, updated_at = NOW()
        WHERE id = ? AND org_id = ? AND status = 0 AND deleted_at IS NULL`,
      [String(request.id), orgId]
    );
    if (result.affectedRows !== 1) {
      return res.status(409).json({
        code: 409,
        message: 'This request is already being dealt with. Please contact us to withdraw it.',
      });
    }

    // The withdrawal is recorded on the timeline, with the reason if one was given, so
    // the request does not simply change colour with no explanation attached.
    await req.pool.execute(
      `INSERT INTO service_activity
         (id, org_id, service_id, status, activity_date, note, created_by, source, created_by_tenant, created_at)
       VALUES (?, ?, ?, 3, NOW(), ?, NULL, 'tenant', ?, NOW())`,
      [newId(), orgId, String(request.id),
       reason ? `Withdrawn by tenant: ${reason}` : 'Withdrawn by tenant.',
       String(request.reported_by)]
    );

    await createNotification(req.pool, {
      orgId,
      type: 'warning',
      title: `Repair ${request.code} withdrawn by tenant`,
      message: reason || 'No reason given.',
      link: `/services/${String(request.id)}/detail`,
    });

    res.json({ code: 200, message: 'Request withdrawn' });
  } catch (error) {
    console.error('[tenant-portal] service cancel error:', error);
    res.status(500).json({ code: 500, message: 'Failed to withdraw your request' });
  }
});

/**
 * GET /service/:id/photo/:fileId — a tenant's own repair photo.
 *
 * Exists because the upload above marks these private, which correctly locks them out
 * of /api/file/preview. That route authenticates staff or nobody; there is no third
 * case for a tenant session, and adding one to a route the listings site depends on
 * would widen a surface we have twice had to narrow. A small dedicated route here can
 * state the whole rule in one query instead.
 *
 * Three conditions, all in SQL, none of them trusting the URL: the service request is
 * this tenant's, the file is linked to THAT request, and the link is `source = 'tenant'`
 * so a staff attachment (vendor quote, inspection shot) can never be served through it.
 */
router.get('/service/:id/photo/:fileId', authenticateTenant, async (req, res) => {
  try {
    const { orgId, tenantIds } = req.tenantPortal;
    const serviceId = String(req.params.id || '');
    const fileId = String(req.params.fileId || '');
    // Both ids go into the query as strings and both must be digits: a Snowflake is a
    // bigint, and anything else is someone probing.
    if (!/^\d+$/.test(serviceId) || !/^\d+$/.test(fileId)) {
      return res.status(404).json({ code: 404, message: 'Photo not found' });
    }

    const [[row]] = await req.pool.execute(
      `SELECT f.item_name, f.mime_type, f.filename
         FROM service s
         JOIN object_file objf ON objf.object_id = s.id AND objf.source = 'tenant'
         JOIN file f ON f.id = objf.file_id AND f.org_id = ?
        WHERE s.id = ? AND s.org_id = ? AND s.reported_by IN (${idsIn(req)})
          AND s.deleted_at IS NULL AND objf.file_id = ?
        LIMIT 1`,
      [orgId, serviceId, orgId, ...tenantIds, fileId]
    );
    // One answer for "no such file", "not yours" and "staff attachment". Distinguishing
    // them would confirm that a given id exists on someone else's request.
    if (!row) return res.status(404).json({ code: 404, message: 'Photo not found' });

    // Resolved from the stored item_name, never from anything in the URL.
    const onDisk = path.join(UPLOADS_DIR, row.item_name || '');
    if (!row.item_name || !onDisk.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(onDisk)) {
      return res.status(404).json({ code: 404, message: 'Photo not found' });
    }

    const mime = PHOTO_MIME.has(row.mime_type) ? row.mime_type : 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    // private, so no shared or CDN cache ever holds a photo of a tenant's home.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', 'inline');
    // Nothing here is markup, but the file is attacker-supplied and served from our
    // origin; these cost nothing and close the door on that being interesting.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    fs.createReadStream(onDisk).pipe(res);
  } catch (error) {
    console.error('[tenant-portal] service photo error:', error);
    res.status(500).json({ code: 500, message: 'Failed to load photo' });
  }
});

module.exports = router;
