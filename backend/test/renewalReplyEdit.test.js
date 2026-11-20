const test = require('node:test');
const assert = require('node:assert/strict');

test('completed renewal cycles never supply the current Vacancy action', async () => {
  const {currentRenewalAsks, renewalAskForRow}=await import('../../frontend/src/lib/renewalStatus.mjs');
  const old={lease_id:'100',settled:true,reply:'extend',reply_applied:true,status:'extend_pending_paperwork'};
  const current={lease_id:'101',settled:false,reply:null,status:'awaiting_reply'};
  const asks=currentRenewalAsks([old,current]);
  assert.equal(asks.has('100'),false);
  assert.equal(asks.get('101'),current);
  assert.equal(renewalAskForRow({renewal_reply:2},old),null);
});

test('an applied answer no longer on the lease is a stale history warning, not paperwork due', async () => {
  const {renewalAskForRow}=await import('../../frontend/src/lib/renewalStatus.mjs');
  const ask={settled:false,reply:'extend',reply_applied:true,status:'extend_pending_paperwork'};
  assert.equal(renewalAskForRow({renewal_reply:1},ask),ask,'current genuine extension still visible');
  assert.equal(renewalAskForRow({renewal_reply:null},ask).status,'replied_but_stale_check_lease');
  assert.equal(renewalAskForRow({renewal_reply:2},ask).status,'replied_but_stale_check_lease');
  assert.equal(ask.status,'extend_pending_paperwork','historical input not mutated');
});
