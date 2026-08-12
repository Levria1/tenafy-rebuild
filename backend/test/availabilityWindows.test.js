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

test('all-null inquiry overrides are a no-op', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: null,
    inquiry_lead_days_nr: null,
    inquiry_lead_days_other: null,
  };

  // This is the property that makes the migration safe. If it ever fails, the
  // split has introduced drift before the operator deliberately opted in.
  assert.deepEqual(
    resolveAvailabilityWindows(settings, 'inquiry'),
    resolveAvailabilityWindows(settings, 'advertising')
  );
});

test('advertising audience ignores inquiry overrides', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: 20,
  };

  assert.deepEqual(windows(settings, 'advertising'), advertisingSettings);
});

test('inquiry falls back per field', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: null,
    inquiry_lead_days_nr: 30,
    inquiry_lead_days_other: null,
  };

  assert.deepEqual(windows(settings, 'inquiry'), {
    min_gap_days: 40,
    lead_days_nr: 30,
    lead_days_other: 45,
  });
});

test('zero is a real inquiry override', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
  };

  // Zero means "warn on any gap"; it must not be treated as unset.
  assert.equal(resolveAvailabilityWindows(settings, 'inquiry').min_gap_days, 0);
});

test('null undefined empty string and NaN are unset', () => {
  const settings = {
    ...advertisingSettings,
    inquiry_min_gap_days: null,
    inquiry_lead_days_nr: undefined,
    inquiry_lead_days_other: '',
  };

  assert.deepEqual(windows(settings, 'inquiry'), advertisingSettings);
  assert.equal(resolveAvailabilityWindows({
    ...advertisingSettings,
    inquiry_min_gap_days: Number.NaN,
  }, 'inquiry').min_gap_days, 40);
});

test('unrecognised audiences use advertising values without throwing', () => {
  for (const audience of ['facebook', undefined, null]) {
    assert.deepEqual(windows({
      ...advertisingSettings,
      inquiry_min_gap_days: 1,
      inquiry_lead_days_nr: 2,
      inquiry_lead_days_other: 3,
    }, audience), advertisingSettings);
  }
});

test('source reports inquiry only for overridden fields', () => {
  const result = resolveAvailabilityWindows({
    ...advertisingSettings,
    inquiry_min_gap_days: 0,
    inquiry_lead_days_nr: null,
    inquiry_lead_days_other: 20,
  }, 'inquiry');

  assert.deepEqual(result.source, {
    min_gap_days: 'inquiry',
    lead_days_nr: 'advertising',
    lead_days_other: 'inquiry',
  });
});

// Number() alone is too permissive as an "is it set?" test: Number('  ') and
// Number([]) are both 0 and Number(true) is 1, so junk written straight to the
// database would read as a deliberate 0 — "no minimum gap". That is a LOOSER policy
// reached by accident, which is the wrong direction to fail in. Unreachable via the
// API (it validates 0-365), so this guards the direct-DB-write path only.
test('resolveAvailabilityWindows: junk overrides fall back rather than becoming 0', () => {
  const base = { min_gap_days: 40, lead_days_nr: 60, lead_days_other: 45 };
  for (const junk of ['  ', '', '40abc', '1; DROP TABLE unit', {}, [], true, false, null, undefined]) {
    const r = resolveAvailabilityWindows({ ...base, inquiry_min_gap_days: junk }, 'inquiry');
    assert.equal(r.min_gap_days, 40, `${JSON.stringify(junk)} must fall back to the advertising value`);
    assert.equal(r.source.min_gap_days, 'advertising');
  }
});

test('resolveAvailabilityWindows: real overrides survive, including 0 and numeric strings', () => {
  const base = { min_gap_days: 40, lead_days_nr: 60, lead_days_other: 45 };
  // 0 is meaningful ("no minimum gap"), so it must NOT be mistaken for unset.
  for (const [given, expected] of [[0, 0], [5, 5], [365, 365], ['30', 30], [' 30 ', 30]]) {
    const r = resolveAvailabilityWindows({ ...base, inquiry_min_gap_days: given }, 'inquiry');
    assert.equal(r.min_gap_days, expected, `${JSON.stringify(given)} should resolve to ${expected}`);
    assert.equal(r.source.min_gap_days, 'inquiry');
  }
});

// Everything interpolated into SQL must be a finite number. /units/available builds its
// gap filter with `INTERVAL ${min_gap_days} DAY`, so a string reaching that point would
// be an injection vector.
test('resolveAvailabilityWindows: every resolved window is a finite number', () => {
  const base = { min_gap_days: 40, lead_days_nr: 60, lead_days_other: 45 };
  for (const junk of ['1 OR 1=1', {}, [], true, '  ', '9e99']) {
    const r = resolveAvailabilityWindows({ ...base, inquiry_min_gap_days: junk }, 'inquiry');
    for (const f of ['min_gap_days', 'lead_days_nr', 'lead_days_other']) {
      assert.equal(typeof r[f], 'number', `${f} must be a number for ${JSON.stringify(junk)}`);
      assert.ok(Number.isFinite(r[f]), `${f} must be finite for ${JSON.stringify(junk)}`);
    }
  }
});
