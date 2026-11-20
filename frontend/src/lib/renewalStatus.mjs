// Completed renewal cycles remain in history, never in the current action label.
export function currentRenewalAsks(asks) {
  return new Map(asks.filter(a => !a.settled).map(a => [String(a.lease_id), a]));
}

export function renewalAskForRow(row, ask) {
  if (!ask || ask.settled) return null;
  const code = { extend: 1, leaving: 2, unsure: 3 }[ask.reply];
  if (ask.reply_applied && [1, 2].includes(code) && Number(row.renewal_reply) !== code) {
    return { ...ask, status: 'replied_but_stale_check_lease', reply_stale_reason: 'lease_reply_changed' };
  }
  return ask;
}
