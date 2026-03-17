const cron = require('node-cron');
const { sendMail } = require('../config/mailer');
const { generateInvoiceCode } = require('../utils/sequenceCode');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const {
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendLeaseExpiryToLandlord,
  sendOverdueToTenant,
  sendOverdueToLandlord,
  shouldSendEmail,
} = require('./emailService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAllActiveOrgs() {
  const masterPool = getMasterPool();
  const [orgs] = await masterPool.execute('SELECT id, db_name FROM organizations WHERE status = 1');
  return orgs;
}

async function createNotification(pool, { orgId, type, title, message, link }) {
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

async function sendAdminAlert(pool, { orgId, subject, html }) {
  try {
    const [admins] = await pool.execute(
      `SELECT email FROM user WHERE org_id = ? AND status = 1 AND email IS NOT NULL LIMIT 3`,
      [orgId]
    );
    if (admins.length === 0) return;
    const emails = admins.map(a => a.email).filter(Boolean);
    if (emails.length === 0) return;
    await sendMail({ to: emails, subject: `[Tenafy] ${subject}`, html });
    console.log(`[Scheduler] Admin alert sent to ${emails.join(', ')}: ${subject}`);
  } catch (err) {
    console.error('[Scheduler] Failed to send admin alert email:', err.message);
  }
}

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function advanceInvoiceDate(date, schedule, dueDay) {
  const inv = String(schedule).toLowerCase();
  const next = new Date(date);
  if (inv === '1' || inv === 'daily') { next.setDate(next.getDate() + 1); }
  else if (inv === '7' || inv === 'weekly') { next.setDate(next.getDate() + 7); }
  else if (inv === '14' || inv === 'bi-weekly') { next.setDate(next.getDate() + 14); }
  else if (inv === '28') { next.setDate(next.getDate() + 28); }
  else if (inv === '30' || inv === 'monthly') {
    next.setMonth(next.getMonth() + 1);
    if (dueDay) { const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(Number(dueDay), maxDay)); }
  } else if (inv === '60' || inv === 'bi-monthly') {
    next.setMonth(next.getMonth() + 2);
    if (dueDay) { const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(Number(dueDay), maxDay)); }
  } else if (inv === '90' || inv === 'quarterly') {
    next.setMonth(next.getMonth() + 3);
    if (dueDay) { const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(Number(dueDay), maxDay)); }
  } else if (inv === '180' || inv === 'bi-annually') {
    next.setMonth(next.getMonth() + 6);
    if (dueDay) { const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(Number(dueDay), maxDay)); }
  } else if (inv === '365' || inv === 'annually') {
    next.setFullYear(next.getFullYear() + 1);
    if (dueDay) { const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate(); next.setDate(Math.min(Number(dueDay), maxDay)); }
  } else {
    next.setMonth(next.getMonth() + 1);
  }
  return next;
}

function daysDiff(date1, date2) {
  const d1 = new Date(toDateString(date1));
  const d2 = new Date(toDateString(date2));
  return Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Job 1: Auto-generate recurring invoices (per org)
// ---------------------------------------------------------------------------

async function generateRecurringInvoicesForOrg(pool, orgId) {
  const [leases] = await pool.execute(
    `SELECT
       l.id, l.tenant_id, l.unit_id, l.amount AS price, l.invoicing, l.due_date,
       l.first_invoice_date, l.start_date, l.end_date, l.all_past, l.currency_id,
       p.org_id AS org_id, p.display_name AS property_name, u.name AS unit_name, u.property_id
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.share_lease = 1
       AND l.invoicing IS NOT NULL AND l.invoicing != ''
       AND l.amount IS NOT NULL AND l.amount > 0 AND p.org_id = ?`,
    [orgId]
  );

  if (leases.length === 0) return;
  console.log(`[Scheduler][org:${orgId}] Found ${leases.length} recurring lease(s).`);

  const result = { created: 0, skipped: 0, errors: 0, errorDetails: [] };
  const orgRentalCategory = {};
  const orgCurrency = {};
  const today = new Date(toDateString(new Date()));

  for (const lease of leases) {
    try {
      const [[latestInvoice]] = await pool.execute(
        `SELECT due_on FROM invoice WHERE leasing_id = ? AND org_id = ? AND deleted_at IS NULL ORDER BY due_on DESC LIMIT 1`,
        [lease.id, orgId]
      );
      if (!latestInvoice) { result.skipped++; continue; }

      const lastDueDate = new Date(latestInvoice.due_on);
      if (daysDiff(today, lastDueDate) < 1) { result.skipped++; continue; }

      if (!orgRentalCategory[orgId]) {
        const [[rentalCat]] = await pool.execute(
          "SELECT id FROM category_setting WHERE org_id = ? AND name LIKE '%Rental%' AND enabled = 1 LIMIT 1", [orgId]
        );
        orgRentalCategory[orgId] = rentalCat ? rentalCat.id : null;
      }
      const catId = orgRentalCategory[orgId];
      if (!catId) { result.errors++; result.errorDetails.push(`${lease.property_name} / ${lease.unit_name}: No 'Rental Income' category`); continue; }

      let currId = lease.currency_id;
      if (!currId) {
        if (!orgCurrency[orgId]) {
          const [[cur]] = await pool.execute('SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1', [orgId]);
          orgCurrency[orgId] = cur ? cur.id : null;
        }
        currId = orgCurrency[orgId];
      }

      let invoicesCreated = 0;
      let cursor = lastDueDate;
      let iterations = 0;

      while (iterations < 50) {
        const nextDueDate = advanceInvoiceDate(cursor, lease.invoicing, lease.due_date);
        const nextDueDateStr = toDateString(nextDueDate);
        if (lease.end_date && nextDueDate > new Date(lease.end_date)) break;

        const [[existing]] = await pool.execute(
          `SELECT id FROM invoice WHERE leasing_id = ? AND due_on = ? AND deleted_at IS NULL`, [lease.id, nextDueDateStr]
        );

        if (!existing) {
          const invoiceCode = await generateInvoiceCode(pool, orgId);
          const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

          await pool.execute(
            `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
              invoice_code, amount, due_on, status, category, currency_id, type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, NOW())`,
            [invoiceId, orgId, lease.tenant_id, lease.unit_id, lease.id, lease.property_id,
             invoiceCode, lease.price, nextDueDateStr, catId, currId]
          );

          invoicesCreated++;
          console.log(`[Scheduler] Created invoice ${invoiceCode} for lease ${lease.id} (due ${nextDueDateStr})`);

          try {
            await sendInvoiceToTenant(pool, orgId, lease.id, { invoiceId, invoiceCode, category: catId, dueDate: nextDueDate });
            await sendInvoiceToLandlord(pool, orgId, lease.id, { invoiceId, invoiceCode, category: catId, dueDate: nextDueDate });
          } catch (emailErr) {
            console.error(`[Scheduler] Invoice email error for ${invoiceCode}:`, emailErr.message);
          }
        }

        if (nextDueDate > today) break;
        cursor = nextDueDate;
        iterations++;
      }

      result.created += invoicesCreated;
      if (invoicesCreated === 0) result.skipped++;
    } catch (err) {
      result.errors++;
      result.errorDetails.push(`${lease.property_name} / ${lease.unit_name}: ${err.message}`);
      console.error(`[Scheduler] Error processing lease ${lease.id}:`, err.message);
    }
  }

  if (result.created > 0) {
    await createNotification(pool, { orgId, type: 'success', title: `${result.created} recurring invoice(s) generated`, message: `${result.created} created, ${result.skipped} up to date.`, link: '/invoices' });
  }
  if (result.errors > 0) {
    await createNotification(pool, { orgId, type: 'error', title: `${result.errors} invoice(s) failed to generate`, message: result.errorDetails.slice(0, 5).join('\n'), link: '/leasing' });
    await sendAdminAlert(pool, { orgId, subject: `${result.errors} recurring invoice(s) failed`, html: `<p>Errors:</p><ul>${result.errorDetails.map(d => `<li>${d}</li>`).join('')}</ul>` });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Job 2: Lease expiry notifications (per org)
// ---------------------------------------------------------------------------

async function sendLeaseExpiryForOrg(pool, orgId) {
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.tenant_id, t.email AS tenant_email, t.first_name AS tenant_first_name,
       t.last_name AS tenant_last_name, p.display_name AS property_name, p.org_id AS org_id,
       u.name AS unit_name, DATEDIFF(l.end_date, CURDATE()) AS days_remaining
     FROM leasing l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.end_date >= CURDATE()
       AND l.end_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND t.email IS NOT NULL AND t.email != '' AND p.org_id = ?`,
    [orgId]
  );

  if (leases.length === 0) return;
  let sent = 0, failures = 0;
  const details = [];

  for (const lease of leases) {
    try {
      const templateResult = await sendLeaseExpiryToLandlord(pool, orgId, lease.id);
      if (!templateResult) {
        const endDateFormatted = new Date(lease.end_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await sendMail({
          to: lease.tenant_email,
          subject: `Lease Expiry Notice — ${lease.property_name}`,
          html: `<p>Dear ${lease.tenant_first_name} ${lease.tenant_last_name},</p><p>Your lease at <strong>${lease.property_name}</strong>${lease.unit_name ? `, Unit ${lease.unit_name}` : ''} expires on <strong>${endDateFormatted}</strong> (${lease.days_remaining} day(s) remaining).</p>`
        });
      }
      sent++;
      details.push(`${lease.tenant_first_name} ${lease.tenant_last_name} @ ${lease.property_name}`);
    } catch (err) {
      failures++;
      console.error(`[Scheduler] Lease expiry error for lease ${lease.id}:`, err.message);
    }
  }

  if (sent > 0) await createNotification(pool, { orgId, type: 'info', title: `${sent} lease expiry notice(s) sent`, message: details.slice(0, 3).join(', '), link: '/leasing' });
  if (failures > 0) await createNotification(pool, { orgId, type: 'warning', title: `${failures} expiry email(s) failed`, message: 'Check tenant emails and SMTP config.', link: '/leasing' });
}

// ---------------------------------------------------------------------------
// Job 3: Overdue invoice reminders (per org)
// ---------------------------------------------------------------------------

async function sendOverdueRemindersForOrg(pool, orgId) {
  const [invoices] = await pool.execute(
    `SELECT i.id, i.invoice_code, i.amount, i.due_on, i.org_id, i.leasing_id,
       t.email AS tenant_email, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name, DATEDIFF(CURDATE(), i.due_on) AS days_overdue
     FROM invoice i JOIN tenant t ON i.tenant_id = t.id JOIN unit u ON i.unit_id = u.id JOIN property p ON u.property_id = p.id
     WHERE i.status = 0 AND i.due_on < CURDATE() AND t.email IS NOT NULL AND t.email != '' AND i.org_id = ? AND i.deleted_at IS NULL
     ORDER BY i.due_on ASC LIMIT 50`,
    [orgId]
  );

  if (invoices.length === 0) return;
  let sent = 0, failures = 0;

  for (const inv of invoices) {
    try {
      let emailSent = false;
      if (inv.leasing_id) {
        const templateResult = await sendOverdueToTenant(pool, orgId, inv.leasing_id, { dueDate: inv.due_on, overdueAmount: inv.amount });
        if (templateResult) emailSent = true;
      }
      if (!emailSent) {
        const dueDateFormatted = new Date(inv.due_on).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await sendMail({
          to: inv.tenant_email,
          subject: `Payment Reminder — Invoice ${inv.invoice_code} is Overdue`,
          html: `<p>Dear ${inv.tenant_first_name} ${inv.tenant_last_name},</p><p>Invoice <strong>${inv.invoice_code}</strong> for <strong>$${Number(inv.amount).toFixed(2)}</strong> was due on <strong>${dueDateFormatted}</strong> and is now <strong>${inv.days_overdue} day(s) overdue</strong>.</p>`
        });
      }
      sent++;
    } catch (err) {
      failures++;
      console.error(`[Scheduler] Overdue reminder error for ${inv.invoice_code}:`, err.message);
    }
  }

  if (sent > 0) await createNotification(pool, { orgId, type: 'warning', title: `${sent} overdue reminder(s) sent`, message: `Sent reminders for ${sent} overdue invoice(s).`, link: '/invoices' });
  if (failures > 0) await createNotification(pool, { orgId, type: 'error', title: `${failures} overdue reminder(s) failed`, message: 'Check tenant email addresses.', link: '/invoices' });
}

// ---------------------------------------------------------------------------
// Job 4: Mark overdue invoices (per org)
// ---------------------------------------------------------------------------

async function markOverdueInvoicesForOrg(pool, orgId) {
  const [result] = await pool.execute(
    `UPDATE invoice i SET i.status = 2
     WHERE i.status = 0 AND i.due_on < CURDATE() AND i.deleted_at IS NULL AND i.org_id = ?
       AND i.amount > COALESCE(
         (SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
          WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL), 0)`,
    [orgId]
  );
  if (result.affectedRows > 0) console.log(`[Scheduler][org:${orgId}] Marked ${result.affectedRows} invoice(s) as overdue.`);

  const [fixResult] = await pool.execute(
    `UPDATE invoice i SET i.status = 1
     WHERE i.status IN (0, 2) AND i.deleted_at IS NULL AND i.org_id = ? AND i.amount > 0
       AND i.amount <= COALESCE(
         (SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
          WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL), 0)`,
    [orgId]
  );
  if (fixResult.affectedRows > 0) console.log(`[Scheduler][org:${orgId}] Fixed ${fixResult.affectedRows} invoice(s) that were actually paid.`);
}

// ---------------------------------------------------------------------------
// Multi-org job runner — runs a job against ALL active orgs
// ---------------------------------------------------------------------------

async function runForAllOrgs(jobName, jobFn) {
  try {
    const orgs = await getAllActiveOrgs();
    if (orgs.length === 0) { console.log(`[Scheduler] No active orgs found for ${jobName}.`); return; }

    const results = await Promise.allSettled(
      orgs.map(async (org) => {
        try {
          const pool = await getOrgPool(org.id);
          await jobFn(pool, String(org.id));
        } catch (err) {
          console.error(`[Scheduler][${jobName}] Error for org ${org.id}:`, err.message);
        }
      })
    );

    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) console.error(`[Scheduler][${jobName}] ${failed} org(s) had errors.`);
  } catch (err) {
    console.error(`[Scheduler][${jobName}] Fatal error:`, err);
  }
}

// ---------------------------------------------------------------------------
// Start scheduler
// ---------------------------------------------------------------------------

function startScheduler() {
  console.log('[Scheduler] Starting background jobs...');

  // Daily at 00:05 AM - mark overdue invoices
  cron.schedule('5 0 * * *', () => {
    console.log('[Scheduler] Updating invoice statuses...');
    runForAllOrgs('markOverdue', markOverdueInvoicesForOrg);
  });

  // Daily at 10:00 AM - generate recurring invoices
  cron.schedule('0 10 * * *', () => {
    console.log('[Scheduler] Running recurring invoice generation...');
    runForAllOrgs('recurringInvoices', generateRecurringInvoicesForOrg);
  });

  // Daily at 08:00 - lease expiry notifications
  cron.schedule('0 8 * * *', () => {
    console.log('[Scheduler] Checking for expiring leases...');
    runForAllOrgs('leaseExpiry', sendLeaseExpiryForOrg);
  });

  // Every Monday at 09:00 - overdue reminders
  cron.schedule('0 9 * * 1', () => {
    console.log('[Scheduler] Sending overdue invoice reminders...');
    runForAllOrgs('overdueReminders', sendOverdueRemindersForOrg);
  });

  // Run once at startup to fix stale statuses
  runForAllOrgs('startupFix', markOverdueInvoicesForOrg);

  console.log('[Scheduler] All jobs scheduled.');
}

module.exports = { startScheduler, createNotification };
