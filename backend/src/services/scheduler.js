const cron = require('node-cron');
const pool = require('../config/database');
const { sendMail } = require('../config/mailer');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the period-check SQL fragment and params for a given invoicing
 * value so we can detect whether an invoice already exists for the current period.
 *
 * Schedule values come from leasing.invoicing:
 *   'weekly', 'bi-weekly', 'monthly', 'quarterly', 'bi-annually', 'annually'
 */
function getPeriodCheck(schedule) {
  const s = (schedule || '').toLowerCase();

  switch (s) {
    case 'weekly':
      // Same ISO year + same ISO week number
      return {
        sql: 'YEARWEEK(due_on, 1) = YEARWEEK(NOW(), 1)',
        params: [],
      };

    case 'bi-weekly':
      // Within the last 14 days from today (rolling fortnight window)
      return {
        sql: 'due_on >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) AND due_on <= DATE_ADD(CURDATE(), INTERVAL 13 DAY)',
        params: [],
      };

    case 'monthly':
      return {
        sql: 'YEAR(due_on) = YEAR(NOW()) AND MONTH(due_on) = MONTH(NOW())',
        params: [],
      };

    case 'quarterly':
      // Same year and same quarter (QUARTER() returns 1-4)
      return {
        sql: 'YEAR(due_on) = YEAR(NOW()) AND QUARTER(due_on) = QUARTER(NOW())',
        params: [],
      };

    case 'bi-annually':
      // Same year and same half (months 1-6 or 7-12)
      return {
        sql: 'YEAR(due_on) = YEAR(NOW()) AND CEIL(MONTH(due_on) / 6) = CEIL(MONTH(NOW()) / 6)',
        params: [],
      };

    case 'annually':
      return {
        sql: 'YEAR(due_on) = YEAR(NOW())',
        params: [],
      };

    default:
      // Unknown schedule — treat as monthly to be safe
      return {
        sql: 'YEAR(due_on) = YEAR(NOW()) AND MONTH(due_on) = MONTH(NOW())',
        params: [],
      };
  }
}

/**
 * Calculates the due date for a new invoice based on the schedule.
 * Returns a Date object set to today's date for MONTHLY, the next occurrence
 * for WEEKLY, etc. We keep it simple: the due date is "today" adjusted to the
 * appropriate cycle start.
 */
function calculateDueDate(schedule) {
  const now = new Date();
  const s = (schedule || '').toLowerCase();

  switch (s) {
    case 'weekly':
      // Due 7 days from now
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    case 'bi-weekly':
      // Due 14 days from now
      return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    case 'monthly': {
      // First day of next month
      const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return d;
    }

    case 'quarterly': {
      // First day of next quarter
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const nextQuarterMonth = (currentQuarter + 1) * 3;
      const year = nextQuarterMonth >= 12 ? now.getFullYear() + 1 : now.getFullYear();
      const month = nextQuarterMonth >= 12 ? 0 : nextQuarterMonth;
      return new Date(year, month, 1);
    }

    case 'bi-annually': {
      // First day of next half-year (Jan 1 or Jul 1)
      const currentHalf = now.getMonth() < 6 ? 0 : 1;
      const nextHalfMonth = currentHalf === 0 ? 6 : 0;
      const nextHalfYear = currentHalf === 0 ? now.getFullYear() : now.getFullYear() + 1;
      return new Date(nextHalfYear, nextHalfMonth, 1);
    }

    case 'annually': {
      // First day of next year
      return new Date(now.getFullYear() + 1, 0, 1);
    }

    default:
      return new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
}

/** Format a Date as 'YYYY-MM-DD' for MySQL */
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
  // Fetch all active leases that have an invoicing schedule set.
  // We join through unit -> property to get org_id and property_name.
  const [leases] = await pool.execute(
    `SELECT
       l.id,
       l.tenant_id,
       l.unit_id,
       l.price,
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
       AND l.invoicing != ''`
  );

  if (leases.length === 0) {
    console.log('[Scheduler] No active recurring leases found.');
    return;
  }

  console.log(`[Scheduler] Found ${leases.length} recurring lease(s) to evaluate.`);

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const lease of leases) {
    try {
      const { sql: periodSql, params: periodParams } = getPeriodCheck(lease.invoicing);

      // Check if an invoice for this tenant/unit/org already exists in the current period
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
        skipped++;
        continue;
      }

      // Generate a unique invoice code
      const invoiceCode = `INV-${Date.now()}-${lease.id}`;
      const dueDate = toDateString(calculateDueDate(lease.invoicing));

      // Get a default category for this org
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

      created++;
      console.log(
        `[Scheduler] Created invoice ${invoiceCode} for lease ${lease.id} ` +
        `(tenant ${lease.tenant_id}, unit ${lease.unit_id}, due ${dueDate})`
      );

      // Small delay between inserts to ensure unique timestamps in invoice codes
      await new Promise((resolve) => setTimeout(resolve, 2));
    } catch (err) {
      errors++;
      console.error(`[Scheduler] Error processing lease ${lease.id}:`, err.message);
    }
  }

  console.log(
    `[Scheduler] Recurring invoice run complete — created: ${created}, skipped: ${skipped}, errors: ${errors}`
  );
}

// ---------------------------------------------------------------------------
// Job 2: Lease expiry notifications
// ---------------------------------------------------------------------------

async function sendLeaseExpiryNotifications() {
  // Find active leases expiring within the next 30 days that have a tenant email
  const [leases] = await pool.execute(
    `SELECT
       l.id,
       l.end_date,
       l.tenant_id,
       t.email          AS tenant_email,
       t.first_name     AS tenant_first_name,
       t.last_name      AS tenant_last_name,
       p.display_name   AS property_name,
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

  let sent = 0;
  let failures = 0;

  for (const lease of leases) {
    try {
      const endDateFormatted = new Date(lease.end_date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
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
        <p>
          Please contact your property manager if you would like to discuss renewal options.
        </p>
        <p>— The Tenafy Team</p>
      `;

      await sendMail({
        to: lease.tenant_email,
        subject,
        html,
      });

      sent++;
      console.log(
        `[Scheduler] Lease expiry notification sent to ${lease.tenant_email} ` +
        `(lease ${lease.id}, expires ${lease.end_date})`
      );
    } catch (err) {
      failures++;
      console.error(
        `[Scheduler] Failed to send lease expiry notification for lease ${lease.id} ` +
        `to ${lease.tenant_email}:`, err.message
      );
    }
  }

  console.log(
    `[Scheduler] Lease expiry notification run complete — sent: ${sent}, failures: ${failures}`
  );
}

// ---------------------------------------------------------------------------
// Job 3: Overdue invoice reminders
// ---------------------------------------------------------------------------

async function sendOverdueReminders() {
  const MAX_PER_RUN = 50;

  // Find unpaid (status=0) invoices whose due_on has passed, with tenant email
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

  let sent = 0;
  let failures = 0;

  for (const invoice of invoices) {
    try {
      const dueDateFormatted = new Date(invoice.due_on).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });

      const amountFormatted = Number(invoice.amount).toFixed(2);
      const subject = `Payment Reminder — Invoice ${invoice.invoice_code} is Overdue`;
      const html = `
        <p>Dear ${invoice.tenant_first_name} ${invoice.tenant_last_name},</p>
        <p>
          This is a reminder that invoice <strong>${invoice.invoice_code}</strong>
          for <strong>$${amountFormatted}</strong> at
          <strong>${invoice.property_name}</strong>${invoice.unit_name ? `, Unit ${invoice.unit_name}` : ''}
          was due on <strong>${dueDateFormatted}</strong>
          and is now <strong>${invoice.days_overdue} day${invoice.days_overdue === 1 ? '' : 's'} overdue</strong>.
        </p>
        <p>
          Please arrange payment at your earliest convenience or contact your property manager
          if you have any questions.
        </p>
        <p>— The Tenafy Team</p>
      `;

      await sendMail({
        to: invoice.tenant_email,
        subject,
        html,
      });

      sent++;
      console.log(
        `[Scheduler] Overdue reminder sent to ${invoice.tenant_email} ` +
        `(invoice ${invoice.invoice_code}, ${invoice.days_overdue} days overdue)`
      );
    } catch (err) {
      failures++;
      console.error(
        `[Scheduler] Failed to send overdue reminder for invoice ${invoice.invoice_code} ` +
        `to ${invoice.tenant_email}:`, err.message
      );
    }
  }

  console.log(
    `[Scheduler] Overdue reminder run complete — sent: ${sent}, failures: ${failures}`
  );
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

module.exports = { startScheduler };
