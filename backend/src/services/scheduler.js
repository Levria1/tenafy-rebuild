const cron = require('node-cron');
const { sendMail } = require('../config/mailer');
const { generateInvoiceCode } = require('../utils/sequenceCode');
const { computeRentInvoiceAmount } = require('../utils/rentProrata');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const {
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendLeaseExpiryToLandlord,
  sendOverdueToTenant,
  sendOverdueToLandlord,
  sendCheckinToTenant,
  sendCheckoutToTenant,
  sendRenewalToTenant,
  shouldSendEmail,
  loadTemplate,
  hasEmailBeenSent,
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

const { advanceInvoiceDate } = require('../utils/invoiceSchedule');
const { resolveLeaseValues } = require('../utils/leaseRevision');

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
       l.booking_platform_id, l.sales_agent_id,
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
          // Prorate the final invoice if the lease ends mid-period
          const periodAfter = advanceInvoiceDate(nextDueDate, lease.invoicing, lease.due_date);
          const periodEnd = new Date(periodAfter);
          periodEnd.setDate(periodEnd.getDate() - 1);

          // Resolve effective rent as of this invoice's due date. If the
          // lease has a scheduled revision (lease_revision row with
          // effective_from <= nextDueDate), its price overrides lease.price.
          // Otherwise this returns lease.price unchanged.
          const effective = await resolveLeaseValues(
            pool, lease.id, nextDueDate,
            { price: lease.price }
          );
          const effectiveRent = effective.price;

          const thisAmount = computeRentInvoiceAmount({
            rent: effectiveRent,
            invoicing: lease.invoicing,
            periodStart: nextDueDate,
            periodEnd,
            leaseEnd: lease.end_date,
          });

          if (thisAmount === null) {
            // Lease already over before this period started — skip.
            cursor = nextDueDate;
            iterations++;
            continue;
          }

          const invoiceCode = await generateInvoiceCode(pool, orgId);
          const invoiceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

          await pool.execute(
            `INSERT INTO invoice (id, org_id, tenant_id, unit_id, leasing_id, property_id,
              invoice_code, amount, due_on, status, category, currency_id, type,
              booking_platform_id, sales_agent_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, ?, NOW())`,
            [invoiceId, orgId, lease.tenant_id, lease.unit_id, lease.id, lease.property_id,
             invoiceCode, thisAmount, nextDueDateStr, catId, currId,
             lease.booking_platform_id || null, lease.sales_agent_id || null]
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
  // landlord_expired_days is a bitmask: 1=30 days, 2=60 days, 4=90 days
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.landlord_expired_days, l.tenant_id,
       t.email AS tenant_email, t.first_name AS tenant_first_name,
       t.last_name AS tenant_last_name, p.display_name AS property_name, p.org_id AS org_id,
       u.name AS unit_name, DATEDIFF(l.end_date, CURDATE()) AS days_remaining
     FROM leasing l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.landlord_expired = 1
       AND l.type = 0 AND l.end_date IS NOT NULL AND l.end_date >= CURDATE()
       AND l.end_date <= DATE_ADD(CURDATE(), INTERVAL 90 DAY)
       AND p.org_id = ?`,
    [orgId]
  );

  if (leases.length === 0) return;
  let sent = 0, failures = 0;
  const details = [];

  for (const lease of leases) {
    try {
      const daysRemaining = Number(lease.days_remaining);
      const flags = Number(lease.landlord_expired_days) || 0;

      // Check if today matches one of the configured reminder days
      const shouldNotify =
        ((flags & 1) !== 0 && daysRemaining === 30) ||
        ((flags & 2) !== 0 && daysRemaining === 60) ||
        ((flags & 4) !== 0 && daysRemaining === 90);

      if (!shouldNotify) continue;

      const templateResult = await sendLeaseExpiryToLandlord(pool, orgId, lease.id);
      if (!templateResult && lease.tenant_email) {
        const endDateFormatted = new Date(lease.end_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await sendMail({
          to: lease.tenant_email,
          subject: `Lease Expiry Notice — ${lease.property_name}`,
          html: `<p>Dear ${lease.tenant_first_name} ${lease.tenant_last_name},</p><p>Your lease at <strong>${lease.property_name}</strong>${lease.unit_name ? `, Unit ${lease.unit_name}` : ''} expires on <strong>${endDateFormatted}</strong> (${daysRemaining} day(s) remaining).</p>`
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
// Job 5: Check-in emails (per org) — send X days before lease start
// ---------------------------------------------------------------------------

async function sendCheckinEmailsForOrg(pool, orgId) {
  // Find leases with tenant_checkin enabled, starting today or in the future
  const [leases] = await pool.execute(
    `SELECT l.id, l.start_date, l.tenant_id,
       t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL
       AND l.tenant_checkin = 1
       AND l.start_date >= CURDATE()
       AND t.email IS NOT NULL AND t.email != ''
       AND p.org_id = ?`,
    [orgId]
  );
  if (leases.length === 0) return;

  // Load the default Checkin-Tenant template to get date_first offset
  const template = await loadTemplate(pool, orgId, 'Checkin-Tenant');
  const dateFirstDays = template ? (Number(template.date_first) || 0) : 0;

  let sent = 0;
  const today = new Date(toDateString(new Date()));
  for (const lease of leases) {
    try {
      const startDate = new Date(toDateString(new Date(lease.start_date)));
      const triggerDate = new Date(startDate);
      triggerDate.setDate(triggerDate.getDate() - dateFirstDays);

      // Send if today is on or after the trigger date (but before/on start date)
      if (today < triggerDate || today > startDate) continue;

      // Skip if already sent for this lease
      if (await hasEmailBeenSent(pool, lease.id, 'Checkin-Tenant')) continue;

      await sendCheckinToTenant(pool, orgId, lease.id);
      sent++;
    } catch (err) {
      console.error(`[Scheduler] Check-in email error for lease ${lease.id}:`, err.message);
    }
  }
  if (sent > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${sent} check-in email(s) sent`, link: '/leasing' });
  }
}

// ---------------------------------------------------------------------------
// Job 6: Check-out emails (per org) — send X days before/after lease end
// ---------------------------------------------------------------------------

async function sendCheckoutEmailsForOrg(pool, orgId) {
  // Find leases with tenant_checkout enabled that have an end date
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.tenant_id,
       t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL
       AND l.tenant_checkout = 1
       AND l.end_date IS NOT NULL
       AND t.email IS NOT NULL AND t.email != ''
       AND p.org_id = ?`,
    [orgId]
  );
  if (leases.length === 0) return;

  // Load the default Checkout-Tenant template to get date_first offset and before_date flag
  const template = await loadTemplate(pool, orgId, 'Checkout-Tenant');
  const dateFirstDays = template ? (Number(template.date_first) || 0) : 0;
  let beforeDate = true; // default: send before end date
  if (template && template.before_date !== undefined && template.before_date !== null) {
    if (Buffer.isBuffer(template.before_date)) {
      beforeDate = template.before_date[0] === 1;
    } else {
      beforeDate = Boolean(template.before_date);
    }
  }

  let sent = 0;
  const today = new Date(toDateString(new Date()));
  for (const lease of leases) {
    try {
      const endDate = new Date(toDateString(new Date(lease.end_date)));
      const triggerDate = new Date(endDate);
      if (beforeDate) {
        triggerDate.setDate(triggerDate.getDate() - dateFirstDays);
      } else {
        triggerDate.setDate(triggerDate.getDate() + dateFirstDays);
      }

      // Send if today is on or after the trigger date (within the window)
      if (beforeDate) {
        // Before mode: trigger between triggerDate and endDate
        if (today < triggerDate || today > endDate) continue;
      } else {
        // After mode: trigger between endDate and triggerDate
        if (today < endDate || today > triggerDate) continue;
      }

      // Skip if already sent for this lease
      if (await hasEmailBeenSent(pool, lease.id, 'Checkout-Tenant')) continue;

      await sendCheckoutToTenant(pool, orgId, lease.id);
      sent++;
    } catch (err) {
      console.error(`[Scheduler] Check-out email error for lease ${lease.id}:`, err.message);
    }
  }
  if (sent > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${sent} check-out email(s) sent`, link: '/leasing' });
  }
}

// ---------------------------------------------------------------------------
// Job 7: Renewal emails (per org) — send tenant_renewal_days before lease end
// ---------------------------------------------------------------------------

async function sendRenewalEmailsForOrg(pool, orgId) {
  // Find leases with tenant_renewal enabled, with an end date and renewal days set
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.tenant_renewal_days, l.tenant_id,
       t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL
       AND l.tenant_renewal = 1
       AND l.end_date IS NOT NULL
       AND l.tenant_renewal_days IS NOT NULL AND l.tenant_renewal_days > 0
       AND t.email IS NOT NULL AND t.email != ''
       AND p.org_id = ?`,
    [orgId]
  );
  if (leases.length === 0) return;

  let sent = 0;
  const today = new Date(toDateString(new Date()));
  for (const lease of leases) {
    try {
      const endDate = new Date(toDateString(new Date(lease.end_date)));
      const triggerDate = new Date(endDate);
      triggerDate.setDate(triggerDate.getDate() - Number(lease.tenant_renewal_days));

      // Send if today is on or after the trigger date (but before/on end date)
      if (today < triggerDate || today > endDate) continue;

      // Skip if already sent for this lease
      if (await hasEmailBeenSent(pool, lease.id, 'Renewal-Tenant')) continue;

      await sendRenewalToTenant(pool, orgId, lease.id);
      sent++;
    } catch (err) {
      console.error(`[Scheduler] Renewal email error for lease ${lease.id}:`, err.message);
    }
  }
  if (sent > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${sent} renewal email(s) sent`, link: '/leasing' });
  }
}

// ---------------------------------------------------------------------------
// Service task auto-promote: pending → in-progress when start date is today
// ---------------------------------------------------------------------------

async function promoteServiceTasksForOrg(pool, orgId) {
  const [result] = await pool.execute(
    `UPDATE service SET status = 1, updated_at = NOW()
     WHERE org_id = ? AND status = 0 AND service_date_start IS NOT NULL
       AND DATE(service_date_start) <= CURDATE()`,
    [orgId]
  );
  if (result.affectedRows > 0) {
    console.log(`[Scheduler] Promoted ${result.affectedRows} service task(s) to in-progress for org ${orgId}`);
  }
}

// ---------------------------------------------------------------------------
// Viewing booking auto-decline: pending bookings older than 24h → declined
// ---------------------------------------------------------------------------

async function autoDeclineStaleViewingsForOrg(pool, /* orgId */) {
  // status 0 = pending, 2 = declined
  // Mark both tenant_decision and employee_decision as 2 (declined) so the
  // derived status is unambiguous.
  const [result] = await pool.execute(
    `UPDATE viewing_booking
     SET status = 2,
         tenant_decision = CASE WHEN tenant_decision = 0 THEN 2 ELSE tenant_decision END,
         employee_decision = CASE WHEN employee_decision = 0 THEN 2 ELSE employee_decision END,
         tenant_decided_at = COALESCE(tenant_decided_at, NOW()),
         employee_decided_at = COALESCE(employee_decided_at, NOW())
     WHERE status = 0
       AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  );
  if (result.affectedRows > 0) {
    console.log(`[Scheduler] Auto-declined ${result.affectedRows} stale viewing booking(s)`);
  }
}

// ---------------------------------------------------------------------------
// Inquiry reminders — email staff who created the inquiry on reminder_date
// ---------------------------------------------------------------------------

async function sendInquiryRemindersForOrg(pool, orgId) {
  const { sendTemplateEmail, loadTemplate } = require('./emailService');

  // Find inquiries whose reminder is due and not yet sent
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT i.id, i.first_name, i.last_name, i.email, i.phone, i.notes,
              i.inquiry_date, i.desired_start_date, i.budget, i.reminder_date,
              ls.name AS lead_source_name,
              p.display_name AS property_name, un.name AS unit_name,
              CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) AS staff_name,
              u.email AS staff_email
       FROM inquiry i
       LEFT JOIN lead_source_setting ls ON i.lead_source_id = ls.id
       LEFT JOIN user u ON i.created_by_user_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit un ON i.unit_id = un.id
       WHERE i.org_id = ?
         AND i.deleted_at IS NULL
         AND i.reminder_date IS NOT NULL
         AND i.reminder_date <= CURDATE()
         AND i.reminder_sent_at IS NULL`,
      [orgId]
    );
  } catch (err) {
    // Table or columns may not exist yet on older DBs — skip silently
    if (/Unknown column|doesn't exist/i.test(err.message)) return;
    throw err;
  }

  if (!rows.length) return;

  const appUrl = process.env.APP_URL || '';

  for (const r of rows) {
    if (!r.staff_email) {
      console.log(`[Scheduler][inquiryReminders] Inquiry ${r.id} has no staff email; skipping.`);
      continue;
    }

    const fullName = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)';
    const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : '';
    const extraVariables = {
      '%Inquiry Name%': fullName,
      '%Inquiry Email%': r.email || '',
      '%Inquiry Phone%': r.phone || '',
      '%Inquiry Notes%': r.notes || '',
      '%Inquiry Source%': r.lead_source_name || '',
      '%Inquiry Date%': fmtDate(r.inquiry_date),
      '%Desired Start Date%': fmtDate(r.desired_start_date),
      '%Budget%': r.budget != null ? String(r.budget) : '',
      '%Inquiry Property%': r.property_name || '',
      '%Inquiry Unit%': r.unit_name || '',
      '%Inquiry Link%': appUrl ? `${appUrl}/inquiries/${r.id}` : `/inquiries/${r.id}`,
    };

    let sent = false;
    try {
      // Look up the template first to decide the primary recipient.
      // - If template has its own `to_address`, send to that and CC staff.
      // - Otherwise, send to staff (no CC needed — they ARE the recipient).
      const tpl = await loadTemplate(pool, orgId, 'Inquiry-Reminder');
      const tplHasTo = !!(tpl && tpl.to_address);
      const result = await sendTemplateEmail(pool, orgId, {
        templateType: 'Inquiry-Reminder',
        toOverride: tplHasTo ? undefined : r.staff_email,
        extraCc: tplHasTo ? r.staff_email : undefined,
        extraVariables,
      });
      sent = !!result;
    } catch (err) {
      console.error(`[Scheduler][inquiryReminders] Send failed for inquiry ${r.id}:`, err.message);
    }

    // Plain fallback if no template configured
    if (!sent) {
      try {
        const subject = `Inquiry reminder — ${fullName}`;
        const html = `
          <p>This is your reminder to follow up on the inquiry below.</p>
          <ul>
            <li><strong>Name:</strong> ${fullName}</li>
            <li><strong>Email:</strong> ${r.email || '—'}</li>
            <li><strong>Phone:</strong> ${r.phone || '—'}</li>
            <li><strong>Lead source:</strong> ${r.lead_source_name || '—'}</li>
            <li><strong>Property/Unit:</strong> ${[r.property_name, r.unit_name].filter(Boolean).join(' · ') || '—'}</li>
            <li><strong>Desired start:</strong> ${fmtDate(r.desired_start_date) || '—'}</li>
            <li><strong>Budget:</strong> ${r.budget != null ? r.budget : '—'}</li>
          </ul>
          <p><strong>Notes:</strong><br>${(r.notes || '').replace(/\n/g, '<br>') || '—'}</p>
          ${appUrl ? `<p><a href="${appUrl}/inquiries/${r.id}">Open inquiry</a></p>` : ''}
        `;
        await sendMail({ to: r.staff_email, subject, html });
        sent = true;
      } catch (err) {
        console.error(`[Scheduler][inquiryReminders] Plain fallback failed for inquiry ${r.id}:`, err.message);
      }
    }

    if (sent) {
      try {
        await pool.execute(
          'UPDATE inquiry SET reminder_sent_at = NOW() WHERE id = ? AND org_id = ?',
          [r.id, orgId]
        );
      } catch (err) {
        console.error(`[Scheduler][inquiryReminders] Failed to stamp reminder_sent_at on ${r.id}:`, err.message);
      }
    }
  }
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

  // Daily at 07:00 - check-in emails (X days before lease start, based on template date_first)
  cron.schedule('0 7 * * *', () => {
    console.log('[Scheduler] Sending check-in emails...');
    runForAllOrgs('checkinEmails', sendCheckinEmailsForOrg);
  });

  // Daily at 07:30 - check-out emails (X days before/after lease end, based on template date_first)
  cron.schedule('30 7 * * *', () => {
    console.log('[Scheduler] Sending check-out emails...');
    runForAllOrgs('checkoutEmails', sendCheckoutEmailsForOrg);
  });

  // Daily at 07:45 - renewal emails (tenant_renewal_days before lease end)
  cron.schedule('45 7 * * *', () => {
    console.log('[Scheduler] Sending renewal emails...');
    runForAllOrgs('renewalEmails', sendRenewalEmailsForOrg);
  });

  // Daily at 06:00 - auto-promote pending service tasks to in-progress
  cron.schedule('0 6 * * *', () => {
    console.log('[Scheduler] Promoting pending service tasks to in-progress...');
    runForAllOrgs('serviceAutoProgress', promoteServiceTasksForOrg);
  });

  // Hourly - auto-decline pending viewing bookings older than 24h
  cron.schedule('15 * * * *', () => {
    console.log('[Scheduler] Auto-declining stale viewing bookings...');
    runForAllOrgs('viewingAutoDecline', autoDeclineStaleViewingsForOrg);
  });

  // Daily at 08:30 - inquiry reminders (Inquiry-Reminder template to creator)
  cron.schedule('30 8 * * *', () => {
    console.log('[Scheduler] Sending inquiry reminders...');
    runForAllOrgs('inquiryReminders', sendInquiryRemindersForOrg);
  });

  // Run once at startup to fix stale statuses
  runForAllOrgs('startupFix', markOverdueInvoicesForOrg);
  runForAllOrgs('startupServiceFix', promoteServiceTasksForOrg);

  console.log('[Scheduler] All jobs scheduled.');
}

module.exports = { startScheduler, createNotification };
