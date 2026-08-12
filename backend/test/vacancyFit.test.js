const test = require('node:test');
const assert = require('node:assert/strict');
const {
  vacancyFit,
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

test('GET /vacancies without target_date keeps the old response shape and order', async () => {
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
    return { max_gap_days: 14 };
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
        phrasing: {
          certain: '{units} available from {date}',
          uncertain: "We may also have {units} available, however the tenant may renew, they're not sure",
        },
      },
    };

    assert.equal(result.statusCode, 200);
    assert.equal(JSON.stringify(result.body), JSON.stringify(expected));
    assert.deepEqual(computeOptions, { page: false });
    assert.equal(loadSettingsCalls, 0);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies with target_date ranks and warns without filtering on fit', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ footer: null, photo_root: '/photos', min_gap_days: 40, max_gap_days: 14, lead_days_nr: 60, lead_days_other: 45 });
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
    assert.equal(typeof result.body.data.phrasing.earlier, 'string');
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
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
