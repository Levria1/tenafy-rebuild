/**
 * Activity logging utility.
 *
 * Usage: await logActivity(req, 'CREATE', 'lease', leaseId, 'Created lease LEA1234');
 *   or:  await logActivity(req, { action: 'CREATE', entityType: 'INQUIRY', entityId: id });
 *
 * WHY BOTH SHAPES
 *
 * Twelve call sites in inquiry.js, leaseTemplate.js and signature.js were written
 * against the object form, which this function did not accept. `action` bound to
 * the object and `entityType` to undefined, so every one of those inserts violated
 * a NOT NULL constraint and was swallowed by the catch below. There has never been
 * an INQUIRY, LEASE_TEMPLATE or SIGNATURE_REQUEST row in activity_log. Accepting
 * both shapes fixes all twelve without editing them, and stops the next person
 * guessing wrong.
 *
 * WHY FAILURES ARE LOUD NOW
 *
 * A dropped audit row used to print "Activity log error: <message>" and nothing
 * else — not the action, not the entity, not which record went unrecorded. That is
 * unreadable at a glance and indistinguishable from noise, which is how an enum
 * rejecting ten of the thirteen action values went unnoticed through a whole
 * session of building audit logging on top of it. The prefix below is searchable
 * and the line carries enough to identify what was lost.
 */

// The canonical action list. Must match the enum in
// migrations-org/081_activity_log_action_values.sql exactly — a test fails if they
// drift, or if a call site introduces a value that is in neither.
const ACTIONS = [
  'CREATE', 'UPDATE', 'DELETE',
  'CONFIRM', 'CANCEL', 'MOVE_OUT',
  'EMAIL', 'RESEND', 'PUBLISH',
  'RESTORE', 'WRITE_OFF', 'LINK_CONTACT', 'DUPLICATE', 'MERGE',
];

// Column widths from the activity_log schema. A description longer than the column
// is another silent way to lose the whole row: MySQL in strict mode rejects the
// insert rather than storing a shortened one. Trimming here keeps the audit entry
// and loses only the tail of its prose.
const MAX_DESCRIPTION = 500;
const MAX_ENTITY_TYPE = 50;
const MAX_ENTITY_ID = 50;

// VARCHAR(50) counts CHARACTERS, while String.slice counts UTF-16 code units.
// Slicing is therefore never too long, but it can cut an emoji in half and store
// a lone surrogate. Array.from iterates code points, so a trim lands on a
// character boundary.
function trim(value, limit) {
  if (value == null) return null;
  const s = String(value);
  if (s.length <= limit) return s;
  return Array.from(s).slice(0, limit).join('');
}

// The error path must not throw. `details` can be circular, and a caller can put
// anything in `action`.
function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return '[unserialisable]'; }
}

async function logActivity(req, action, entityType, entityId, description, details = null) {
  let opts = null;
  if (action && typeof action === 'object') {
    opts = action;
    action      = opts.action;
    entityType  = opts.entityType  !== undefined ? opts.entityType  : opts.entity_type;
    entityId    = opts.entityId    !== undefined ? opts.entityId    : opts.entity_id;
    description = opts.description;
    details     = opts.details !== undefined ? opts.details : null;
  }

  try {
    const pool = req?.pool;
    const orgId = req?.user?.orgId;
    const userId = req?.user?.id;
    const username = req?.user?.username || null;
    const ip = req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || null;

    // user_id is NOT NULL, so an action with no signed-in user cannot be recorded
    // at all. Silent by design: public and unauthenticated routes would otherwise
    // fill the log with lines nobody can act on.
    if (!pool || !orgId || !userId) return;

    // entity_type is NOT NULL. Passing null would fail the insert inside the catch
    // below, which is the same silent loss this rewrite exists to end.
    if (entityType == null || String(entityType) === '') {
      console.error('AUDIT ROW LOST — missing entityType', safeJson({
        action, entityId: entityId ? String(entityId) : null,
      }));
      return;
    }

    if (!ACTIONS.includes(action)) {
      // The insert would be rejected by the enum. Say which value and which record,
      // because "Data truncated for column 'action'" identifies neither.
      console.error('AUDIT ROW LOST — unknown action', safeJson({
        action, entityType, entityId: entityId ? String(entityId) : null,
      }), '— add it to ACTIONS and to the activity_log enum');
      return;
    }

    await pool.execute(
      `INSERT INTO activity_log (org_id, user_id, username, action, entity_type, entity_id, description, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orgId, userId, username, action,
       trim(entityType, MAX_ENTITY_TYPE),
       entityId == null ? null : trim(entityId, MAX_ENTITY_ID),
       description == null ? null : trim(description, MAX_DESCRIPTION),
       details == null ? null : JSON.stringify(details), ip]
    );
  } catch (err) {
    // Never let logging errors break the actual request — but never let one pass
    // as an anonymous line either.
    console.error('AUDIT ROW LOST — activity_log insert failed', safeJson({
      action, entityType, entityId: entityId ? String(entityId) : null, error: err.message,
    }));
  }
}

module.exports = { logActivity, ACTIONS };
