const test = require('node:test');
const assert = require('node:assert/strict');
const {
  vacancyFit,
  exceedsHardGapCap,
  vacancyNoMatchReason,
  partnerForwardBlock,
  compareVacancyFit,
  vacancyToPublicShape,
  classifyFreeOn,
  matchesFreeOn,
  gapBandDays,
  bookingHorizonDecision,
  bookingGapLimitForLease,
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

test('vacancyToPublicShape includes location and next move-in fields as null when absent', () => {
  const result = vacancyToPublicShape(vacancySourceRow());

  assert.equal(Object.hasOwn(result, 'district'), true);
  assert.equal(Object.hasOwn(result, 'city'), true);
  assert.equal(Object.hasOwn(result.availability, 'next_move_in_date'), true);
  assert.equal(result.district, null);
  assert.equal(result.city, null);
  assert.equal(result.availability.next_move_in_date, null);
});

test('matchesFreeOn keeps a vacant-now unit with no incoming tenant', () => {
  assert.equal(matchesFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: null, days_until: 0, certain: true } }),
    '2026-10-15'
  ), true);
});

test('matchesFreeOn keeps a unit available before the requested free date', () => {
  assert.equal(matchesFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-01', next_move_in_date: null, days_until: 48, certain: true } }),
    '2026-10-15'
  ), true);
});

test('matchesFreeOn rejects a unit available after the requested free date', () => {
  assert.equal(matchesFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-20', next_move_in_date: null, days_until: 67, certain: true } }),
    '2026-10-15'
  ), false);
});

test('matchesFreeOn rejects a vacant-now unit already re-let before the requested free date', () => {
  // This is the point of free_on: empty today is not enough if someone else
  // moves in before the prospect needs the unit.
  assert.equal(matchesFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: '2026-10-10', days_until: 0, certain: true } }),
    '2026-10-15'
  ), false);
});

test('matchesFreeOn keeps a vacant-now unit re-let after the requested free date', () => {
  assert.equal(matchesFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: '2026-11-30', days_until: 0, certain: true } }),
    '2026-10-15'
  ), true);
});

test('matchesFreeOn rejects an incoming tenant exactly on the requested free date', () => {
  assert.equal(matchesFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: '2026-10-15', days_until: 0, certain: true } }),
    '2026-10-15'
  ), false);
});

test('matchesFreeOn keeps a unit available exactly on the requested free date', () => {
  assert.equal(matchesFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-15', next_move_in_date: null, days_until: 62, certain: true } }),
    '2026-10-15'
  ), true);
});

test('matchesFreeOn rejects unknown available_from for from_date availability', () => {
  assert.equal(matchesFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: null, next_move_in_date: null, days_until: null, certain: false } }),
    '2026-10-15'
  ), false);
});

test('classifyFreeOn matches a unit available before the requested date', () => {
  assert.equal(classifyFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-01', next_move_in_date: null, days_until: 48, certain: true } }),
    '2026-10-15'
  ), 'match');
});

test('classifyFreeOn matches a unit available exactly on the requested date', () => {
  assert.equal(classifyFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-15', next_move_in_date: null, days_until: 62, certain: true } }),
    '2026-10-15'
  ), 'match');
});

test('classifyFreeOn matches a vacant-now unit with no incoming tenant', () => {
  assert.equal(classifyFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: null, days_until: 0, certain: true } }),
    '2026-10-15'
  ), 'match');
});

test('classifyFreeOn marks a unit freeing up after the requested date as later', () => {
  assert.equal(classifyFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-16', next_move_in_date: null, days_until: 63, certain: true } }),
    '2026-10-15'
  ), 'later');
});

test('classifyFreeOn marks a vacant-now unit re-let by the requested date as unavailable', () => {
  assert.equal(classifyFreeOn(
    publicRow({ tier: 1, availability: { status: 'now', available_from: null, next_move_in_date: '2026-10-15', days_until: 0, certain: true } }),
    '2026-10-15'
  ), 'unavailable');
});

test('classifyFreeOn lets a re-let date win over later availability', () => {
  assert.equal(classifyFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: '2026-10-20', next_move_in_date: '2026-10-10', days_until: 67, certain: true } }),
    '2026-10-15'
  ), 'unavailable');
});

test('classifyFreeOn marks unknown later availability as unavailable', () => {
  assert.equal(classifyFreeOn(
    publicRow({ availability: { status: 'from_date', available_from: null, next_move_in_date: null, days_until: null, certain: false } }),
    '2026-10-15'
  ), 'unavailable');
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
  // end_date is available_from (same-day turnover); dates chosen so gaps stay 9/30.
  const targetDate = '2026-10-12';
  const options = { maxGapDays: 10, today: '2026-08-12' };
  const rows = [
    vacancySourceRow({ unit_id: 'u-gap-9', unit_name: '9', tier: 2, end_date: '2026-10-03' }),
    vacancySourceRow({ unit_id: 'u-gap-30', unit_name: '30', tier: 2, end_date: '2026-09-12' }),
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

test('partnerForwardBlock applies to empty returned vacancies and returns stored text verbatim', () => {
  assert.deepEqual(partnerForwardBlock(0, 'Please contact the prospect.'), {
    applies: true,
    message: 'Please contact the prospect.',
  });
});

test('partnerForwardBlock keeps message visible when vacancies are returned', () => {
  assert.deepEqual(partnerForwardBlock(3, 'Please contact the prospect.'), {
    applies: false,
    message: 'Please contact the prospect.',
  });
});

test('partnerForwardBlock has no default for an unauthored message', () => {
  // The caller must send nothing here: this is the unauthored case and the
  // reason the API must not invent a default.
  assert.deepEqual(partnerForwardBlock(0, null), {
    applies: true,
    message: null,
  });
});

test('partnerForwardBlock treats blank messages as unauthored', () => {
  assert.equal(partnerForwardBlock(0, '').message, null);
  assert.equal(partnerForwardBlock(0, '   ').message, null);
});

test('partnerForwardBlock returns placeholders unsubstituted', () => {
  // Substitution is the caller's job; a half-filled template must never reach a
  // partner agency from server-side partial substitution.
  const result = partnerForwardBlock(0, 'Please help {customer_name} for {target_date}.');

  assert.equal(result.message, 'Please help {customer_name} for {target_date}.');
  assert.match(result.message, /\{customer_name\}/);
  assert.match(result.message, /\{target_date\}/);
});

test('partnerForwardBlock applies by returned count, not no_match_reason', () => {
  for (const hiddenByGapCap of [0, 2]) {
    const reason = vacancyNoMatchReason(0, hiddenByGapCap);
    assert.ok(['no_vacancies', 'all_beyond_hard_cap'].includes(reason));
    assert.equal(partnerForwardBlock(0, 'Forward this inquiry.').applies, true);
  }
});

test('gapBandDays implements the operator lease-length bands', () => {
  assert.equal(gapBandDays(null), null);
  assert.equal(gapBandDays(undefined), null);
  assert.equal(gapBandDays(31), 3);
  assert.equal(gapBandDays(32), 6);
  assert.equal(gapBandDays(62), 6);
  assert.equal(gapBandDays(63), 10);
  assert.equal(gapBandDays(93), 10);
  assert.equal(gapBandDays(94), 10);
  assert.equal(gapBandDays(365), 10);
});

test('gapBandDays applies operator band overrides', () => {
  const bands = {
    band_1m_days: 1,
    band_2m_days: 2,
    band_3m_plus_days: 4,
  };
  assert.equal(gapBandDays(31, bands), 1);
  assert.equal(gapBandDays(45, bands), 2);
  assert.equal(gapBandDays(90, bands), 4);
});

test('gapBandDays junk values fall back to the default and never loosen', () => {
  for (const junk of ['  ', '', {}, [], true, '3abc', '20abc']) {
    assert.equal(gapBandDays(31, { band_1m_days: junk }), 3);
    assert.equal(gapBandDays(45, { band_2m_days: junk }), 6);
    assert.equal(gapBandDays(90, { band_3m_plus_days: junk }), 10);
    assert.ok(gapBandDays(31, { band_1m_days: junk }) <= 3);
    assert.ok(gapBandDays(45, { band_2m_days: junk }) <= 6);
    assert.ok(gapBandDays(90, { band_3m_plus_days: junk }) <= 10);
  }
});

test('gapBandDays treats 0 as a real band value', () => {
  assert.equal(gapBandDays(31, { band_1m_days: 0 }), 0);
  assert.equal(gapBandDays(45, { band_2m_days: 0 }), 0);
  assert.equal(gapBandDays(90, { band_3m_plus_days: 0 }), 0);
  assert.equal(gapBandDays(31, { band_1m_days: '0' }), 0);
});

test('gapBandDays does not read audience-specific column names', () => {
  assert.equal(gapBandDays(31, {
    inquiry_gap_band_1m_days: 1,
    search_gap_band_1m_days: 9,
  }), 3);
});

test('booking horizon edges are inclusive through day 60', () => {
  const today = '2026-08-17';
  assert.equal(bookingHorizonDecision('2026-10-15', { today, bookingHorizonDays: 60 }).days_out, 59);
  assert.equal(bookingHorizonDecision('2026-10-15', { today, bookingHorizonDays: 60 }).too_far_out, false);
  assert.equal(bookingHorizonDecision('2026-10-16', { today, bookingHorizonDays: 60 }).days_out, 60);
  assert.equal(bookingHorizonDecision('2026-10-16', { today, bookingHorizonDays: 60 }).too_far_out, false);
  assert.equal(bookingHorizonDecision('2026-10-17', { today, bookingHorizonDays: 60 }).days_out, 61);
  assert.equal(bookingHorizonDecision('2026-10-17', { today, bookingHorizonDays: 60 }).too_far_out, true);
});

test('booking check-back arithmetic uses the supplied business date', () => {
  assert.deepEqual(bookingHorizonDecision('2026-11-15', { today: '2026-08-17', bookingHorizonDays: 60 }), {
    request_date: '2026-11-15',
    today: '2026-08-17',
    days_out: 90,
    booking_horizon_days: 60,
    too_far_out: true,
    check_back_in_days: 30,
    check_back_on: '2026-09-16',
  });
  assert.deepEqual(bookingHorizonDecision('2026-12-06', { today: '2026-08-17', bookingHorizonDays: 60 }), {
    request_date: '2026-12-06',
    today: '2026-08-17',
    days_out: 111,
    booking_horizon_days: 60,
    too_far_out: true,
    check_back_in_days: 51,
    check_back_on: '2026-10-07',
  });
});

test('bookingGapLimitForLease uses flat 10 when length is unknown and bands when move_out is present', () => {
  assert.equal(bookingGapLimitForLease('2026-11-15', null), 10);
  assert.equal(bookingGapLimitForLease('2026-11-15', '2026-12-15'), 3);
  assert.equal(bookingGapLimitForLease('2026-11-15', '2027-01-15'), 6);
  assert.equal(bookingGapLimitForLease('2026-11-15', '2027-02-15'), 10);
  assert.equal(bookingGapLimitForLease('2026-11-15', '2027-03-20'), 10);
  assert.equal(bookingGapLimitForLease('2026-11-15', '2026-12-15', { band_1m_days: 1 }), 1);
  assert.equal(bookingGapLimitForLease('2026-11-15', null, { band_3m_plus_days: 4 }), 10);
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
    return { max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: null };
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
        partner_forward: {
          applies: false,
          message: null,
        },
        phrasing: {
          certain: '{units} available from {date}',
          uncertain: "We may also have {units} available, however the tenant may renew, they're not sure",
        },
      },
    };

    assert.equal(result.statusCode, 200);
    assert.equal(JSON.stringify(result.body), JSON.stringify(expected));
    assert.deepEqual(computeOptions, {
      page: false,
      settings: { max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: null },
      audience: 'inquiry',
    });
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
  advertising.loadSettings = async () => ({ footer: null, photo_root: '/photos', partner_forward_message: 'Forward message', min_gap_days: 40, max_gap_days: 14, hard_max_gap_days: 365, lead_days_nr: 60, lead_days_other: 45 });
  advertising.computeVacancies = async () => ({
    vacancies: [
      // end_date === available_from; chosen so gaps stay exact / +30 / after-target.
      vacancySourceRow({ unit_id: 'u-gap', unit_name: '8B', property_name: 'Harbour Court', end_date: '2026-09-15', days_left: 33 }),
      vacancySourceRow({ unit_id: 'u-after', unit_name: '2C', property_name: 'Kowloon Loft', end_date: '2026-11-01', days_left: 80 }),
      vacancySourceRow({ unit_id: 'u-exact', unit_name: '4A', property_name: 'Central House', end_date: '2026-10-15', days_left: 63 }),
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
    assert.deepEqual(result.body.data.partner_forward, { applies: false, message: 'Forward message' });
    assert.equal(typeof result.body.data.phrasing.earlier, 'string');
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies applies free_on after shaping and before limit', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: null });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-incoming', unit_name: '1A', tier: 1, end_date: null, next_move_in_date: '2026-10-10' }),
      vacancySourceRow({ unit_id: 'u-late', unit_name: '2A', tier: 2, end_date: '2026-10-19' }),
      vacancySourceRow({ unit_id: 'u-free', unit_name: '3A', tier: 1, end_date: null, next_move_in_date: null }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-10-15', limit: '1' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies.map(row => row.unit_id), ['u-free']);
    assert.equal(result.body.data.count, 1);
    assert.equal(result.body.data.free_on, '2026-10-15');
    assert.equal(result.body.data.hidden_by_free_on, 2);
    assert.equal(result.body.data.no_match_reason, null);
    assert.deepEqual(result.body.data.next_available.map(row => row.unit_id), ['u-late']);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies offers later rows when free_on removes every shaped row', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: 'Forward message' });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-oct', unit_name: '3A', property_name: 'Beta', end_date: '2026-10-11' }),
      vacancySourceRow({ unit_id: 'u-sep-b', unit_name: '2A', property_name: 'Beta', end_date: '2026-09-16' }),
      vacancySourceRow({ unit_id: 'u-sep-a', unit_name: '1A', property_name: 'Alpha', end_date: '2026-09-16' }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-08-24', limit: '50' });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.count, 0);
    assert.deepEqual(result.body.data.next_available.map(row => row.unit_id), ['u-sep-a', 'u-sep-b', 'u-oct']);
    assert.deepEqual(result.body.data.next_available.map(row => row.availability.available_from), ['2026-09-16', '2026-09-16', '2026-10-11']);
    assert.equal(typeof result.body.data.phrasing.later, 'string');
    assert.equal(result.body.data.hidden_by_free_on, 3);
    assert.equal(result.body.data.partner_forward.applies, false);
    assert.equal(result.body.data.no_match_reason, 'none_free_on_date');
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies separates free_on matches, later rows, and unavailable rows', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: 'Forward message' });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-free', unit_name: '1A', tier: 1, end_date: null, next_move_in_date: null }),
      vacancySourceRow({ unit_id: 'u-late', unit_name: '2A', tier: 2, end_date: '2026-10-19' }),
      vacancySourceRow({ unit_id: 'u-incoming', unit_name: '3A', tier: 1, end_date: null, next_move_in_date: '2026-10-10' }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-10-15' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies.map(row => row.unit_id), ['u-free']);
    assert.deepEqual(result.body.data.next_available.map(row => row.unit_id), ['u-late']);
    assert.equal(result.body.data.vacancies.some(row => row.unit_id === 'u-incoming'), false);
    assert.equal(result.body.data.next_available.some(row => row.unit_id === 'u-incoming'), false);
    assert.equal(result.body.data.hidden_by_free_on, 2);
    assert.deepEqual(result.body.data.partner_forward, { applies: false, message: 'Forward message' });
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies reports none_free_on_date when free_on removes every shaped row', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: 'Forward message' });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-incoming', unit_name: '1A', tier: 1, end_date: null, next_move_in_date: '2026-10-10' }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-10-15' });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.data.count, 0);
    assert.equal(result.body.data.hidden_by_free_on, 1);
    assert.equal(result.body.data.no_match_reason, 'none_free_on_date');
    assert.equal(Object.hasOwn(result.body.data, 'next_available'), false);
    assert.equal(Object.hasOwn(result.body.data.phrasing, 'later'), false);
    assert.deepEqual(result.body.data.partner_forward, { applies: true, message: 'Forward message' });
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies applies limit to next_available independently', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: null });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-free-1', unit_name: '1A', tier: 1, end_date: null, next_move_in_date: null }),
      vacancySourceRow({ unit_id: 'u-free-2', unit_name: '1B', tier: 1, end_date: null, next_move_in_date: null }),
      vacancySourceRow({ unit_id: 'u-late-1', unit_name: '2A', tier: 2, end_date: '2026-10-19' }),
      vacancySourceRow({ unit_id: 'u-late-2', unit_name: '2B', tier: 2, end_date: '2026-10-20' }),
    ],
  });

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-10-15', limit: '1' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies.map(row => row.unit_id), ['u-free-1']);
    assert.deepEqual(result.body.data.next_available.map(row => row.unit_id), ['u-late-1']);
    assert.equal(result.body.data.count, 1);
    assert.equal(result.body.data.hidden_by_free_on, 2);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
  }
});

test('GET /vacancies beyond horizon returns matching NR from the on-demand lookup', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  let computeCalled = false;
  let lookupOptions = null;
  advertising.loadSettings = async () => ({
    max_gap_days: 10,
    hard_max_gap_days: 20,
    partner_forward_message: 'Forward message',
    inquiry_booking_horizon_days: 60,
    inquiry_too_far_out_phrase: 'Check back {check_back_on}',
  });
  advertising.computeVacancies = async () => {
    computeCalled = true;
    return { vacancies: [] };
  };
  advertising.findBeyondHorizonNrVacancies = async (_pool, _orgId, options) => {
    lookupOptions = options;
    return [
      vacancySourceRow({ unit_id: 'u-nr', unit_name: 'NR', tier: 2, end_date: '2026-11-12', days_left: 87 }),
      vacancySourceRow({ unit_id: 'u-too-early', unit_name: 'Early', tier: 2, end_date: '2026-10-01', days_left: 45 }),
      vacancySourceRow({ unit_id: 'u-mr', unit_name: 'MR', tier: 3, intent: 'MR', end_date: '2026-11-10', days_left: 85 }),
    ];
  };

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-11-15', move_out: '2026-12-15' });

    assert.equal(result.statusCode, 200);
    assert.equal(computeCalled, false);
    assert.deepEqual(lookupOptions, {
      requestDate: '2026-11-15',
      maxGapDays: 3,
      propertyId: null,
      limit: 50,
    });
    assert.deepEqual(result.body.data.vacancies.map(row => row.unit_id), ['u-nr']);
    assert.equal(result.body.data.vacancies[0].availability.available_from, '2026-11-12');
    assert.equal(result.body.data.no_match_reason, null);
    assert.equal(Object.hasOwn(result.body.data, 'check_back_in_days'), false);
    assert.equal(Object.hasOwn(result.body.data, 'next_available'), false);
    assert.deepEqual(result.body.data.partner_forward, { applies: false, message: null });
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

test('GET /vacancies beyond horizon withholds tier 1 and tier 3 and returns too_far_out', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  advertising.loadSettings = async () => ({
    max_gap_days: 10,
    hard_max_gap_days: 20,
    partner_forward_message: 'Forward message',
    inquiry_booking_horizon_days: 60,
    inquiry_too_far_out_phrase: null,
  });
  advertising.computeVacancies = async () => ({
    vacancies: [
      vacancySourceRow({ unit_id: 'u-vacant', tier: 1, end_date: null }),
      vacancySourceRow({ unit_id: 'u-mr', tier: 3, intent: 'MR', end_date: '2026-11-15' }),
    ],
  });
  advertising.findBeyondHorizonNrVacancies = async () => [];

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-11-15' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies, []);
    assert.equal(result.body.data.no_match_reason, 'too_far_out');
    assert.equal(result.body.data.check_back_in_days, 30);
    assert.equal(result.body.data.check_back_on, '2026-09-16');
    assert.equal(result.body.data.booking_horizon_days, 60);
    assert.equal(result.body.data.booking_gap_days, 10);
    assert.equal(Object.hasOwn(result.body.data, 'next_available'), false);
    assert.deepEqual(result.body.data.partner_forward, { applies: false, message: null });
    assert.equal(result.body.data.phrasing.too_far_out, null);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

// The sibling test above stubs the NR lookup to [] and so proves the too_far_out
// CONTRACT, not the tier gate — it passes even if the gate is deleted, because the
// branch has nothing to filter. This one feeds the gate rows it must reject, so the
// gate is load-bearing rather than decorative: a later loosening of the query would
// otherwise ship may-renew stock to someone asking about a date months out.
//
// Tier 3 is what the tier check actually guards. Tier 1 is withheld by TWO other
// mechanisms and reaches this gate already harmless: the SQL selects contract_type=3
// only, and vacancyToPublicShape gives a tier-1 row available_from=null, which fails
// the gap comparison on its own. Deleting the tier check therefore leaks tier 3 (this
// test fails) but never tier 1 — worth knowing before trusting the check alone.
test('beyond horizon, only NR survives the gate even when tier 1 and 3 fit the date exactly', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  advertising.loadSettings = async () => ({
    max_gap_days: 10,
    hard_max_gap_days: 20,
    partner_forward_message: 'Forward message',
    inquiry_booking_horizon_days: 60,
    inquiry_too_far_out_phrase: null,
  });
  advertising.computeVacancies = async () => ({ vacancies: [] });
  // Deliberately returns what the SQL should never return, so the JS gate is
  // load-bearing rather than decorative.
  advertising.findBeyondHorizonNrVacancies = async () => [
    vacancySourceRow({ unit_id: 'u-vacant', unit_name: 'V', tier: 1, intent: 'Vacant', end_date: '2026-11-15' }),
    vacancySourceRow({ unit_id: 'u-mr', unit_name: 'M', tier: 3, intent: 'MR', end_date: '2026-11-15' }),
    vacancySourceRow({ unit_id: 'u-nr', unit_name: 'N', tier: 2, intent: 'NR', end_date: '2026-11-15' }),
  ];

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-11-15' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(
      result.body.data.vacancies.map(row => row.unit_id),
      ['u-nr'],
      'only the NR unit may be offered beyond the booking horizon'
    );
    assert.equal(result.body.data.no_match_reason, null);
    // A match means there is something to offer, so there is nothing to come back for.
    assert.equal(Object.hasOwn(result.body.data, 'check_back_in_days'), false);
    assert.deepEqual(result.body.data.partner_forward, { applies: false, message: null });
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

// Operator decision, 2026-08-17: a manual vacancy override must NOT be offered
// beyond the booking horizon either. Overrides are merged inside computeVacancies,
// which the beyond-horizon branch deliberately never consults — so this asserts the
// branch stays sealed. A future "fall back to the roster when no NR matches" change
// would reopen it, and this is the test that would object.
test('beyond horizon, a manual vacancy override is not offered', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  advertising.loadSettings = async () => ({
    max_gap_days: 10,
    hard_max_gap_days: 20,
    partner_forward_message: 'Forward message',
    inquiry_booking_horizon_days: 60,
    inquiry_too_far_out_phrase: null,
  });
  // A manual override that fits the requested date exactly. Inside the horizon this
  // would be offered; beyond it, the operator wants silence.
  advertising.computeVacancies = async () => ({
    vacancies: [vacancySourceRow({
      unit_id: 'u-manual', unit_name: 'MAN', tier: 3, intent: 'Manual',
      source: 'manual', end_date: '2026-11-15',
    })],
  });
  advertising.findBeyondHorizonNrVacancies = async () => [];

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-11-15' });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.data.vacancies, [], 'a manual override must stay withheld beyond the horizon');
    assert.equal(result.body.data.no_match_reason, 'too_far_out');
    assert.equal(result.body.data.check_back_in_days, 30);
    // The manual phrasing template must not be advertised either — there is nothing
    // manual on offer to describe.
    assert.equal(Object.hasOwn(result.body.data.phrasing, 'manual'), false);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

test('GET /vacancies target_date cannot bypass the horizon', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  let computeCalled = false;
  advertising.loadSettings = async () => ({ max_gap_days: 10, hard_max_gap_days: 20, partner_forward_message: null, inquiry_booking_horizon_days: 60 });
  advertising.computeVacancies = async () => {
    computeCalled = true;
    return { vacancies: [vacancySourceRow({ unit_id: 'u-vacant', tier: 1, end_date: null })] };
  };
  advertising.findBeyondHorizonNrVacancies = async () => [];

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { target_date: '2026-11-15' });

    assert.equal(result.statusCode, 200);
    assert.equal(computeCalled, false);
    assert.equal(result.body.data.no_match_reason, 'too_far_out');
    assert.equal(result.body.data.target_date, '2026-11-15');
    assert.equal(Object.hasOwn(result.body.data, 'next_available'), false);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

test('GET /vacancies rejects malformed free_on', async () => {
  const publicRouter = require('../src/routes/public');
  const handler = publicRouter.stack
    .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
    .route.stack.at(-1).handle;
  const result = await callVacanciesHandler(handler, { free_on: '2026-02-30' });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /free_on must be in YYYY-MM-DD format/);
});

test('GET /vacancies rejects malformed move_out', async () => {
  const publicRouter = require('../src/routes/public');
  const handler = publicRouter.stack
    .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
    .route.stack.at(-1).handle;
  const result = await callVacanciesHandler(handler, { free_on: '2026-10-15', move_out: '2026-02-30' });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /move_out must be in YYYY-MM-DD format/);
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

test('PUT /advertising/settings rejects invalid inquiry_booking_horizon_days', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;

  const result = await callSettingsPutHandler(handler, { inquiry_booking_horizon_days: null }, { execute: async () => {
    throw new Error('pool should not be used for invalid inquiry booking input');
  } });

  assert.equal(result.statusCode, 400);
  assert.match(result.body.message, /inquiry_booking_horizon_days must be an integer between 0 and 365/);
});

test('GET /vacancies beyond horizon uses operator gap bands from settings', async () => {
  const advertising = require('../src/routes/advertising');
  const originalComputeVacancies = advertising.computeVacancies;
  const originalLoadSettings = advertising.loadSettings;
  const originalFindNr = advertising.findBeyondHorizonNrVacancies;
  let lookupOptions = null;
  advertising.loadSettings = async () => ({
    max_gap_days: 10,
    hard_max_gap_days: 20,
    partner_forward_message: 'Forward message',
    inquiry_booking_horizon_days: 60,
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
    search_gap_band_1m_days: 9,
    search_gap_band_2m_days: 9,
    search_gap_band_3m_plus_days: 9,
  });
  advertising.computeVacancies = async () => ({ vacancies: [] });
  advertising.findBeyondHorizonNrVacancies = async (_pool, _orgId, options) => {
    lookupOptions = options;
    return [];
  };

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/vacancies' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { free_on: '2026-11-15', move_out: '2026-12-15' });

    assert.equal(result.statusCode, 200);
    assert.equal(lookupOptions.maxGapDays, 1);
    assert.equal(result.body.data.booking_gap_days, 1);
  } finally {
    advertising.computeVacancies = originalComputeVacancies;
    advertising.loadSettings = originalLoadSettings;
    advertising.findBeyondHorizonNrVacancies = originalFindNr;
  }
});

test('PUT /advertising/settings accepts inquiry booking fields', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;
  const executed = [];
  const pool = {
    execute: async (sql, params) => {
      executed.push({ sql, params });
      if (/SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 60,
          inquiry_too_far_out_phrase: null,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  const result = await callSettingsPutHandler(handler, {
    inquiry_booking_horizon_days: 90,
    inquiry_too_far_out_phrase: 'Check back {check_back_on}',
  }, pool);

  assert.equal(result.statusCode, 200);
  const upsert = executed.find(item => /INSERT INTO advertising_setting/.test(item.sql));
  assert.match(upsert.sql, /inquiry_booking_horizon_days/);
  assert.match(upsert.sql, /inquiry_too_far_out_phrase/);
  assert.ok(upsert.params.includes(90));
  assert.ok(upsert.params.includes('Check back {check_back_on}'));
});

test('GET /units/search passes SEARCH gap bands, not inquiry', async () => {
  const advertising = require('../src/routes/advertising');
  const unitSearch = require('../src/services/unitSearch');
  const originalLoadSettings = advertising.loadSettings;
  const originalSearchUnits = unitSearch.searchUnits;
  let capturedBands = null;
  advertising.loadSettings = async () => ({
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
    search_gap_band_1m_days: 7,
    search_gap_band_2m_days: 8,
    search_gap_band_3m_plus_days: 9,
  });
  unitSearch.searchUnits = async (_pool, criteria) => {
    capturedBands = criteria.gapBands;
    return { results: [], total: 0 };
  };

  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const publicRouter = require('../src/routes/public');
    const handler = publicRouter.stack
      .find(layer => layer.route?.path === '/units/search' && layer.route.methods.get)
      .route.stack.at(-1).handle;
    const result = await callVacanciesHandler(handler, { move_in_date: '2026-11-15', move_out_date: '2026-12-15' });

    assert.equal(result.statusCode, 200);
    assert.equal(capturedBands.band_1m_days, 7);
    assert.equal(capturedBands.band_2m_days, 8);
    assert.equal(capturedBands.band_3m_plus_days, 9);
    assert.equal(capturedBands.source.band_1m_days, 'search');
  } finally {
    advertising.loadSettings = originalLoadSettings;
    unitSearch.searchUnits = originalSearchUnits;
    delete require.cache[require.resolve('../src/routes/public')];
  }
});

test('search_available_units tool passes SEARCH gap bands, not inquiry', async () => {
  const advertising = require('../src/routes/advertising');
  const unitSearch = require('../src/services/unitSearch');
  const originalLoadSettings = advertising.loadSettings;
  const originalSearchUnits = unitSearch.searchUnits;
  let capturedBands = null;
  advertising.loadSettings = async () => ({
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
    search_gap_band_1m_days: 7,
    search_gap_band_2m_days: 8,
    search_gap_band_3m_plus_days: 9,
  });
  unitSearch.searchUnits = async (_pool, criteria) => {
    capturedBands = criteria.gapBands;
    return { results: [], total: 0 };
  };

  try {
    delete require.cache[require.resolve('../src/services/chatTools')];
    const { toolsForCapabilities } = require('../src/services/chatTools');
    const tool = toolsForCapabilities({ can_search: true }).byName.search_available_units;
    await tool.execute(
      { pool: {}, orgId: 'org1' },
      { move_in_date: '2026-11-15', move_out_date: '2026-12-15', city: 'causeway bay', budget: 15000 },
    );
    assert.equal(capturedBands.band_1m_days, 7);
    assert.equal(capturedBands.band_2m_days, 8);
    assert.equal(capturedBands.band_3m_plus_days, 9);
    assert.equal(capturedBands.source.band_1m_days, 'search');
  } finally {
    advertising.loadSettings = originalLoadSettings;
    unitSearch.searchUnits = originalSearchUnits;
    delete require.cache[require.resolve('../src/services/chatTools')];
  }
});

test('PUT /advertising/settings accepts valid inquiry gap bands', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;
  const executed = [];
  const pool = {
    execute: async (sql, params) => {
      executed.push({ sql, params });
      if (/SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 60,
          inquiry_too_far_out_phrase: null,
          inquiry_gap_band_1m_days: 3,
          inquiry_gap_band_2m_days: 6,
          inquiry_gap_band_3m_plus_days: 10,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  const result = await callSettingsPutHandler(handler, {
    inquiry_gap_band_1m_days: 0,
    inquiry_gap_band_2m_days: 4,
    inquiry_gap_band_3m_plus_days: 8,
  }, pool);

  assert.equal(result.statusCode, 200);
  const upsert = executed.find(item => /INSERT INTO advertising_setting/.test(item.sql));
  assert.match(upsert.sql, /inquiry_gap_band_1m_days/);
  assert.match(upsert.sql, /inquiry_gap_band_2m_days/);
  assert.match(upsert.sql, /inquiry_gap_band_3m_plus_days/);
  assert.ok(upsert.params.includes(0));
  assert.ok(upsert.params.includes(4));
  assert.ok(upsert.params.includes(8));
});

test('PUT /advertising/settings accepts valid search gap bands independently', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;
  const executed = [];
  const pool = {
    execute: async (sql, params) => {
      executed.push({ sql, params });
      if (/SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 60,
          inquiry_too_far_out_phrase: null,
          inquiry_gap_band_1m_days: 1,
          inquiry_gap_band_2m_days: 2,
          inquiry_gap_band_3m_plus_days: 4,
          search_gap_band_1m_days: 3,
          search_gap_band_2m_days: 6,
          search_gap_band_3m_plus_days: 10,
        }]];
      }
      return [{ affectedRows: 1 }];
    },
  };

  const result = await callSettingsPutHandler(handler, {
    search_gap_band_1m_days: 0,
    search_gap_band_2m_days: 5,
    search_gap_band_3m_plus_days: 11,
  }, pool);

  assert.equal(result.statusCode, 200);
  const upsert = executed.find(item => /INSERT INTO advertising_setting/.test(item.sql));
  assert.match(upsert.sql, /search_gap_band_1m_days/);
  assert.match(upsert.sql, /search_gap_band_2m_days/);
  assert.match(upsert.sql, /search_gap_band_3m_plus_days/);
  assert.doesNotMatch(upsert.sql, /inquiry_gap_band_1m_days = VALUES/);
  assert.ok(upsert.params.includes(0));
  assert.ok(upsert.params.includes(5));
  assert.ok(upsert.params.includes(11));
});

test('PUT /advertising/settings rejects out-of-range inquiry gap bands', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;

  const missing = await callSettingsPutHandler(handler, { inquiry_gap_band_1m_days: null }, { execute: async () => {
    throw new Error('pool should not be used for invalid inquiry gap band input');
  } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body.message, /inquiry_gap_band_1m_days must be an integer between 0 and 365/);

  const tooHigh = await callSettingsPutHandler(handler, { inquiry_gap_band_3m_plus_days: 366 }, { execute: async () => {
    throw new Error('pool should not be used for invalid inquiry gap band input');
  } });
  assert.equal(tooHigh.statusCode, 400);
  assert.match(tooHigh.body.message, /inquiry_gap_band_3m_plus_days must be an integer between 0 and 365/);

  const searchMissing = await callSettingsPutHandler(handler, { search_gap_band_1m_days: null }, { execute: async () => {
    throw new Error('pool should not be used for invalid search gap band input');
  } });
  assert.equal(searchMissing.statusCode, 400);
  assert.match(searchMissing.body.message, /search_gap_band_1m_days must be an integer between 0 and 365/);

  const searchTooHigh = await callSettingsPutHandler(handler, { search_gap_band_3m_plus_days: 366 }, { execute: async () => {
    throw new Error('pool should not be used for invalid search gap band input');
  } });
  assert.equal(searchTooHigh.statusCode, 400);
  assert.match(searchTooHigh.body.message, /search_gap_band_3m_plus_days must be an integer between 0 and 365/);
});

test('loadSettings falls back to default gap bands on an older schema', async () => {
  const advertising = require('../src/routes/advertising');
  const pool = {
    execute: async (sql) => {
      if (/inquiry_gap_band_1m_days/.test(sql)) {
        const err = new Error("Unknown column 'inquiry_gap_band_1m_days' in 'field list'");
        err.code = 'ER_BAD_FIELD_ERROR';
        err.errno = 1054;
        throw err;
      }
      if (/inquiry_booking_horizon_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 90,
          inquiry_too_far_out_phrase: 'hello',
        }]];
      }
      throw new Error(`unexpected loadSettings query: ${sql}`);
    },
  };

  const settings = await advertising.loadSettings(pool, 'org1');
  assert.equal(settings.inquiry_gap_band_1m_days, 3);
  assert.equal(settings.inquiry_gap_band_2m_days, 6);
  assert.equal(settings.inquiry_gap_band_3m_plus_days, 10);
  assert.equal(settings.search_gap_band_1m_days, 3);
  assert.equal(settings.search_gap_band_2m_days, 6);
  assert.equal(settings.search_gap_band_3m_plus_days, 10);
  assert.equal(settings.inquiry_booking_horizon_days, 90);
  assert.equal(settings.inquiry_too_far_out_phrase, 'hello');
});

test('loadSettings keeps inquiry bands and defaults search bands when search columns are absent', async () => {
  const advertising = require('../src/routes/advertising');
  const pool = {
    execute: async (sql) => {
      if (/search_gap_band_1m_days/.test(sql)) {
        const err = new Error("Unknown column 'search_gap_band_1m_days' in 'field list'");
        err.code = 'ER_BAD_FIELD_ERROR';
        err.errno = 1054;
        throw err;
      }
      if (/inquiry_gap_band_1m_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 90,
          inquiry_too_far_out_phrase: 'hello',
          inquiry_gap_band_1m_days: 1,
          inquiry_gap_band_2m_days: 2,
          inquiry_gap_band_3m_plus_days: 4,
        }]];
      }
      throw new Error(`unexpected loadSettings query: ${sql}`);
    },
  };

  const settings = await advertising.loadSettings(pool, 'org1');
  assert.equal(settings.inquiry_gap_band_1m_days, 1);
  assert.equal(settings.inquiry_gap_band_2m_days, 2);
  assert.equal(settings.inquiry_gap_band_3m_plus_days, 4);
  assert.equal(settings.search_gap_band_1m_days, 3);
  assert.equal(settings.search_gap_band_2m_days, 6);
  assert.equal(settings.search_gap_band_3m_plus_days, 10);
});

test('PUT /advertising/settings still saves when search gap columns are missing', async () => {
  const advertising = require('../src/routes/advertising');
  const handler = advertising.stack
    .find(layer => layer.route?.path === '/settings' && layer.route.methods.put)
    .route.stack.at(-1).handle;
  const executed = [];
  const pool = {
    execute: async (sql, params) => {
      executed.push({ sql, params });
      if (/SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
          min_gap_days: 40,
          max_gap_days: 10,
          hard_max_gap_days: 20,
          lead_days_nr: 60,
          lead_days_other: 45,
          inquiry_min_gap_days: 40,
          inquiry_lead_days_nr: 60,
          inquiry_lead_days_other: 45,
          inquiry_booking_horizon_days: 60,
          inquiry_too_far_out_phrase: null,
          inquiry_gap_band_1m_days: 3,
          inquiry_gap_band_2m_days: 6,
          inquiry_gap_band_3m_plus_days: 10,
        }]];
      }
      if (/search_gap_band_1m_days/.test(sql)) {
        const err = new Error("Unknown column 'search_gap_band_1m_days' in 'field list'");
        err.code = 'ER_BAD_FIELD_ERROR';
        err.errno = 1054;
        throw err;
      }
      return [{ affectedRows: 1 }];
    },
  };

  const result = await callSettingsPutHandler(handler, { inquiry_booking_horizon_days: 90 }, pool);
  assert.equal(result.statusCode, 200);
  const upserts = executed.filter(item => /INSERT INTO advertising_setting/.test(item.sql));
  assert.ok(upserts.length >= 2);
  assert.match(upserts[0].sql, /search_gap_band_1m_days/);
  assert.doesNotMatch(upserts.at(-1).sql, /search_gap_band_1m_days/);
  assert.match(upserts.at(-1).sql, /inquiry_booking_horizon_days/);
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
      if (/SELECT footer, photo_root, partner_forward_message, min_gap_days, max_gap_days, hard_max_gap_days/.test(sql)) {
        return [[{
          footer: null,
          photo_root: '/photos',
          partner_forward_message: null,
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
  const req = {
    query,
    pool: {},
    apiKey: { orgId: 'org1' },
    protocol: 'http',
    get: () => 'localhost',
  };
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
