const cron = require('node-cron');
const {
  assessFactDeliveryHealth, STALE_HOURS, LOOKBACK_DAYS,
} = require('../utils/inquiryFactHealth');
const { sendMail } = require('../config/mailer');
const { bitToBool } = require('../utils/mysqlBit');
const { generateInvoiceCode } = require('../utils/sequenceCode');
const { computeRentInvoiceAmount } = require('../utils/rentProrata');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const config = require('../config');
const inquiryExtractor = require('./inquiryExtractor');
const { ORG_TIME_ZONE, orgToday, orgTodayDate } = require('../utils/orgTime');
const { renewalAskStatus } = require('../utils/renewalAsk');
const {
  sendInvoiceToTenant,
  sendInvoiceToLandlord,
  sendLeaseExpiryToLandlord,
  sendOverdueToTenant,
  sendOverdueToLandlord,
  sendCheckinToTenant,
  sendCheckinFollowUpToTenant,
  lastSentOrgDate,
  CHECKIN_FOLLOWUP_TYPE,
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

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
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

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const RENEWAL_DIGEST_SECTIONS = [
  ['extend_pending_paperwork', 'Confirmed — extend the lease and issue paperwork'],
  ['possible_reply_check_it', 'Possibly answered — read it and decide'],
  ['replied_but_stale_check_lease', 'Replied, but the lease changed since we asked'],
  ['replied_needs_review', 'Told us they are leaving'],
  ['no_answer_call_them', 'No answer after 3 asks — call them'],
  ['could_not_reach_them', 'Could not be reached'],
];

// The subject is read in a notification list, so it has to carry the count and the
// job. Pluralised because "3 stale reply needs lease check" reads as a bug in the
// one place a reader sees before deciding whether to open it.
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const RENEWAL_DIGEST_SUBJECTS = {
  extend_pending_paperwork: c => `Renewals: ${plural(c, 'confirmation', 'confirmations')} awaiting paperwork`,
  possible_reply_check_it: c => `Renewals: ${plural(c, 'tenant may have', 'tenants may have')} answered`,
  replied_but_stale_check_lease: c => `Renewals: ${plural(c, 'reply needs', 'replies need')} a lease check`,
  replied_needs_review: c => `Renewals: ${plural(c, 'tenant is', 'tenants are')} leaving`,
  no_answer_call_them: c => `Renewals: ${plural(c, 'tenant has', 'tenants have')} not answered after 3 asks`,
  could_not_reach_them: c => `Renewals: ${plural(c, 'tenant', 'tenants')} could not be reached`,
};

function buildRenewalDigest(rows = []) {
  const sections = Object.fromEntries(RENEWAL_DIGEST_SECTIONS.map(([status]) => [status, []]));
  let awaitingCount = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const status = renewalAskStatus(row);
    if (status === 'awaiting_reply') {
      awaitingCount++;
    } else if (sections[status]) {
      sections[status].push(row);
    }
  }

  const firstAction = RENEWAL_DIGEST_SECTIONS.find(([status]) => sections[status].length > 0);
  if (!firstAction) {
    return { shouldSend: false, subject: null, html: null, sections, awaitingCount, actionCount: 0 };
  }

  const actionCount = RENEWAL_DIGEST_SECTIONS.reduce((sum, [status]) => sum + sections[status].length, 0);
  const subject = RENEWAL_DIGEST_SUBJECTS[firstAction[0]](sections[firstAction[0]].length);
  const htmlSections = RENEWAL_DIGEST_SECTIONS
    .filter(([status]) => sections[status].length > 0)
    .map(([status, title]) => {
      const items = sections[status].map((row) => {
        const label = [row.property_name, row.unit_name].filter(Boolean).join(' ') || 'Unknown unit';
        const tenant = row.tenant_name || 'Unknown tenant';
        const leaseEnd = row.lease_end || row.end_date || '';
        const stale = status === 'replied_but_stale_check_lease' && row.reply_stale_reason
          ? `<br>Stale reason: ${escapeHtml(row.reply_stale_reason)}`
          : '';
        return `<li><strong>${escapeHtml(label)}</strong><br>${escapeHtml(tenant)}${leaseEnd ? `<br>Lease end: ${escapeHtml(leaseEnd)}` : ''}${stale}</li>`;
      }).join('');
      return `<h3>${escapeHtml(title)}</h3><ul>${items}</ul>`;
    })
    .join('');
  const awaitingLine = awaitingCount > 0 ? `<p>${awaitingCount} more awaiting a reply.</p>` : '';

  return {
    shouldSend: true,
    subject,
    html: `<p>Renewals needing action this week:</p>${htmlSections}${awaitingLine}`,
    sections,
    awaitingCount,
    actionCount,
  };
}

function toDateString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const { advanceInvoiceDate } = require('../utils/invoiceSchedule');
const { isWithinCheckinWindow, shouldSendCheckinFollowUp } = require('../utils/checkinWindow');
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
       AND l.lease_state = 'active'
       AND l.invoicing IS NOT NULL AND l.invoicing != ''
       AND l.amount IS NOT NULL AND l.amount > 0 AND p.org_id = ?`,
    [orgId]
  );

  if (leases.length === 0) return;
  console.log(`[Scheduler][org:${orgId}] Found ${leases.length} recurring lease(s).`);

  const result = { created: 0, skipped: 0, errors: 0, errorDetails: [] };
  const orgCurrency = {};
  const today = orgTodayDate();

  // Look up the org's rental category ONCE before the loop. Used for both:
  //  (a) finding the latest RENT invoice's due_on (so non-rent invoices like
  //      stamp duty / deposit / credits don't contaminate the next-rent calc), and
  //  (b) tagging newly-created rent invoices below.
  // Skip the whole org if there's no rental category — can't create rent invoices
  // without one and old behavior already errored out per-lease in that case.
  const [[rentalCat]] = await pool.execute(
    // MUST resolve to the same category lease creation/confirmation uses
    // (leasing.js), because the duplicate check below is now scoped to it — a
    // mismatch would make every night's check miss and create DUPLICATE rent.
    // '%Rental%' alone is ambiguous and unordered: org 8300127259922432 also has
    // a "Rental Expense" category, and another org has four %Rental% matches.
    "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1", [orgId]
  );
  const catId = rentalCat ? rentalCat.id : null;
  if (!catId) {
    console.warn(`[Scheduler][org:${orgId}] No 'Rental Income' category — skipping all leases.`);
    return result;
  }

  for (const lease of leases) {
    try {
      const [[latestInvoice]] = await pool.execute(
        `SELECT due_on FROM invoice WHERE leasing_id = ? AND org_id = ? AND deleted_at IS NULL AND category = ? ORDER BY due_on DESC LIMIT 1`,
        [lease.id, orgId, catId]
      );
      if (!latestInvoice) { result.skipped++; continue; }

      const lastDueDate = new Date(latestInvoice.due_on);
      if (daysDiff(today, lastDueDate) < 1) { result.skipped++; continue; }

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

        // "Has this period's RENT already been billed?" — two things had to change.
        //
        // 1. Scope to the RENTAL category (and the org), matching the cursor query
        //    above and the move-out push in leasing.js. Unscoped, this asked "is
        //    there ANY invoice on this date?", so a stamp fee or utility bill that
        //    happened to share a rent due date read as "rent already exists" and
        //    the period was skipped.
        //
        // 2. Also match rent that was raised MANUALLY and never linked to a lease.
        //    117 such invoices exist in the main org: staff noticed the skipped
        //    month and billed it by hand, leaving leasing_id NULL. Those are
        //    invisible to a leasing_id-only lookup, so fixing (1) alone would have
        //    re-created rent the tenant had already been charged. Every one of
        //    those rows carries tenant_id, and all but one carry unit_id.
        const [[existing]] = await pool.execute(
          `SELECT id FROM invoice
            WHERE org_id = ? AND due_on = ? AND category = ? AND deleted_at IS NULL
              AND (leasing_id = ?
                   OR (leasing_id IS NULL AND tenant_id = ?
                       AND (unit_id = ? OR unit_id IS NULL)))
            LIMIT 1`,
          [orgId, nextDueDateStr, catId, lease.id, lease.tenant_id, lease.unit_id]
        );

        // Do NOT back-fill periods the old category-blind check suppressed.
        //
        // Those months were almost always billed by hand once staff noticed —
        // there are 137 such manually-raised rent invoices — and raising them again
        // now would chase a tenant who has often already moved out. So when a past
        // due date is occupied by some OTHER invoice, skip it and say so, rather
        // than silently resurrecting it.
        //
        // Deliberately narrow: it only triggers for a date in the past that
        // something else already occupies. Ordinary catch-up after a late or failed
        // scheduler run creates past-dated rent exactly as before.
        let skipBackfill = false;
        if (!existing && nextDueDate < today) {
          const [[occupied]] = await pool.execute(
            `SELECT id FROM invoice WHERE leasing_id = ? AND org_id = ? AND due_on = ?
               AND category <> ? AND deleted_at IS NULL LIMIT 1`,
            [lease.id, orgId, nextDueDateStr, catId]
          );
          if (occupied) {
            skipBackfill = true;
            console.warn(`[Scheduler][org:${orgId}] Not back-filling rent for lease ${lease.id} due ${nextDueDateStr} — another invoice already sits on that date. Check by hand if the rent is genuinely unbilled.`);
          }
        }

        if (!existing && !skipBackfill) {
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
            // NOTE: the TENANT reminder is intentionally NOT sent here. Invoices
            // are generated ~one cycle (≈30 days) ahead of their due date, which
            // is far too early to nudge the tenant. The tenant reminder is sent
            // closer to the due date by sendUpcomingInvoiceRemindersForOrg (see
            // the daily "upcoming invoice reminders" job). The landlord notice
            // still fires at generation so owners see invoices as they're raised.
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
  // Bound ONCE and reused across the query: the 30/60/90-day notice is an exact
  // day match, so two CURDATE() calls straddling midnight could silently drop a
  // lease from the window it belongs to.
  const today = orgToday();
  // landlord_expired_days is a bitmask: 1=30 days, 2=60 days, 4=90 days
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.landlord_expired_days, l.tenant_id,
       t.email AS tenant_email, t.first_name AS tenant_first_name,
       t.last_name AS tenant_last_name, p.display_name AS property_name, p.org_id AS org_id,
       u.name AS unit_name, DATEDIFF(l.end_date, ?) AS days_remaining
     FROM leasing l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.lease_state = 'active'
       AND l.landlord_expired = 1
       AND l.type = 0 AND l.end_date IS NOT NULL AND l.end_date >= ?
       AND l.end_date <= DATE_ADD(?, INTERVAL 90 DAY)
       AND p.org_id = ?`,
    [today, today, today, orgId]
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
// Job 2b: Upcoming invoice reminders (per org)
// Sends the tenant the Invoice-Tenant reminder a configurable number of days
// BEFORE the due date — instead of at generation time (≈30 days early). The
// lead time is read from the Invoice-Tenant template's `date_first` (and an
// optional second nudge from `date_second`); it defaults to 7 days when unset.
// Runs daily and matches on an EXACT day offset (DATEDIFF == lead), so each
// invoice is reminded exactly once per offset with no dedup bookkeeping.
// ---------------------------------------------------------------------------

const DEFAULT_INVOICE_REMINDER_LEAD = 7;

async function sendUpcomingInvoiceRemindersForOrg(pool, orgId) {
  // Exact-day match (due_on is N days out), so "today" is read once — see the
  // note in sendLeaseExpiryForOrg.
  const today = orgToday();
  // Rent category — only rent invoices get the courtesy reminder (mirrors what
  // the generation job used to send). Deposits / stamp duty etc. are excluded.
  const [[rentalCat]] = await pool.execute(
    // MUST resolve to the same category lease creation/confirmation uses
    // (leasing.js), because the duplicate check below is now scoped to it — a
    // mismatch would make every night's check miss and create DUPLICATE rent.
    // '%Rental%' alone is ambiguous and unordered: org 8300127259922432 also has
    // a "Rental Expense" category, and another org has four %Rental% matches.
    "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1", [orgId]
  );
  if (!rentalCat) return;
  const catId = rentalCat.id;

  // Lead time(s) from the Invoice-Tenant template, default 7. A second nudge
  // fires only if date_second is set and differs from date_first.
  let leadDays = DEFAULT_INVOICE_REMINDER_LEAD;
  let secondLead = null;
  try {
    const [[tpl]] = await pool.execute(
      `SELECT date_first, date_second FROM email_template
       WHERE org_id = ? AND template_type = 'Invoice-Tenant' AND status = 1
       ORDER BY is_default_template DESC, created_time DESC LIMIT 1`,
      [orgId]
    );
    if (tpl) {
      if (Number(tpl.date_first) > 0) leadDays = Number(tpl.date_first);
      if (Number(tpl.date_second) > 0) secondLead = Number(tpl.date_second);
    }
  } catch (err) {
    console.error(`[Scheduler][upcomingReminders][org:${orgId}] template lookup failed, using default ${leadDays}d:`, err.message);
  }

  const offsets = [...new Set([leadDays, secondLead].filter(n => Number(n) > 0))];

  const [invoices] = await pool.execute(
    `SELECT i.id, i.invoice_code, i.leasing_id, i.due_on, DATEDIFF(i.due_on, ?) AS days_until
       FROM invoice i
       JOIN tenant t ON i.tenant_id = t.id
      WHERE i.org_id = ? AND i.status = 0 AND i.deleted_at IS NULL
        AND i.category = ? AND i.leasing_id IS NOT NULL
        AND DATEDIFF(i.due_on, ?) IN (${offsets.map(() => '?').join(',')})`,
    [today, orgId, catId, today, ...offsets]
  );

  if (invoices.length === 0) return;
  let sent = 0, failures = 0;

  for (const inv of invoices) {
    try {
      await sendInvoiceToTenant(pool, orgId, inv.leasing_id, {
        invoiceId: inv.id,
        invoiceCode: inv.invoice_code,
        category: catId,
        dueDate: new Date(inv.due_on),
      });
      sent++;
    } catch (err) {
      failures++;
      console.error(`[Scheduler][upcomingReminders] Error for ${inv.invoice_code}:`, err.message);
    }
  }

  if (sent > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${sent} upcoming invoice reminder(s) sent`, message: `Reminded tenants of invoice(s) due in ${offsets.join('/')} day(s).`, link: '/invoices' });
  }
}

// ---------------------------------------------------------------------------
// Job 3: Overdue invoice reminders (per org)
// ---------------------------------------------------------------------------

async function sendOverdueRemindersForOrg(pool, orgId) {
  // Bound once and reused for both placeholders so the DATEDIFF and the
  // comparison cannot straddle midnight and disagree.
  const today = orgToday();
  const [invoices] = await pool.execute(
    `SELECT i.id, i.invoice_code, i.amount, i.due_on, i.org_id, i.leasing_id,
       t.email AS tenant_email, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name, DATEDIFF(?, i.due_on) AS days_overdue
     FROM invoice i JOIN tenant t ON i.tenant_id = t.id JOIN unit u ON i.unit_id = u.id JOIN property p ON u.property_id = p.id
     WHERE i.status = 0 AND i.due_on < ? AND t.email IS NOT NULL AND t.email != '' AND i.org_id = ? AND i.deleted_at IS NULL
     ORDER BY i.due_on ASC LIMIT 50`,
    [today, today, orgId]
  );

  if (invoices.length === 0) return;
  let sent = 0, failures = 0;

  for (const inv of invoices) {
    try {
      let emailSent = false;
      if (inv.leasing_id) {
        const templateResult = await sendOverdueToTenant(pool, orgId, inv.leasing_id, { dueDate: inv.due_on, overdueAmount: inv.amount, invoiceId: inv.id, invoiceCode: inv.invoice_code });
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
     WHERE i.status = 0 AND i.due_on < ? AND i.deleted_at IS NULL AND i.org_id = ?
       AND i.amount > COALESCE(
         (SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
          WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL), 0)`,
    [orgToday(), orgId]
  );
  if (result.affectedRows > 0) console.log(`[Scheduler][org:${orgId}] Marked ${result.affectedRows} invoice(s) as overdue.`);

  // Flip to Paid (1) any invoice whose outstanding has reached zero — either
  // because total payments cover the amount, OR because the amount itself is
  // $0/negative (e.g. an invoice was edited down or written off). Without the
  // amount<=0 branch, $0 overdue invoices would stay Overdue forever.
  const [fixResult] = await pool.execute(
    `UPDATE invoice i SET i.status = 1
     WHERE i.status IN (0, 2) AND i.deleted_at IS NULL AND i.org_id = ?
       AND (
         i.amount <= 0
         OR i.amount <= COALESCE(
           (SELECT SUM(al.amount) FROM accounting_line al JOIN accounting a ON al.accounting_id = a.id
            WHERE al.invoice_code = i.invoice_code AND a.org_id = i.org_id AND a.deleted_at IS NULL AND al.deleted_at IS NULL), 0)
       )`,
    [orgId]
  );
  if (fixResult.affectedRows > 0) console.log(`[Scheduler][org:${orgId}] Fixed ${fixResult.affectedRows} invoice(s) with zero outstanding → Paid.`);
}

// ---------------------------------------------------------------------------
// Job 5: Check-in emails (per org) — send X days before lease start
// ---------------------------------------------------------------------------

async function sendCheckinEmailsForOrg(pool, orgId) {
  // Find leases with tenant_checkin enabled, starting today or in the future
  const [leases] = await pool.execute(
    `SELECT l.id, l.start_date, l.tenant_id, l.lease_state, l.tenant_checkin,
       t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.lease_state = 'active'
       AND l.tenant_checkin = 1
       AND l.start_date >= ?
       AND t.email IS NOT NULL AND t.email != ''
       AND p.org_id = ?`,
    [orgToday(), orgId]
  );
  if (leases.length === 0) return;

  // Both lead times come off the one Checkin-Tenant template: `date_first` is the
  // first email, `date_second` an optional follow-up nearer the move-in date. Same
  // arrangement Invoice-Tenant has always used.
  const template = await loadTemplate(pool, orgId, 'Checkin-Tenant');
  const dateFirstDays = template ? (Number(template.date_first) || 0) : 0;
  const followUpDays = template ? (Number(template.date_second) || 0) : 0;

  let sent = 0;
  let followUps = 0;
  const today = orgToday();
  for (const lease of leases) {
    try {
      const firstAlreadySent = await hasEmailBeenSent(pool, lease.id, 'Checkin-Tenant');

      // Leg one. Same comparison the create and confirm endpoints use — see
      // utils/checkinWindow.js for why it lives in one place now.
      if (!firstAlreadySent) {
        if (!isWithinCheckinWindow(lease.start_date, today, dateFirstDays)) continue;
        await sendCheckinToTenant(pool, orgId, lease.id);
        sent++;
        // Never both legs in one sweep: the follow-up is a reminder of an email
        // the tenant has had time to read, not a second copy of one sent seconds
        // ago. shouldSendCheckinFollowUp would refuse anyway (no gap), but not
        // asking is clearer than relying on it.
        continue;
      }

      if (followUpDays <= 0) continue;
      if (await hasEmailBeenSent(pool, lease.id, CHECKIN_FOLLOWUP_TYPE)) continue;

      const decision = shouldSendCheckinFollowUp({
        leaseState: lease.lease_state,
        tenantCheckin: lease.tenant_checkin,
        startDate: lease.start_date,
        today,
        followUpDays,
        firstSentOn: await lastSentOrgDate(pool, lease.id, 'Checkin-Tenant'),
      });
      if (!decision.send) continue;

      await sendCheckinFollowUpToTenant(pool, orgId, lease.id);
      followUps++;
    } catch (err) {
      console.error(`[Scheduler] Check-in email error for lease ${lease.id}:`, err.message);
    }
  }
  if (sent > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${sent} check-in email(s) sent`, link: '/leasing' });
  }
  if (followUps > 0) {
    await createNotification(pool, { orgId, type: 'info', title: `${followUps} check-in follow-up(s) sent`, message: `Sent ${followUpDays} day(s) before move-in.`, link: '/leasing' });
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
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.lease_state = 'active'
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
  // Absent means "send before the end date"; bitToBool would say false, so the null
  // check stays outside it.
  let beforeDate = true;
  if (template && template.before_date != null) {
    beforeDate = bitToBool(template.before_date);
  }

  let sent = 0;
  const today = orgTodayDate();
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
  // Superseded by the renewal-ask flow when that is switched on. Both would contact the
  // same tenant about the same question, so exactly one of them runs — and the existing
  // flag is the switch, which makes the changeover reversible in one click.
  try {
    const { loadSettings } = require('../routes/advertising');
    const settings = await loadSettings(pool, orgId);
    if (Number(settings.renewal_ask_enabled)) return;
  } catch (e) {
    // Settings unreadable. SKIP rather than fall through: if the flag was actually on,
    // sending here and again from the ask flow at 10:00 double-contacts the tenant. A
    // missed reminder is recoverable tomorrow; a duplicate message is not.
    console.error('[Scheduler] renewal-ask gate unreadable, skipping legacy renewal emails:', e.message);
    return;
  }
  // Find leases with tenant_renewal enabled, with an end date and renewal days set
  const [leases] = await pool.execute(
    `SELECT l.id, l.end_date, l.tenant_renewal_days, l.tenant_id,
       t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
       p.display_name AS property_name, u.name AS unit_name
     FROM leasing l
     JOIN unit u ON l.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     JOIN tenant t ON l.tenant_id = t.id
     WHERE l.status = 1 AND l.deleted_at IS NULL AND l.lease_state = 'active'
       AND l.tenant_renewal = 1
       AND l.end_date IS NOT NULL
       AND l.tenant_renewal_days IS NOT NULL AND l.tenant_renewal_days > 0
       AND t.email IS NOT NULL AND t.email != ''
       AND p.org_id = ?`,
    [orgId]
  );
  if (leases.length === 0) return;

  let sent = 0;
  const today = orgTodayDate();
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
// Weekly renewal digest — admin work list for renewal answers needing action
// ---------------------------------------------------------------------------

async function sendRenewalDigestForOrg(pool, orgId) {
  let rows;
  try {
    [rows] = await pool.execute(
      `SELECT MAX(r.id) AS latest_ask_id, r.lease_id, r.unit_id,
              DATE_FORMAT(r.lease_end_at_ask, '%Y-%m-%d') AS lease_end,
              DATE_FORMAT(r.decision_due_on, '%Y-%m-%d')  AS decision_due_on,
              -- sent_at, not state='SENT' — see the note on the same column in
              -- routes/advertising.js. State moves to REPLIED on an answer, so counting it
              -- reports an answered ask as never delivered.
              SUM(r.sent_at IS NOT NULL)                   AS asks_delivered,
              DATE_FORMAT(MAX(r.unverified_at), '%Y-%m-%d') AS unverified_on,
              COUNT(*)                                     AS slots_used,
              MAX(r.ask_number)                            AS last_ask_number,
              DATE_FORMAT(MAX(r.sent_at), '%Y-%m-%d')      AS last_delivered_on,
              MAX(r.escalated_at IS NOT NULL)              AS escalated,
              SUBSTRING_INDEX(GROUP_CONCAT(r.reply_intent ORDER BY r.replied_at DESC), ',', 1) AS reply_intent,
              SUBSTRING_INDEX(GROUP_CONCAT(r.applied ORDER BY r.replied_at DESC), ',', 1)      AS reply_applied,
              SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(r.stale_reason,'') ORDER BY r.replied_at DESC), ',', 1) AS reply_stale_reason,
              u.name AS unit_name, p.display_name AS property_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END AS tenant_name
         FROM renewal_ask r
         JOIN unit u ON u.id = r.unit_id
         JOIN property p ON p.id = u.property_id
         JOIN leasing l ON l.id = r.lease_id AND l.deleted_at IS NULL
         LEFT JOIN tenant t ON t.id = r.tenant_id
        WHERE r.org_id = ?
          -- OUTSTANDING WORK ONLY. Without these three the digest repeats itself
          -- forever: a status is derived from the ask row alone and nothing ever
          -- marks it done, so a confirmation stays 'paperwork due' after the
          -- paperwork is issued. A weekly email that keeps naming jobs you have
          -- already finished is one people stop opening, which costs more than
          -- sending nothing.
          --
          -- The lease END DATE is the completion signal. If it still matches what
          -- we asked about, nobody has acted; if it moved — in either direction —
          -- someone has, and this row is history.
          AND l.end_date IS NOT NULL
          AND DATE(l.end_date) = DATE(r.lease_end_at_ask)
          -- A lease that has already ended cannot be renewed or chased.
          AND DATE(l.end_date) >= ?
        GROUP BY r.lease_id, r.unit_id, r.lease_end_at_ask, r.decision_due_on,
                 u.name, p.display_name, tenant_name
        ORDER BY MAX(r.escalated_at IS NOT NULL) DESC, r.decision_due_on ASC
        LIMIT 500`,
      [orgId, orgToday()]
    );
  } catch (err) {
    if (err && err.code === 'ER_NO_SUCH_TABLE') {
      console.log(`[Scheduler][org:${orgId}] renewal_ask table missing; skipping renewal digest.`);
      return;
    }
    throw err;
  }

  const digest = buildRenewalDigest(rows);
  if (!digest.shouldSend) {
    console.log(`[Scheduler][org:${orgId}] Renewal digest skipped; no actionable renewals.`);
    return;
  }

  await sendAdminAlert(pool, { orgId, subject: digest.subject, html: digest.html });
}

// ---------------------------------------------------------------------------
// Service task auto-promote: pending → in-progress when start date is today
// ---------------------------------------------------------------------------

async function promoteServiceTasksForOrg(pool, orgId) {
  const [result] = await pool.execute(
    `UPDATE service SET status = 1, updated_at = NOW()
     WHERE org_id = ? AND status = 0 AND service_date_start IS NOT NULL
       AND DATE(service_date_start) <= ?`,
    [orgId, orgToday()]
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
  // Release any tentative candidates + clear `awaiting` on the bookings about
  // to be declined, so an expired invite doesn't leave dangling soft-holds.
  // viewing_candidate + the `awaiting` column only exist post-migration 012,
  // so guard: orgs that haven't applied 012 yet simply skip this.
  try {
    await pool.execute(
      `UPDATE viewing_candidate vc
         JOIN viewing_booking vb ON vc.booking_id = vb.id
          SET vc.status = 0
        WHERE vc.status = 1 AND vb.status = 0
          AND vb.created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
    await pool.execute(
      `UPDATE viewing_booking SET awaiting = NULL
        WHERE status = 0 AND awaiting IS NOT NULL
          AND created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );
  } catch (err) {
    if (!/doesn't exist|Unknown column|Unknown table/i.test(err.message)) {
      console.error('[Scheduler] candidate release on auto-decline failed:', err.message);
    }
  }

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
         AND i.reminder_date <= ?
         AND i.reminder_sent_at IS NULL`,
      [orgId, orgToday()]
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
// Daily re-extract for WhatsApp inquiries that are still active.
//
// "Still active" = inquiry.status = 0 (Open), not converted to a tenant,
// and no confirmed/completed viewing. New messages since last_extracted_at
// are diffed against the inquiry; any new or changed facts are appended as
// dated lines to inquiry.notes (Option A: one line per fact). Structured
// fields are NEVER overwritten — the notes log is the audit trail.
// ---------------------------------------------------------------------------

async function reExtractInquiriesForOrg(pool, orgId) {
  // Pull eligible sessions in one query — open inquiry, no booking, with at
  // least one new user-message since last_extracted_at.
  const [rows] = await pool.execute(
    `SELECT cs.id AS session_id, cs.inquiry_id, cs.last_extracted_at, cs.extract_count
       FROM chat_session cs
       JOIN inquiry i ON i.id = cs.inquiry_id AND i.deleted_at IS NULL
       JOIN chat_message cm ON cm.session_id = cs.id AND cm.role = 'user'
      WHERE cs.channel = 'whatsapp'
        AND cs.inquiry_id IS NOT NULL
        AND i.status = 0
        AND i.tenant_id IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM viewing_booking vb
               WHERE vb.inquiry_id = i.id AND vb.status IN (1, 3)
            )
      GROUP BY cs.id
      HAVING MAX(cm.created_at) > COALESCE(cs.last_extracted_at, '1970-01-01')
      LIMIT 200`
  );

  if (!rows.length) {
    console.log(`[Scheduler][org:${orgId}] reExtract: nothing to do.`);
    return { processed: 0, updated: 0, errors: 0 };
  }

  let processed = 0, updated = 0, errors = 0;
  for (const r of rows) {
    try {
      const [newMsgs] = await pool.execute(
        `SELECT role, content, created_at FROM chat_message
          WHERE session_id = ?
            AND created_at > COALESCE(?, '1970-01-01')
            AND role IN ('user', 'assistant')
          ORDER BY created_at ASC
          LIMIT 50`,
        [r.session_id, r.last_extracted_at]
      );
      if (!newMsgs.length) { processed++; continue; }

      const [[inq]] = await pool.execute(
        `SELECT first_name, last_name, email, phone, budget,
                DATE_FORMAT(desired_start_date, '%Y-%m-%d') AS desired_start_date,
                notes
           FROM inquiry WHERE id = ? LIMIT 1`,
        [r.inquiry_id]
      );
      if (!inq) { processed++; continue; }

      const { diff } = await inquiryExtractor.extractDiff(newMsgs, inq);
      if (diff && diff.length) {
        if (config.inquiryExtractMode === 'staging') {
          for (const line of diff) {
            await pool.execute(
              `INSERT INTO inquiry_fact_staging (id, org_id, inquiry_id, session_id, fact_line, occurred_on)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [newId(), orgId, r.inquiry_id, r.session_id, String(line), orgToday()]
            );
          }
        } else {
          const newNotes = inquiryExtractor.appendDiffToNotes(inq.notes, diff);
          await pool.execute(
            `UPDATE inquiry SET notes = ?, updated_at = NOW() WHERE id = ?`,
            [newNotes, r.inquiry_id]
          );
        }
        updated++;
      }
      await pool.execute(
        `UPDATE chat_session
            SET last_extracted_at = NOW(), extract_count = extract_count + 1
          WHERE id = ?`,
        [r.session_id]
      );
      processed++;
    } catch (err) {
      errors++;
      console.error(`[Scheduler][org:${orgId}] reExtract session ${r.session_id} failed:`, err.message);
    }
  }

  console.log(`[Scheduler][org:${orgId}] reExtract: ${processed} processed, ${updated} updated, ${errors} errors`);
  return { processed, updated, errors };
}


// ---------------------------------------------------------------------------
// Job: TaneChat fact-delivery health (per org)
//
// TaneChat now extracts inquiry facts and posts them to /api/public/inquiry/facts,
// sending a daily heartbeat per active conversation even when nothing changed. If
// their emitter dies, inquiries silently stop being updated — and after cutover
// Tenafy has no transcripts to fall back on. This job is the detector.
//
// Deliberately DELIVERY-based rather than inbound-based: post-cutover TaneChat stops
// calling /chat/log, so chat_message stops being written and "had inbound activity
// recently" becomes unanswerable here. See utils/inquiryFactHealth.js.
// ---------------------------------------------------------------------------
const FACT_SILENCE_TITLE = 'TaneChat has stopped sending inquiry updates';

async function checkFactDeliveryHealthForOrg(pool, orgId) {
  let sessions;
  try {
    const [rows] = await pool.execute(
      `SELECT cs.id AS session_id, cs.channel, cs.channel_user_id, cs.inquiry_id,
              MAX(d.created_at) AS last_delivery_at,
              COUNT(*)          AS deliveries_in_lookback
         FROM chat_session cs
         JOIN inquiry_fact_delivery d ON d.inquiry_id = cs.inquiry_id
        WHERE cs.inquiry_id IS NOT NULL
          AND d.org_id = ?
          AND d.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY cs.id`,
      [orgId, LOOKBACK_DAYS]
    );
    sessions = rows;
  } catch (err) {
    // inquiry_fact_delivery absent on an un-migrated org — nothing to check.
    if (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR') {
      return { tracked: 0, stale: 0, orgSilent: false };
    }
    throw err;
  }

  // Needed so an outage lasting longer than the lookback window still alarms.
  const [[hist]] = await pool.execute(
    'SELECT COUNT(*) AS total FROM inquiry_fact_delivery WHERE org_id = ?', [orgId]
  );
  const health = assessFactDeliveryHealth({
    sessions, historicalTotal: Number(hist ? hist.total : 0), nowMs: Date.now(),
  });

  if (health.orgSilent) {
    // Don't stack an identical alarm every morning for the length of an outage.
    const [[open]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM notification
        WHERE org_id = ? AND title = ? AND is_read = 0
          AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [orgId, FACT_SILENCE_TITLE]
    );
    if (Number(open ? open.n : 0) > 0) {
      console.log(`[Scheduler][org:${orgId}] factDeliveryHealth: silence alert already open, not repeating`);
      return { tracked: health.tracked, stale: health.stale.length, orgSilent: true };
    }
    await createNotification(pool, {
      orgId,
      type: 'error',
      title: FACT_SILENCE_TITLE,
      message: `No fact deliveries for any of ${health.tracked} active conversation(s) in the last `
        + `${STALE_HOURS} hours. Inquiries are no longer being updated from chat. Check TaneChat's `
        + `emitter and that its API key is still valid.`,
      link: '/inquiries',
    });
  }
  // NOTE: deliberately no per-conversation alert. TaneChat only heartbeats
  // conversations with inbound activity in the last 3 days, so a conversation going
  // quiet is the NORMAL end of a lead, not a fault. Alerting on it would fire for
  // every closed enquiry, and an alert that cries wolf daily gets muted — which is
  // how the silent-failure mode we are guarding against comes back.

  console.log(`[Scheduler][org:${orgId}] factDeliveryHealth: ${health.tracked} tracked, `
    + `${health.stale.length} stale, orgSilent=${health.orgSilent}`);
  return { tracked: health.tracked, stale: health.stale.length, orgSilent: health.orgSilent };
}

// ---------------------------------------------------------------------------
// Start scheduler
// ---------------------------------------------------------------------------

function startScheduler() {
  console.log('[Scheduler] Starting background jobs...');

  // EVERY time below is Hong Kong local (ORG_TIME_ZONE), not server time.
  // Production runs Etc/UTC; node-cron defaults to the server zone, so before this
  // was made explicit the "10:00" invoice run actually went out at 18:00 HK.
  // Two rules for anything added here:
  //   1. always pass { timezone: ORG_TIME_ZONE };
  //   2. never derive a date from CURDATE() or local getters — use orgToday() /
  //      orgTodayDate(), or the job reads the UTC calendar date and is a day out
  //      for the eight hours HK is already into tomorrow.

  // Daily at 00:05 AM - mark overdue invoices
  cron.schedule('5 0 * * *', () => {
    console.log('[Scheduler] Updating invoice statuses...');
    runForAllOrgs('markOverdue', markOverdueInvoicesForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 10:00 AM - generate recurring invoices
  cron.schedule('0 10 * * *', () => {
    console.log('[Scheduler] Running recurring invoice generation...');
    runForAllOrgs('recurringInvoices', generateRecurringInvoicesForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 08:00 - lease expiry notifications
  cron.schedule('0 8 * * *', () => {
    console.log('[Scheduler] Checking for expiring leases...');
    runForAllOrgs('leaseExpiry', sendLeaseExpiryForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 09:30 - upcoming invoice reminders (N days before due, per template date_first; default 7)
  cron.schedule('30 9 * * *', () => {
    console.log('[Scheduler] Sending upcoming invoice reminders...');
    runForAllOrgs('upcomingInvoiceReminders', sendUpcomingInvoiceRemindersForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Every Monday at 09:00 - overdue reminders
  cron.schedule('0 9 * * 1', () => {
    console.log('[Scheduler] Sending overdue invoice reminders...');
    runForAllOrgs('overdueReminders', sendOverdueRemindersForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 07:00 - check-in emails (X days before lease start, based on template date_first)
  cron.schedule('0 7 * * *', () => {
    console.log('[Scheduler] Sending check-in emails...');
    runForAllOrgs('checkinEmails', sendCheckinEmailsForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 07:30 - check-out emails (X days before/after lease end, based on template date_first)
  cron.schedule('30 7 * * *', () => {
    console.log('[Scheduler] Sending check-out emails...');
    runForAllOrgs('checkoutEmails', sendCheckoutEmailsForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 07:45 - renewal emails (tenant_renewal_days before lease end)
  cron.schedule('45 7 * * *', () => {
    console.log('[Scheduler] Sending renewal emails...');
    runForAllOrgs('renewalEmails', sendRenewalEmailsForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 10:00 - renewal asks. Deliberately mid-morning rather than 07:45: this one
  // messages tenants on WhatsApp, and a 7am message about their home reads badly.
  cron.schedule('0 10 * * *', () => {
    console.log('[Scheduler] Sending renewal asks...');
    runForAllOrgs('renewalAsks', async (pool, orgId) => {
      const { runRenewalAsksForOrg } = require('./renewalAskDispatch');
      const { loadSettings } = require('../routes/advertising');
      const summary = await runRenewalAsksForOrg(pool, orgId, { loadSettings, createNotification });
      if (summary && (summary.asked || summary.escalated)) {
        console.log(`[Scheduler] renewal asks org ${orgId}:`, JSON.stringify(summary));
      }
    });
  }, { timezone: ORG_TIME_ZONE });

  // Every Monday at 11:00 - weekly renewal digest to admins
  cron.schedule('0 11 * * 1', () => {
    console.log('[Scheduler] Sending weekly renewal digest...');
    runForAllOrgs('renewalDigest', sendRenewalDigestForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 06:00 - auto-promote pending service tasks to in-progress
  cron.schedule('0 6 * * *', () => {
    console.log('[Scheduler] Promoting pending service tasks to in-progress...');
    runForAllOrgs('serviceAutoProgress', promoteServiceTasksForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Hourly - auto-decline pending viewing bookings older than 24h
  cron.schedule('15 * * * *', () => {
    console.log('[Scheduler] Auto-declining stale viewing bookings...');
    runForAllOrgs('viewingAutoDecline', autoDeclineStaleViewingsForOrg);
    // Also escalate stale relay-scheduler negotiations (no activity for 24h).
    const { autoEscalateStaleNegotiationsForOrg } = require('./viewingNegotiation');
    runForAllOrgs('viewingNegotiationReap', autoEscalateStaleNegotiationsForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 08:30 - inquiry reminders (Inquiry-Reminder template to creator)
  cron.schedule('30 8 * * *', () => {
    console.log('[Scheduler] Sending inquiry reminders...');
    runForAllOrgs('inquiryReminders', sendInquiryRemindersForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 23:00 - re-extract WhatsApp inquiries (Option A: diff into notes).
  cron.schedule('0 23 * * *', () => {
    console.log('[Scheduler] Re-extracting WhatsApp inquiries...');
    runForAllOrgs('inquiryReExtract', reExtractInquiriesForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Daily at 04:00 - TaneChat fact-delivery health (their heartbeat lands 02:00)
  cron.schedule('0 4 * * *', () => {
    console.log('[Scheduler] Checking TaneChat fact-delivery health...');
    runForAllOrgs('factDeliveryHealth', checkFactDeliveryHealthForOrg);
  }, { timezone: ORG_TIME_ZONE });

  // Run once at startup to fix stale statuses
  runForAllOrgs('startupFix', markOverdueInvoicesForOrg);
  runForAllOrgs('startupServiceFix', promoteServiceTasksForOrg);

  console.log('[Scheduler] All jobs scheduled.');
}

module.exports = { startScheduler, createNotification };
// Exported for tests: these are the jobs whose correctness depends on "today"
// being the operator's calendar date rather than the server's.
module.exports.markOverdueInvoicesForOrg = markOverdueInvoicesForOrg;
module.exports.promoteServiceTasksForOrg = promoteServiceTasksForOrg;
module.exports.generateRecurringInvoicesForOrg = generateRecurringInvoicesForOrg;
module.exports.sendOverdueRemindersForOrg = sendOverdueRemindersForOrg;
module.exports.sendLeaseExpiryForOrg = sendLeaseExpiryForOrg;
module.exports.sendUpcomingInvoiceRemindersForOrg = sendUpcomingInvoiceRemindersForOrg;
module.exports.sendRenewalDigestForOrg = sendRenewalDigestForOrg;
module.exports.buildRenewalDigest = buildRenewalDigest;
