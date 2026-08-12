const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTING } = require('../src/services/viewingNegotiationLogic');

test('viewing_setting cadence SQL defaults match DEFAULT_SETTING', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '..', 'migrations-org', '051_viewing_setting_cadence.sql'),
    'utf8'
  );
  // [a-z0-9_]+ — NOT [a-z_]+. Two of these columns have digits in their names
  // (customer_nudge_1_hours, customer_nudge_2_hours) and a letters-only class skips
  // them silently, leaving the guard covering 7 of 9 while still passing. Those two
  // are the ones in the nudge-before-escalation rule, i.e. the pair that matters most.
  const matches = [...migration.matchAll(/ADD COLUMN\s+([a-z0-9_]+)\s+[A-Z]+(?:\([^)]+\))?\s+NOT NULL DEFAULT\s+(-?\d+)/gi)];

  // Pin the count as well as the contents. Without this, a regex that quietly stops
  // matching (or a migration rewritten into a different DDL shape) makes this test
  // vacuously green — which is worse than not having it, because it reads as covered.
  const CADENCE_COLUMNS = [
    'customer_nudge_1_hours', 'customer_nudge_2_hours', 'customer_nudge_cap',
    'customer_timeout_hours', 'tenant_opt_out_hours', 'tenant_explicit_timeout_hours',
    'tenant_nudge_cap', 'auto_send_nudges', 'respect_quiet_hours',
  ];
  assert.deepEqual(
    matches.map(m => m[1]).sort(),
    [...CADENCE_COLUMNS].sort(),
    'migration 051 no longer declares exactly the nine cadence columns this guard checks — '
    + 'either the migration changed shape or the regex stopped matching, and either way the '
    + 'defaults are no longer being compared'
  );

  for (const match of matches) {
    const [, name, sqlDefault] = match;
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_SETTING, name),
      `${name} exists in migration 051 but not DEFAULT_SETTING; a first-ever settings save would silently switch behaviour from DEFAULT_SETTING to SQL default ${sqlDefault}`
    );
    assert.equal(
      Number(DEFAULT_SETTING[name]),
      Number(sqlDefault),
      `${name} default mismatch: DEFAULT_SETTING=${DEFAULT_SETTING[name]}, SQL default=${sqlDefault}; a first-ever settings save would silently switch behaviour from one to the other`
    );
  }
});
