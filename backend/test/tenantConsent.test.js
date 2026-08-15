const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chooseTenantNoticeTemplate,
  resolvePolicy,
} = require('../src/services/viewingNegotiationLogic');
const viewingService = require('../src/services/viewingNegotiation');

test('chooseTenantNoticeTemplate uses silence-confirm ask for normal policy with or without a deadline', () => {
  assert.deepEqual(
    chooseTenantNoticeTemplate({ require_explicit_confirmation: false }, '2099-01-06T14:00:00'),
    { templateType: 'Viewing-Tenant-Ask', eventType: 'tenant_silence_confirm', deadline: null }
  );
  assert.deepEqual(
    chooseTenantNoticeTemplate({ require_explicit_confirmation: false }),
    { templateType: 'Viewing-Tenant-Ask', eventType: 'tenant_silence_confirm', deadline: null }
  );
});

test('chooseTenantNoticeTemplate uses explicit confirm only when policy requires it', () => {
  assert.deepEqual(
    chooseTenantNoticeTemplate({ require_explicit_confirmation: true }, '2099-01-06T14:00:00'),
    { templateType: 'Viewing-Tenant-Explicit', eventType: 'tenant_explicit_confirm_request', deadline: null }
  );
});

test('regression: mapping Viewing-Tenant-Ask to explicit confirm would silently disable auto-confirm', () => {
  assert.equal(viewingService.EVENT_TYPE_BY_TEMPLATE['Viewing-Tenant-Ask'], 'tenant_silence_confirm');
  assert.notEqual(viewingService.EVENT_TYPE_BY_TEMPLATE['Viewing-Tenant-Ask'], 'tenant_explicit_confirm_request');
});

test('historical opt-out event remains but old opt-out template is no longer emitted', () => {
  assert.equal(Object.hasOwn(viewingService.FALLBACKS, 'Viewing-Tenant-OptOut'), false);
  assert.equal(Object.hasOwn(viewingService.EVENT_TYPE_BY_TEMPLATE, 'Viewing-Tenant-OptOut'), false);
  assert.equal(Object.values(viewingService.EVENT_TYPE_BY_TEMPLATE).includes('Viewing-Tenant-OptOut'), false);
  assert.equal(viewingService.EVENT_TYPES.includes('tenant_opt_out_notice'), true);
});

test('resolvePolicy still forces explicit yes when viewing starts before the response window elapses', () => {
  assert.deepEqual(resolvePolicy({
    setting: { tenant_opt_out_hours: 4 },
    viewingStartAt: '2099-01-06T12:00:00',
    noticeSentAt: '2099-01-06T09:00:00',
  }), {
    opt_out_window_hours: 4,
    require_explicit_confirmation: true,
    source: 'short_notice',
  });
});

test('tenant variable bag supports Name - Lease and renders the operator template without literal tokens', async () => {
  const tenantName = 'Taylor Tenant';
  const vars = {
    ...viewingService.viewingNegotiationVars({
      unit_name: '5B',
      property_name: 'Harbour House',
      tenant_first_name: 'Taylor',
      tenant_last_name: 'Tenant',
    }),
    '%Proposed Time%': 'Tue, Jan 6, 2:00 PM',
  };
  assert.equal(vars['%Tenant Name%'], tenantName);
  assert.equal(vars['%Name - Lease%'], tenantName);

  const pool = { execute: async () => [[null]] };
  const rendered = await viewingService.renderMessage(pool, 'org1', 'Viewing-Tenant-Ask', vars);
  assert.doesNotMatch(rendered, /%[^%]+%/);
  assert.match(rendered, /Hi Taylor Tenant/);
});

test('PUT /viewing/settings validates tenant response window range', async () => {
  const viewing = require('../src/routes/viewing');
  const handler = viewing.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;

  for (const bad of [0, 49, 1.5, 'many']) {
    const result = await callSettingsPutHandler(handler, { tenant_opt_out_hours: bad }, {
      execute: async () => { throw new Error('pool should not be used for invalid tenant_opt_out_hours'); },
    });
    assert.equal(result.statusCode, 400, `tenant_opt_out_hours=${bad}`);
    assert.match(result.body.message, /tenant_opt_out_hours must be 1.48/);
  }

  for (const good of [1, 4, 48]) {
    const pool = settingsPool();
    const result = await callSettingsPutHandler(handler, { tenant_opt_out_hours: good }, pool);
    assert.equal(result.statusCode, 200, `tenant_opt_out_hours=${good}`);
    assert.equal(result.body.data.tenant_opt_out_hours, good);
    const insert = pool.calls.find(call => /INSERT INTO viewing_setting/i.test(call.sql));
    assert.ok(insert, 'settings save should upsert viewing_setting');
    assert.match(insert.sql, /viewing_days/);
    assert.match(insert.sql, /viewing_start/);
    assert.match(insert.sql, /viewing_end/);
    assert.match(insert.sql, /relay_mode/);
    assert.match(insert.sql, /auto_send_nudges/);
    assert.match(insert.sql, /respect_quiet_hours/);
  }
});

async function callSettingsPutHandler(handler, body, pool) {
  let statusCode = 200;
  let responseBody = null;
  const req = { body, pool, user: { orgId: 'org1' } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      responseBody = value;
      return this;
    },
  };

  await handler(req, res);
  return { statusCode, body: responseBody };
}

function settingsPool() {
  let saved = null;
  const pool = {
    calls: [],
    async execute(sql, params = []) {
      this.calls.push({ sql, params });
      if (/SELECT \* FROM viewing_setting/i.test(sql)) return [[saved]];
      if (/INSERT INTO viewing_setting/i.test(sql)) {
        const cols = sql.match(/INSERT INTO viewing_setting \(([^)]+)\)/i)[1]
          .split(',').map(s => s.trim());
        saved = Object.fromEntries(cols.map((col, index) => [col, params[index]]));
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unhandled SQL: ${sql}`);
    },
  };
  return pool;
}
