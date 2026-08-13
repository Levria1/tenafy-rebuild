const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAvailabilityWindows } = require('../src/utils/advertisingPlan');

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
