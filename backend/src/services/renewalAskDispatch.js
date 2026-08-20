/**
 * Renewal ask dispatch — the only place that messages a tenant about renewing.
 *
 * WHY THIS IS ITS OWN MODULE, and does not call the existing helpers:
 * `sendTemplateEmail` fires a best-effort WhatsApp for the same template type when one
 * exists (emailService.js), and a `Renewal-Tenant` WhatsApp template does exist. Routing
 * a renewal ask through it would therefore send the email AND the WhatsApp — the exact
 * double-contact this feature is meant to end. The channel decision has to sit above
 * both senders, which is what this module is.
 *
 * Ordering is deliberate: record the attempt, then send, then record the outcome. If the
 * process dies mid-send we have a row saying "attempted" rather than a tenant who was
 * messaged with nothing to show it. Over-recording is recoverable; over-sending is not.
 */

const { orgToday, orgWallClock } = require('../utils/orgTime');
const renewalAsk = require('../utils/renewalAsk');
const whatsappService = require('./whatsappService');

const newId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

const PHRASE_COLUMN = { 1: 'renewal_ask_phrase', 2: 'renewal_ask_phrase_2', 3: 'renewal_ask_phrase_3' };

// WE NEVER RETRY A SEND. A gateway call that throws or times out is indistinguishable
// from one that was delivered and then lost its acknowledgement, so a retry can put the
// same message in front of a real tenant twice. Instead the slot is RESOLVED: it counts
// as one of the three asks and the sequence moves on, so the tenant is neither
// double-messaged nor stranded. The cost is that a transient failure spends one ask,
// which is the cheaper mistake.

/**
 * Leases that are candidates today: the unit's latest live lease, still running, tenant
 * undecided, renewal reminders opted in, and inside the notice window.
 *
 * Note this is a NARROWER set than the legacy renewal-email job, deliberately. That job
 * required a tenant email (so it silently skipped phone-only tenants), ignored
 * contract_type (so it chased tenants who had already decided) and keyed off
 * tenant_renewal_days rather than the notice period.
 */
async function findRenewalCandidates(pool, orgId, { today, defaultNoticeDays, minTenancyDays }) {
  const [rows] = await pool.execute(
    `SELECT l.id AS lease_id, l.unit_id, l.tenant_id, l.contract_type,
            l.notice_period_days, l.renewal_reply,
            DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
            u.name AS unit_name, p.display_name AS property_name,
            t.phone AS tenant_phone, t.email AS tenant_email,
            t.first_name AS tenant_first_name,
            CASE WHEN t.type = 1 THEN t.company_name
                 ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END AS tenant_name
       FROM leasing l
       JOIN unit u ON u.id = l.unit_id
       JOIN property p ON p.id = u.property_id
       LEFT JOIN tenant t ON t.id = l.tenant_id
      WHERE p.org_id = ?
        AND l.deleted_at IS NULL
        AND u.active_status = 1
        AND l.tenant_renewal = 1
        AND l.status = 1
        AND l.lease_state = 'active'
        AND l.start_date <= ?
        AND l.end_date IS NOT NULL
        AND l.end_date >= ?
        AND l.contract_type IN (1, 4)
        -- 3 = unsure. Not an answer, so the lease stays in the pool and the remaining
        -- asks still go out; renewalAskEligibility applies the same rule in code.
        AND (l.renewal_reply IS NULL OR l.renewal_reply = 3)
        AND NOT EXISTS (
          SELECT 1 FROM leasing l2
           WHERE l2.unit_id = l.unit_id AND l2.deleted_at IS NULL AND l2.id <> l.id
             AND (l2.end_date IS NULL OR l2.end_date > l.end_date))
      ORDER BY l.end_date ASC`,
    [orgId, today, today]
  );
  return rows.filter(r => renewalAsk.renewalAskEligibility(
    { ...r, end_date: r.end_date }, { today, defaultNoticeDays, minTenancyDays }
  ).eligible);
}

/**
 * Cycles still awaiting a real answer, one row per cycle — the latest ask in it.
 *
 * "Open" is a property of the CYCLE, not of a row. Ask 1 stays `SENT` forever once ask 2 goes
 * out, so filtering on `state IN ('PENDING','SENT')` reported one conversation three times
 * and, worse, kept reporting ask 1 as awaiting an answer after the tenant had answered ask 2.
 * A reply can only ever be about the most recent thing we said, so that is what is listed.
 *
 * A cycle closes on a DEFINITE reply, never on `unsure` — otherwise the ask disappears from
 * here the moment a stray "ok thanks" is filed, and the real answer that follows has no id to
 * be attributed to, which is the whole point of the list.
 *
 * Small by construction: at most one row per lease inside a notice window.
 */
/**
 * Serialise ask creation for one conversation, across connections and processes.
 *
 * An earlier attempt inserted first and broke ties on the Snowflake id, on the theory that the
 * older ask wins and both racers reach the same verdict. That is wrong, and the counterexample
 * is simple: the racer with the LOWER id may commit SECOND. The higher-id racer then re-reads,
 * sees nothing older, and sends; the lower-id racer re-reads, sees only something newer than
 * itself, and sends too. Id order is not commit order, so no amount of reading after the fact
 * can establish who was first.
 *
 * So we take a real lock, named for the conversation, and do the check and the insert inside
 * it. `GET_LOCK` is connection-scoped and cross-process, needs no schema and no privileges, and
 * MySQL releases it if the connection dies — the failure mode is a lock that frees itself
 * rather than a claim row that strands.
 *
 * Failing to acquire it defers the ask. That is the safe direction: not messaging a tenant this
 * hour costs a few hours; messaging them twice about their own home cannot be undone.
 *
 * The callback must use the CONNECTION it is handed, not the pool — a lock taken on one
 * connection does nothing for work done on another. Delivery deliberately happens after the
 * lock is released: nothing holds it across a network call to the gateway.
 */
async function withConversationLock(pool, orgId, conversationKey, fn, { timeoutSeconds = 5 } = {}) {
  if (!conversationKey) return { locked: false, reason: 'no_conversation_key' };
  // MySQL caps lock names at 64 characters; this is well inside it.
  const name = `renewal_ask:${orgId}:${conversationKey}`;
  const conn = await pool.getConnection();
  try {
    const [[got]] = await conn.execute('SELECT GET_LOCK(?, ?) AS got', [name, timeoutSeconds]);
    if (!got || Number(got.got) !== 1) return { locked: false, reason: 'lock_timeout' };
    try {
      return { locked: true, value: await fn(conn) };
    } finally {
      await conn.execute('SELECT RELEASE_LOCK(?) AS released', [name]);
    }
  } finally {
    conn.release();
  }
}

// Company tenants store their name in company_name; individuals in first/last.
const tenantNameSql = `CASE WHEN t.type = 1 THEN t.company_name
       ELSE TRIM(CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))) END`;

/**
 * @param {boolean} [opts.deliveredOnly] Restrict to asks the tenant actually received.
 *   The two consumers want slightly different sets, and the difference matters:
 *   - the serialisation rule wants PENDING rows too, because an ask mid-send still owns the
 *     conversation and a second lease must not jump in front of it;
 *   - the partner's correlation list must NOT include them. A reply cannot be about a message
 *     that never arrived, and offering one invites a stray "ok thanks" being filed against an
 *     ask the tenant never saw.
 */
async function openAsks(pool, orgId, { deliveredOnly = false } = {}) {
  // Built PER ALIAS, not as a bare fragment with the alias prefixed outside it. `r.${frag}`
  // reads fine until the fragment is parenthesised, at which point it emits
  // `r.(sent_at IS NOT NULL OR state = 'PENDING')` — a syntax error MySQL rejects. That shipped
  // and broke the first live run: every candidate threw, so nine tenants went unasked. The fake
  // pool the tests use matches on a regex and never parses the SQL, so nothing caught it.
  //
  // Applied to BOTH the outer filter and the "is this the newest" subquery. If only the outer
  // one narrowed, a failed ask 2 would hide a delivered ask 1 by being newer than it, and the
  // cycle would vanish from the list entirely.
  const delivered = (a) => (deliveredOnly
    ? `${a}.sent_at IS NOT NULL`
    : `(${a}.sent_at IS NOT NULL OR ${a}.state = 'PENDING')`);
  const [rows] = await pool.execute(
    `SELECT r.id, r.lease_id, r.tenant_id, r.state, r.unit_id, r.escalated_at, r.ask_number,
            r.channel, r.reply_intent,
            DATE_FORMAT(r.sent_at, '%Y-%m-%d %H:%i:%s') AS sent_at,
            DATE_FORMAT(r.lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask,
            DATE_FORMAT(r.decision_due_on, '%Y-%m-%d')  AS decision_due_on,
            u.name AS unit_name, p.display_name AS property_name,
            ${tenantNameSql} AS tenant_name,
            t.phone AS tenant_phone, t.email AS tenant_email
       FROM renewal_ask r
       JOIN unit u ON u.id = r.unit_id
       JOIN property p ON p.id = u.property_id
       -- The tenant we ASKED, never the lease's current one: if the tenant changed after the
       -- ask went out, the reply still belongs to the person who received it.
       LEFT JOIN tenant t ON t.id = r.tenant_id
      WHERE r.org_id = ?
        AND r.state IN ('PENDING','SENT','REPLIED')
        -- A FAILED or CANCELLED ask is not outstanding.
        AND ${delivered('r')}
        -- The cycle has had no real answer yet.
        AND NOT EXISTS (
          SELECT 1 FROM renewal_ask d
           WHERE d.lease_id = r.lease_id AND d.lease_end_at_ask = r.lease_end_at_ask
             AND d.decision_due_on = r.decision_due_on
             AND d.reply_intent IS NOT NULL AND d.reply_intent <> 3)
        -- …and this is the newest ask in it, so one cycle is one row.
        AND NOT EXISTS (
          SELECT 1 FROM renewal_ask n
           WHERE n.lease_id = r.lease_id AND n.lease_end_at_ask = r.lease_end_at_ask
             AND n.decision_due_on = r.decision_due_on
             AND ${delivered('n')}
             AND (n.ask_number > r.ask_number
                  OR (n.ask_number = r.ask_number AND n.id > r.id)))
      ORDER BY r.sent_at ASC, r.id ASC`,
    [orgId]
  );
  return rows;
}

async function askHistory(pool, lease, cycle) {
  const [rows] = await pool.execute(
    `SELECT id, ask_number, state, attempts, channel, escalated_at, reply_intent,
            DATE_FORMAT(sent_at, '%Y-%m-%d') AS sent_at,
            DATE_FORMAT(COALESCE(sent_at, resolved_on), '%Y-%m-%d') AS attempted_on
       FROM renewal_ask
      WHERE lease_id = ? AND lease_end_at_ask = ? AND decision_due_on = ?
      ORDER BY ask_number ASC`,
    [lease.lease_id, cycle.lease_end_at_ask, cycle.decision_due_on]
  );
  return rows;
}

async function deliver(pool, orgId, { channel, lease, message, askId }) {
  if (channel === 'whatsapp') {
    // The ask id travels with the message so the partner can attribute the REPLY. Dropped
    // silently until WHATSAPP_SEND_ORIGIN=1, so passing it is always safe.
    return whatsappService.sendWhatsApp(pool, orgId, lease.tenant_phone, message,
      askId ? { origin: { type: 'renewal_ask', id: askId } } : {});
  }
  // Deliberately the low-level mailer, NOT sendTemplateEmail: that helper also fires a
  // best-effort WhatsApp for the matching template type, which would double-contact the
  // tenant. Going straight to the transport keeps one message per ask.
  const { findSmtpAccount } = require('./emailService');
  const { sendMail, sendMailWithAccount } = require('../config/mailer');
  const subject = `Your lease at ${[lease.property_name, lease.unit_name].filter(Boolean).join(' ')}`;
  try {
    const account = typeof findSmtpAccount === 'function'
      ? await findSmtpAccount(pool, orgId).catch(() => null)
      : null;
    if (account && typeof sendMailWithAccount === 'function') {
      await sendMailWithAccount(account, { to: lease.tenant_email, subject, text: message });
    } else {
      await sendMail({ to: lease.tenant_email, subject, text: message });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Run one org's renewal asks for today. Returns a summary; never throws for a single
 * lease, because one unreachable tenant must not stop the rest.
 */
async function runRenewalAsksForOrg(pool, orgId, { loadSettings, createNotification } = {}) {
  const settings = await loadSettings(pool, orgId);
  if (!Number(settings.renewal_ask_enabled)) return { skipped: 'disabled' };

  const today = orgToday();
  const defaultNoticeDays = settings.renewal_default_notice_days;
  const minTenancyDays = settings.renewal_min_tenancy_days;
  const gapDays = settings.renewal_ask_gap_days;

  const candidates = await findRenewalCandidates(pool, orgId, { today, defaultNoticeDays, minTenancyDays });
  const summary = { asked: 0, escalated: 0, unreachable: 0, failed: 0, no_wording: 0,
                    deferred_conversation_busy: 0, considered: candidates.length };

  for (const lease of candidates) {
    try {
      const cycle = renewalAsk.renewalAskCycleKey(lease, { today, defaultNoticeDays });
      if (!cycle) continue;
      const history = await askHistory(pool, lease, cycle);
      const hasDefiniteReply = history.some(h => renewalAsk.isDefiniteReply(h.reply_intent));

      if (renewalAsk.shouldEscalate(history, { today, gapDays, hasDefiniteReply })) {
        const [escUpd] = await pool.execute(
          `UPDATE renewal_ask SET escalated_at = ?
            WHERE lease_id = ? AND lease_end_at_ask = ? AND decision_due_on = ? AND escalated_at IS NULL`,
          [orgWallClock(new Date()), lease.lease_id, cycle.lease_end_at_ask, cycle.decision_due_on]
        );
        // Two concurrent runs would both pass shouldEscalate; only the one that actually
        // stamped the rows may raise the notification, or staff get told twice.
        if (!escUpd || escUpd.affectedRows === 0) continue;
        if (typeof createNotification === 'function') {
          await createNotification(pool, {
            orgId, type: 'warning',
            title: `No renewal answer after ${renewalAsk.MAX_ASKS} asks — ${[lease.property_name, lease.unit_name].filter(Boolean).join(' ')}`,
            link: '/leasing/vacancy',
          });
        }
        summary.escalated += 1;
        continue;
      }

      // Resolve any unfinished attempt from an earlier run before considering a new one.
      // It is left PENDING only when the process died mid-send or the gateway never
      // answered — in both cases the message may already have arrived, so it is closed
      // out rather than repeated.
      // Covers both origins: a scheduled send that died mid-flight, and an ask the partner
      // claimed but never confirmed with /sent. Neither is re-sent — the slot is closed.
      const stuck = history.find(h => h.state === 'PENDING' && !h.sent_at);
      if (stuck) {
        if (stuck.attempted_on === today) continue;   // still in flight from this run
        const [resolved] = await pool.execute(
          `UPDATE renewal_ask SET state = 'FAILED', resolved_on = ?
            WHERE id = ? AND state = 'PENDING' AND sent_at IS NULL`,
          [today, stuck.id]);
        if (resolved && resolved.affectedRows > 0) summary.failed += 1;
        continue;   // next run picks up the following ask number
      }

      const due = renewalAsk.nextAskDue(history, { today, gapDays, hasDefiniteReply });
      if (!due.due) continue;


      // The channel is fixed for the whole cycle. Recomputing it per ask would move a
      // tenant from WhatsApp to email mid-sequence just because staff edited a phone
      // number, which the operator explicitly ruled out.
      const priorChannel = history.map(h => h.channel).find(Boolean);
      const channel = priorChannel || renewalAsk.renewalAskChannel(lease);
      if (!channel) { summary.unreachable += 1; continue; }
      if (channel === 'whatsapp' && !lease.tenant_phone) { summary.unreachable += 1; continue; }
      if (channel === 'email' && !lease.tenant_email) { summary.unreachable += 1; continue; }

      // No fallback to another ask's wording. If the operator has not written this one,
      // we do not put words in their mouth — the sequence ends here and a person takes
      // over, which is a truthful outcome rather than a silent stall.
      const template = settings[PHRASE_COLUMN[due.ask_number]];
      const message = renewalAsk.renderRenewalAsk(template,
        renewalAsk.renewalAskVars(lease, { defaultNoticeDays, today }));
      if (!message) {
        summary.no_wording += 1;
        // Only escalate a sequence that has actually started; an unwritten FIRST ask is
        // a configuration gap, not an unresponsive tenant.
        if (history.length) {
          const [esc] = await pool.execute(
            `UPDATE renewal_ask SET escalated_at = ?
              WHERE lease_id = ? AND lease_end_at_ask = ? AND decision_due_on = ? AND escalated_at IS NULL`,
            [orgWallClock(new Date()), lease.lease_id, cycle.lease_end_at_ask, cycle.decision_due_on]);
          if (esc && esc.affectedRows > 0 && typeof createNotification === 'function') {
            await createNotification(pool, {
              orgId, type: 'warning',
              title: `Ask ${due.ask_number} wording is not written — ${[lease.property_name, lease.unit_name].filter(Boolean).join(' ')} handed to staff`,
              link: '/chatbot/settings',
            });
            summary.escalated += 1;
          }
        }
        continue;
      }

      // Recorded BEFORE sending. The unique key on (lease, cycle, ask_number) is what
      // actually prevents a second message, so it has to exist before the send.
      //
      // Check and insert together, under the conversation lock: one open question per
      // conversation, so a tenant renting two units is never asked about both at once. The
      // check has to be inside the lock — done outside it, two runners both see a clear
      // conversation and both insert.
      const id = newId();
      const claim = await withConversationLock(
        pool, orgId, renewalAsk.conversationLockKey(lease),
        async (conn) => {
          const conflict = renewalAsk.conflictingOpenAsk(await openAsks(conn, orgId), lease);
          if (conflict) return { deferred: true };
          try {
            await conn.execute(
              `INSERT INTO renewal_ask
                 (id, org_id, lease_id, unit_id, tenant_id, lease_end_at_ask, decision_due_on,
                  state, message, triggered_by, contract_type_at_ask, ask_number, channel, attempts)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, 'schedule', ?, ?, ?, 1)`,
              [id, orgId, lease.lease_id, lease.unit_id, lease.tenant_id || null,
               cycle.lease_end_at_ask, cycle.decision_due_on, message,
               lease.contract_type, due.ask_number, channel]
            );
          } catch (e) {
            if (e && e.code === 'ER_DUP_ENTRY') return { duplicate: true };
            throw e;
          }
          return { inserted: true };
        });
      if (!claim.locked || claim.value?.deferred) {
        summary.deferred_conversation_busy += 1;
        continue;
      }
      if (claim.value?.duplicate) continue;   // another runner took this slot

      const sendResult = await deliver(pool, orgId, { channel, lease, message, askId: id });
      if (sendResult && sendResult.ok !== false) {
        await pool.execute(
          `UPDATE renewal_ask SET state = 'SENT', sent_at = ? WHERE id = ?`,
          [orgWallClock(new Date()), id]);
        summary.asked += 1;
      } else {
        await pool.execute(
          `UPDATE renewal_ask SET send_error = ? WHERE id = ?`,
          [String((sendResult && sendResult.error) || 'send failed').slice(0, 255), id]);
        summary.failed += 1;
      }
    } catch (err) {
      console.error(`[RenewalAsk] lease ${lease.lease_id}:`, err.message);
      summary.failed += 1;
    }
  }
  return summary;
}

// Exported so the demand-triggered route in routes/public.js sends through this exact
// function. Tenafy is the only sender of a renewal ask (operator decision, 2026-08-19);
// two senders is how a tenant gets messaged twice, or not at all.
module.exports = {
  runRenewalAsksForOrg, findRenewalCandidates, askHistory, openAsks, deliver,
  withConversationLock,
};
