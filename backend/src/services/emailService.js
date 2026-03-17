
const { sendMail, sendMailWithAccount } = require('../config/mailer');

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
  { value: 'Inventory-Tenant', label: 'Inventory (Tenant)' },
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
};

// ---------------------------------------------------------------------------
// Available template variables with descriptions
// ---------------------------------------------------------------------------

const TEMPLATE_VARIABLES = [
  { key: '%Name - Lease%', description: 'Tenant full name (or company name)' },
  { key: '%Unit # - Property%', description: 'Unit name/number' },
  { key: '%Name - Property%', description: 'Property name' },
  { key: '%Building / Unit Address - Property%', description: 'Property full address' },
  { key: '%Lease start date - Lease%', description: 'Lease start date' },
  { key: '%Lease end date - Lease%', description: 'Lease end date' },
  { key: '%Unit Access Information - Property%', description: 'Unit access information' },
  { key: '%Wifi Details - Property%', description: 'WiFi details' },
  { key: '%Payment Info - Property%', description: 'Payment instructions' },
  { key: '%Unit Information - Lease%', description: 'Unit information from lease' },
  { key: '%Outstandings%', description: 'Total outstanding balance with currency' },
  { key: '%Monthly utility credit%', description: 'Monthly utility credit amount' },
  { key: '%Security deposit amount%', description: 'Security deposit amount' },
  { key: '%Payment Month%', description: 'Payment month name (e.g. March)' },
  { key: '%Payment Date%', description: 'Payment date (e.g. March 15)' },
  { key: '%Due Date%', description: 'Full due date (e.g. March 15, 2026)' },
  { key: '%Overdue Amount%', description: 'Total overdue invoice amount' },
  { key: '%Tenant Number%', description: 'Tenant phone number' },
  { key: '%Category%', description: 'Invoice category name' },
  { key: '%Invoice Number%', description: 'Invoice code (e.g. TRIV0000000001)' },
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

  // Load the default template for this type
  const [rows] = await pool.execute(
    `SELECT * FROM email_template
     WHERE org_id = ? AND template_type = ? AND is_default_template = 1 AND status = 1
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
       l.credits, l.deposit, l.amount AS lease_amount,
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

  // 2. Compute outstanding balance for this lease
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
       WHERE i.leasing_id = ? AND i.status IN (0, 2) AND i.deleted_at IS NULL`,
      [leaseId, orgId, leaseId]
    );
    outstanding = (parseFloat(outRow.total_invoiced) || 0) - (parseFloat(outRow.total_paid) || 0);
  } catch (err) {
    console.error('[EmailService] Error computing outstanding:', err.message);
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
    // category is an ID — look up the name
    try {
      const [[catRow]] = await pool.execute(
        'SELECT display_name FROM category_setting WHERE id = ?',
        [category]
      );
      categoryName = catRow ? catRow.display_name : '';
    } catch (err) { /* ignore */ }
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
    '%Unit Access Information - Property%': r.access_information || '',
    '%Wifi Details - Property%': r.wifi_information || '',
    '%Payment Info - Property%': paymentInfo,
    '%Unit Information - Lease%': r.unit_information || '',
    '%Outstandings%': formatAmount(sym, outstanding),
    '%Monthly utility credit%': formatAmount(sym, r.credits),
    '%Security deposit amount%': formatAmount(sym, r.deposit),
    '%Payment Month%': formatMonth(effectiveDueDate),
    '%Payment Date%': formatPaymentDate(effectiveDueDate),
    '%Due Date%': formatDueDate(effectiveDueDate),
    '%Overdue Amount%': formatAmount(sym, overdue),
    '%Tenant Number%': r.tenant_phone || '',
    '%Category%': categoryName,
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
    '%Unit Access Information - Property%': 'Front gate code: 1234',
    '%Wifi Details - Property%': 'Network: SunsetWifi, Password: guest123',
    '%Payment Info - Property%': 'Bank transfer to Account #XXXX',
    '%Unit Information - Lease%': 'Studio apartment, furnished',
    '%Outstandings%': '$1,200.00',
    '%Monthly utility credit%': '$50.00',
    '%Security deposit amount%': '$2,400.00',
    '%Payment Month%': 'March',
    '%Payment Date%': 'March 15',
    '%Due Date%': 'March 15, 2026',
    '%Overdue Amount%': '$0.00',
    '%Tenant Number%': '(555) 123-4567',
    '%Category%': 'Rental Income',
    '%Invoice Number%': 'TRIV0000000001',
  };
}

// ---------------------------------------------------------------------------
// Variable substitution
// ---------------------------------------------------------------------------

/**
 * Replace all %Variable% placeholders in content with resolved values.
 * Also handles &nbsp; variants (HTML editors sometimes encode spaces).
 */
function substituteVariables(content, variablesMap) {
  if (!content) return '';

  let result = content;
  for (const [key, value] of Object.entries(variablesMap)) {
    // Replace normal version: %Name - Lease%
    result = result.split(key).join(value || '');

    // Replace &nbsp; version: %Name&nbsp;-&nbsp;Lease%
    const nbspKey = key.replace(/ /g, '&nbsp;');
    if (nbspKey !== key) {
      result = result.split(nbspKey).join(value || '');
    }
  }
  return result;
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
    const val = rows[0].toggled;
    if (Buffer.isBuffer(val)) return val[0] === 1;
    return Boolean(val);
  } catch (err) {
    console.error(`[EmailService] Error checking toggle ${column}:`, err.message);
    return false;
  }
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

  // 3. Substitute in subject and body
  const renderedSubject = substituteVariables(template.subject || '', variables);
  const renderedBody = substituteVariables(template.template_content || '', variables);

  // 4. Determine recipient
  let recipient = toOverride;
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
      let whitelistEnabled = false;
      if (orgRow.email_whitelist_enabled) {
        if (Buffer.isBuffer(orgRow.email_whitelist_enabled)) {
          whitelistEnabled = orgRow.email_whitelist_enabled[0] === 1;
        } else {
          whitelistEnabled = Boolean(orgRow.email_whitelist_enabled);
        }
      }

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
              [orgId, recipient, renderedSubject, templateType || 'manual', template.id || null, leaseId || null]
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
    html: renderedBody,
    from: template.from || undefined,
  };

  // Add CC/BCC if template has them
  if (template.cc) mailOpts.cc = template.cc;
  if (template.bcc) mailOpts.bcc = template.bcc;
  if (template.reply_to) mailOpts.replyTo = template.reply_to;

  // 6. Send — try matching SMTP account first, fall back to .env credentials
  let result;
  let status = 'sent';
  let error = null;
  try {
    const smtpAccount = await findSmtpAccount(pool, orgId, mailOpts.from);
    if (smtpAccount) {
      result = await sendMailWithAccount(smtpAccount, mailOpts);
    } else {
      result = await sendMail(mailOpts);
    }
  } catch (err) {
    status = 'failed';
    error = err.message;
    console.error(`[EmailService] Send failed for type=${templateType}:`, err.message);
  }

  // 7. Log to email_log
  try {
    await pool.execute(
      `INSERT INTO email_log (org_id, to_email, subject, type, template_id, lease_id, status, error, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        orgId, recipient, renderedSubject, templateType || 'manual',
        template.id || null, leaseId || null, status, error,
      ]
    );
  } catch (logErr) {
    console.error('[EmailService] Failed to write email_log:', logErr.message);
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
  const renderedBody = substituteVariables(template.template_content || '', variables);

  return { subject: renderedSubject, body: renderedBody, variables };
}

// ---------------------------------------------------------------------------
// Convenience send functions (check toggle → resolve → send)
// ---------------------------------------------------------------------------

async function sendInvoiceToTenant(pool, orgId, leaseId, { invoiceId, invoiceCode, category, dueDate } = {}) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Invoice-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Invoice-Tenant',
    leaseId,
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

async function sendOverdueToTenant(pool, orgId, leaseId, { dueDate, overdueAmount } = {}) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Overdue-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Overdue-Tenant',
    leaseId,
    dueDate,
    overdueAmount,
  });
}

async function sendOverdueToLandlord(pool, orgId, leaseId, { dueDate, overdueAmount } = {}) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Overdue-Landlord');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Overdue-Landlord',
    leaseId,
    dueDate,
    overdueAmount,
  });
}

async function sendCheckinToTenant(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Checkin-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Checkin-Tenant',
    leaseId,
  });
}

async function sendCheckoutToTenant(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Checkout-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Checkout-Tenant',
    leaseId,
  });
}

async function sendRenewalToTenant(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Renewal-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Renewal-Tenant',
    leaseId,
  });
}

async function sendLeaseExpiryToLandlord(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Leaseexpiry-Landlord');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Leaseexpiry-Landlord',
    leaseId,
  });
}

async function sendDepositToTenant(pool, orgId, leaseId) {
  const shouldSend = await shouldSendEmail(pool, leaseId, 'Deposit-Tenant');
  if (!shouldSend) return null;
  return sendTemplateEmail(pool, orgId, {
    templateType: 'Deposit-Tenant',
    leaseId,
  });
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
  loadTemplate,
  resolveVariables,
  substituteVariables,
  getSampleVariables,
  sendTemplateEmail,
  previewTemplate,
  shouldSendEmail,

  // Convenience senders
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendOverdueToTenant,
  sendOverdueToLandlord,
  sendCheckinToTenant,
  sendCheckoutToTenant,
  sendRenewalToTenant,
  sendLeaseExpiryToLandlord,
  sendDepositToTenant,
};
