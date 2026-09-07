/**
 * A meter reading you can correct, and a back-dated one that stays history.
 *
 * Two defects behind "why can't we change the meter reading":
 *
 *   1. The Edit Meter form has always shown a reading field. PUT /meter/:id
 *      destructured everything EXCEPT current_reading, so the value was thrown
 *      away, the request returned 200, and the UI reported "Meter updated". A
 *      no-op that announces success is worse than a visible failure.
 *
 *   2. POST /meter-reading set current_reading to whatever had just been entered,
 *      with no regard for date order. Entering a back-dated reading rewound the
 *      meter while the screen kept showing the newest one, because the screen
 *      reads the log and orders by date. Mercer 4B, 2 Sep 2026: August's 23,241
 *      entered at 06:49, July's 23,134 at 07:44, meter left on the July figure.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Line comments FIRST, or a "/*" inside one opens a phantom block comment.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const route = () => stripComments(read('../src/routes/utility.js'));
const page = () => stripComments(read('../../frontend/src/app/utilities/page.js'));

// ── the reading can now be corrected ────────────────────────────────────────

test('the meter update reads current_reading off the body', () => {
  const src = route();
  assert.match(src, /const \{ group_id, unit_id, meter_number, meter_type, meter_category, current_reading \} = req\.body/,
    'the field the form sends must not be silently dropped');
});

test('a correction is written into the reading log, not just the column', () => {
  const src = route();
  assert.match(src, /READING_TYPE_CORRECTION/, 'corrections need their own reading type');
  assert.match(src, /INSERT INTO utility_meter_reading[\s\S]{0,400}READING_TYPE_CORRECTION/,
    'bills are built from the log — a reading with no entry behind it has no evidence');
});

test('the correction records what it changed and who changed it', () => {
  const src = route();
  assert.match(src, /Corrected from \$\{shown\} to \$\{Number\(current_reading\)\} by \$\{req\.user\.username/,
    'an unattributed correction cannot be judged later');
});

test('a correction is audited', () => {
  assert.match(route(), /logActivity\(req, 'UPDATE', 'utility_meter'/);
});

test('the comparison is against the reading the form displayed, not the column', () => {
  // The form prefills from last_reading ?? current_reading. Comparing against the
  // column instead would log a correction nobody asked for every time an unrelated
  // field was edited on a meter where those two disagree — which is exactly the
  // three meters this work exists to fix.
  const src = route();
  assert.match(src, /const shown = lastReading \? Number\(lastReading\.reading_value\) : Number\(meter\.current_reading\)/);
  assert.match(src, /Number\(current_reading\) !== shown/);
});

test('editing only the details still works, and still rejects an empty request', () => {
  const src = route();
  assert.match(src, /if \(fields\.length === 0 && !wantsCorrection\)/,
    '"Nothing to update" must not fire when only the reading changed');
  assert.match(src, /if \(fields\.length > 0\) \{/,
    'and a reading-only correction must not run an UPDATE with no columns');
});

// ── a back-dated reading stays history ──────────────────────────────────────

test('current_reading only advances when the reading is newest by date', () => {
  const src = route();
  assert.match(src, /SELECT COUNT\(\*\) AS newerCount FROM utility_meter_reading WHERE meter_id = \? AND reading_date > \?/);
  assert.match(src, /const isNewest = Number\(newerCount\) === 0/,
    "COUNT(*) arrives as a string — '0' is truthy, so it must be compared as a number");
  assert.match(src, /if \(isNewest\) \{[\s\S]{0,200}UPDATE utility_meter SET current_reading/,
    'the update must be conditional');
});

test('the unconditional update is gone', () => {
  const src = route();
  // The old line ran straight after the INSERT with nothing guarding it.
  assert.doesNotMatch(src, /\[id, orgId, meter_id, reading_value[\s\S]{0,200}\n\s*await req\.pool\.execute\('UPDATE utility_meter SET current_reading = \? WHERE id = \?', \[reading_value, meter_id\]\);/,
    'a back-dated entry must not rewind the meter');
});

test('the response says whether the meter actually moved', () => {
  assert.match(route(), /meter_advanced: isNewest/);
});

// ── the UI stops claiming things it did not do ──────────────────────────────

test('the form no longer calls it "Initial" when editing an existing meter', () => {
  assert.match(page(), /label=\{editingMeter \? 'Meter Reading' : 'Initial Meter Reading'\}/);
});

test('the form warns that changing the reading logs a correction', () => {
  assert.match(page(), /logs a dated correction in the reading history/);
});

test('the save message names the correction rather than saying "Meter updated"', () => {
  const src = page();
  assert.match(src, /Reading corrected from/,
    '"Meter updated" was shown even when the reading was discarded');
  // The ternary wraps across lines in the source, so allow the newline.
  assert.match(src, /message\.success\(correction\s*\?[\s\S]{0,220}'Meter updated'\)/,
    'and the plain message must remain for a details-only edit');
});

test('logging a back-dated reading tells the user it did not move the meter', () => {
  assert.match(page(), /meter_advanced === false[\s\S]{0,200}current value is unchanged/);
});

test('Correction is a labelled reading type in the history', () => {
  assert.match(page(), /4: 'Correction'/);
});

// ── the repair script ───────────────────────────────────────────────────────

test('the repair aligns the column to the log, not the other way round', () => {
  const src = stripComments(read('../scripts/repairMeterCurrentReading.js'));
  assert.match(src, /UPDATE utility_meter SET current_reading = \? WHERE id = \? AND current_reading = \?/,
    'it must re-check the value it replaces, in case a reading landed mid-run');
  assert.match(src, /affectedRows !== 1/);
  assert.match(src, /utility_meter_reading_repair_backup/, 'changes must be snapshotted');
  assert.match(src, /b\.backed_up_at >=/, 'and the revert scoped to this run');
});

test('the repair writes nothing without --apply', () => {
  const src = stripComments(read('../scripts/repairMeterCurrentReading.js'));
  const guard = src.indexOf('if (!apply)');
  const update = src.indexOf('UPDATE utility_meter SET current_reading');
  assert.ok(guard > -1 && update > guard, 'the UPDATE must sit after the dry-run return');
});

test('a meter with no readings is left alone', () => {
  const src = stripComments(read('../scripts/repairMeterCurrentReading.js'));
  assert.match(src, /JOIN \(\s*\n\s*SELECT meter_id, reading_value, reading_date/,
    'an inner JOIN, so a meter with nothing logged has nothing to align to');
});
