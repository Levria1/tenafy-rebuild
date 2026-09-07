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

test('a bad reading is refused before it reaches the column', () => {
  const src = route();
  assert.match(src, /const submitted = parseReadingValue\(current_reading\)/);
  assert.match(src, /submitted === null[\s\S]{0,160}status\(400\)/,
    "'abc' became NaN, read as a correction, and went to a DECIMAL(12,2)");
});

test('the correction and the column move in ONE transaction', () => {
  // Without this the log could record a correction the column never took, and bill
  // creation takes the highest of the two — so a downward correction would be
  // logged and then ignored.
  const src = route();
  assert.match(src, /conn = await req\.pool\.getConnection\(\)/);
  assert.match(src, /await conn\.beginTransaction\(\)/);
  assert.match(src, /FOR UPDATE/, 'the row must be locked while it is read and rewritten');
  assert.match(src, /await conn\.commit\(\)/);
  assert.match(src, /try \{ await conn\.rollback\(\); \} catch/,
    'a rollback that throws must not mask the original error');
  assert.match(src, /finally \{\s*\n\s*if \(conn\) conn\.release\(\)/,
    'the connection must be released on every path');
  // The audit row is written after the commit, deliberately.
  const commitAt = src.indexOf('await conn.commit()');
  const auditAt = src.indexOf("logActivity(req, 'UPDATE', 'utility_meter'");
  assert.ok(commitAt > -1 && auditAt > commitAt, 'a failed audit must not roll back a real correction');
});

test('org scoping is on every statement the correction touches', () => {
  const src = route();
  assert.match(src, /FROM utility_meter WHERE id = \? AND org_id = \? FOR UPDATE/);
  assert.match(src, /FROM utility_meter_reading\s*\n?\s*WHERE meter_id = \? AND org_id = \?/);
  assert.match(src, /UPDATE utility_meter SET current_reading = \? WHERE id = \? AND org_id = \?/);
});

test('a correction is written into the reading log, not just the column', () => {
  const src = route();
  assert.match(src, /READING_TYPE_CORRECTION/, 'corrections need their own reading type');
  assert.match(src, /INSERT INTO utility_meter_reading[\s\S]{0,400}READING_TYPE_CORRECTION/,
    'bills are built from the log — a reading with no entry behind it has no evidence');
});

test('the correction records what it changed and who changed it', () => {
  const src = route();
  assert.match(src, /Corrected from \$\{shown\} to \$\{submitted\} by \$\{req\.user\.username/,
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
  assert.match(src, /const wantsCorrection = isCorrection\(shown, submitted\)/,
    'the rule itself lives in utils/meterReading.js and is tested for behaviour there');
});

test('editing only the details still works, and still rejects an empty request', () => {
  const src = route();
  assert.match(src, /if \(fields\.length === 0 && !wantsCorrection\)/,
    '"Nothing to update" must not fire when only the reading changed');
  assert.match(src, /if \(fields\.length > 0\) \{/,
    'and a reading-only correction must not run an UPDATE with no columns');
});

// ── a back-dated reading stays history ──────────────────────────────────────

test('the newest-by-date rule is enforced inside the UPDATE, not around it', () => {
  // A separate SELECT then UPDATE loses to a newer reading landing in between.
  // The condition has to be part of the write.
  const src = route();
  assert.match(src, /UPDATE utility_meter m SET m\.current_reading = \?[\s\S]{0,400}NOT EXISTS \([\s\S]{0,200}r\.reading_date > \?/,
    'the guard must be a predicate on the UPDATE');
  assert.match(src, /const isNewest = Number\(newerCount\) === 0/,
    "COUNT(*) arrives as a string — '0' is truthy, so it must be compared as a number");
});

test('the reading date is normalised once, before the row and the comparison', () => {
  const src = route();
  assert.match(src, /const readingDate = normaliseReadingDate\(reading_date, orgToday\(\)\)/);
  assert.match(src, /readingDate === null[\s\S]{0,160}status\(400\)/);
  // It used to be redeclared inside the auto-sync block from the raw body, so the
  // lease lookup and the stored row could match on two different dates.
  assert.strictEqual((src.match(/const readingDate/g) || []).length, 1,
    'exactly one declaration — no shadow with different semantics');
});

test('the two writes this change owns are both guarded', () => {
  // The earlier version of this test matched the old line's exact formatting and
  // proximity, so moving the same mistake a few lines away would have passed it.
  // This checks the predicates instead. Scoped to these two writes on purpose:
  // finalize, checkout and settlement-undo also write current_reading and are
  // deliberately unconditional — they are asserting a value, not logging a reading.
  const src = route();
  const writes = (src.match(/UPDATE utility_meter[^;]*SET[^;]*current_reading[^;]*/g) || []);

  const correction = writes.find(w => /\[submitted, id, orgId\]/.test(w));
  assert.ok(correction, 'the correction write must be present');
  assert.match(correction, /WHERE id = \? AND org_id = \?/, 'and org-scoped');

  const fromReading = writes.find(w => /NOT EXISTS/.test(w));
  assert.ok(fromReading, 'the reading write must carry the newest-by-date predicate');
  assert.match(fromReading, /r\.reading_date > \?/);
  assert.match(fromReading, /m\.org_id = \?/);
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
});

test('each repair run is separately recoverable', () => {
  // Keyed on meter_id alone with INSERT IGNORE, a second run on a meter that had
  // drifted again would skip its snapshot, and the printed revert would restore
  // the FIRST run's value or miss the row entirely.
  const src = stripComments(read('../scripts/repairMeterCurrentReading.js'));
  assert.match(src, /PRIMARY KEY \(run_id, meter_id\)/);
  assert.doesNotMatch(src, /INSERT IGNORE INTO utility_meter_reading_repair_backup/,
    'a skipped snapshot is an unrecoverable run');
  assert.match(src, /b\.run_id = /, 'the revert must name exactly one run');
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
