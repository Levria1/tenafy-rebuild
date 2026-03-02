const cron = require('node-cron');
const pool = require('../config/database');
const { sendMail } = require('../config/mailer');

// ---------------------------------------------------------------------------
// Notification helper — creates in-app notification + optional email alert
// ---------------------------------------------------------------------------

/**
 * Create an in-app notification in the database.
 * @param {object} opts - { orgId, type, title, message, link }
 *   type: 'error' | 'warning' | 'success' | 'info'
 */
async function createNotification({ orgId, type, title, message, link }) {
  try {
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
    await pool.execute(
      `INSERT INTO notification (id, org_id, type, title, message, link, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
      [id.toString(), orgId, type || 'info', title, message || null, link || null]
    );
  } catch (err) {
    console.error('[Scheduler] Failed to create notification:', err.message);
  }
}

/**
 * Send an email alert to org admin(s) about a scheduler event.
 * Looks up the org's admin email from the user table.
 */
async function sendAdminAlert({ orgId, subject, html }) {
  try {
    // Get admin email(s) for this org
    const [admins] = await pool.execute(
      `SELECT email FROM user WHERE org_id = ? AND status = 1 AND role_type = 0 AND email IS NOT NULL LIMIT 3`,
      [orgId]
    );
    if (admins.length === 0) return;

    const emails = admins.map(a => a.email).filter(Boolean);
    if (emails.length === 0) return;

    await sendMail({
      to: emails,
      subject: `[Tenafy] ${subject}`,
      html,
    });
    console.log(`[Scheduler] Admin alert sent to ${emails.join(', ')}: ${subject}`);
  } catch (err) {
    // Don't let email failures break the scheduler
    console.error('[Scheduler] Failed to send admin alert email:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPeriodCheck(schedule) {
  const s = (schedule || '').toLowerCase();

  switch (s) {
    case 'weekly':
      return { sql: 'YEARWEEK(due_on, 1) = YEARWEEK(NOW(), 1)', params: [] };
    case 'bi-weekly':
      return { sql: 'due_on >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND due_on <= DATE_ADD(CURDATE(), INTERVAL 13 DAY)', params: [] };
    case 'monthly':
      return { sql: 'YEAR(due_on) = YEAR(NOW()) AND MONTH(due_on) = MONTH(NOW())', params: [] };
    case 'quarterly':
      return { sql: 'YEAR(due_on) = YEAR(NOW()) AND QUARTER(due_on) = QUARTER(NOW())', params: [] };
    case 'bi-annually':
      return { sql: 'YEAR(due_on) = YEAR(NOW()) AND CEIL(MONTH(due_on) / 6) = CEIL(MONTH(NOW()) / 6)', params: [] };
    case 'annually':
      return { sql: 'YEAR(due_on) = YEAR(NOW())', params: [] };
    default:
      return { sql: 'YEAR(due_on) = YEAR(NOW()) AND MONTH(due_on) = MONTH(NOW())', params: [] };
  }
}

function calculateDueDate(schedule) {
  const now = new Date();
  const s = (schedule || '').toLowerCase();

  switch (s) {
    case 'weekly':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'bi-weekly':
      return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    case 'monthly': {
      return new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }
    case 'quarterly': {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const nextQuarterMonth = (currentQuarter + 1) * 3;
      const year = nextQuarterMonth >= 12 ? now.getFullYear() + 1 : now.getFullYear();
      const month = nextQuarterMonth >= 12 ? 0 : nextQuarterMonth;
      return new Date(year, month, 1);
    }
    case 'bi-annually': {
      const currentHalf = now.getMonth() < 6 ? 0 : 1;
      const nextHalfMonth = currentHalf === 0 ? 6 : 0;
      const nextHalfYear = currentHalf === 0 ? now.getFullYear() : now.getFullYear() + 1;
      return new Date(nextHalfYear, nextHalfMonth, 1);
    }
    case 'annually':
      return new Date(now.getFullYear() + 1, 0, 1);
    default:
      return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
}

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Job 1: Auto-generate recurring invoices
// ---------------------------------------------------------------------------

async function generateRecurringInvoices() {
  const [leases] = await pool.execute(
    `SELECT
       l.id,
       l.tenant_id,
       l.unit_id,
       l.amount AS price,
       l.invoicing,
       l.currency_id,
       p.org_id   AS org_id,
       p.display_name AS property_name,
       u.name AS unit_name
     FROM leasing l
     JOIN unit u    ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE l.status = 1
       AND l.deleted_at IS NULL
       AND l.invoicing IS NOT NULL
       AND l.invoicing != ''
       AND l.amount IS NOT NULL
       AND l.amount > 0`
  );

  if (leases.length === 0) {
    console.log('[Scheduler] No active recurring leases found.');
    return;
  }

  console.log(`[Scheduler] Found ${leases.length} recurring lease(s) to evaluate.`);

  // Track results per org so we can send grouped notifications
  const orgResults = {}; // orgId -> { created, skipped, errors, errorDetails[] }

  for (const lease of leases) {
    if (!orgResults[lease.org_id]) {
      orgResults[lease.org_id] = { created: 0, skipped: 0, errors: 0, errorDetails: [] };
    }
    const result = orgResults[lease.org_id];

    try {
      const { sql: periodSql, params: periodParams } = getPeriodCheck(lease.invoicing);

      const [[{ count }]] = await pool.execute(
        `SELECT COUNT(*) AS count
         FROM invoice
         WHERE tenant_id = ?
           AND unit_id   = ?
           AND org_id    = ?
           AND ${periodSql}`,
        [lease.tenant_id, lease.unit_id, lease.org_id, ...periodParams]
      );

      if (count > 0) {
        result.skipped++;
        continue;
      }

      const invoiceCode = `INV-${Date.now()}-${lease.id}`;
      const dueDate = toDateString(calculateDueDate(lease.invoicing));

      const [[defaultCategory]] = await pool.execute(
        `SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 ORDER BY id LIMIT 1`,
        [lease.org_id]
      );
      const categoryId = defaultCategory ? defaultCategory.id : null;

      await pool.execute(
        `INSERT INTO invoice
           (org_id, tenant_id, unit_id, invoice_code, amount, note, due_on, currency_id, category, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
        [
          lease.org_id,
          lease.tenant_id,
          lease.unit_id,
          invoiceCode,
          lease.price,
          'Recurring rent invoice',
          dueDate,
          lease.currency_id,
          categoryId,
        ]
      );

      result.created++;
      console.log(
        `[Scheduler] Created invoice ${invoiceCode} for lease ${lease.id} ` +
        `(tenant ${lease.tenant_id}, unit ${lease.unit_id}, due ${dueDate})`
      );

      await new Promise((resolve) => setTimeout(resolve, 2));
    } catch (err) {
      result.errors++;
      result.errorDetails.push(`${lease.property_name} / ${lease.unit_name}: ${err.message}`);
      console.error(`[Scheduler] Error processing lease ${lease.id}:`, err.message);
    }
  }

  // Send notifications per org
  for (const [orgId, result] of Object.entries(orgResults)) {
    const { created, skipped, errors, errorDetails } = result;

    if (created > 0) {
      await createNotification({
        orgId,
        type: 'success',
        title: `${created} recurring invoice${created > 1 ? 's' : ''} generated`,
        message: `${created} created, ${skipped} already existed. ${errors > 0 ? `${errors} failed.` : ''}`,
        link: '/invoices',
      });
    }

    if (errors > 0) {
      const errorMsg = errorDetails.slice(0, 5).join('\n');
      const suffix = errorDetails.length > 5 ? `\n...and ${errorDetails.length - 5} more` : '';

      await createNotification({
        orgId,
        type: 'error',
        title: `${errors} invoice${errors > 1 ? 's' : ''} failed to generate`,
        message: `${errorMsg}${suffix}`,
        link: '/leasing',
      });

      // Also send email alert for errors
      await sendAdminAlert({
        orgId,
        subject: `${errors} recurring invoice(s) failed to generate`,
        html: `
          <h3>Recurring Invoice Generation Alert</h3>
          <p>The automatic invoice scheduler encountered errors:</p>
          <ul>
            <li><strong>Created:</strong> ${created}</li>
            <li><strong>Skipped (already exists):</strong> ${skipped}</li>
            <li style="color: red;"><strong>Failed:</strong> ${errors}</li>
          </ul>
          <h4>Error details:</h4>
          <ul>
            ${errorDetails.map(d => `<li>${d}</li>`).join('')}
          </ul>
          <p>Please review the affected leases in the <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/leasing">Leasing section</a>.</p>
          <p style="color: #999;">— Tenafy Scheduler</p>
        `,
      });
    }
  }

  const totalCreated = Object.values(orgResults).reduce((s, r) => s + r.created, 0);
  const totalSkipped = Object.values(orgResults).reduce((s, r) => s + r.skipped, 0);
  const totalErrors = Object.values(orgResults).reduce((s, r) => s + r.errors, 0);
  console.log(
    `[Scheduler] Recurring invoice run complete — created: ${totalCreated}, skipped: ${totalSkipped}, errors: ${totalErrors}`
  );
}

// ---------------------------------------------------------------------------
// Job 2: Lease expiry notifications
// ---------------------------------------------------------------------------

async function sendLeaseExpiryNotifications() {
  const [leases] = await pool.execute(
    `SELECT
       l.id,
       l.end_date,
       l.tenant_id,
       t.email          AS tenant_email,
       t.first_name     AS tenant_first_name,
       t.last_name      AS tenant_last_name,
       p.display_name   AS property_name,
       p.org_id         AS org_id,
       u.name           AS unit_name,
       DATEDIFF(l.end_date, CURDATE()) AS days_remaining
     FROM leasing l
     JOIN unit u     ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t   ON l.tenant_id = t.id
     WHERE l.status = 1
       AND l.deleted_at IS NULL
       AND l.end_date >= CURDATE()
       AND l.end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
       AND t.email IS NOT NULL
       AND t.email != ''`
  );

  if (leases.length === 0) {
    console.log('[Scheduler] No expiring leases found within the next 30 days.');
    return;
  }

  console.log(`[Scheduler] Found ${leases.length} expiring lease(s). Sending notifications...`);

  // Track per org
  const orgResults = {}; // orgId -> { sent, failures, details[] }

  for (const lease of leases) {
    if (!orgResults[lease.org_id]) {
      orgResults[lease.org_id] = { sent: 0, failures: 0, details: [] };
    }
    const result = orgResults[lease.org_id];

    try {
      const endDateFormatted = new Date(lease.end_date).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      const subject = `Lease Expiry Notice — ${lease.property_name}`;
      const html = `
        <p>Dear ${lease.tenant_first_name} ${lease.tenant_last_name},</p>
        <p>
          This is a reminder that your lease at
          <strong>${lease.property_name}</strong>${lease.unit_name ? `, Unit ${lease.unit_name}` : ''}
          will expire on <strong>${endDateFormatted}</strong>
          (${lease.days_remaining} day${lease.days_remaining === 1 ? '' : 's'} remaining).
        </p>
        <p>Please contact your property manager if you would like to discuss renewal options.</p>
        <p>— The Tenafy Team</p>
      `;

      await sendMail({ to: lease.tenant_email, subject, html });
      result.sent++;
      result.details.push(`${lease.tenant_first_name} ${lease.tenant_last_name} @ ${lease.property_name} ${lease.unit_name || ''} (${lease.days_remaining}d)`);
    } catch (err) {
      result.failures++;
      console.error(`[Scheduler] Failed to send lease expiry for lease ${lease.id}:`, err.message);
    }
  }

  // Send in-app notifications per org
  for (const [orgId, result] of Object.entries(orgResults)) {
    if (result.sent > 0) {
      await createNotification({
        orgId,
        type: 'info',
        title: `${result.sent} lease expiry notice${result.sent > 1 ? 's' : ''} sent`,
        message: result.details.slice(0, 3).join(', ') + (result.details.length > 3 ? ` +${result.details.length - 3} more` : ''),
        link: '/leasing',
      });
    }
    if (result.failures > 0) {
      await createNotification({
        orgId,
        type: 'warning',
        title: `${result.failures} lease expiry email${result.failures > 1 ? 's' : ''} failed to send`,
        message: 'Check that tenant email addresses are valid and SMTP is configured.',
        link: '/leasing',
      });
    }
  }

  const totalSent = Object.values(orgResults).reduce((s, r) => s + r.sent, 0);
  const totalFail = Object.values(orgResults).reduce((s, r) => s + r.failures, 0);
  console.log(`[Scheduler] Lease expiry run complete — sent: ${totalSent}, failures: ${totalFail}`);
}

// ---------------------------------------------------------------------------
// Job 3: Overdue invoice reminders
// ---------------------------------------------------------------------------

async function sendOverdueReminders() {
  const MAX_PER_RUN = 50;

  const [invoices] = await pool.execute(
    `SELECT
       i.id,
       i.invoice_code,
       i.amount,
       i.due_on,
       i.org_id,
       t.email        AS tenant_email,
       t.first_name   AS tenant_first_name,
       t.last_name    AS tenant_last_name,
       p.display_name AS property_name,
       u.name         AS unit_name,
       DATEDIFF(CURDATE(), i.due_on) AS days_overdue
     FROM invoice i
     JOIN tenant t   ON i.tenant_id = t.id
     JOIN unit u     ON i.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE i.status = 0
       AND i.due_on < CURDATE()
       AND t.email IS NOT NULL
       AND t.email != ''
     ORDER BY i.due_on ASC
     LIMIT ?`,
    [MAX_PER_RUN]
  );

  if (invoices.length === 0) {
    console.log('[Scheduler] No overdue invoices found.');
    return;
  }

  console.log(`[Scheduler] Found ${invoices.length} overdue invoice(s). Sending reminders...`);

  const orgResults = {};

  for (const inv of invoices) {
    if (!orgResults[inv.org_id]) {
      orgResults[inv.org_id] = { sent: 0, failures: 0, totalOverdue: 0 };
    }
    const result = orgResults[inv.org_id];
    result.totalOverdue++;

    try {
      const dueDateFormatted = new Date(inv.due_on).toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      const amountFormatted = Number(inv.amount).toFixed(2);
      const subject = `Payment Reminder — Invoice ${inv.invoice_code} is Overdue`;
      const html = `
        <p>Dear ${inv.tenant_first_name} ${inv.tenant_last_name},</p>
        <p>
          This is a reminder that invoice <strong>${inv.invoice_code}</strong>
          for <strong>$${amountFormatted}</strong> at
          <strong>${inv.property_name}</strong>${inv.unit_name ? `, Unit ${inv.unit_name}` : ''}
          was due on <strong>${dueDateFormatted}</strong>
          and is now <strong>${inv.days_overdue} day${inv.days_overdue === 1 ? '' : 's'} overdue</strong>.
        </p>
        <p>Please arrange payment at your earliest convenience or contact your property manager.</p>
        <p>— The Tenafy Team</p>
      `;

      await sendMail({ to: inv.tenant_email, subject, html });
      result.sent++;
    } catch (err) {
      result.failures++;
      console.error(`[Scheduler] Failed to send overdue reminder for ${inv.invoice_code}:`, err.message);
    }
  }

  // Send in-app notifications per org
  for (const [orgId, result] of Object.entries(orgResults)) {
    if (result.sent > 0) {
      await createNotification({
        orgId,
        type: 'warning',
        title: `${result.sent} overdue reminder${result.sent > 1 ? 's' : ''} sent`,
        message: `Sent payment reminders for ${result.sent} overdue invoice${result.sent > 1 ? 's' : ''}.`,
        link: '/invoices',
      });
    }
    if (result.failures > 0) {
      await createNotification({
        orgId,
        type: 'error',
        title: `${result.failures} overdue reminder${result.failures > 1 ? 's' : ''} failed to send`,
        message: 'Some overdue payment reminders could not be emailed. Check tenant email addresses.',
        link: '/invoices',
      });
    }
  }

  const totalSent = Object.values(orgResults).reduce((s, r) => s + r.sent, 0);
  const totalFail = Object.values(orgResults).reduce((s, r) => s + r.failures, 0);
  console.log(`[Scheduler] Overdue reminder run complete — sent: ${totalSent}, failures: ${totalFail}`);
}

// ---------------------------------------------------------------------------
// Start scheduler
// ---------------------------------------------------------------------------

function startScheduler() {
  console.log('[Scheduler] Starting background jobs...');

  // Daily at 00:30 - generate recurring invoices
  cron.schedule('30 0 * * *', async () => {
    console.log('[Scheduler] Running recurring invoice generation...');
    try {
      await generateRecurringInvoices();
    } catch (err) {
      console.error('[Scheduler] Invoice generation error:', err);
    }
  });

  // Daily at 08:00 - lease expiry notifications
  cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Checking for expiring leases...');
    try {
      await sendLeaseExpiryNotifications();
    } catch (err) {
      console.error('[Scheduler] Lease expiry notification error:', err);
    }
  });

  // Every Monday at 09:00 - overdue invoice reminders
  cron.schedule('0 9 * * 1', async () => {
    console.log('[Scheduler] Sending overdue invoice reminders...');
    try {
      await sendOverdueReminders();
    } catch (err) {
      console.error('[Scheduler] Overdue reminder error:', err);
    }
  });

  console.log('[Scheduler] All jobs scheduled.');
}

module.exports = { startScheduler, createNotification };
