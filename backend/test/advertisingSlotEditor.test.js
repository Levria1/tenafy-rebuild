const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { slotProblem } = require('../src/utils/advertisingPlan');

// tane.joanne@gmail.com was lost and had 9 weekly slots. Deleting it made those
// slots vanish from the Posting Sheet (its query joins live accounts only) and
// the app had no way to give a slot to another account. Two slots in a deleted
// group had already gone unnoticed the same way.

test('slotProblem names why the daily plan would skip a slot', () => {
  assert.equal(slotProblem({ forum_live: true, account_live: true, is_member: true }), null);
  assert.equal(slotProblem({ forum_live: false, account_live: true, is_member: true }), 'Group removed');
  assert.equal(slotProblem({ forum_live: true, account_live: false, is_member: false }), 'Account removed');
  assert.equal(slotProblem({ forum_live: true, account_live: true, is_member: false }), 'Account is not a member of this group');
  assert.equal(slotProblem(null), 'Group removed');
});

const SHEET = [
  { id: '1', weekday: 1, slot_kind: 'prop', slot_no: 1, position: 1, forum_id: 'F1', forum_name: 'Find A Room',
    url: null, is_owned: 0, forum_live: 1, account_id: 'A1', account_name: null, account_email: 'ok@x.com', account_live: 1, is_member: 1 },
  { id: '2', weekday: 1, slot_kind: 'prop', slot_no: 6, position: 2, forum_id: 'F1', forum_name: 'Find A Room',
    url: null, is_owned: 0, forum_live: 1, account_id: 'J', account_name: null, account_email: 'lost@x.com', account_live: 0, is_member: 0 },
  { id: '3', weekday: 6, slot_kind: 'prop', slot_no: 9, position: 1, forum_id: 'F9', forum_name: 'Deleted group',
    url: null, is_owned: 0, forum_live: 0, account_id: 'A1', account_name: null, account_email: 'ok@x.com', account_live: 1, is_member: 0 },
];

const pool = {
  async execute(sql) {
    if (/AS forum_live/.test(sql)) return [SHEET];
    // loadForumsWithAccounts: one live group with one member.
    if (/LEFT JOIN advertising_forum_account fa/.test(sql)) {
      return [[{ forum_id: 'F1', forum_name: 'Find A Room', url: null, is_owned: 0, max_per_week: null, account_id: 'A1', account_email: 'ok@x.com' }]];
    }
    // loadScheduleRows (healthy slots only).
    if (/FROM advertising_schedule s\s+JOIN advertising_forum f/.test(sql)) return [[]];
    return [[]];
  },
};

function loadRouter() {
  const id = require.resolve('../src/middleware/auth');
  require.cache[id] = { id, filename: id, loaded: true, exports: {
    authenticate: (req, res, next) => { req.user = { orgId: 'org1' }; req.pool = pool; next(); },
    requirePermission: () => (req, res, next) => next(),
  } };
  delete require.cache[require.resolve('../src/routes/advertising')];
  return require('../src/routes/advertising');
}

test('the Posting Sheet lists slots the plan skips, with the reason, and the groups to pick from', async () => {
  const app = express();
  app.use('/api/advertising', loadRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/advertising/schedule`);
    const { data } = await r.json();
    assert.equal(r.status, 200);
    const mon = data.days.find(d => d.weekday === 1).slots;
    assert.deepEqual(mon.map(s => [s.id, s.problem]), [['1', null], ['2', 'Account removed']]);
    assert.equal(mon[1].account.email, 'lost@x.com');
    const sat = data.days.find(d => d.weekday === 6).slots;
    assert.deepEqual(sat.map(s => [s.id, s.slot_label, s.problem]), [['3', 'Prop 9', 'Group removed']]);
    assert.deepEqual(data.forums, [{ forum_id: 'F1', forum_name: 'Find A Room', is_owned: 0, accounts: [{ id: 'A1', email: 'ok@x.com' }] }]);
  } finally { server.close(); }
});
