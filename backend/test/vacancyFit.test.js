const test = require('node:test');
const assert = require('node:assert/strict');
const {
  vacancyFit,
  exceedsHardGapCap,
  vacancyNoMatchReason,
  compareVacancyFit,
  vacancyToPublicShape,
} = require('../src/utils/advertisingPlan');

const EMPTY_FIT = {
  gap_days: null,
  gap_warning: null,
  available_after_target: null,
};

function publicRow(overrides = {}) {
  return {
    unit_id: 'u1',
    unit_name: '5B',
    property_id: 'p1',
    property_name: "Gilman's Bazaar",
    label: "Gilman's Bazaar 5B",
    tier: 2,
    availability: {
      status: 'from_date',
      available_from: '2026-09-16',
      days_until: 35,
      certain: true,
    },
    ...overrides,
  };
}

test('vacancyFit flags the operator scenario as a warning at the default threshold', () => {
  // Exact operator scenario: free 2026-09-16, prospect wants 2026-10-15.
  assert.deepEqual(vacancyFit(publicRow(), '2026-10-15'), {
    gap_days: 29,
    gap_warning: true,
    available_after_target: false,
  });
});

test('vacancyFit warning is decided by maxGapDays, not the gap alone', () => {
  assert.deepEqual(vacancyFit(publicRow(), '2026-10-15', { maxGapDays: 45 }), {
    gap_days: 29,
    gap_warning: false,
    available_after_target: false,
  });
});

test('vacancyFit handles an exact fit without warning', () => {
  assert.deepEqual(vacancyFit(publicRow(), '2026-09-16'), {
    gap_days: 0,
    gap_warning: false,
    available_after_target: false,
  });
});

test('vacancyFit marks units available after target without a gap warning', () => {
  const result = vacancyFit(
    publicRow({ availability: { status: 'from_date', available_from: '2026-11-01', days_until: 81, certain: true } }),
    '2026-10-15'
  );

  assert.deepEqual(result, {
    gap_days: -17,
    available_after_target: true,
    gap_warning: false, // Negative gap costs no rent; the prospect waits instead.
  });
});

test('vacancyFit treats tier-1 null available_from as available now', () => {
  // For tier 1, null available_from means "now", not "unknown".
  const result = vacancyFit(
    publicRow({
      tier: 1,
      availability: { status: 'now', available_from: null, days_until: 0, certain: true },
    }),
    '2026-10-15',
    { today: '2026-08-12' }
  );

  assert.deepEqual(result, {
    gap_days: 64,
    gap_warning: true,
    available_after_target: false,
  });
});

test('vacancyFit returns null fields for tier 2 rows without available_from', () => {
  const result = vacancyFit(
    publicRow({ availability: { status: 'from_date', available_from: null, days_until: null, certain: false } }),
    '2026-10-15'
  );

  assert.deepEqual(result, EMPTY_FIT);
});

test('vacancyFit returns null fields for absent or malformed targetDate', () => {
  assert.deepEqual(vacancyFit(publicRow()), EMPTY_FIT);
  assert.deepEqual(vacancyFit(publicRow(), '2026'), EMPTY_FIT);
  assert.deepEqual(vacancyFit(publicRow(), 'today'), EMPTY_FIT);
  assert.deepEqual(vacancyFit(publicRow(), '2026-02-30'), EMPTY_FIT);
});

test('vacancyFit permits maxGapDays 0 and warns on any positive gap only', () => {
  assert.deepEqual(vacancyFit(publicRow(), '2026-09-17', { maxGapDays: 0 }), {
    gap_days: 1,
    gap_warning: true,
    available_after_target: false,
  });
  assert.deepEqual(vacancyFit(publicRow(), '2026-09-16', { maxGapDays: 0 }), {
    gap_days: 0,
    gap_warning: false,
    available_after_target: false,
  });
});

test('vacancyFit handles month and year boundaries', () => {
  assert.deepEqual(
    vacancyFit(
      publicRow({ availability: { status: 'from_date', available_from: '2026-12-20', days_until: 130, certain: true } }),
      '2027-01-05'
    ),
    {
      gap_days: 16,
      gap_warning: true,
      available_after_target: false,
    }
  );
});

test('compareVacancyFit orders positive gaps, after-target rows, then nulls without mutating', () => {
  const rows = [
    { property_name: 'P', unit_name: '30', tier: 2, gap_days: 30 },
    { property_name: 'P', unit_name: '0', tier: 2, gap_days: 0 },
    { property_name: 'P', unit_name: '-5', tier: 2, gap_days: -5, available_after_target: true },
    { property_name: 'P', unit_name: 'null', tier: 2, gap_days: null },
    { property_name: 'P', unit_name: '3', tier: 2, gap_days: 3 },
  ];
  const before = rows.map(row => row.unit_name);

  const sorted = [...rows].sort(compareVacancyFit);

  assert.deepEqual(sorted.map(row => row.gap_days), [0, 3, 30, -5, null]);
  assert.deepEqual(rows.map(row => row.unit_name), before);
});

test('exceedsHardGapCap withholds non-vacant positive gaps beyond the cap', () => {
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: 21, available_after_target: false }, 20), true);
});

test('exceedsHardGapCap keeps the inclusive boundary', () => {
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: 20, available_after_target: false }, 20), false);
});

test('exceedsHardGapCap always keeps tier-1 vacant units', () => {
  // An already-vacant unit is the one the operator most wants to offer.
  assert.equal(exceedsHardGapCap({ tier: 1, gap_days: 61, available_after_target: false }, 20), false);
});

test('exceedsHardGapCap withholds tier-3 positive gaps beyond the cap', () => {
  assert.equal(exceedsHardGapCap({ tier: 3, gap_days: 30, available_after_target: false }, 20), true);
});

test('exceedsHardGapCap keeps rows available after the target', () => {
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: -17, available_after_target: true }, 20), false);
});

test('exceedsHardGapCap keeps rows without a judged gap', () => {
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: null, available_after_target: null }, 20), false);
});

test('exceedsHardGapCap fails open when the hard cap setting is missing or invalid', () => {
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: 30, available_after_target: false }), false);
  assert.equal(exceedsHardGapCap({ tier: 2, gap_days: 30, available_after_target: false }, Number.NaN), false);
});

test('hard cap applies to the operator move-in scenario while preserving warnings', () => {
  // Operator scenario: requested 2026-10-12, today 2026-08-12. Gap-9 is a clean
  // offer, gap-30 is hidden, and the already-vacant tier-1 row is still offered
  // and warned because it is the unit most urgent to fill.
  const targetDate = '2026-10-12';
  const options = { maxGapDays: 10, today: '2026-08-12' };
  const rows = [
    vacancySourceRow({ unit_id: 'u-gap-9', unit_name: '9', tier: 2, end_date: '2026-10-02' }),
    vacancySourceRow({ unit_id: 'u-gap-30', unit_name: '30', tier: 2, end_date: '2026-09-11' }),
    vacancySourceRow({ unit_id: 'u-vacant', unit_name: 'V', tier: 1, end_date: null }),
  ].map(vacancyToPublicShape)
    .map(row => ({ ...row, ...vacancyFit(row, targetDate, options) }));

  const returned = rows.filter(row => !exceedsHardGapCap(row, 20));

  assert.equal(rows.find(row => row.unit_id === 'u-gap-9').gap_days, 9);
  assert.equal(rows.find(row => row.unit_id === 'u-gap-9').gap_warning, false);
  assert.equal(exceedsHardGapCap(rows.find(row => row.unit_id === 'u-gap-30'), 20), true);
  assert.equal(rows.find(row => row.unit_id === 'u-vacant').gap_days, 61);
  assert.equal(rows.find(row => row.unit_id === 'u-vacant').gap_warning, true);
  assert.deepEqual(returned.map(row => row.unit_id).sort(), ['u-gap-9', 'u-vacant']);
});

test('vacancyNoMatchReason distinguishes capped results from no vacancies', () => {
  assert.equal(vacancyNoMatchReason(0, 3), 'all_beyond_hard_cap');
  assert.equal(vacancyNoMatchReason(0, 0), 'no_vacancies');
  assert.equal(vacancyNoMatchReason(1, 3), null);
});

test('GET /vacancies without target_date keeps order and reports no cap filtering', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  let loadSettingsCalls = 0;
  let computeOptions = null;
  advertising.computeVacancies = async (_pool, _orgId, options) => {
    computeOptions = options;
    return {
      vacancies: [
        vacancySourceRow({ unit_id: 'u1', unit_name: '1A', property_id: 'p1', property_name: 'Alpha', tier: 1, days_left: -10, end_date: null }),
        vacancySourceRow({ unit_id: 'u2', unit_name: '2B', property_id: 'p2', property_name: 'Beta', tier: 2, days_left: 34, end_date: '2026-09-15' }),
      ],
    };
  };
  advertising.loadSettings = async () => {
    loadSettingsCalls += 1;
    return { max_gap_days: 10, hard_max_gap_days: 20 };
  };

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, {});
    const expected = {
      code: 200,
      data: {
        vacancies: [
          vacancyToPublicShape(vacancySourceRow({ unit_id: 'u1', unit_name: '1A', property_id: 'p1', property_name: 'Alpha', tier: 1, days_left: -10, end_date: null })),
          vacancyToPublicShape(vacancySourceRow({ unit_id: 'u2', unit_name: '2B', property_id: 'p2', property_name: 'Beta', tier: 2, days_left: 34, end_date: '2026-09-15' })),
        ],
        count: 2,
        hard_max_gap_days: 20,
        hidden_by_gap_cap: 0,
        no_match_reason: null,
        phrasing: {
          certain: '{units} available from {date}',
          uncertain: "We may also have {units} available, however the tenant may renew, they're not sure",
        },
      },
    };

    assert.equal(result.statusCode, 200);
    assert.equal(JSON.stringify(result.body), JSON.stringify(expected));
    assert.deepEqual(computeOptions, { page: false, settings: { max_gap_days: 10, hard_max_gap_days: 20 } });
    assert.equal(loadSettingsCalls, 1);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies with target_date ranks and warns without filtering on max_gap_days', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ footer: null, photo_root: '/photos', min_gap_days: 40, max_gap_days: 14, hard_max_gap_days: 365, lead_days_nr: 60, lead_days_other: 45 });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-gap', unit_name: '8B', property_name: 'Harbour Court', end_date: '2026-09-14', days_left: 33 }),
      vacancySourceRow({ unit_id: 'u-after', unit_name: '2C', property_name: 'Kowloon Loft', end_date: '2026-10-31', days_left: 80 }),
      vacancySourceRow({ unit_id: 'u-exact', unit_name: '4A', property_name: 'Central House', end_date: '2026-10-14', days_left: 63 }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { target_date: '2026-10-15' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies.map(row => row.unit_id), ['u-exact', 'u-gap', 'u-after']);
    assert.deepEqual(result.body.data.vacancies.map(row => row.gap_days), [0, 30, -17]);
    assert.equal(result.body.data.vacancies.find(row => row.unit_id === 'u-gap').gap_warning, true);
    assert.equal(result.body.data.vacancies.find(row => row.unit_id === 'u-after').available_after_target, true);
    assert.equal(result.body.data.count, 3);
    assert.equal(result.body.data.target_date, '2026-10-15');
    assert.equal(result.body.data.max_gap_days, 14);
    assert.equal(result.body.data.hard_max_gap_days, 365);
    assert.equal(result.body.data.hidden_by_gap_cap, 0);
    assert.equal(result.body.data.no_match_reason, null);
    assert.equal(typeof result.body.data.phrasing.earlier, 'string');
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('PUT /advertising/settings rejects hard_max_gap_days outside the allowed range', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;

  const result = await callSettingsPutHandler(handler, { hard_max_gap_days: 366 }, { execute: async () => {
    throw new Error('pool should not be used for invalid scalar input');
  } });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /hard_max_gap_days must be an integer between 0 and 365/);
});

test('PUT /advertising/settings validates max_gap_days against merged hard_max_gap_days', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;
  const executed = [];
  const pool = {
    execute: async (sql, params) => {
      executed.push({ sql, params });
      if (/SELECT footer, photo_root, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
        }]];
      }
      throw new Error('upsert should not run after cross-field validation fails');
    },
  };

  const result = await callSettingsPutHandler(handler, { max_gap_days: 21 }, pool);

  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /warning threshold above the hide threshold/);
  assert.equal(executed.length, 1);
});

function vacancySourceRow(overrides = {}) {
  return {
    unit_id: 'u1',
    unit_name: '5B',
    property_id: 'p1',
    property_name: "Gilman's Bazaar",
    unit_type: 'apartment',
    beds: 1,
    baths: 1,
    size: 320,
    rent: 12000,
    tier: 2,
    intent: 'NR',
    days_left: 34,
    end_date: '2026-09-15',
    ...overrides,
  };
}

async function callVacanciesHandler(handler, query) {
  let statusCode = 200;
  let body = null;
  const req = { query, pool: {}, apiKey: { orgId: 'org1' } };
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
