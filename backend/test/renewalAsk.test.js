const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPLY_EXTEND, REPLY_LEAVING, REPLY_UNSURE,
  renewalDecisionDueOn,
  renewalAskEligibility,
  renewalAskCycleKey,
  classifyRenewalReply,
  applyRenewalReply,
  renderRenewalAsk,
} = require('../src/utils/renewalAsk');

// Fixed literals throughout: every function here takes `today` explicitly and never
// reads the clock, so these assertions compare two supplied dates against each other
// and cannot rot. See the header comment in vacancyFit.test.js for the rule.

test('renewalDecisionDueOn subtracts the notice period from the lease end', () => {
  assert.equal(renewalDecisionDueOn('2026-09-25', 45), '2026-08-11');
  assert.equal(renewalDecisionDueOn('2026-09-25', 30), '2026-08-26');
  assert.equal(renewalDecisionDueOn('2026-01-05', 30), '2025-12-06');   // crosses a year
  assert.equal(renewalDecisionDueOn('2026-03-01', 1), '2026-02-28');    // non-leap February
});

test('a missing notice period falls back to the default, but a zero is honoured', () => {
  // Number(null) is 0, so a naive check turns "no notice period recorded" into
  // "no notice required" and makes every undecided lease look due today.
  assert.equal(renewalDecisionDueOn('2026-09-25', null, 30), '2026-08-26');
  assert.equal(renewalDecisionDueOn('2026-09-25', undefined, 30), '2026-08-26');
  assert.equal(renewalDecisionDueOn('2026-09-25', '', 30), '2026-08-26');
  assert.equal(renewalDecisionDueOn('2026-09-25', '   ', 30), '2026-08-26');
  // Zero is a legitimate setting and must survive.
  assert.equal(renewalDecisionDueOn('2026-09-25', 0, 30), '2026-09-25');
});

test('renewalDecisionDueOn rejects junk rather than guessing', () => {
  assert.equal(renewalDecisionDueOn('2026-13-01', 30), null);
  assert.equal(renewalDecisionDueOn('2026-02-30', 30), null);
  assert.equal(renewalDecisionDueOn('not-a-date', 30), null);
  assert.equal(renewalDecisionDueOn(null, 30), null);
  assert.equal(renewalDecisionDueOn(new Date('2026-09-25'), 30), null);
});

test('eligibility opens on the decision date and not before', () => {
  const lease = { end_date: '2026-09-25', contract_type: 1, notice_period_days: 45 };
  // Due 2026-08-11.
  assert.equal(renewalAskEligibility(lease, { today: '2026-08-10' }).eligible, false);
  assert.equal(renewalAskEligibility(lease, { today: '2026-08-10' }).reason, 'too_early');
  assert.equal(renewalAskEligibility(lease, { today: '2026-08-11' }).eligible, true);  // inclusive
  assert.equal(renewalAskEligibility(lease, { today: '2026-09-01' }).eligible, true);
});

test('eligibility refuses leases that are decided, answered, or over', () => {
  const base = { end_date: '2026-09-25', notice_period_days: 45 };
  assert.equal(renewalAskEligibility({ ...base, contract_type: 3 }, { today: '2026-09-01' }).reason, 'already_decided');
  assert.equal(renewalAskEligibility({ ...base, contract_type: 2 }, { today: '2026-09-01' }).reason, 'already_decided');
  assert.equal(renewalAskEligibility({ ...base, contract_type: 4 }, { today: '2026-09-01' }).eligible, true);
  assert.equal(renewalAskEligibility({ ...base, contract_type: 1, renewal_reply: 1 }, { today: '2026-09-01' }).reason, 'already_replied');
  assert.equal(renewalAskEligibility({ end_date: '2026-07-01', contract_type: 1 }, { today: '2026-09-01' }).reason, 'lease_already_ended');
  assert.equal(renewalAskEligibility({ end_date: null, contract_type: 1 }, { today: '2026-09-01' }).reason, 'no_end_date');
});

test('the cycle key changes when the lease is extended, so a new ask is not suppressed', () => {
  const before = renewalAskCycleKey({ id: '7', end_date: '2026-09-25', notice_period_days: 45 }, { today: '2026-09-01' });
  const after = renewalAskCycleKey({ id: '7', end_date: '2027-09-25', notice_period_days: 45 }, { today: '2026-09-01' });
  assert.equal(before.lease_end_at_ask, '2026-09-25');
  assert.equal(after.lease_end_at_ask, '2027-09-25');
  assert.notEqual(before.decision_due_on, after.decision_due_on);
  // Correcting the notice period also opens a new cycle — same lease end, new due date.
  const corrected = renewalAskCycleKey({ id: '7', end_date: '2026-09-25', notice_period_days: 30 }, { today: '2026-09-01' });
  assert.notEqual(before.decision_due_on, corrected.decision_due_on);
});

test('reply classification is conservative — ambiguity is never a decision', () => {
  assert.equal(classifyRenewalReply('Yes, staying thanks'), REPLY_EXTEND);
  assert.equal(classifyRenewalReply('I want to renew'), REPLY_EXTEND);
  assert.equal(classifyRenewalReply('No, moving out'), REPLY_LEAVING);
  assert.equal(classifyRenewalReply('not renewing'), REPLY_LEAVING);
  assert.equal(classifyRenewalReply('I will not be staying'), REPLY_LEAVING);
  assert.equal(classifyRenewalReply("won't renew"), REPLY_LEAVING);
  assert.equal(classifyRenewalReply('let me think about it'), REPLY_UNSURE);
  assert.equal(classifyRenewalReply('yes but I might leave'), REPLY_UNSURE);   // both signals
  assert.equal(classifyRenewalReply(''), null);
  assert.equal(classifyRenewalReply(null), null);
});

const asked = { id: '7', end_date: '2026-09-25', contract_type: 1 };

test('"extend" withdraws the unit; "leaving" never makes it firmly available', () => {
  const extend = applyRenewalReply(REPLY_EXTEND, { askedLease: asked, currentLease: { ...asked } });
  assert.equal(extend.applied, true);
  assert.equal(extend.suppress, true, 'a tenant choosing Extend must take the unit off offer');

  // The asymmetry: this is the direction that would promise a customer a home the
  // tenant may never vacate, so it goes to a human instead of flipping the unit.
  const leaving = applyRenewalReply(REPLY_LEAVING, { askedLease: asked, currentLease: { ...asked } });
  assert.equal(leaving.applied, true);
  assert.equal(leaving.suppress, false);
  assert.equal(leaving.needs_staff, true);

  const unsure = applyRenewalReply(REPLY_UNSURE, { askedLease: asked, currentLease: { ...asked } });
  assert.equal(unsure.suppress, false);
  assert.equal(unsure.needs_staff, true);
});

test('a reply that arrives after the lease moved on is recorded but not acted on', () => {
  const extended = applyRenewalReply(REPLY_EXTEND, {
    askedLease: asked, currentLease: { ...asked, end_date: '2027-09-25' },
  });
  assert.equal(extended.applied, false);
  assert.equal(extended.suppress, false);
  assert.equal(extended.stale_reason, 'lease_end_changed');
  assert.equal(extended.needs_staff, true);

  const replaced = applyRenewalReply(REPLY_EXTEND, {
    askedLease: asked, currentLease: { ...asked, id: '9' },
  });
  assert.equal(replaced.stale_reason, 'lease_replaced');
  assert.equal(replaced.applied, false);

  const retyped = applyRenewalReply(REPLY_EXTEND, {
    askedLease: asked, currentLease: { ...asked, contract_type: 3 },
  });
  assert.equal(retyped.stale_reason, 'intent_changed_elsewhere');
  assert.equal(retyped.applied, false);

  // A vanished lease must not throw or silently apply.
  assert.equal(applyRenewalReply(REPLY_EXTEND, { askedLease: asked, currentLease: null }).valid, false);
  assert.equal(applyRenewalReply(99, { askedLease: asked, currentLease: { ...asked } }).valid, false);
});

test('the ask template fills known placeholders and leaves unknown ones alone', () => {
  const out = renderRenewalAsk(
    'Hi {tenant_name}, your lease at {unit} runs to {end_date}. Staying? {mystery}',
    { tenant_name: 'Wei', unit: "Gilman's Bazaar 2A", end_date: '2026-09-25' }
  );
  assert.equal(out, "Hi Wei, your lease at Gilman's Bazaar 2A runs to 2026-09-25. Staying? {mystery}");
  assert.equal(renderRenewalAsk(null, {}), null);
  assert.equal(renderRenewalAsk('   ', {}), null);
});

// ---------------------------------------------------------------------------
// Route-level. The pure tests above prove applyRenewalReply() CAN detect a stale
// reply; these prove the route actually hands it the values needed to do so. That
// gap is exactly where the first version of this feature was broken: the route
// re-derived contract_type from the current lease, so the comparison was against
// itself and a re-typed lease was silently acted on.
// ---------------------------------------------------------------------------
// A faked pool will happily hand back columns the query never asked for, so a route
// can read `row.foo` while the SELECT omits `foo` and the test still passes — which is
// exactly how a missing `unit_id`/`contract_type_at_ask` survived review here. Rows are
// therefore filtered to the columns the SQL actually names, so the fake enforces the
// same contract the database would.
function projectToSelectedColumns(sql, rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    const kept = {};
    for (const key of Object.keys(row)) {
      if (new RegExp(`\\b${key}\\b`).test(sql)) kept[key] = row[key];
    }
    return kept;
  });
}

function fakePool(handlers) {
  return {
    execute: async (sql, params) => {
      for (const [pattern, fn] of handlers) {
        if (pattern.test(sql)) {
          const out = fn(params, sql);
          return Array.isArray(out) && Array.isArray(out[0])
            ? [projectToSelectedColumns(sql, out[0]), out[1]]
            : out;
        }
      }
      throw new Error('unexpected SQL: ' + sql.slice(0, 90));
    },
    getConnection: async () => ({
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release: () => {},
      execute: async (sql, params) => {
        for (const [pattern, fn] of handlers) {
          if (pattern.test(sql)) return fn(params, sql);
        }
        throw new Error('unexpected SQL in txn: ' + sql.slice(0, 90));
      },
    }),
  };
}

function replyHandler() {
  delete require.cache[require.resolve('../src/routes/public')];
  const router = require('../src/routes/public');
  return router.stack
    .find(l => l.route?.path === '/renewal-ask/:id/reply' && l.route.methods.post)
    .route.stack.at(-1).handle;
}

function callReply(handler, { pool, id = '1', body }) {
  return new Promise((resolve, reject) => {
    const req = { params: { id }, body, pool, apiKey: { orgId: '9' }, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ statusCode: this.statusCode, body: b }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

test('an "extend" reply is applied when the lease is unchanged', async () => {
  const writes = [];
  const pool = fakePool([
    [/FROM renewal_ask WHERE id/, () => [[{ id: '1', lease_id: '7', unit_id: '5', state: 'SENT', applied: 0, contract_type_at_ask: 1, lease_end_at_ask: '2026-09-25' }]]],
    [/FROM leasing WHERE id/, () => [[{ id: '7', contract_type: 1, end_date: '2026-09-25' }]]],
    [/FROM leasing WHERE unit_id/, () => [[{ id: '7', contract_type: 1, end_date: '2026-09-25' }]]],
    [/UPDATE renewal_ask/, (p) => { writes.push(['ask', p]); return [{ affectedRows: 1 }]; }],
    [/UPDATE leasing SET renewal_reply/, (p) => { writes.push(['lease', p]); return [{ affectedRows: 1 }]; }],
  ]);
  const result = await callReply(replyHandler(), { pool, body: { intent: 'extend' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.applied, true);
  assert.equal(result.body.data.withdrawn_from_offers, true);
  assert.ok(writes.some(w => w[0] === 'lease'), 'the lease must be stamped so the feed suppresses it');
});

test('an "extend" reply on a lease re-typed since the ask is recorded but not acted on', async () => {
  const writes = [];
  const pool = fakePool([
    // Asked while the lease was MR (1)…
    [/FROM renewal_ask WHERE id/, () => [[{ id: '1', lease_id: '7', unit_id: '5', state: 'SENT', applied: 0, contract_type_at_ask: 1, lease_end_at_ask: '2026-09-25' }]]],
    // …but staff have since set it to NR (3).
    [/FROM leasing WHERE id/, () => [[{ id: '7', contract_type: 3, end_date: '2026-09-25' }]]],
    [/FROM leasing WHERE unit_id/, () => [[{ id: '7', contract_type: 3, end_date: '2026-09-25' }]]],
    [/UPDATE renewal_ask/, (p) => { writes.push(['ask', p]); return [{ affectedRows: 1 }]; }],
    [/UPDATE leasing SET renewal_reply/, (p) => { writes.push(['lease', p]); return [{ affectedRows: 1 }]; }],
  ]);
  const result = await callReply(replyHandler(), { pool, body: { intent: 'extend' } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.applied, false, 'a reply about a lease that has moved on must not be applied');
  assert.equal(result.body.data.stale_reason, 'intent_changed_elsewhere');
  assert.equal(result.body.data.withdrawn_from_offers, false);
  assert.ok(writes.some(w => w[0] === 'ask'), 'the reply is still recorded');
  assert.ok(!writes.some(w => w[0] === 'lease'), 'but the lease must not be stamped');
});

test('a reply whose lease has been deleted is recorded rather than rejected', async () => {
  const writes = [];
  const pool = fakePool([
    [/FROM renewal_ask WHERE id/, () => [[{ id: '1', lease_id: '7', unit_id: '5', state: 'SENT', applied: 0, contract_type_at_ask: 1, lease_end_at_ask: '2026-09-25' }]]],
    [/FROM leasing WHERE id/, () => [[undefined]]],
    [/FROM leasing WHERE unit_id/, () => [[undefined]]],
    [/UPDATE renewal_ask/, (p) => { writes.push(['ask', p]); return [{ affectedRows: 1 }]; }],
    [/UPDATE leasing SET renewal_reply/, (p) => { writes.push(['lease', p]); return [{ affectedRows: 1 }]; }],
  ]);
  const result = await callReply(replyHandler(), { pool, body: { intent: 'extend' } });
  assert.equal(result.statusCode, 200, 'a tenant who answered must never get an error swallowing their reply');
  assert.equal(result.body.data.applied, false);
  assert.equal(result.body.data.stale_reason, 'lease_gone');
  assert.ok(writes.some(w => w[0] === 'ask'));
  assert.ok(!writes.some(w => w[0] === 'lease'));
});

// ── A vague answer may be corrected; a real one is final ──────────────────────
//
// The relay cannot distinguish a tenant's answer from an unrelated message, and refuses to
// guess. So an ask that lands mid-conversation gets whatever the tenant says next filed
// against it — "ok thanks" becomes `unsure`. Before this rule the real answer that followed
// was discarded with a 200, and nobody could tell.

function repliedAsk(intent, text) {
  return {
    id: '1', lease_id: '7', unit_id: '5', state: 'REPLIED', applied: 1,
    contract_type_at_ask: 1, lease_end_at_ask: '2026-09-25',
    reply_intent: intent, reply_text: text, replied_at: '2026-08-19 09:00:00',
  };
}

function upgradePool(ask, writes) {
  return fakePool([
    [/FROM renewal_ask WHERE id/, () => [[ask]]],
    [/FROM leasing WHERE id/, () => [[{ id: '7', contract_type: 1, end_date: '2026-09-25' }]]],
    [/FROM leasing WHERE unit_id/, () => [[{ id: '7', contract_type: 1, end_date: '2026-09-25' }]]],
    [/UPDATE renewal_ask/, (p) => { writes.push(['ask', p]); return [{ affectedRows: 1 }]; }],
    [/UPDATE leasing SET renewal_reply/, (p) => { writes.push(['lease', p]); return [{ affectedRows: 1 }]; }],
  ]);
}

test('a real answer supersedes a vague one, and the vague one is kept', async () => {
  const writes = [];
  const result = await callReply(replyHandler(), {
    pool: upgradePool(repliedAsk(3, 'ok thanks'), writes),
    body: { intent: 'extend' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.already_replied, false, 'the real answer must not be discarded');
  assert.equal(result.body.data.intent, 'extend');
  assert.equal(result.body.data.applied, true);
  assert.equal(result.body.data.withdrawn_from_offers, true, 'the unit must leave the feeds');
  assert.equal(result.body.data.superseded, 'unsure');

  const askWrite = writes.find(w => w[0] === 'ask');
  assert.ok(askWrite, 'the upgraded reply must be written');
  // Params: now, intent, text, applied, stale_reason, recordedBy, prior_intent, prior_text, prior_at, id
  assert.equal(askWrite[1][6], 3, 'the superseded intent must be preserved');
  assert.equal(askWrite[1][7], 'ok thanks', 'the superseded text must be preserved');
  assert.ok(writes.some(w => w[0] === 'lease'), 'and the lease is stamped');
});

test('a definite answer is final — a later message cannot overwrite it', async () => {
  // The dangerous direction. A tenant who said "we are staying" has had their home taken
  // off the market; a stray later message must never put it back.
  for (const laterIntent of ['leaving', 'unsure', 'extend']) {
    const writes = [];
    const result = await callReply(replyHandler(), {
      pool: upgradePool(repliedAsk(1, "yes we're staying"), writes),
      body: { intent: laterIntent },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.already_replied, true, `"${laterIntent}" must not overwrite a definite answer`);
    assert.equal(result.body.data.intent, 'extend', 'the original answer is what is reported back');
    assert.equal(writes.length, 0, 'nothing may be written');
  }
});

test('a second vague message changes nothing and does not overwrite the first', async () => {
  const writes = [];
  const result = await callReply(replyHandler(), {
    pool: upgradePool(repliedAsk(3, 'ok thanks'), writes),
    body: { text: 'sure' },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.already_replied, true);
  assert.equal(result.body.data.superseded, false);
  assert.equal(writes.length, 0, 'a vague answer repeated is not new information');
});

test('an unsure lease is still eligible for the next ask', () => {
  const { renewalAskEligibility } = require('../src/utils/renewalAsk');
  const base = { end_date: '2026-09-25', contract_type: 1, notice_period_days: 45 };
  const opts = { today: '2026-08-19' };
  assert.equal(renewalAskEligibility({ ...base, renewal_reply: null }, opts).eligible, true);
  assert.equal(renewalAskEligibility({ ...base, renewal_reply: 3 }, opts).eligible, true,
    'unsure is not an answer — the remaining asks still have work to do');
  assert.equal(renewalAskEligibility({ ...base, renewal_reply: '3' }, opts).eligible, true,
    'mysql2 may hand back a string');
  for (const answered of [1, 2, '1', '2']) {
    assert.equal(renewalAskEligibility({ ...base, renewal_reply: answered }, opts).eligible, false,
      `a tenant who answered ${answered} must not be asked again`);
  }
});
