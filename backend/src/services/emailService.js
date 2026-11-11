
const { sendMail, sendMailWithAccount } = require('../config/mailer');
const { bitToBool } = require('../utils/mysqlBit');
const { pickTemplate } = require('../utils/pickTemplate');
const { orgTimeSql } = require('../utils/orgTime');
const { toCalendarDate } = require('../utils/checkinWindow');

// ---------------------------------------------------------------------------
// SMTP account lookup — match "from" address to smtp_account table
// ---------------------------------------------------------------------------

/**
 * Extract raw email from a "from" field that may include a display name.
 * e.g. "Tane Residence <bookings@taneresidence.com>" → "bookings@taneresidence.com"
 */
function extractEmail(fromStr) {
  if (!fromStr) return null;
  const match = fromStr.match(/<([^>]+)>/);
  if (match) return match[1].trim().toLowerCase();
  return fromStr.trim().toLowerCase();
}

/**
 * Find matching SMTP account for a "from" address, or fall back to default account.
 * @param {string} orgId
 * @param {string} fromAddress - template.from value (may include display name)
 * @returns {object|null} smtp_account row or null
 */
async function findSmtpAccount(pool, orgId, fromAddress) {
  const email = extractEmail(fromAddress);
  if (email) {
    const [rows] = await pool.execute(
      'SELECT * FROM smtp_account WHERE org_id = ? AND email = ? AND status = 1 LIMIT 1',
      [orgId, email]
    );
    if (rows.length > 0) return rows[0];
  }

  // Fall back to default account for this org
  const [defaults] = await pool.execute(
    'SELECT * FROM smtp_account WHERE org_id = ? AND is_default = 1 AND status = 1 LIMIT 1',
    [orgId]
  );
  return defaults.length > 0 ? defaults[0] : null;
}

// ---------------------------------------------------------------------------
// Template types and their corresponding leasing toggle columns
// ---------------------------------------------------------------------------

const TEMPLATE_TYPES = [
  { value: 'Checkin-Tenant', label: 'Check-In (Tenant)' },
  { value: 'Checkout-Tenant', label: 'Check-Out (Tenant)' },
  { value: 'Overdue-Tenant', label: 'Overdue (Tenant)' },
  { value: 'Overdue-Landlord', label: 'Overdue (Landlord)' },
  { value: 'Invoice-Tenant', label: 'Invoice (Tenant)' },
  { value: 'Invoice-Landlord', label: 'Invoice (Landlord)' },
  { value: 'Renewal-Tenant', label: 'Renewal (Tenant)' },
  { value: 'Leaseexpiry-Landlord', label: 'Lease Expiry (Landlord)' },
  { value: 'Deposit-Tenant', label: 'Deposit (Tenant)' },
  { value: 'Receipt-Tenant', label: 'Payment Receipt (Tenant)' },
  { value: 'Payment-Options', label: 'Payment Options (Tenant)' },
  { value: 'Inventory-Tenant', label: 'Inventory (Tenant)' },
  // The tenant portal sign-up email. Sent when a lease is confirmed and by the
  // Invite button on the Tenants list. If no template exists, or the customised
  // one loses the sign-up link, utils/tenantPortalInvite.js falls back to the
  // built-in wording in utils/registrationEmail.js — an invitation with no link
  // in it is worse than an unstyled one.
  { value: 'Portal-Invite-Tenant', label: 'Tenant Portal Invitation (Tenant)' },
  // Lease e-signature templates (sent from routes/signature.js; if no template
  // exists the route falls back to a built-in plain email so signing still works)
  { value: 'Lease-Signature-Request', label: 'Lease Signature Request (Signer)' },
  { value: 'Lease-Signed', label: 'Lease Signed — Copy (All Parties)' },
  // Public viewing-booking templates (ad-hoc HTML fallback lives in routes/viewingPublic.js)
  { value: 'Viewing-Receipt', label: 'Viewing Request Received (Viewer)' },
  { value: 'Viewing-Employee-Request', label: 'Viewing Request (Employee)' },
  { value: 'Viewing-Tenant-Request', label: 'Viewing Request (Tenant)' },
  { value: 'Viewing-Confirmation', label: 'Viewing Confirmation (All)' },
  { value: 'Viewing-Declined', label: 'Viewing Declined (Viewer)' },
  { value: 'Viewing-Cancelled', label: 'Viewing Cancelled (All)' },
  // The "please give us 2–3 times" prompt the chatbot sends a prospect. Rendered
  // by GET /api/public/viewing-prompt; built-in fallback if not customised.
  { value: 'Viewing-Prospect-Prompt', label: 'Viewing Prompt (Prospect / Bot)' },
  // The multi-time "which works for you?" message to the current tenant.
  { value: 'Viewing-Tenant-Confirm', label: 'Viewing Time Choice (Tenant)' },
  // Reschedule invite sent to the prospect when staff reschedule a booking.
  { value: 'Viewing-Reschedule', label: 'Viewing Reschedule (Prospect)' },
  // Sent to the CURRENT tenant when staff tick "Request viewings" on an NR lease —
  // asks them for their preferred viewing windows. Built-in fallback in
  // services/viewingRequest.js if the org hasn't customised it.
  { value: 'Viewing-Availability-Request', label: 'Viewing Availability Request (Tenant)' },
  // Viewing Relay Scheduler — the conversational WhatsApp relay steps. Each has a
  // built-in fallback in services/viewingNegotiation.js; customise the wording here.
  { value: 'Viewing-Prospect-Day-Ask', label: 'Viewing Relay — Ask Prospect for Day' },
  { value: 'Viewing-Slot-Taken', label: 'Viewing Relay — Slot Taken (Prospect)' },
  { value: 'Viewing-Checking', label: 'Viewing Relay — Checking (Prospect)' },
  { value: 'Viewing-Tenant-Ask', label: 'Viewing Relay — Ask Tenant if Time Works' },
  { value: 'Viewing-Tenant-Alt-Ask', label: 'Viewing Relay — Ask Tenant for Alternative' },
  { value: 'Viewing-Relay-Prospect', label: 'Viewing Relay — Relay New Time to Prospect' },
  { value: 'Viewing-Outside-Hours', label: 'Viewing Relay — Time Outside Hours' },
  { value: 'Viewing-Confirm-Time', label: 'Viewing Relay — Read-back Confirm (Proposer)' },
  { value: 'Viewing-Relay-Confirmed', label: 'Viewing Relay — Confirmed (Both)' },
  { value: 'Viewing-Relay-Escalated', label: 'Viewing Relay — Needs Staff (Both)' },
  { value: 'Viewing-Relay-Reminder', label: 'Viewing Relay — Reminder (Silent Party)' },
  { value: 'Viewing-Hold-MultiUnit', label: 'Viewing Relay — Multi-Unit Hold (Prospect)' },
  // Inquiry follow-up reminder (sent to staff who created the inquiry)
  { value: 'Inquiry-Reminder', label: 'Inquiry Reminder (Staff)' },
];

const TOGGLE_MAP = {
  'Checkin-Tenant': 'tenant_checkin',
  'Checkout-Tenant': 'tenant_checkout',
  'Overdue-Tenant': 'tenant_overdue',
  'Overdue-Landlord': 'landlord_overdue',
  'Invoice-Tenant': 'tenant_posted',
  'Invoice-Landlord': 'landlord_posted',
  'Renewal-Tenant': 'tenant_renewal',
  'Leaseexpiry-Landlord': 'landlord_expired',
  'Deposit-Tenant': 'tenant_deposit_posted',
  'Receipt-Tenant': 'payment_receipt',
};

// ---------------------------------------------------------------------------
// Available template variables with descriptions
// ---------------------------------------------------------------------------

// Category names are chosen for the ledger, not for tenants. Rent is filed under
// "Rental Income", which is correct in a P&L and reads like an accountant wrote
// the email when it lands in "Details: Rental Income for August". Rent is the
// bulk of what goes out (1,111 of 2026's invoices against 218 utilities), so the
// jargon would be the common case rather than the edge case.
//
// Only names that are actually wrong for a tenant belong here. "Utilities",
// "Deposit" and "Stamp Fee" already say what they mean and pass through
// untouched, so this stays a short list rather than a second naming system to
// keep in sync. Keys are compared lower-cased and trimmed, because one live
// category is stored as "Garbage disposal fee " with a trailing space.
const TENANT_CATEGORY_LABELS = {
  'rental income': 'Rent payment',
};

/**
 * The wording a tenant should see for a category. Unknown names are returned
 * as-is (trimmed), so adding a category never breaks an email.
 */
function tenantCategoryLabel(name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return '';
  return TENANT_CATEGORY_LABELS[trimmed.toLowerCase()] || trimmed;
}

const TEMPLATE_VARIABLES = [
  { key: '%Name - Lease%', description: 'Tenant full name (or company name)' },
  // Portal invitation only. The link is single-use and time-limited, so it cannot
  // be pre-baked into the body: it has to be substituted at send time.
  { key: '%Portal Signup Link%', description: 'Tenant portal sign-up link (portal invitation only — the email is useless without it)' },
  { key: '%Link Expiry%', description: 'How long the sign-up link lasts, in words, e.g. "7 days" (portal invitation only)' },
  { key: '%Link Expiry Minutes%', description: 'The same lifetime as a raw number of minutes — currently 10080. Prefer %Link Expiry%' },
  { key: '%Company Name%', description: 'Your organisation name, as it appears on your account' },
  { key: '%Unit # - Property%', description: 'Unit name/number' },
  { key: '%Name - Property%', description: 'Property name' },
  { key: '%Building / Unit Address - Property%', description: 'Property full address' },
  { key: '%Lease start date - Lease%', description: 'Lease start date' },
  { key: '%Lease end date - Lease%', description: 'Lease end date' },
  { key: '%Notice Period - Lease%', description: 'Renewal notice period in days the tenant must give' },
  { key: '%Unit Access Information - Property%', description: 'Unit access information' },
  { key: '%Wifi Details - Property%', description: 'WiFi details' },
  { key: '%Payment Info - Property%', description: 'Payment instructions' },
  { key: '%Unit Information - Lease%', description: 'Unit information from lease' },
  { key: '%Outstandings%', description: 'Total outstanding balance for the lease (all unpaid invoices)' },
  { key: '%Invoice Outstanding%', description: 'Outstanding amount for the specific invoice being referenced' },
  { key: '%Monthly utility credit%', description: 'Monthly utility credit amount' },
  { key: '%Rent amount%', description: 'Rent per billing period from the lease (the Amount field) — monthly, quarterly, or a one-off total depending on the lease' },
  { key: '%Payment frequency%', description: 'How often rent is billed: monthly / quarterly / weekly / one-time' },
  { key: '%Security deposit amount%', description: 'Security deposit amount' },
  { key: '%Payment Month%', description: 'Payment month name (e.g. March)' },
  { key: '%Payment Date%', description: 'Payment date (e.g. March 15)' },
  { key: '%Due Date%', description: 'Full due date (e.g. March 15, 2026)' },
  { key: '%Overdue Amount%', description: 'Total overdue invoice amount' },
  { key: '%Tenant Number%', description: 'Tenant phone number' },
  { key: '%Category%', description: 'Invoice category, in tenant-facing wording' },
  { key: '%Invoice Number%', description: 'Invoice code (e.g. TRIV0000000001)' },
  { key: '%Receipt Amount%', description: 'Payment receipt amount' },
  { key: '%Transaction Code%', description: 'Payment transaction code' },
  { key: '%Payment Method%', description: 'Payment method name' },
  // --- Viewing-booking variables (used in Viewing-* template types) ---
  { key: '%Viewer Name%', description: 'Prospective viewer full name' },
  { key: '%Viewer Email%', description: 'Prospective viewer email' },
  { key: '%Viewer Phone%', description: 'Prospective viewer phone' },
  { key: '%Viewer Message%', description: 'Optional message from the viewer' },
  { key: '%Viewing Date%', description: 'Proposed viewing date & time' },
  { key: '%Unit Name%', description: 'Unit name/number (viewing)' },
  { key: '%Property Name%', description: 'Property name (viewing)' },
  { key: '%Property Address%', description: 'Full property address' },
  { key: '%Host Name%', description: 'Assigned staff host name' },
  { key: '%Approve URL%', description: 'Approve link (employee/tenant emails)' },
  { key: '%Decline URL%', description: 'Decline link (employee/tenant emails)' },
  { key: '%Manage URL%', description: 'Viewer self-manage / cancel link' },
  // --- Inquiry-Reminder variables ---
  { key: '%Inquiry Name%', description: 'Inquiry contact full name' },
  { key: '%Inquiry Email%', description: 'Inquiry contact email' },
  { key: '%Inquiry Phone%', description: 'Inquiry contact phone' },
  { key: '%Inquiry Notes%', description: 'Inquiry notes' },
  { key: '%Inquiry Source%', description: 'Lead source name' },
  { key: '%Inquiry Date%', description: 'Date the inquiry was created' },
  { key: '%Desired Start Date%', description: 'Date the prospect wants to start' },
  { key: '%Budget%', description: 'Prospect budget' },
  { key: '%Inquiry Property%', description: 'Property of interest' },
  { key: '%Inquiry Unit%', description: 'Unit of interest' },
  { key: '%Inquiry Link%', description: 'Link to the inquiry detail page' },
  // --- Lease e-signature variables (Lease-Signature-Request / Lease-Signed) ---
  { key: '%Signer Name%', description: 'Name of the person being asked to sign (may differ from lease tenant)' },
  { key: '%Signing Link%', description: 'Personal link for this signer to review & sign the lease' },
  { key: '%Sign Expiry%', description: 'How long the signing link stays valid (e.g. "14 days")' },
  { key: '%Signature Message%', description: 'Optional note the staff member added when sending' },
  { key: '%Signed Document Link%', description: 'Link to view the fully-signed lease online (Lease-Signed)' },
];

// ---------------------------------------------------------------------------
// Currency symbol helper
// ---------------------------------------------------------------------------

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', KRW: '₩',
  INR: '₹', AUD: 'A$', CAD: 'C$', CHF: 'CHF', HKD: 'HK$',
  SGD: 'S$', NZD: 'NZ$', MXN: 'MX$', BRL: 'R$', ZAR: 'R',
  THB: '฿', PHP: '₱', MYR: 'RM', IDR: 'Rp', VND: '₫',
  TWD: 'NT$', AED: 'AED', SAR: 'SAR', KWD: 'KWD', QAR: 'QAR',
};

function getCurrencySymbol(code) {
  if (!code) return '$';
  return CURRENCY_SYMBOLS[code.toUpperCase()] || code + ' ';
}

// ---------------------------------------------------------------------------
// Date formatting helpers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// leasing.invoicing holds either a word ('monthly') or a day count ('30').
// Empty/absent means the lease has no recurring schedule — the scheduler skips
// those (it requires invoicing IS NOT NULL AND != ''), so it's a one-off payment.
function formatInvoicingFrequency(invoicing) {
  const v = String(invoicing == null ? '' : invoicing).trim().toLowerCase();
  if (!v) return 'one-time';
  const byWord = {
    weekly: 'weekly',
    'bi-weekly': 'every 2 weeks',
    biweekly: 'every 2 weeks',
    monthly: 'monthly',
    quarterly: 'quarterly',
    'bi-annually': 'every 6 months',
    biannually: 'every 6 months',
    annually: 'yearly',
    yearly: 'yearly',
  };
  if (byWord[v]) return byWord[v];
  const days = Number(v);
  if (Number.isFinite(days)) {
    if (days <= 0) return 'one-time';   // '0' means no recurrence, same as empty
    if (days === 1) return 'daily';     // avoid "every 1 days"
    return ({ 7: 'weekly', 14: 'every 2 weeks', 30: 'monthly', 90: 'quarterly', 180: 'every 6 months', 365: 'yearly' })[days]
      || `every ${days} days`;
  }
  return v; // unrecognised word — surface it rather than silently blanking
}

function formatMonth(date) {
  if (!date) return '';
  const d = new Date(date);
  return MONTH_NAMES[d.getMonth()] || '';
}

function formatPaymentDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`;
}

function formatDueDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatLeaseDate(date) {
  if (!date) return '';
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${month}/${day}/${d.getFullYear()}`;
}

function formatAmount(symbol, amount) {
  const num = parseFloat(amount) || 0;
  return `${symbol}${num.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Load template from DB
// ---------------------------------------------------------------------------

/**
 * Load an email template by ID or by type (default template for that type+org).
 */
async function loadTemplate(pool, orgId, templateType, templateId = null) {
  if (templateId) {
    const [rows] = await pool.execute(
      `SELECT * FROM email_template WHERE id = ? AND org_id = ? AND status = 1`,
      [templateId, orgId]
    );
    return rows[0] || null;
  }

  // Load the default template for this type.
  //
  // ORDER BY is not decoration. Tane has EIGHT active Checkin-Tenant templates and all
  // eight are flagged default; with a bare LIMIT 1 the row MySQL hands back is arbitrary
  // and can change after any write. Seven of those eight carry a lead time of 0 and
  // several have an empty subject, so which one wins decides both when the email goes and
  // what it says. Newest-first at least makes the choice stable and predictable while the
  // duplicates are sorted out.
  //
  // Ordered by id, NOT created_at: this table has created_time/updated_time, and no
  // created_at at all. The first version of this ORDER BY named a column that does not
  // exist, which made every template load throw — caught on deploy, because the tests
  // that cover this read the SQL as text and cannot know what the server will accept.
  // ids are Snowflakes, so id DESC is newest-first anyway.
  const [rows] = await pool.execute(
    `SELECT * FROM email_template
     WHERE org_id = ? AND template_type = ? AND is_default_template = 1 AND status = 1
     ORDER BY id DESC
     LIMIT 1`,
    [orgId, templateType]
  );
  if (rows[0]) return rows[0];

  // Fallback: any active template of this type
  const [fallback] = await pool.execute(
    `SELECT * FROM email_template
     WHERE org_id = ? AND template_type = ? AND status = 1
     ORDER BY created_time DESC LIMIT 1`,
    [orgId, templateType]
  );
  return fallback[0] || null;
}

// ---------------------------------------------------------------------------
// Resolve variables from DB data
// ---------------------------------------------------------------------------

/**
 * Resolve all template variables for a given lease.
 * @param {string} orgId
 * @param {string} leaseId
 * @param {object} opts - { category, dueDate, overdueAmount }
 * @returns {object} map of variable key → resolved string
 */
async function resolveVariables(pool, orgId, leaseId, { category, dueDate, overdueAmount, invoiceCode, invoiceId } = {}) {
  // 1. Load lease + tenant + unit + property
  const [rows] = await pool.execute(
    `SELECT
       l.id AS lease_id, l.start_date, l.end_date, l.unit_information,
       l.credits, l.deposit, l.amount AS lease_amount, l.price AS lease_price,
       l.invoicing, l.notice_period_days,
       t.first_name, t.middle_name, t.last_name, t.company_name,
       t.type AS tenant_type, t.phone AS tenant_phone,
       u.name AS unit_name, u.access_information, u.wifi_information,
       u.payment_information,
       p.display_name AS property_name, p.street_address, p.city,
       p.state, p.country, p.currency, p.payment_instructions
     FROM leasing l
     JOIN tenant t ON l.tenant_id = t.id
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE l.id = ? AND p.org_id = ?`,
    [leaseId, orgId]
  );

  if (rows.length === 0) {
    console.warn(`[EmailService] No lease data found for leaseId=${leaseId}, orgId=${orgId}`);
    return getSampleVariables();
  }

  const r = rows[0];
  const sym = getCurrencySymbol(r.currency);

  // 2. Compute outstanding balance for this lease.
  // Both sides must cover the SAME set of invoices, otherwise payments against
  // already-Paid invoices get subtracted from the unpaid-only invoiced total
  // and produce a large negative number. Use all non-deleted invoices in the
  // lease — fully-paid ones net to zero, open/overdue ones net to remainder.
  let outstanding = 0;
  try {
    const [[outRow]] = await pool.execute(
      `SELECT
         COALESCE(SUM(i.amount), 0) AS total_invoiced,
         COALESCE((
           SELECT SUM(al.amount) FROM accounting_line al
           JOIN accounting a ON al.accounting_id = a.id
           WHERE al.invoice_code IN (
             SELECT invoice_code FROM invoice
             WHERE leasing_id = ? AND deleted_at IS NULL
           ) AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
         ), 0) AS total_paid
       FROM invoice i
       WHERE i.leasing_id = ? AND i.deleted_at IS NULL`,
      [leaseId, orgId, leaseId]
    );
    outstanding = (parseFloat(outRow.total_invoiced) || 0) - (parseFloat(outRow.total_paid) || 0);
  } catch (err) {
    console.error('[EmailService] Error computing outstanding:', err.message);
  }

  // 2b. Compute outstanding for the specific invoice being referenced (if any).
  let invoiceOutstanding = 0;
  let invoiceOutstandingResolved = false;
  if (invoiceId || invoiceCode) {
    try {
      const [[invOutRow]] = await pool.execute(
        `SELECT
           COALESCE(i.amount, 0) AS amount,
           COALESCE((
             SELECT SUM(al.amount) FROM accounting_line al
             JOIN accounting a ON al.accounting_id = a.id
             WHERE al.invoice_code = i.invoice_code
               AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
           ), 0) AS paid
         FROM invoice i
         WHERE ${invoiceId ? 'i.id = ?' : 'i.invoice_code = ?'} AND i.deleted_at IS NULL
         LIMIT 1`,
        [orgId, invoiceId || invoiceCode]
      );
      if (invOutRow) {
        invoiceOutstanding = (parseFloat(invOutRow.amount) || 0) - (parseFloat(invOutRow.paid) || 0);
        invoiceOutstandingResolved = true;
      }
    } catch (err) {
      console.error('[EmailService] Error computing invoice outstanding:', err.message);
    }
  }

  // 3. Compute overdue amount if not supplied
  let overdue = parseFloat(overdueAmount) || 0;
  if (!overdueAmount) {
    try {
      const [[ovRow]] = await pool.execute(
        `SELECT COALESCE(SUM(amount), 0) AS overdue_total
         FROM invoice WHERE leasing_id = ? AND status = 2 AND deleted_at IS NULL`,
        [leaseId]
      );
      overdue = parseFloat(ovRow.overdue_total) || 0;
    } catch (err) {
      console.error('[EmailService] Error computing overdue:', err.message);
    }
  }

  // 4. Build tenant name
  let tenantName = '';
  if (Number(r.tenant_type) === 1 && r.company_name) {
    tenantName = r.company_name;
  } else {
    tenantName = [r.first_name, r.middle_name, r.last_name].filter(Boolean).join(' ');
  }

  // 5. Build address
  const addressParts = [r.street_address, r.city, r.state, r.country].filter(Boolean);
  const fullAddress = addressParts.join(', ');

  // 6. Payment info — prefer unit-level, fall back to property-level
  const paymentInfo = r.payment_information || r.payment_instructions || '';

  // 7. Resolve the due date for date-based variables
  const effectiveDueDate = dueDate || new Date();

  // 8. Resolve category name
  let categoryName = category || '';
  if (category && !isNaN(category)) {
    // category is an ID, so look up the name. The column is `name`; there is no
    // `display_name` on category_setting, so the old query threw on every call
    // and the silent catch left categoryName holding the raw bigint. %Category%
    // therefore rendered a 16-digit ID rather than "Utilities". Blank out first
    // so a lookup that fails degrades to a missing word, never to an ID in a
    // tenant's inbox, and log it so the next failure is visible.
    categoryName = '';
    try {
      const [[catRow]] = await pool.execute(
        'SELECT name FROM category_setting WHERE id = ?',
        [category]
      );
      categoryName = catRow ? (catRow.name || '') : '';
    } catch (err) {
      console.error('[EmailService] Category lookup failed for id', String(category), '-', err.message);
    }
  }

  // 9. Resolve invoice code
  let resolvedInvoiceCode = invoiceCode || '';
  if (!resolvedInvoiceCode && invoiceId) {
    try {
      const [[invRow]] = await pool.execute(
        'SELECT invoice_code FROM invoice WHERE id = ? LIMIT 1',
        [invoiceId]
      );
      resolvedInvoiceCode = invRow ? invRow.invoice_code : '';
    } catch (err) { /* ignore */ }
  }

  return {
    '%Name - Lease%': tenantName,
    '%Unit # - Property%': r.unit_name || '',
    '%Name - Property%': r.property_name || '',
    '%Building / Unit Address - Property%': fullAddress,
    '%Lease start date - Lease%': formatLeaseDate(r.start_date),
    '%Lease end date - Lease%': formatLeaseDate(r.end_date),
    '%Notice Period - Lease%': r.notice_period_days != null ? String(r.notice_period_days) : '',
    '%Unit Access Information - Property%': r.access_information || '',
    '%Wifi Details - Property%': r.wifi_information || '',
    '%Payment Info - Property%': paymentInfo,
    '%Unit Information - Lease%': r.unit_information || '',
    '%Outstandings%': formatAmount(sym, outstanding),
    '%Invoice Outstanding%': invoiceOutstandingResolved ? formatAmount(sym, invoiceOutstanding) : '',
    '%Monthly utility credit%': formatAmount(sym, r.credits),
    // The lease form's "AMOUNT" field writes the SAME value to both price and
    // amount; the scheduler bills from `amount`. It is the rent PER BILLING
    // PERIOD (leasing.invoicing) — so it is only "monthly" when the lease is
    // billed monthly. Pair with %Payment frequency% to keep copy accurate.
    '%Rent amount%': formatAmount(sym, r.lease_price),
    '%Payment frequency%': formatInvoicingFrequency(r.invoicing),
    // Deprecated alias — kept resolving so any template already using it doesn't
    // start emitting a raw placeholder. Not listed in TEMPLATE_VARIABLES.
    '%Monthly rent%': formatAmount(sym, r.lease_price),
    '%Security deposit amount%': formatAmount(sym, r.deposit),
    '%Payment Month%': formatMonth(effectiveDueDate),
    '%Payment Date%': formatPaymentDate(effectiveDueDate),
    '%Due Date%': formatDueDate(effectiveDueDate),
    '%Overdue Amount%': formatAmount(sym, overdue),
    '%Tenant Number%': r.tenant_phone || '',
    '%Category%': tenantCategoryLabel(categoryName),
    '%Invoice Number%': resolvedInvoiceCode,
  };
}

// ---------------------------------------------------------------------------
// Sample variables for preview (no real data)
// ---------------------------------------------------------------------------

function getSampleVariables() {
  return {
    '%Name - Lease%': 'John Smith',
    '%Unit # - Property%': 'Unit 101',
    '%Name - Property%': 'Sunset Apartments',
    '%Building / Unit Address - Property%': '123 Main St, Los Angeles, CA',
    '%Lease start date - Lease%': '01/01/2026',
    '%Lease end date - Lease%': '12/31/2026',
    '%Notice Period - Lease%': '60',
    '%Unit Access Information - Property%': 'Front gate code: 1234',
    '%Wifi Details - Property%': 'Network: SunsetWifi, Password: guest123',
    '%Payment Info - Property%': 'Bank transfer to Account #XXXX',
    '%Unit Information - Lease%': 'Studio apartment, furnished',
    '%Outstandings%': '$1,200.00',
    '%Invoice Outstanding%': '$800.00',
    '%Monthly utility credit%': '$50.00',
    '%Rent amount%': '$2,400.00',
    '%Payment frequency%': 'monthly',
    '%Monthly rent%': '$2,400.00',
    '%Security deposit amount%': '$2,400.00',
    '%Payment Month%': 'March',
    '%Payment Date%': 'March 15',
    '%Due Date%': 'March 15, 2026',
    '%Overdue Amount%': '$0.00',
    '%Tenant Number%': '(555) 123-4567',
    '%Category%': 'Rental Income',
    '%Invoice Number%': 'TRIV0000000001',
    // Lease e-signature samples (for preview)
    '%Signer Name%': 'John Smith',
    '%Signing Link%': 'https://platform.tenafy.com/sign/sample-token',
    '%Sign Expiry%': '14 days',
    '%Signature Message%': '',
    '%Signed Document Link%': 'https://platform.tenafy.com/sign/sample-token',
  };
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Replace all %Variable% placeholders in content with resolved values.
 * Also handles &nbsp; variants (HTML editors sometimes encode spaces).
 *
 * When `htmlMode` is true (the body comes from a rich-text editor and contains
 * HTML tags), multi-line variable values get their `\n` chars converted to
 * `<br>` so they render as line breaks instead of collapsing to spaces.
 * Leading/trailing whitespace is also stripped from values to avoid stray
 * blank lines in the rendered email.
 */
function substituteVariables(content, variablesMap, htmlMode = false) {
  if (!content) return '';

  const formatValue = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (!htmlMode) return s;
    // Trim leading/trailing whitespace+newlines so a value like "\nAccount: ...\n"
    // doesn't render as a leading or trailing blank line in the email.
    s = s.replace(/^[\s\r\n]+|[\s\r\n]+$/g, '');
    // Convert remaining newlines to <br> so multi-line property fields (bank
    // details, payment instructions, etc.) render with line breaks instead of
    // collapsing to spaces inside the surrounding <p>/<div>.
    s = s.replace(/\r\n|\r|\n/g, '<br>');
    return s;
  };

  let result = content;
  for (const [key, value] of Object.entries(variablesMap)) {
    const formatted = formatValue(value);
    // Replace normal version: %Name - Lease%
    result = result.split(key).join(formatted);

    // Replace &nbsp; version: %Name&nbsp;-&nbsp;Lease%
    const nbspKey = key.replace(/ /g, '&nbsp;');
    if (nbspKey !== key) {
      result = result.split(nbspKey).join(formatted);
    }
  }
  return result;
}

/**
 * Wrap email body HTML in a proper document with CSS reset so that <p> tags
 * rendered by the Quill rich-text editor don't add unwanted vertical spacing
 * in email clients (Gmail, Outlook, etc.).
 */
function wrapEmailHtml(bodyHtml) {
  // Gmail overrides inline margin on <p> tags with its own stylesheet.
  // Replace <p> with <div> which has no default margin in any email client.
  // Empty <p></p> tags (Quill's blank lines) become <div><br></div> to preserve spacing.
  let html = bodyHtml
    .replace(/<p><\/p>/gi, '<div><br></div>')
    .replace(/<p(\s|>)/gi, '<div$1')
    .replace(/<\/p>/gi, '</div>');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">${html}</body></html>`;
}

// ---------------------------------------------------------------------------
// Check lease email toggle
// ---------------------------------------------------------------------------

/**
 * Check if a lease has a specific email toggle enabled.
 * @param {string} leaseId
 * @param {string} toggleColumn - one of the toggle column names
 * @returns {boolean}
 */
async function shouldSendEmail(pool, leaseId, toggleColumn) {
  if (!leaseId || !toggleColumn) return true; // No lease context = send anyway
  if (!TOGGLE_MAP[toggleColumn] && !Object.values(TOGGLE_MAP).includes(toggleColumn)) return true;

  const column = TOGGLE_MAP[toggleColumn] || toggleColumn;

  try {
    const [rows] = await pool.execute(
      `SELECT \`${column}\` AS toggled FROM leasing WHERE id = ?`,
      [leaseId]
    );
    if (rows.length === 0) return false;
    // Bit/boolean columns: could be Buffer, number, or boolean
    return bitToBool(rows[0].toggled);
  } catch (err) {
    console.error(`[EmailService] Error checking toggle ${column}:`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-lease WhatsApp switches (migration 085), one per tenant notice.
//
// Separate from TOGGLE_MAP on purpose: the email and the WhatsApp for a notice are
// now independent, so unticking the email no longer silences the WhatsApp and a
// tenant with a phone but no email can still be reached.
// ---------------------------------------------------------------------------
const WA_TOGGLE_MAP = {
  'Invoice-Tenant': 'wa_tenant_posted',
  'Overdue-Tenant': 'wa_tenant_overdue',
  'Deposit-Tenant': 'wa_tenant_deposit_posted',
  'Checkin-Tenant': 'wa_tenant_checkin',
  'Checkout-Tenant': 'wa_tenant_checkout',
  'Renewal-Tenant': 'wa_tenant_renewal',
};

async function shouldSendWhatsApp(pool, leaseId, templateType) {
  const column = WA_TOGGLE_MAP[templateType];
  // Fail closed: a notice with no WhatsApp switch, or no lease to read it from,
  // is not sent on WhatsApp by this path.
  if (!leaseId || !column) return false;
  try {
    const [rows] = await pool.execute(
      `SELECT \`${column}\` AS toggled FROM leasing WHERE id = ?`,
      [leaseId]
    );
    return rows.length > 0 && bitToBool(rows[0].toggled);
  } catch (err) {
    console.error(`[EmailService] Error checking WhatsApp toggle ${column}:`, err.message);
    return false;
  }
}

/**
 * Send one tenant notice on each channel the lease has ticked, independently.
 *
 * Returns the email result if the email went, otherwise `{ whatsapp }` if only the
 * WhatsApp went, otherwise null — so callers that treat null as "skipped" (the
 * overdue sweep) count a WhatsApp-only send as sent.
 */
async function sendTenantNotice(pool, orgId, leaseId, templateType, opts = {}) {
  const [emailOn, waOn] = await Promise.all([
    shouldSendEmail(pool, leaseId, templateType),
    shouldSendWhatsApp(pool, leaseId, templateType),
  ]);
  let emailResult = null;
  if (emailOn) {
    emailResult = await sendTemplateEmail(pool, orgId, { ...opts, templateType, leaseId, whatsapp: false });
  }
  let waResult = null;
  if (waOn) {
    try {
      // Lazy require: whatsappService imports from this file.
      const { sendTemplateWhatsApp } = require('./whatsappService');
      waResult = await sendTemplateWhatsApp(pool, orgId, {
        templateType, leaseId,
        category: opts.category, dueDate: opts.dueDate, overdueAmount: opts.overdueAmount,
        invoiceCode: opts.invoiceCode, invoiceId: opts.invoiceId,
        extraVariables: opts.extraVariables, logType: opts.logType,
      });
    } catch (err) {
      console.error(`[WhatsApp] ${templateType} send failed for lease ${leaseId}:`, err.message);
    }
  }
  if (emailResult) return emailResult;
  if (waResult && waResult.ok) return { whatsapp: waResult };
  return null;
}

// ---------------------------------------------------------------------------
// Get recipient email — tenant or landlord
// ---------------------------------------------------------------------------

async function getTenantEmail(pool, leaseId) {
  const [rows] = await pool.execute(
    `SELECT t.email FROM tenant t
     JOIN leasing l ON l.tenant_id = t.id
     WHERE l.id = ?`,
    [leaseId]
  );
  return rows[0] ? rows[0].email : null;
}

async function getLandlordEmail(pool, orgId) {
  const [rows] = await pool.execute(
    `SELECT email FROM user WHERE org_id = ? AND status = 1 AND origin_id IS NULL AND email IS NOT NULL LIMIT 1`,
    [orgId]
  );
  return rows[0] ? rows[0].email : null;
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

/**
 * Send a template-based email.
 * @param {string} orgId
 * @param {object} opts
 *   - templateType: one of the TEMPLATE_TYPES values
 *   - templateId: specific template ID (optional, overrides type lookup)
 *   - leaseId: lease to resolve variables from
 *   - category: category ID or name for %Category%
 *   - dueDate: date for %Due Date%, %Payment Month%, etc.
 *   - overdueAmount: pre-computed overdue amount (optional)
 *   - toOverride: override recipient email (e.g. for test sends)
 * @returns {{ messageId, previewUrl } | null}
 */
async function sendTemplateEmail(pool, orgId, {
  templateType,
  templateId = null,
  leaseId,
  category,
  dueDate,
  overdueAmount,
  invoiceCode,
  invoiceId,
  toOverride,
  extraVariables,
  extraCc,
  attachments,
  // What to record in email_log.type. Defaults to templateType, which is what
  // every caller wanted until check-in grew a second send off the SAME template:
  // both legs render 'Checkin-Tenant', so logging both under that name makes them
  // indistinguishable and the follow-up's dedup check can never tell whether it
  // was the first email or its own that already went.
  logType = null,
  // Whether to also send this template on WhatsApp, coupled to the email. True
  // keeps the old behaviour for every caller that has no per-lease WhatsApp
  // setting (manual sends, landlord notices, receipts). The tenant notices pass
  // false and send WhatsApp themselves via sendTenantNotice, under the lease's own
  // WhatsApp tickbox.
  whatsapp = true,
} = {}) {
  // 1. Load template
  const template = await loadTemplate(pool, orgId, templateType, templateId);
  if (!template) {
    console.warn(`[EmailService] No template found for type=${templateType}, org=${orgId}. Skipping.`);
    return null;
  }

  // 2. Resolve variables
  let variables;
  if (leaseId) {
    variables = await resolveVariables(pool, orgId, leaseId, { category, dueDate, overdueAmount, invoiceCode, invoiceId });
  } else {
    variables = getSampleVariables();
  }

  // 2b. Merge extra variables (e.g. receipt-specific ones)
  if (extraVariables) {
    Object.assign(variables, extraVariables);
  }

  // 3. Substitute in subject and body
  const renderedSubject = substituteVariables(template.subject || '', variables);
  const bodyIsHtml = /<[a-z][\s\S]*>/i.test(template.template_content || '');
  let renderedBody = substituteVariables(template.template_content || '', variables, bodyIsHtml);

  // Plain-text bodies: convert raw newlines to <br>
  if (!bodyIsHtml) {
    renderedBody = renderedBody.replace(/\n/g, '<br>\n');
  }

  // 4. Determine recipient
  // Precedence: explicit toOverride > template.to_address > role-based (landlord/tenant)
  let recipient = toOverride;
  if (!recipient && template.to_address) {
    recipient = template.to_address;
  }
  if (!recipient) {
    if (templateType && templateType.toLowerCase().includes('landlord')) {
      recipient = await getLandlordEmail(pool, orgId);
    } else if (leaseId) {
      recipient = await getTenantEmail(pool, leaseId);
    }
  }

  if (!recipient) {
    console.warn(`[EmailService] No recipient for type=${templateType}, lease=${leaseId}. Skipping.`);
    return null;
  }

  // 4b. Whitelist check
  try {
    const [[orgRow]] = await pool.execute(
      'SELECT email_whitelist_enabled, email_whitelist FROM organization WHERE id = ?',
      [orgId]
    );
    if (orgRow) {
      const whitelistEnabled = bitToBool(orgRow.email_whitelist_enabled);

      if (whitelistEnabled) {
        const whitelist = (orgRow.email_whitelist || '')
          .split(/[,\n]/)
          .map(e => e.trim().toLowerCase())
          .filter(Boolean);

        const recipientLower = recipient.toLowerCase().trim();
        if (!whitelist.includes(recipientLower)) {
          console.log(`[EmailService] WHITELIST BLOCKED: ${recipient} not in whitelist for org=${orgId}. Skipping.`);
          // Log as blocked
          try {
            await pool.execute(
              `INSERT INTO email_log (org_id, to_email, subject, type, template_id, lease_id, status, error, sent_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'whitelist_blocked', 'Recipient not in whitelist', NOW(), NOW())`,
              [orgId, recipient, renderedSubject, logType || templateType || 'manual', template.id || null, leaseId || null]
            );
          } catch (logErr) { /* ignore */ }
          return null;
        }
      }
    }
  } catch (wlErr) {
    console.error('[EmailService] Whitelist check failed, proceeding with send:', wlErr.message);
  }

  // 5. Build email options
  const mailOpts = {
    to: recipient,
    subject: renderedSubject,
    html: wrapEmailHtml(renderedBody),
    from: template.from || undefined,
  };

  // Add CC/BCC if template has them; merge in any extraCc passed by caller
  const ccList = [];
  if (template.cc) ccList.push(template.cc);
  if (extraCc) {
    if (Array.isArray(extraCc)) ccList.push(...extraCc.filter(Boolean));
    else ccList.push(extraCc);
  }
  if (ccList.length > 0) mailOpts.cc = ccList.join(', ');
  if (template.bcc) mailOpts.bcc = template.bcc;
  if (template.reply_to) mailOpts.replyTo = template.reply_to;
  if (attachments && attachments.length > 0) mailOpts.attachments = attachments;

  console.log(`[EmailService] Sending type=${templateType} to=${mailOpts.to} cc=${mailOpts.cc || '(none)'} bcc=${mailOpts.bcc || '(none)'} from=${mailOpts.from || '(default)'} (template.cc raw=${JSON.stringify(template.cc)} template.bcc raw=${JSON.stringify(template.bcc)})`);

  // 6. Send — try matching SMTP account first, fall back to .env credentials
  let result;
  let status = 'sent';
  let error = null;
  try {
    const smtpAccount = await findSmtpAccount(pool, orgId, mailOpts.from);
    if (smtpAccount) {
      console.log(`[EmailService] Routing through smtp_account=${smtpAccount.email}`);
      result = await sendMailWithAccount(smtpAccount, mailOpts);
    } else {
      console.log(`[EmailService] No matching smtp_account, using .env transport`);
      result = await sendMail(mailOpts);
    }
  } catch (err) {
    status = 'failed';
    // mailer retries transient SMTP errors and attaches the attempt count. Record
    // it: "failed after 3 attempts" is a real outage, "failed after 1" is the
    // server refusing the message outright, and email_log is the only place
    // anyone can tell them apart afterwards.
    error = err.attempts > 1 ? `${err.message} (after ${err.attempts} attempts)` : err.message;
    console.error(`[EmailService] Send failed for type=${templateType}:`, error);
  }

  // 7. Log to email_log
  try {
    await pool.execute(
      `INSERT INTO email_log (org_id, to_email, subject, type, template_id, lease_id, status, error, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        orgId, recipient, renderedSubject, logType || templateType || 'manual',
        template.id || null, leaseId || null, status, error,
      ]
    );
  } catch (logErr) {
    console.error('[EmailService] Failed to write email_log:', logErr.message);
  }

  // 8. Parallel WhatsApp send (best-effort, fire-and-forget)
  // Looks up its own template in whatsapp_template — silent skip if none exists.
  // Lazy require avoids a circular dependency (whatsappService imports from this file).
  if (whatsapp) try {
    const { sendTemplateWhatsApp } = require('./whatsappService');
    sendTemplateWhatsApp(pool, orgId, {
      templateType, templateId, leaseId, category,
      dueDate, overdueAmount, invoiceCode, invoiceId,
      extraVariables,
    }).catch(err => console.error('[WhatsApp] template send failed:', err.message));
  } catch (waErr) {
    console.error('[WhatsApp] sendTemplateWhatsApp dispatch failed:', waErr.message);
  }

  return result || null;
}

// ---------------------------------------------------------------------------
// Preview (render without sending)
// ---------------------------------------------------------------------------

/**
 * Render a template with variables but do NOT send.
 * @returns {{ subject, body, variables }}
 */
async function previewTemplate(pool, orgId, { templateId, templateType, leaseId, category, dueDate } = {}) {
  const template = await loadTemplate(pool, orgId, templateType, templateId);
  if (!template) {
    return { subject: '', body: '', variables: getSampleVariables() };
  }

  let variables;
  if (leaseId) {
    variables = await resolveVariables(pool, orgId, leaseId, { category, dueDate });
  } else {
    variables = getSampleVariables();
  }

  const renderedSubject = substituteVariables(template.subject || '', variables);
  const bodyIsHtml = /<[a-z][\s\S]*>/i.test(template.template_content || '');
  let renderedBody = substituteVariables(template.template_content || '', variables, bodyIsHtml);

  if (!bodyIsHtml) {
    renderedBody = renderedBody.replace(/\n/g, '<br>\n');
  }

  return { subject: renderedSubject, body: wrapEmailHtml(renderedBody), variables };
}

// ---------------------------------------------------------------------------
// Convenience send functions (check toggle → resolve → send)
// ---------------------------------------------------------------------------

async function sendInvoiceToTenant(pool, orgId, leaseId, { invoiceId, invoiceCode, category, dueDate } = {}) {
  return sendTenantNotice(pool, orgId, leaseId, 'Invoice-Tenant', {
    category,
    dueDate,
    invoiceId,
    invoiceCode,
  });
}

async function sendInvoiceToLandlord(pool, orgId, leaseId, { invoiceId, invoiceCode, category, dueDate } = {}) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Invoice-Landlord');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Invoice-Landlord',
    leaseId,
    category,
    dueDate,
    invoiceId,
    invoiceCode,
  });
}

async function sendOverdueToTenant(pool, orgId, leaseId, { dueDate, overdueAmount, invoiceId, invoiceCode, category } = {}) {
  return sendTenantNotice(pool, orgId, leaseId, 'Overdue-Tenant', {
    // Accepted above and forwarded here. Leaving it out of either half is
    // what made %Category% render blank in every overdue email.
    category,
    dueDate,
    overdueAmount,
    invoiceId,
    invoiceCode,
  });
}

async function sendOverdueToLandlord(pool, orgId, leaseId, { dueDate, overdueAmount, invoiceId, invoiceCode, category } = {}) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Overdue-Landlord');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Overdue-Landlord',
    leaseId,
    // Accepted above and forwarded here. Leaving it out of either half is
    // what made %Category% render blank in every overdue email.
    category,
    dueDate,
    overdueAmount,
    invoiceId,
    invoiceCode,
  });
}

async function sendCheckinToTenant(pool, orgId, leaseId) {
  return sendTenantNotice(pool, orgId, leaseId, 'Checkin-Tenant');
}

// The check-in follow-up. Renders the SAME template as the first email — the
// operator configures one Check-In template and gives it two lead times
// (`date_first`, `date_second`), exactly as Invoice-Tenant already works — but
// records itself under its own type so the two legs dedup independently.
const CHECKIN_FOLLOWUP_TYPE = 'Checkin-Tenant-2';

async function sendCheckinFollowUpToTenant(pool, orgId, leaseId) {
  // Same per-lease toggles as the first message: switching check-in off must
  // silence both legs, not just the one the operator happens to think of.
  return sendTenantNotice(pool, orgId, leaseId, 'Checkin-Tenant', {
    logType: CHECKIN_FOLLOWUP_TYPE,
  });
}

async function sendCheckoutToTenant(pool, orgId, leaseId) {
  return sendTenantNotice(pool, orgId, leaseId, 'Checkout-Tenant');
}

async function sendRenewalToTenant(pool, orgId, leaseId) {
  return sendTenantNotice(pool, orgId, leaseId, 'Renewal-Tenant');
}

async function sendLeaseExpiryToLandlord(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Leaseexpiry-Landlord');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Leaseexpiry-Landlord',
    leaseId,
  });
}

/**
 * Send a payment receipt email with the receipt PDF attached.
 * @param {object} pool - DB pool
 * @param {string} orgId
 * @param {string} leaseId - lease to check toggle & resolve variables
 * @param {object} paymentInfo - { paymentId, amount, transactionCode, paymentMethod, invoiceCode }
 * @param {Buffer} pdfBuffer - generated receipt PDF as a Buffer
 */
async function sendReceiptToTenant(pool, orgId, leaseId, paymentInfo = {}, pdfBuffer = null) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Receipt-Tenant');
  if (!shouldSend) return null;

  const sym = await (async () => {
    try {
      const [[row]] = await pool.execute(
        `SELECT p.currency FROM leasing l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id WHERE l.id = ?`,
        [leaseId]
      );
      return CURRENCY_SYMBOLS[row?.currency] || '$';
    } catch { return '$'; }
  })();

  const extraVariables = {
    '%Receipt Amount%': `${sym}${parseFloat(paymentInfo.amount || 0).toFixed(2)}`,
    '%Transaction Code%': paymentInfo.transactionCode || '',
    '%Payment Method%': paymentInfo.paymentMethod || '',
    '%Invoice Number%': paymentInfo.invoiceCode || '',
  };

  const attachments = pdfBuffer ? [{
    filename: `receipt-${paymentInfo.transactionCode || paymentInfo.paymentId || 'payment'}.pdf`,
    content: pdfBuffer,
    contentType: 'application/pdf',
  }] : [];

  return sendTemplateEmail(pool, orgId, {
    templateType: 'Receipt-Tenant',
    leaseId,
    invoiceCode: paymentInfo.invoiceCode,
    extraVariables,
    attachments,
  });
}

async function sendDepositToTenant(pool, orgId, leaseId) {
  return sendTenantNotice(pool, orgId, leaseId, 'Deposit-Tenant');
}

// ---------------------------------------------------------------------------
// Dedup helper — check if an email of a given type was already sent for a lease
// ---------------------------------------------------------------------------

/**
 * Check if an email of a specific type has already been sent for a lease.
 * Used by scheduler to avoid sending duplicate check-in/check-out/renewal emails.
 * @param {string} leaseId
 * @param {string} templateType - e.g. 'Checkin-Tenant', 'Checkout-Tenant'
 * @returns {boolean} true if already sent
 */
async function hasEmailBeenSent(pool, leaseId, templateType) {
  if (!leaseId || !templateType) return false;
  try {
    const [[row]] = await pool.execute(
      // Either channel counts. A lease with only WhatsApp ticked writes nothing to
      // email_log, so checking email alone would re-send its check-in, check-out
      // or renewal message every morning.
      `SELECT (SELECT COUNT(*) FROM email_log
                WHERE lease_id = ? AND type = ? AND status = 'sent')
            + (SELECT COUNT(*) FROM whatsapp_log
                WHERE lease_id = ? AND type = ? AND status = 'sent') AS cnt`,
      [leaseId, templateType, leaseId, templateType]
    );
    return (row.cnt || 0) > 0;
  } catch (err) {
    console.error(`[EmailService] Error checking email_log for ${templateType}:`, err.message);
    return false;
  }
}

/**
 * The Hong Kong calendar date an email of this type last went out for a lease,
 * or null if none ever did.
 *
 * `sent_at` is a TIMESTAMP — an absolute instant that MySQL renders in the
 * connection's timezone, which is UTC in production. A bare DATE(sent_at) is
 * therefore a day behind Hong Kong for anything sent between 00:00 and 08:00 HK,
 * and the 07:00 check-in sweep lands squarely in that band: its rows read 23:00
 * the previous day. orgTimeSql shifts the instant onto the operator's clock
 * first — without it the follow-up would measure its gap from the wrong day.
 */
async function lastSentOrgDate(pool, leaseId, templateType) {
  if (!leaseId || !templateType) return null;
  try {
    const [[row]] = await pool.execute(
      `SELECT DATE(${orgTimeSql('MAX(t)')}) AS d FROM (
         SELECT sent_at AS t FROM email_log
          WHERE lease_id = ? AND type = ? AND status = 'sent'
         UNION ALL
         SELECT COALESCE(sent_at, created_at) FROM whatsapp_log
          WHERE lease_id = ? AND type = ? AND status = 'sent'
       ) x`,
      [leaseId, templateType, leaseId, templateType]
    );
    if (!row || !row.d) return null;
    return row.d instanceof Date ? toCalendarDate(row.d) : String(row.d).slice(0, 10);
  } catch (err) {
    console.error(`[EmailService] Error reading last sent date for ${templateType}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Payment-Options resolver
// ---------------------------------------------------------------------------

// Resolve the Payment-Options email template for a building:
//   1) a template explicitly linked to this property (via property_email_template)
//   2) else a catch-all Payment-Options template (no property_email_template rows)
//   3) else null (caller skips sending)
async function resolvePaymentOptionsTemplate(pool, orgId, propertyId) {
  // 1) building-specific
  const [linked] = await pool.execute(
    `SELECT et.id, et.is_default_template, et.created_time
       FROM email_template et
       JOIN property_email_template pet ON pet.template_id = et.id AND pet.org_id = et.org_id
      WHERE et.org_id = ? AND pet.property_id = ?
        AND et.template_type = 'Payment-Options' AND et.status = 1`,
    [orgId, propertyId]
  );
  const specific = pickTemplate(linked);
  if (specific) return specific;

  // 2) catch-all: Payment-Options templates with NO property links
  const [catchAll] = await pool.execute(
    `SELECT et.id, et.is_default_template, et.created_time
       FROM email_template et
      WHERE et.org_id = ? AND et.template_type = 'Payment-Options' AND et.status = 1
        AND NOT EXISTS (
          SELECT 1 FROM property_email_template pet
           WHERE pet.template_id = et.id AND pet.org_id = et.org_id
        )`,
    [orgId]
  );
  return pickTemplate(catchAll);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  TEMPLATE_TYPES,
  TEMPLATE_VARIABLES,
  TOGGLE_MAP,

  // Core functions
  findSmtpAccount,
  extractEmail,
  formatInvoicingFrequency,
  loadTemplate,
  resolveVariables,
  substituteVariables,
  wrapEmailHtml,
  getSampleVariables,
  tenantCategoryLabel,
  sendTemplateEmail,
  previewTemplate,
  shouldSendEmail,
  hasEmailBeenSent,
  lastSentOrgDate,
  shouldSendWhatsApp,
  sendTenantNotice,
  WA_TOGGLE_MAP,
  CHECKIN_FOLLOWUP_TYPE,

  // Convenience senders
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendOverdueToTenant,
  sendOverdueToLandlord,
  sendCheckinToTenant,
  sendCheckinFollowUpToTenant,
  sendCheckoutToTenant,
  sendRenewalToTenant,
  sendLeaseExpiryToLandlord,
  sendDepositToTenant,
  sendReceiptToTenant,

  // Per-building resolvers
  resolvePaymentOptionsTemplate,
};
