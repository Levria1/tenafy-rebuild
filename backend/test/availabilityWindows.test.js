const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveAvailabilityWindows,
  resolveGapBands,
  resolveInquiryBookingSettings,
} = require('../src/utils/advertisingPlan');

const advertisingSettings = {
  min_gap_days: 40,
  lead_days_nr: 60,
  lead_days_other: 45,
};

function windows(settings, audience) {
  const { source, ...values } = resolveAvailabilityWindows(settings, audience);
  return values;
}

test('advertising and inquiry windows resolve independently', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: 10,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  };

  assert.deepEqual(windows(settings, 'advertising'), {
    min_gap_days: 40,
    lead_days_nr: 60,
    lead_days_other: 45,
  });
  assert.deepEqual(windows(settings, 'inquiry'), {
    min_gap_days: 10,
    lead_days_nr: 30,
    lead_days_other: 20,
  });
});

test('changing one audience does not change the other audience result', () => {
  // This independence is now the point of the design: there is no shared fallback
  // path, so changing advertising does not retune inquiries and vice versa.
  const settings = {
    min_gap_days: 55,
    lead_days_nr: 75,
    lead_days_other: 65,
    inquiry_min_gap_days: 10,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  };

  assert.deepEqual(windows(settings, 'advertising'), {
    min_gap_days: 55,
    lead_days_nr: 75,
    lead_days_other: 65,
  });
  assert.deepEqual(windows(settings, 'inquiry'), {
    min_gap_days: 10,
    lead_days_nr: 30,
    lead_days_other: 20,
  });

  assert.deepEqual(windows({
    ...settings,
    min_gap_days: 5,
    lead_days_nr: 6,
    lead_days_other: 7,
  }, 'inquiry'), {
    min_gap_days: 10,
    lead_days_nr: 30,
    lead_days_other: 20,
  });
  assert.deepEqual(windows({
    ...settings,
    inquiry_min_gap_days: 88,
    inquiry_lead_days_nr: 89,
    inquiry_lead_days_other: 90,
  }, 'advertising'), {
    min_gap_days: 55,
    lead_days_nr: 75,
    lead_days_other: 65,
  });
});

test('zero is a real inquiry value', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  };

  // Zero means "warn on any gap"; it must not be treated as unset.
  assert.equal(resolveAvailabilityWindows(settings, 'inquiry').min_gap_days, 0);
});

test('junk inquiry values fall back to inquiry defaults, never advertising values', () => {
  const base = {
    min_gap_days: 99,
    lead_days_nr: 98,
    lead_days_other: 97,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  };

  // Cross-audience fallback is exactly what was removed. Junk direct-DB values
  // fail closed to the inquiry default for this field, not to advertising.
  for (const junk of ['  ', '', {}, [], true, '40abc']) {
    const r = resolveAvailabilityWindows({ ...base, inquiry_min_gap_days: junk }, 'inquiry');
    assert.equal(r.min_gap_days, 40, `${JSON.stringify(junk)} must fall back to the inquiry default`);
    assert.equal(r.source.min_gap_days, 'inquiry');
  }
});

test('unrecognised and omitted audiences use advertising values without throwing', () => {
  for (const audience of ['facebook', undefined, null]) {
    assert.deepEqual(windows({
      min_gap_days: 4,
      lead_days_nr: 6,
      lead_days_other: 5,
      inquiry_min_gap_days: 1,
      inquiry_lead_days_nr: 2,
      inquiry_lead_days_other: 3,
    }, audience), {
      min_gap_days: 4,
      lead_days_nr: 6,
      lead_days_other: 5,
    });
  }
});

test('source reports which set was read', () => {
  const inquiry = resolveAvailabilityWindows({
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  }, 'inquiry');
  const advertising = resolveAvailabilityWindows({
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  }, 'advertising');

  assert.deepEqual(inquiry.source, {
    min_gap_days: 'inquiry',
    lead_days_nr: 'inquiry',
    lead_days_other: 'inquiry',
  });
  assert.deepEqual(advertising.source, {
    min_gap_days: 'advertising',
    lead_days_nr: 'advertising',
    lead_days_other: 'advertising',
  });
});

test('real values survive, including 0 and numeric strings', () => {
  const base = { min_gap_days: 40, lead_days_nr: 60, lead_days_other: 45 };
  for (const [given, expected] of [[0, 0], [5, 5], [365, 365], ['30', 30], [' 30 ', 30]]) {
    const r = resolveAvailabilityWindows({
      ...base,
      inquiry_min_gap_days: given,
      inquiry_lead_days_nr: 30,
      inquiry_lead_days_other: 20,
    }, 'inquiry');
    assert.equal(r.min_gap_days, expected, `${JSON.stringify(given)} should resolve to ${expected}`);
    assert.equal(r.source.min_gap_days, 'inquiry');
  }
});

// Everything interpolated into SQL must be a finite number. /units/available builds its
// gap filter with `INTERVAL ${min_gap_days} DAY`, so a string reaching that point would
// be an injection vector.
test('resolveAvailabilityWindows: every resolved window is a finite number', () => {
  const junkValues = ['1 OR 1=1', {}, [], true, '  ', '9e999', '', null, undefined];
  for (const audience of ['advertising', 'inquiry', undefined]) {
    for (const junk of junkValues) {
      const r = resolveAvailabilityWindows({
        min_gap_days: junk,
        lead_days_nr: junk,
        lead_days_other: junk,
        inquiry_min_gap_days: junk,
        inquiry_lead_days_nr: junk,
        inquiry_lead_days_other: junk,
      }, audience);
      for (const f of ['min_gap_days', 'lead_days_nr', 'lead_days_other']) {
        assert.equal(typeof r[f], 'number', `${f} must be a number for ${String(audience)} ${JSON.stringify(junk)}`);
        assert.ok(Number.isFinite(r[f]), `${f} must be finite for ${String(audience)} ${JSON.stringify(junk)}`);
      }
    }
  }
});

test('inquiry booking settings default independently from advertising values', () => {
  const resolved = resolveInquiryBookingSettings({
    min_gap_days: 99,
    lead_days_nr: 98,
    inquiry_booking_horizon_days: undefined,
    inquiry_too_far_out_phrase: null,
  });

  assert.deepEqual(resolved, {
    booking_horizon_days: 60,
    too_far_out_phrase: null,
  });
});

test('inquiry booking settings treat 0 as real and junk as inquiry default', () => {
  assert.equal(resolveInquiryBookingSettings({ inquiry_booking_horizon_days: 0 }).booking_horizon_days, 0);
  for (const junk of ['  ', '', {}, [], true, '60abc']) {
    assert.equal(
      resolveInquiryBookingSettings({ inquiry_booking_horizon_days: junk }).booking_horizon_days,
      60,
      `${JSON.stringify(junk)} must fall back to the inquiry booking default`
    );
  }
});

function gapBands(settings, audience) {
  const { source, ...values } = resolveGapBands(settings, audience);
  return values;
}

test('inquiry and search gap bands both resolve from inquiry columns', () => {
  const settings = {
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
    search_gap_band_1m_days: 7,
    search_gap_band_2m_days: 8,
    search_gap_band_3m_plus_days: 9,
  };

  assert.deepEqual(gapBands(settings, 'inquiry'), {
    band_1m_days: 1,
    band_2m_days: 2,
    band_3m_plus_days: 4,
  });
  assert.deepEqual(gapBands(settings, 'search'), {
    band_1m_days: 1,
    band_2m_days: 2,
    band_3m_plus_days: 4,
  });
});

test('changing inquiry gap bands changes every audience, search columns do not', () => {
  const settings = {
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
    search_gap_band_1m_days: 7,
    search_gap_band_2m_days: 8,
    search_gap_band_3m_plus_days: 9,
  };

  assert.deepEqual(gapBands({
    ...settings,
    inquiry_gap_band_1m_days: 11,
    inquiry_gap_band_2m_days: 12,
    inquiry_gap_band_3m_plus_days: 13,
  }, 'search'), {
    band_1m_days: 11,
    band_2m_days: 12,
    band_3m_plus_days: 13,
  });
  assert.deepEqual(gapBands({
    ...settings,
    search_gap_band_1m_days: 21,
    search_gap_band_2m_days: 22,
    search_gap_band_3m_plus_days: 23,
  }, 'inquiry'), {
    band_1m_days: 1,
    band_2m_days: 2,
    band_3m_plus_days: 4,
  });
});

test('junk search columns are ignored in favour of inquiry values', () => {
  const base = {
    inquiry_gap_band_1m_days: 1,
    inquiry_gap_band_2m_days: 2,
    inquiry_gap_band_3m_plus_days: 4,
  };
  for (const junk of ['  ', '', {}, [], true, '3abc']) {
    const r = resolveGapBands({
      ...base,
      search_gap_band_1m_days: junk,
      search_gap_band_2m_days: junk,
      search_gap_band_3m_plus_days: junk,
    }, 'search');
    assert.equal(r.band_1m_days, 1, `${JSON.stringify(junk)} must use inquiry 1m`);
    assert.equal(r.band_2m_days, 2, `${JSON.stringify(junk)} must use inquiry 2m`);
    assert.equal(r.band_3m_plus_days, 4, `${JSON.stringify(junk)} must use inquiry 3m`);
    assert.equal(r.source.band_1m_days, 'inquiry');
  }
});

test('junk inquiry bands fall back to hardcoded defaults, never search values', () => {
  const base = {
    search_gap_band_1m_days: 7,
    search_gap_band_2m_days: 8,
    search_gap_band_3m_plus_days: 9,
  };
  for (const junk of ['  ', '', {}, [], true, '3abc']) {
    const r = resolveGapBands({
      ...base,
      inquiry_gap_band_1m_days: junk,
      inquiry_gap_band_2m_days: junk,
      inquiry_gap_band_3m_plus_days: junk,
    }, 'inquiry');
    assert.equal(r.band_1m_days, 3, `${JSON.stringify(junk)} must not inherit search 1m`);
    assert.equal(r.band_2m_days, 6, `${JSON.stringify(junk)} must not inherit search 2m`);
    assert.equal(r.band_3m_plus_days, 10, `${JSON.stringify(junk)} must not inherit search 3m`);
    assert.equal(r.source.band_1m_days, 'inquiry');
  }
});

test('zero is a real gap-band value for both audiences', () => {
  assert.equal(resolveGapBands({ inquiry_gap_band_1m_days: 0 }, 'inquiry').band_1m_days, 0);
  assert.equal(resolveGapBands({ inquiry_gap_band_2m_days: 0, search_gap_band_2m_days: 7 }, 'search').band_2m_days, 0);
});

test('unrecognised gap-band audiences use inquiry columns without throwing', () => {
  for (const audience of ['facebook', undefined, null]) {
    assert.deepEqual(gapBands({
      inquiry_gap_band_1m_days: 1,
      inquiry_gap_band_2m_days: 2,
      inquiry_gap_band_3m_plus_days: 4,
      search_gap_band_1m_days: 7,
      search_gap_band_2m_days: 8,
      search_gap_band_3m_plus_days: 9,
    }, audience), {
      band_1m_days: 1,
      band_2m_days: 2,
      band_3m_plus_days: 4,
    });
  }
});

test('resolveGapBands source reports which set was read', () => {
  const inquiry = resolveGapBands({
    inquiry_gap_band_1m_days: 1,
    search_gap_band_1m_days: 7,
  }, 'inquiry');
  const search = resolveGapBands({
    inquiry_gap_band_1m_days: 1,
    search_gap_band_1m_days: 7,
  }, 'search');

  assert.deepEqual(inquiry.source, {
    band_1m_days: 'inquiry',
    band_2m_days: 'inquiry',
    band_3m_plus_days: 'inquiry',
  });
  assert.deepEqual(search.source, {
    band_1m_days: 'inquiry',
    band_2m_days: 'inquiry',
    band_3m_plus_days: 'inquiry',
  });
});

test('resolveGapBands: every resolved band is a finite number', () => {
  const junkValues = ['1 OR 1=1', {}, [], true, '  ', '9e999', '', null, undefined];
  for (const audience of ['inquiry', 'search', undefined]) {
    for (const junk of junkValues) {
      const r = resolveGapBands({
        inquiry_gap_band_1m_days: junk,
        inquiry_gap_band_2m_days: junk,
        inquiry_gap_band_3m_plus_days: junk,
        search_gap_band_1m_days: junk,
        search_gap_band_2m_days: junk,
        search_gap_band_3m_plus_days: junk,
      }, audience);
      for (const f of ['band_1m_days', 'band_2m_days', 'band_3m_plus_days']) {
        assert.equal(typeof r[f], 'number', `${f} must be a number for ${String(audience)} ${JSON.stringify(junk)}`);
        assert.ok(Number.isFinite(r[f]), `${f} must be finite for ${String(audience)} ${JSON.stringify(junk)}`);
      }
    }
  }
});

test('inquiry booking horizon resolves to a finite number for SQL-safe callers', () => {
  for (const junk of ['1 OR 1=1', {}, [], true, '  ', '9e999', '', null, undefined]) {
    const resolved = resolveInquiryBookingSettings({ inquiry_booking_horizon_days: junk });
    assert.equal(typeof resolved.booking_horizon_days, 'number');
    assert.ok(Number.isFinite(resolved.booking_horizon_days));
  }
});
