#!/usr/bin/env node
/**
 * Realign utility_meter.current_reading with the meter's own reading log.
 *
 * Usage:
 *   node scripts/repairMeterCurrentReading.js <orgDbName>            # dry run
 *   node scripts/repairMeterCurrentReading.js <orgDbName> --apply    # write
 *
 * WHY
 * ---
 * POST /api/utility/meter-reading used to set current_reading unconditionally to
 * whatever had just been entered. Entering a back-dated reading therefore rewound
 * the meter to an earlier month's figure while the screen carried on showing the
 * latest one, because the screen reads the log and orders by date.
 *
 * It happened to Mercer 4B on 2 Sep 2026: an August reading of 23,241 entered at
 * 06:49, then a July reading of 23,134 at 07:44. Three meters are still out of
 * step; 127 readings across the system were entered after a newer-dated one
 * already existed, and the rest were corrected by the next in-order reading.
 *
 * The route no longer does this. This realigns what it already left behind.
 *
 * WHY THE LOG WINS
 * ----------------
 * current_reading is a denormalised copy. utility_meter_reading is the evidence,
 * it is what the screen shows, and bill creation already prefers it (it takes the
 * highest of the log, the last finalized bill ending, and this column). So the
 * column is the copy that drifted, and the log is what to restore it to.
 *
 * SCOPE
 * -----
 * Only active meters whose latest reading BY DATE differs from current_reading.
 * A meter with no logged readings is left alone: there is nothing to align to.
 *
 * REVERSAL
 * --------
 * Every changed row is snapshotted into `utility_meter_reading_repair_backup`
 * before anything is written. The script prints the exact revert statement.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orgDbName = args.filter(a => !a.startsWith('--'))[0];
  if (!orgDbName) {
    console.error('Usage: node scripts/repairMeterCurrentReading.js <orgDbName> [--apply]');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: orgDbName,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  try {
    const [rows] = await conn.query(
      `SELECT m.id, m.meter_number, g.name AS group_name,
              m.current_reading,
              lr.reading_value AS latest_value,
              DATE_FORMAT(lr.reading_date, '%Y-%m-%d') AS latest_date
         FROM utility_meter m
         LEFT JOIN utility_group g ON g.id = m.group_id
         JOIN (
           SELECT meter_id, reading_value, reading_date,
                  ROW_NUMBER() OVER (PARTITION BY meter_id ORDER BY reading_date DESC, created_at DESC) AS rn
             FROM utility_meter_reading
         ) lr ON lr.meter_id = m.id AND lr.rn = 1
        WHERE m.status = 1
        ORDER BY g.name, m.meter_number`
    );

    const changes = rows.filter(r => Number(r.current_reading) !== Number(r.latest_value));

    console.log(`${orgDbName}: ${rows.length} active meter(s) with a reading log`);
    console.log(`  out of step with their log: ${changes.length}`);
    console.log('');
    for (const c of changes) {
      console.log(`  ${c.group_name} / ${c.meter_number}: ${Number(c.current_reading)} -> ${Number(c.latest_value)} (latest reading dated ${c.latest_date})`);
    }

    if (!apply) {
      console.log('');
      console.log('DRY RUN — nothing written. Re-run with --apply to make these changes.');
      return;
    }
    if (!changes.length) {
      console.log('');
      console.log('Nothing to do.');
      return;
    }

    await conn.query(
      `CREATE TABLE IF NOT EXISTS utility_meter_reading_repair_backup (
         meter_id              BIGINT        NOT NULL,
         current_reading_before DECIMAL(12,2) NULL,
         backed_up_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (meter_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    const [[{ started_at: startedAt }]] = await conn.query(
      `SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS started_at`
    );

    const applied = [];
    const skipped = [];
    await conn.beginTransaction();
    try {
      for (const c of changes) {
        // Re-check the value being replaced: rows were read before the transaction
        // opened, and a reading logged in that window must not be overwritten by
        // the stale value this script read.
        const [res] = await conn.execute(
          'UPDATE utility_meter SET current_reading = ? WHERE id = ? AND current_reading = ?',
          [c.latest_value, c.id, c.current_reading]
        );
        if (res.affectedRows !== 1) { skipped.push(c); continue; }
        await conn.execute(
          `INSERT IGNORE INTO utility_meter_reading_repair_backup (meter_id, current_reading_before)
           VALUES (?, ?)`,
          [c.id, c.current_reading]
        );
        applied.push(c);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }

    console.log('');
    console.log(`APPLIED. ${applied.length} meter(s) realigned.`);
    if (skipped.length) {
      console.log(`SKIPPED ${skipped.length} — the reading changed after this script read it:`);
      skipped.forEach(c => console.log(`  ${c.meter_number}`));
    }
    console.log('');
    console.log('To revert what THIS run did:');
    console.log('  UPDATE utility_meter m');
    console.log('    JOIN utility_meter_reading_repair_backup b ON b.meter_id = m.id');
    console.log('     SET m.current_reading = b.current_reading_before');
    console.log(`   WHERE b.backed_up_at >= '${startedAt}';`);
  } finally {
    await conn.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
