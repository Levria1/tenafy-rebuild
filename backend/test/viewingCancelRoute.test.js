const test = require('node:test');
const assert = require('node:assert/strict');

const ORG_ID = 'org1';
const NEG_ID = 'neg1';

function routeHandler(path, method) {
  delete require.cache[require.resolve('../src/routes/public')];
  const publicRouter = require('../src/routes/public');
  return publicRouter.stack
    .find((layer) => layer.route?.path === path && layer.route.methods[method])
    .route.stack.at(-1).handle;
}

function makePool(neg) {
  const pool = {
    calls: [],
    neg: neg || null,
    async execute(sql, params = []) {
      this.calls.push({ sql, params });
      if (/SELECT \* FROM viewing_negotiation WHERE id = \? AND org_id = \?/i.test(sql)) {
        const match = this.neg
          && String(this.neg.id) === String(params[0])
          && String(this.neg.org_id) === String(params[1]);
        return [[match ? this.neg : undefined]];
      }
      if (/UPDATE viewing_negotiation SET state = 'CANCELLED'/i.test(sql)) {
        if (this.neg && String(this.neg.id) === String(params[0])) {
          this.neg.state = 'CANCELLED';
          this.neg.awaiting = null;
        }
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return pool;
}

async function callCancel(pool, { id = NEG_ID, body = {}, orgId = ORG_ID } = {}) {
  const handler = routeHandler('/viewing-negotiation/:id/cancel', 'post');
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  await handler({ params: { id }, body, pool, apiKey: { orgId } }, res);
  return res;
}

function cancelledUpdate(pool) {
  return pool.calls.find(({ sql }) => /UPDATE viewing_negotiation SET state = 'CANCELLED'/i.test(sql));
}

test('POST /viewing-negotiation/:id/cancel retires an open negotiation', async () => {
  const pool = makePool({ id: NEG_ID, org_id: ORG_ID, state: 'ASK_PROSPECT_DAY', awaiting: 'prospect' });
  const res = await callCancel(pool, { body: { reason: 'customer went cold' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.cancelled, true);
  assert.equal(res.body.data.already_cancelled, false);
  assert.equal(res.body.data.state, 'CANCELLED');
  const update = cancelledUpdate(pool);
  assert.ok(update, 'must call cancelNegotiation');
  assert.equal(update.params[0], NEG_ID);
});

test('POST /viewing-negotiation/:id/cancel is idempotent once already cancelled', async () => {
  const pool = makePool({ id: NEG_ID, org_id: ORG_ID, state: 'ASK_PROSPECT_DAY' });
  const first = await callCancel(pool);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.data.already_cancelled, false);

  const second = await callCancel(pool);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.data.cancelled, true);
  assert.equal(second.body.data.already_cancelled, true);
  assert.equal(pool.calls.filter(({ sql }) => /UPDATE viewing_negotiation SET state = 'CANCELLED'/i.test(sql)).length, 1);
});

test('POST /viewing-negotiation/:id/cancel refuses a confirmed viewing', async () => {
  for (const state of ['CONFIRMED', 'AUTO_CONFIRMED']) {
    const pool = makePool({ id: NEG_ID, org_id: ORG_ID, state });
    const res = await callCancel(pool);

    assert.equal(res.statusCode, 409, state);
    assert.equal(res.body.code, 409);
    assert.equal(res.body.reason, 'already_confirmed');
    assert.equal(typeof res.body.message, 'string');
    assert.ok(res.body.message.length > 0);
    assert.equal(cancelledUpdate(pool), undefined, `${state} must stay a staff action`);
  }
});

test('POST /viewing-negotiation/:id/cancel returns 404 for another org id', async () => {
  const pool = makePool({ id: NEG_ID, org_id: 'other-org', state: 'ASK_PROSPECT_DAY' });
  const res = await callCancel(pool);

  assert.equal(res.statusCode, 404);
  assert.equal(cancelledUpdate(pool), undefined);
});

test('POST /viewing-negotiation/:id/cancel rejects a non-string reason', async () => {
  const pool = makePool({ id: NEG_ID, org_id: ORG_ID, state: 'ASK_PROSPECT_DAY' });
  const res = await callCancel(pool, { body: { reason: { text: 'cold' } } });

  assert.equal(res.statusCode, 400);
  assert.equal(cancelledUpdate(pool), undefined);
});
