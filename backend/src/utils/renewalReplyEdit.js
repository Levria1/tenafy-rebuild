const { parseContractType } = require('./contractType');
const { orgTimeSql } = require('./orgTime');

// These assignments MUST precede edits to end_date/unit_id/tenant_id/contract_type:
// MySQL single-table UPDATE evaluates assignments left to right. Compare against
// the row being edited atomically, rather than an earlier read that can go stale.
// Historical renewal_ask rows are intentionally untouched.
function renewalReplyEdit(changes = {}) {
  const period = [], periodParams = [];
  for (const key of ['end_date', 'unit_id', 'tenant_id']) {
    if (changes[key] === undefined) continue;
    period.push(`NOT (${key} <=> ?)`);
    periodParams.push(key === 'end_date' ? changes[key] || null : changes[key]);
  }
  let intent = null;
  if (changes.contract_type !== undefined) {
    intent = parseContractType(changes.contract_type);
    if (intent == null) throw new Error('A valid contract type is required before reconciling renewal reply.');
  }
  if (!period.length && intent == null) return { fields: [], params: [] };
  const periodCondition = period.length ? '(' + period.join(' OR ') + ')' : 'FALSE';
  const intentCondition = intent == null ? 'FALSE'
    : `(NOT (contract_type <=> ?)${intent === 3 ? ' OR renewal_reply = 1' : ''})`;
  const conditions = [...periodParams, ...(intent == null ? [] : [intent])];
  const time = intent === 3 ? orgTimeSql('NOW()') : 'NULL';
  const reply = intent === 3 ? '2' : 'NULL';
  return {
    fields: [
      `renewal_reply_at = CASE WHEN ${periodCondition} THEN NULL WHEN ${intentCondition} THEN ${time} ELSE renewal_reply_at END`,
      `renewal_reply = CASE WHEN ${periodCondition} THEN NULL WHEN ${intentCondition} THEN ${reply} ELSE renewal_reply END`,
    ],
    params: [...conditions, ...conditions],
  };
}
module.exports = { renewalReplyEdit };
