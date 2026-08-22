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
/**
 * Capture a message the relay believes is an answer but cannot attribute safely —
 * a group thread, a forward, wording that only reads as an answer if you saw the
 * message before it.
 *
 * Records the words, holds the ask sequence, changes NOTHING about the lease, and
 * raises it for a human. Deliberately not an intent: the alternatives available to
 * a relay without this are to send something it does not believe, or to say nothing
 * and let the tenant be asked again having already answered. Both are worse.
 *
 * Writes to its own columns. reply_intent/reply_text are the answer of record, and a
 * value nobody trusts must never be able to masquerade as one.
 */
async function recordUnverifiedReply(pool, orgId, askId, { text, recordedBy = 'partner' } = {}) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) return { status: 400, body: { message: 'text is required for an unverified reply' } };

  const [[ask]] = await pool.execute(
    `SELECT id, state, reply_intent FROM renewal_ask WHERE id = ? AND org_id = ? LIMIT 1`,
    [askId, orgId]
  );
  if (!ask) return { status: 404, body: { message: 'Renewal ask not found' } };

  // A definite answer already stands. An uncertain message arriving afterwards is
  // noise against a settled question and must not reopen or hold it.
  if (renewalAsk.isDefiniteReply(ask.reply_intent)) {
    return {
      status: 200,
      body: {
        recorded: false, already_replied: true, acted: false, held: false,
        intent: INTENT_NAME[Number(ask.reply_intent)] || null,
      },
    };
  }

  const now = orgWallClock(new Date());
  await pool.execute(
    `UPDATE renewal_ask SET unverified_at = ?, unverified_text = ?, unverified_by = ? WHERE id = ?`,
    [now, body.slice(0, 2000), String(recordedBy).slice(0, 32), ask.id]
  );

  return {
    status: 200,
    body: {
      recorded: true,
      // Said plainly so a caller cannot read this as a reply that took effect.
      acted: false,
      held: true,
      hold_days: renewalAsk.UNVERIFIED_HOLD_DAYS,
      needs_staff: true,
      recorded_by: recordedBy,
      as_of: orgToday(),
    },
  };
}

async function recordRenewalReply(pool, orgId, askId, { intent, text, recordedBy = 'partner', verified = true } = {}) {
  if (verified === false) {
    return recordUnverifiedReply(pool, orgId, askId, { text, recordedBy });
  }
  const resolved = resolveIntent({ intent, text });
  if (resolved.error === 'bad_intent') {
    return { status: 400, body: { message: 'intent must be one of: extend, leaving, unsure' } };
  }
  if (resolved.error === 'no_input') {
    return { status: 400, body: { message: 'Send either intent or a non-empty text' } };
  }
  const code = resolved.intent;

  const [[ask]] = await pool.execute(
    `SELECT id, lease_id, unit_id, state, applied, contract_type_at_ask, reply_intent, reply_text,
            replied_at,
            DATE_FORMAT(lease_end_at_ask, '%Y-%m-%d') AS lease_end_at_ask
       FROM renewal_ask WHERE id = ? AND org_id = ? LIMIT 1`,
    [askId, orgId]
  );
  if (!ask) return { status: 404, body: { message: 'Renewal ask not found' } };

  // Already answered? A VAGUE answer may still be superseded by a real one; a real one is
  // final. The relay cannot distinguish a tenant's answer from an unrelated message, so
  // an ask landing mid-conversation gets "ok thanks" filed against it and classified
  // `unsure`. Refusing the real answer that follows is the one outcome ruled out — see
  // migration 069 for why the reverse is impossible.
  const upgrading = ask.state === 'REPLIED' && !renewalAsk.isDefiniteReply(ask.reply_intent);
  if (ask.state === 'REPLIED' && !upgrading) {
    return {
      status: 200,
      body: {
        recorded: true, already_replied: true, applied: Number(ask.applied) === 1,
        intent: INTENT_NAME[Number(ask.reply_intent)] || null,
      },
    };
  }
  // A vague reply repeated is not an upgrade — it changes nothing and must not overwrite
  // the text we already filed.
  if (upgrading && !renewalAsk.isDefiniteReply(code)) {
    return {
      status: 200,
      body: {
        recorded: true, already_replied: true, applied: Number(ask.applied) === 1,
        intent: INTENT_NAME[Number(ask.reply_intent)] || null, superseded: false,
      },
    };
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
  // Set false if the lease refuses the write; the response must not overstate what happened.
  let appliedToLease = decision.applied;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // COMPARE-AND-SET, not a blind write. The row above was read outside this transaction,
    // so two replies arriving together would both have seen the same state and the second
    // would silently overwrite the first. The guard makes the decision the DATABASE's: a
    // row that is already REPLIED may only be touched while its answer is still `unsure`.
    // Losing the race therefore reports already_replied rather than overwriting a tenant's
    // "we're staying" — which is the write that would put a home back on the market.
    const [upd] = await conn.execute(
      `UPDATE renewal_ask
          SET state = 'REPLIED', replied_at = ?, reply_intent = ?, reply_text = ?,
              applied = ?, stale_reason = ?, triggered_by = COALESCE(triggered_by, ?),
              -- Keep the superseded reply rather than overwrite it: the tenant sent it,
              -- and staff reading this row need to see what we originally filed. COALESCE
              -- so a second upgrade could never erase the first record.
              prior_reply_intent = COALESCE(prior_reply_intent, ?),
              prior_reply_text   = COALESCE(prior_reply_text, ?),
              prior_replied_at   = COALESCE(prior_replied_at, ?)
        WHERE id = ? AND (state <> 'REPLIED' OR reply_intent = ?)`,
      [now, code, typeof text === 'string' ? text : null, decision.applied ? 1 : 0,
       decision.stale_reason || null, recordedBy,
       upgrading ? ask.reply_intent : null,
       upgrading ? ask.reply_text : null,
       upgrading ? ask.replied_at : null,
       ask.id, renewalAsk.REPLY_UNSURE]
    );
    if (!upd || upd.affectedRows === 0) {
      // Another reply won. Report what actually stands rather than what we tried to write.
      await conn.rollback();
      const [[current]] = await pool.execute(
        `SELECT reply_intent, applied FROM renewal_ask WHERE id = ? LIMIT 1`, [ask.id]);
      return {
        status: 200,
        body: {
          recorded: true, already_replied: true, superseded: false,
          intent: current ? INTENT_NAME[Number(current.reply_intent)] || null : null,
          applied: current ? Number(current.applied) === 1 : false,
        },
      };
    }
    if (decision.applied) {
      // Same asymmetry on the lease: a definite decision already recorded there is never
      // overwritten. NULL or unsure (3) may be.
      const [leaseUpd] = await conn.execute(
        `UPDATE leasing SET renewal_reply = ?, renewal_reply_at = ?
          WHERE id = ? AND (renewal_reply IS NULL OR renewal_reply = ? OR ? = renewal_reply)`,
        [code, now, ask.lease_id, renewalAsk.REPLY_UNSURE, code]
      );
      // The guard rejected it: a DIFFERENT definite decision is already on the lease, put
      // there by another cycle or by staff. The ask row must not then claim `applied` — that
      // would leave the audit trail saying we acted on this answer while the lease records
      // the opposite, and the API would tell the partner their relay had taken effect. Record
      // it as unapplied with a reason instead, which is what a human needs to see.
      if (!leaseUpd || leaseUpd.affectedRows === 0) {
        appliedToLease = false;
        await conn.execute(
          `UPDATE renewal_ask SET applied = 0, stale_reason = 'lease_decided_elsewhere' WHERE id = ?`,
          [ask.id]
        );
      }
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
      // True when this replaced a vague answer we had already filed.
      superseded: upgrading ? INTENT_NAME[Number(ask.reply_intent)] || 'unsure' : null,
      intent: INTENT_NAME[code],
      applied: appliedToLease,
      stale_reason: decision.stale_reason || (appliedToLease ? null : 'lease_decided_elsewhere'),
      // True only for "extend": the unit leaves customer-facing feeds at once. It stays
      // on the staff Vacancy page, where the lease extension is now outstanding work. Not
      // claimed when the lease refused the write — nothing was withdrawn in that case.
      withdrawn_from_offers: !!decision.suppress && appliedToLease,
      needs_staff: !!decision.needs_staff || !appliedToLease,
      recorded_by: recordedBy,
      as_of: orgToday(),
    },
  };
}

module.exports = { recordRenewalReply, recordUnverifiedReply, INTENTS, INTENT_NAME };
