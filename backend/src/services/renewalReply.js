/**
 * Recording a tenant's renewal answer — shared by BOTH entry points.
 *
 * Two callers exist: TaneChat relaying what the tenant sent, and staff entering an answer
 * they saw themselves. They must behave identically — the same staleness checks, the same
 * suppression, the same audit — because a rule enforced on one path and not the other is
 * not a rule. Hence one function rather than two similar route bodies.
 *
 * The asymmetry lives here: "extend" withdraws the unit from customer-facing feeds
 * automatically; "leaving" and "unsure" are recorded and left for a human. Evidence good
 * enough to stop us selling is not good enough to let us sell.
 */

const { orgToday, orgWallClock } = require('../utils/orgTime');
const renewalAsk = require('./../utils/renewalAsk');

const INTENTS = { extend: 1, staying: 1, leaving: 2, unsure: 3 };
const INTENT_NAME = { 1: 'extend', 2: 'leaving', 3: 'unsure' };

function resolveIntent({ intent, text }) {
  if (intent !== undefined && intent !== null && intent !== '') {
    const mapped = typeof intent === 'number' ? intent : INTENTS[String(intent).toLowerCase()];
    return mapped === undefined ? { error: 'bad_intent' } : { intent: mapped };
  }
  const classified = renewalAsk.classifyRenewalReply(typeof text === 'string' ? text : null);
  return classified == null ? { error: 'no_input' } : { intent: classified };
}

/**
 * @returns {{status:number, body:object}} shaped for either route to return directly.
 */
async function recordRenewalReply(pool, orgId, askId, { intent, text, recordedBy = 'partner' } = {}) {
  const resolved = resolveIntent({ intent, text });
  if (resolved.error === 'bad_intent') {
    return { status: 400, body: { message: 'intent must be one of: extend, leaving, unsure' } };
  }
  if (resolved.error === 'no_input') {
    return { status: 400, body: { message: 'Send either intent or a non-empty text' } };
  }
  const code = resolved.intent;

  const [[ask]] = await pool.execute(
    `SELECT id, lease_id, unit_id, state, applied, contract_type_at_ask,
            DATE_FORMAT(lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask
       FROM renewal_ask WHERE id = ? AND org_id = ? LIMIT 1`,
    [askId, orgId]
  );
  if (!ask) return { status: 404, body: { message: 'Renewal ask not found' } };
  if (ask.state === 'REPLIED') {
    return { status: 200, body: { recorded: true, already_replied: true, applied: Number(ask.applied) === 1 } };
  }

  const [[askedNow]] = await pool.execute(
    `SELECT id, contract_type, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
       FROM leasing WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [ask.lease_id]);
  const [[latestForUnit]] = await pool.execute(
    `SELECT id, contract_type, DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date
       FROM leasing WHERE unit_id = ? AND deleted_at IS NULL AND end_date IS NOT NULL
      ORDER BY end_date DESC, id DESC LIMIT 1`, [ask.unit_id]);

  // The lease AS WE ASKED (snapshotted at creation) against the lease as it is now.
  const askedLease = {
    id: ask.lease_id,
    end_date: ask.lease_end_at_ask,
    contract_type: ask.contract_type_at_ask,
  };
  const currentLease = askedNow || latestForUnit || null;

  // A reply is always RECORDED even when it cannot be acted on: a tenant took the trouble
  // to answer, and dropping that silently is the one outcome ruled out.
  const decision = currentLease
    ? renewalAsk.applyRenewalReply(code, { askedLease, currentLease })
    : { valid: true, applied: false, stale_reason: 'lease_gone', suppress: false, needs_staff: true, intent: code };
  if (!decision.valid) {
    return { status: 400, body: { message: 'Could not apply reply: ' + decision.reason } };
  }

  const now = orgWallClock(new Date());
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE renewal_ask
          SET state = 'REPLIED', replied_at = ?, reply_intent = ?, reply_text = ?,
              applied = ?, stale_reason = ?, triggered_by = COALESCE(triggered_by, ?)
        WHERE id = ?`,
      [now, code, typeof text === 'string' ? text : null, decision.applied ? 1 : 0,
       decision.stale_reason || null, recordedBy, ask.id]
    );
    if (decision.applied) {
      await conn.execute(
        `UPDATE leasing SET renewal_reply = ?, renewal_reply_at = ? WHERE id = ?`,
        [code, now, ask.lease_id]
      );
    }
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally { conn.release(); }

  return {
    status: 200,
    body: {
      recorded: true,
      already_replied: false,
      intent: INTENT_NAME[code],
      applied: decision.applied,
      stale_reason: decision.stale_reason || null,
      // True only for "extend": the unit leaves customer-facing feeds at once. It stays
      // on the staff Vacancy page, where the lease extension is now outstanding work.
      withdrawn_from_offers: !!decision.suppress,
      needs_staff: !!decision.needs_staff,
      recorded_by: recordedBy,
      as_of: orgToday(),
    },
  };
}

module.exports = { recordRenewalReply, INTENTS, INTENT_NAME };
