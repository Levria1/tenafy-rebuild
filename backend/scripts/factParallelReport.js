#!/usr/bin/env node
/**
 * Print TaneChat-vs-Tenafy inquiry fact extraction output for parallel-run sign-off.
 *
 * Usage:
 *   node scripts/factParallelReport.js <orgDbName> [days]
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeFacts(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.map(v => String(v)) : [];
}

function printLines(lines, emptyText) {
  if (!lines.length) {
    console.log(`  ${emptyText}`);
    return;
  }
  for (const line of lines) console.log(`  - ${line}`);
}

async function main() {
  const orgDbName = process.argv[2];
  const days = Number(process.argv[3] || 14);
  if (!orgDbName || !Number.isFinite(days) || days <= 0) {
    console.error('Usage: node scripts/factParallelReport.js <orgDbName> [days]');
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
    const [rows] = await conn.execute(
      `SELECT i.id AS inquiry_id, i.budget,
              DATE_FORMAT(i.desired_start_date, '%Y-%m-%d') AS desired_start_date
         FROM inquiry i
         JOIN (
              SELECT inquiry_id
                FROM inquiry_fact_staging
               WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
              UNION
              SELECT inquiry_id
                FROM inquiry_fact_delivery
               WHERE applied = 1
                 AND inquiry_id IS NOT NULL
                 AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ) active ON active.inquiry_id = i.id
        ORDER BY i.id`,
      [days, days]
    );

    const ids = rows.map(r => r.inquiry_id);
    const stagedByInquiry = new Map();
    const deliveredByInquiry = new Map();

    if (ids.length) {
      const [stagedRows] = await conn.query(
        `SELECT inquiry_id, DATE_FORMAT(occurred_on, '%Y-%m-%d') AS occurred_on, fact_line
           FROM inquiry_fact_staging
          WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            AND inquiry_id IN (?)
          ORDER BY inquiry_id, created_at, id`,
        [days, ids]
      );
      for (const row of stagedRows) {
        const key = String(row.inquiry_id);
        if (!stagedByInquiry.has(key)) stagedByInquiry.set(key, []);
        stagedByInquiry.get(key).push(`${row.occurred_on || '(no date)'}: ${row.fact_line}`);
      }

      const [deliveryRows] = await conn.query(
        `SELECT inquiry_id, facts_json, fields_json, created_at
           FROM inquiry_fact_delivery
          WHERE applied = 1
            AND inquiry_id IN (?)
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY inquiry_id, created_at, id`,
        [ids, days]
      );
      for (const row of deliveryRows) {
        const key = String(row.inquiry_id);
        if (!deliveredByInquiry.has(key)) deliveredByInquiry.set(key, []);
        for (const fact of normalizeFacts(row.facts_json)) {
          deliveredByInquiry.get(key).push(fact);
        }
      }
    }

    let withStaged = 0, withDelivered = 0, withBoth = 0, stagedOnly = 0;
    console.log(`Fact parallel report for ${orgDbName} (${days} day${days === 1 ? '' : 's'})`);
    console.log('');

    for (const row of rows) {
      const id = String(row.inquiry_id);
      const staged = stagedByInquiry.get(id) || [];
      const delivered = deliveredByInquiry.get(id) || [];
      if (staged.length) withStaged++;
      if (delivered.length) withDelivered++;
      if (staged.length && delivered.length) withBoth++;
      if (staged.length && !delivered.length) stagedOnly++;

      console.log(`Inquiry ${id}`);
      console.log(`  current budget: ${row.budget == null ? '(none)' : row.budget}`);
      console.log(`  current desired_start_date: ${row.desired_start_date || '(none)'}`);
      console.log('  Tenafy staged lines:');
      printLines(staged, '(none)');
      console.log('  TaneChat delivered facts:');
      printLines(delivered, '(none)');
      console.log('');
    }

    console.log('Summary');
    console.log(`  inquiries with staged lines: ${withStaged}`);
    console.log(`  inquiries with delivered facts: ${withDelivered}`);
    console.log(`  inquiries with both: ${withBoth}`);
    console.log(`  inquiries with staged lines but no delivered facts: ${stagedOnly}`);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
