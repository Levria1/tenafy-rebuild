const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalModuleLoad = Module._load;
Module._load = function patchedModuleLoad(request, parent, isMain) {
  if (request === 'googleapis') {
    return {
      google: {
        auth: { GoogleAuth: class GoogleAuth {} },
        calendar: () => ({ events: {} }),
      },
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const {
  composeStep,
  DRAFT_FRESH_MINUTES,
} = require('../src/services/viewingNegotiationLogic');

const viewingNegotiation = require('../src/services/viewingNegotiation');

test('composeStep maps RESOLVE_UNIT with candidates to choose-unit prospect draft', () => {
  assert.deepEqual(composeStep({ state: 'RESOLVE_UNIT', awaiting: 'prospect', hasCandidates: true }), {
    templateType: 'Viewing-Choose-Unit',
    party: 'prospect',
  });
});

test('composeStep maps RESOLVE_UNIT without candidates to unit-not-found prospect draft', () => {
  assert.deepEqual(composeStep({ state: 'RESOLVE_UNIT', awaiting: 'prospect', hasCandidates: false }), {
    templateType: 'Viewing-Unit-NotFound',
    party: 'prospect',
  });
});

test('composeStep maps CONFIRM_UNIT with pending unit to confirm-unit prospect draft', () => {
  assert.deepEqual(composeStep({ state: 'CONFIRM_UNIT', awaiting: 'prospect', hasPendingUnit: true }), {
    templateType: 'Viewing-Confirm-Unit',
    party: 'prospect',
  });
});

test('composeStep returns null for CONFIRM_UNIT without pending unit', () => {
  assert.equal(composeStep({ state: 'CONFIRM_UNIT', awaiting: 'prospect', hasPendingUnit: false }), null);
});

test('composeStep maps prospect-facing active states', () => {
  assert.deepEqual(composeStep({ state: 'ASK_PROSPECT_DAY', awaiting: 'prospect' }), {
    templateType: 'Viewing-Prospect-Day-Ask',
    party: 'prospect',
  });
  assert.deepEqual(composeStep({ state: 'CONFIRM_TIME', awaiting: 'prospect' }), {
    templateType: 'Viewing-Confirm-Time',
    party: 'prospect',
  });
  assert.deepEqual(composeStep({ state: 'RELAY_TO_PROSPECT', awaiting: 'prospect' }), {
    templateType: 'Viewing-Relay-Prospect',
    party: 'prospect',
  });
});

test('composeStep maps tenant-facing active states', () => {
  assert.deepEqual(composeStep({
    state: 'AWAIT_TENANT',
    awaiting: 'tenant',
    policy: { require_explicit_confirmation: false },
    deadline: '2099-01-06T14:00:00',
  }), {
    templateType: 'Viewing-Tenant-Ask',
    eventType: 'tenant_silence_confirm',
    deadline: null,
    party: 'tenant',
  });
  assert.deepEqual(composeStep({ state: 'ASK_TENANT_ALT', awaiting: 'tenant' }), {
    templateType: 'Viewing-Tenant-Alt-Ask',
    party: 'tenant',
  });
});

test('composeStep returns null for terminal, staff-owned, mismatched, and unknown states', () => {
  for (const state of ['CONFIRMED', 'AUTO_CONFIRMED', 'CANCELLED', 'NEEDS_STAFF', 'SOMETHING_NEW']) {
    assert.equal(composeStep({ state, awaiting: 'prospect', hasCandidates: true, hasPendingUnit: true }), null, state);
  }
  assert.equal(composeStep({ state: 'AWAIT_TENANT', awaiting: 'prospect' }), null);
});

test('POST /viewing-negotiation/:id/compose inserts a draft rendered from current unit candidates', async () => {
  const { handler, restore } = composeHarness({ state: 'RESOLVE_UNIT', unit_candidates: candidates(['Alpha 1A', 'Beta 2B']) });
  try {
    const result = await callHandler(handler, { id: 'neg1' }, makePool());
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.template_type, 'Viewing-Choose-Unit');
    assert.match(result.body.data.body, /1\) Alpha 1A/);
    assert.match(result.body.data.body, /2\) Beta 2B/);
    assert.equal(result.body.data.unchanged, false);
  } finally {
    restore();
  }
});

test('POST /viewing-negotiation/:id/compose writes no viewing_negotiation state or nudge columns', async () => {
  const pool = makePool();
  const { handler, restore } = composeHarness({ state: 'RESOLVE_UNIT', unit_candidates: candidates(['Alpha 1A']) });
  try {
    await callHandler(handler, { id: 'neg1' }, pool);
    const forbidden = pool.calls.filter(({ sql }) => /UPDATE\s+viewing_negotiation\b/i.test(sql)
      && /\b(state|awaiting|customer_nudge_count|tenant_nudge_count|last_nudge_at)\b/i.test(sql));
    assert.deepEqual(forbidden, []);
  } finally {
    restore();
  }
});

test('POST /viewing-negotiation/:id/compose returns identical fresh draft on a double click', async () => {
  const pool = makePool();
  const { handler, restore } = composeHarness({ state: 'RESOLVE_UNIT', unit_candidates: candidates(['Alpha 1A']) });
  try {
    const first = await callHandler(handler, { id: 'neg1' }, pool);
    const second = await callHandler(handler, { id: 'neg1' }, pool);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.data.event_id, first.body.data.event_id);
    assert.equal(second.body.data.unchanged, true);
    assert.equal(pool.events.length, 1);
  } finally {
    restore();
  }
});

test('POST /viewing-negotiation/:id/compose after candidate change inserts a changed body', async () => {
  const pool = makePool();
  const neg = baseNegotiation({ unit_candidates: candidates(['Alpha 1A']) });
  const { handler, restore } = composeHarness(neg);
  try {
    const first = await callHandler(handler, { id: 'neg1' }, pool);
    neg.unit_candidates = candidates(['Alpha 1A', 'Beta 2B']);
    const second = await callHandler(handler, { id: 'neg1' }, pool);
    assert.equal(second.body.data.unchanged, false);
    assert.notEqual(second.body.data.body, first.body.data.body);
    assert.equal(pool.events.length, 2);
  } finally {
    restore();
  }
});

test('POST /viewing-negotiation/:id/compose returns 409 nothing_to_send for closed and staff-owned states', async () => {
  for (const state of ['CONFIRMED', 'NEEDS_STAFF']) {
    const { handler, restore } = composeHarness({ state });
    try {
      const result = await callHandler(handler, { id: 'neg1' }, makePool());
      assert.equal(result.statusCode, 409);
      assert.deepEqual(result.body, { code: 409, reason: 'nothing_to_send', state });
    } finally {
      restore();
    }
  }
});

test('POST /viewing-negotiation/:id/compose returns 404 for another org negotiation', async () => {
  const { handler, restore } = composeHarness({ org_id: 'org2' });
  try {
    const result = await callHandler(handler, { id: 'neg1' }, makePool());
    assert.equal(result.statusCode, 404);
  } finally {
    restore();
  }
});

test('GET /viewing-negotiation/drafts omits a 31-minute-old draft and includes a 29-minute-old draft', async () => {
  const pool = makePool({ draftAgesMinutes: [31, 29] });
  const handler = routeHandler('/viewing-negotiation/drafts', 'get');
  const result = await callHandler(handler, {}, pool);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.data.drafts.map((draft) => draft.event_id), ['draft-29']);
});

test('GET /viewing-negotiation/drafts caps max_age_hours=168 at thirty minutes', async () => {
  const pool = makePool({ draftAgesMinutes: [31, 29] });
  const handler = routeHandler('/viewing-negotiation/drafts', 'get');
  const result = await callHandler(handler, {}, pool, { max_age_hours: '168' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.data.drafts.map((draft) => draft.event_id), ['draft-29']);
  assert.match(pool.calls.at(-1).sql, /INTERVAL 30 MINUTE/);
});

test('GET /viewing-negotiation/drafts includes freshness metadata and no expired flag', async () => {
  const pool = makePool({ draftAgesMinutes: [29] });
  const handler = routeHandler('/viewing-negotiation/drafts', 'get');
  const result = await callHandler(handler, {}, pool);
  const draft = result.body.data.drafts[0];
  assert.equal(result.body.data.fresh_minutes, DRAFT_FRESH_MINUTES);
  assert.equal(typeof draft.expires_at, 'string');
  assert.equal(Object.hasOwn(draft, 'expired'), false);
});

function composeHarness(overrides = {}) {
  const originals = {
    renderMessage: viewingNegotiation.renderMessage,
    getSetting: viewingNegotiation.getSetting,
    loadContext: viewingNegotiation.loadContext,
  };
  const neg = overrides.id ? overrides : baseNegotiation(overrides);
  viewingNegotiation.renderMessage = async (_pool, _orgId, templateType, vars) => {
    if (templateType === 'Viewing-Choose-Unit') return `Choose:\n${vars['%Unit Options%']}`;
    if (templateType === 'Viewing-Unit-NotFound') return 'Not found';
    if (templateType === 'Viewing-Prospect-Day-Ask') return `When for ${vars['%Property Name%']} ${vars['%Unit Name%']}`;
    return `${templateType} ${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('|')}`;
  };
  viewingNegotiation.getSetting = async () => ({ relay_mode: 'manual', auto_send_nudges: 0 });
  viewingNegotiation.loadContext = async () => ({
    unit_name: '1A',
    property_name: 'Alpha',
    tenant_phone: '+85222222222',
    tenant_first_name: 'Tess',
    tenant_last_name: 'Tenant',
  });
  const handler = routeHandler('/viewing-negotiation/:id/compose', 'post');
  lastHarness = {
    handler,
    restore() {
      Object.assign(viewingNegotiation, originals);
    },
    neg,
  };
  return lastHarness;
}

function routeHandler(path, method) {
  delete require.cache[require.resolve('../src/routes/public')];
  const publicRouter = require('../src/routes/public');
  return publicRouter.stack
    .find((layer) => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;
}

function baseNegotiation(overrides = {}) {
  return {
    id: 'neg1',
    org_id: 'org1',
    state: 'RESOLVE_UNIT',
    awaiting: 'prospect',
    prospect_name: 'Pat Prospect',
    prospect_phone: '+85211111111',
    unit_id: null,
    property_id: null,
    tenant_id: null,
    pending_unit_id: null,
    unit_candidates: candidates(['Alpha 1A']),
    current_proposed_datetime: null,
    opt_out_deadline_at: null,
    policy_explicit_confirm: null,
    ...overrides,
  };
}

function candidates(labels) {
  return JSON.stringify(labels.map((label, index) => ({ unit_id: `u${index + 1}`, label })));
}

function makePool({ draftAgesMinutes = [] } = {}) {
  const pool = {
    calls: [],
    neg: null,
    events: draftAgesMinutes.map((age) => eventRow(`draft-${age}`, {
      created_at: new Date(Date.now() - age * 60000),
      body: `body ${age}`,
    })),
    async execute(sql, params = []) {
      this.calls.push({ sql, params });
      if (/SELECT \* FROM viewing_negotiation WHERE id = \? AND org_id = \?/i.test(sql)) {
        const neg = currentHarnessNegotiation();
        return [[neg && neg.id === params[0] && neg.org_id === params[1] ? neg : undefined]];
      }
      if (/SELECT \* FROM viewing_setting/i.test(sql)) return [[null]];
      if (/SELECT id, body, created_at\s+FROM viewing_negotiation_event/i.test(sql)) {
        return [[this.events.filter((event) => event.negotiation_id === params[0]).at(-1)]];
      }
      if (/SELECT COUNT\(\*\) AS c FROM viewing_negotiation_event/i.test(sql)) {
        return [[{ c: this.events.filter((event) => event.negotiation_id === params[0] && event.event_type === params[1]).length }]];
      }
      if (/INSERT INTO viewing_negotiation_event/i.test(sql)) {
        const [id, negotiationId, party, toPhone, templateType, body, sendMode, eventType, idempotencyKey, deadlineAt] = params;
        this.events.push(eventRow(id, {
          negotiation_id: negotiationId,
          party,
          to_phone: toPhone,
          template_type: templateType,
          body,
          send_mode: sendMode,
          event_type: eventType,
          idempotency_key: idempotencyKey,
          deadline_at: deadlineAt,
        }));
        return [{ affectedRows: 1 }];
      }
      if (/WHERE e\.id = \? LIMIT 1/i.test(sql)) {
        return [[this.events.find((event) => event.id === params[0])]];
      }
      if (/FROM viewing_negotiation_event e\s+JOIN viewing_negotiation n/i.test(sql)) {
        const minutes = Number((sql.match(/INTERVAL (\d+) MINUTE/) || [])[1] || 0);
        const cutoff = Date.now() - minutes * 60000;
        return [this.events.filter((event) => new Date(event.created_at).getTime() >= cutoff)];
      }
      if (/SELECT u\.name AS unit_name/i.test(sql)) {
        return [[{ unit_name: '1A', property_name: 'Alpha' }]];
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
  return pool;
}

let lastHarness = null;
function currentHarnessNegotiation() {
  return lastHarness && lastHarness.neg;
}

async function callHandler(handler, params, pool, query = {}) {
  lastHarness = lastHarness || {};
  const req = { params, query, pool, apiKey: { orgId: 'org1' }, body: {} };
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  await handler(req, res);
  return { statusCode, body };
}

function eventRow(id, overrides = {}) {
  const created = overrides.created_at || new Date();
  const expires = new Date(new Date(created).getTime() + DRAFT_FRESH_MINUTES * 60000);
  return {
    id,
    event_id: id,
    negotiation_id: 'neg1',
    negotiation_state: 'RESOLVE_UNIT',
    awaiting: 'prospect',
    party: 'prospect',
    to_phone: '+85211111111',
    body: 'body',
    template_type: 'Viewing-Choose-Unit',
    event_type: null,
    send_mode: 'approve',
    idempotency_key: null,
    deadline_at: null,
    created_at: created,
    expires_at: expires,
    age_hours: 0,
    unit_id: null,
    prospect_name: 'Pat Prospect',
    prospect_phone: '+85211111111',
    unit_name: null,
    property_name: null,
    ...overrides,
  };
}

test('compose tenant ask never quotes an internal response deadline', async () => {
  // Compose deliberately does not advance the negotiation, so a lapsed
  // opt_out_deadline_at is still sitting on the row. Quoting it would send a
  // tenant "please reply by [yesterday]" — the exact staleness this endpoint
  // exists to prevent.
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  const { handler, restore } = composeHarness({
    state: 'AWAIT_TENANT',
    awaiting: 'tenant',
    unit_id: 'unit1',
    current_proposed_datetime: new Date(Date.now() + 24 * 3600 * 1000),
    policy_explicit_confirm: 0,
    opt_out_deadline_at: past,
  });
  try {
    const result = await callHandler(handler, { id: 'neg1' }, makePool());

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.template_type, 'Viewing-Tenant-Ask');
    assert.doesNotMatch(result.body.data.body, /Opt Out Deadline%=\S/);
  } finally {
    restore();
  }
});

test('compose ignores stored response deadline for normal tenant ask', async () => {
  const future = new Date(Date.now() + 48 * 3600 * 1000);
  const { handler, restore } = composeHarness({
    state: 'AWAIT_TENANT',
    awaiting: 'tenant',
    unit_id: 'unit1',
    current_proposed_datetime: new Date(Date.now() + 24 * 3600 * 1000),
    policy_explicit_confirm: 0,
    opt_out_deadline_at: future,
  });
  try {
    const result = await callHandler(handler, { id: 'neg1' }, makePool());

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.template_type, 'Viewing-Tenant-Ask');
  } finally {
    restore();
  }
});
