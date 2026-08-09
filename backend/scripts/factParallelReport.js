#!/usr/bin/env node
/**
 * Print TaneChat-vs-Tenafy inquiry fact extraction output for parallel-run sign-off.
 *
 * Usage:
 *   node scripts/factParallelReport.js <orgDbName> [days] [--json]
 *
 * The headline number is "staged but nothing delivered" — inquiries where our own
 * extractor found something and TaneChat sent nothing at all. It counts a delivery
 * as content only if it carried facts, fields or a summary: an `applied:1` row can
 * be an empty heartbeat, and early deliveries carried the channel phone and
 * nothing else, which would otherwise read as coverage.
 *
 * --json prints one machine-readable object instead, for sharing with TaneChat.
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

function fieldSummary(fields) {
  const obj = parseJson(fields, {});
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.entries(obj).map(([k, v]) => `${k}=${v == null ? 'null' : v}`);
}

function printLines(lines, emptyText) {
  if (!lines.length) {
    console.log(`  ${emptyText}`);
    return;
  }
  for (const line of lines) console.log(`  - ${line}`);
}

async function main() {
  const argv = process.argv.slice(2).filter(a => a !== '--json');
  const asJson = process.argv.slice(2).includes('--json');
  const orgDbName = argv[0];
  const days = Number(argv[1] || 14);
  if (!orgDbName || !Number.isFinite(days) || days <= 0) {
    console.error('Usage: node scripts/factParallelReport.js <orgDbName> [days] [--json]');
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
        `SELECT inquiry_id, facts_json, fields_json, summary_text, summary_applied,
                skipped_json, created_at
           FROM inquiry_fact_delivery
          WHERE applied = 1
            AND inquiry_id IN (?)
            AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          ORDER BY inquiry_id, created_at, id`,
        [ids, days]
      );
      for (const row of deliveryRows) {
        const key = String(row.inquiry_id);
        if (!deliveredByInquiry.has(key)) {
          deliveredByInquiry.set(key, { facts: [], fields: [], summaries: [], skipped: [], count: 0 });
        }
        const bucket = deliveredByInquiry.get(key);
        bucket.count++;
        for (const fact of normalizeFacts(row.facts_json)) bucket.facts.push(fact);
        for (const pair of fieldSummary(row.fields_json)) bucket.fields.push(pair);
        if (row.summary_text) {
          bucket.summaries.push(
            `${Number(row.summary_applied) === 1 ? '[applied]' : '[recorded, not applied]'} ${row.summary_text}`
          );
        }
        for (const name of normalizeFacts(row.skipped_json)) bucket.skipped.push(name);
      }
    }

    const EMPTY = { facts: [], fields: [], summaries: [], skipped: [], count: 0 };
    const perInquiry = rows.map(row => {
      const id = String(row.inquiry_id);
      const staged = stagedByInquiry.get(id) || [];
      const d = deliveredByInquiry.get(id) || EMPTY;
      return {
        inquiry_id: id,
        current_budget: row.budget == null ? null : row.budget,
        current_desired_start_date: row.desired_start_date || null,
        staged_lines: staged,
        deliveries: d.count,
        delivered_facts: d.facts,
        delivered_fields: d.fields,
        delivered_summaries: d.summaries,
        skipped_fields: [...new Set(d.skipped)],
        // A delivery with no facts, no fields and no summary carried nothing.
        delivered_content: d.facts.length > 0 || d.fields.length > 0 || d.summaries.length > 0,
      };
    });

    const totals = {
      inquiries: perInquiry.length,
      with_staged: perInquiry.filter(r => r.staged_lines.length).length,
      with_delivered_content: perInquiry.filter(r => r.delivered_content).length,
      with_delivered_facts: perInquiry.filter(r => r.delivered_facts.length).length,
      with_both: perInquiry.filter(r => r.staged_lines.length && r.delivered_content).length,
      staged_but_nothing_delivered: perInquiry.filter(r => r.staged_lines.length && !r.delivered_content).length,
      staged_but_no_delivered_facts: perInquiry.filter(r => r.staged_lines.length && !r.delivered_facts.length).length,
      deliveries_with_skipped_fields: perInquiry.filter(r => r.skipped_fields.length).length,
    };

    if (asJson) {
      console.log(JSON.stringify({ org_db: orgDbName, days, totals, inquiries: perInquiry }, null, 2));
      return;
    }

    console.log(`Fact parallel report for ${orgDbName} (${days} day${days === 1 ? '' : 's'})`);
    console.log('');

    for (const r of perInquiry) {
      console.log(`Inquiry ${r.inquiry_id}   (${r.deliveries} deliver${r.deliveries === 1 ? 'y' : 'ies'})`);
      console.log(`  current budget: ${r.current_budget == null ? '(none)' : r.current_budget}`);
      console.log(`  current desired_start_date: ${r.current_desired_start_date || '(none)'}`);
      console.log('  Tenafy staged lines:');
      printLines(r.staged_lines, '(none)');
      console.log('  TaneChat delivered facts:');
      printLines(r.delivered_facts, '(none)');
      console.log('  TaneChat delivered fields:');
      printLines(r.delivered_fields, '(none)');
      console.log('  TaneChat summaries:');
      printLines(r.delivered_summaries, '(none)');
      if (r.skipped_fields.length) {
        console.log(`  fields we declined (already set): ${r.skipped_fields.join(', ')}`);
      }
      console.log('');
    }

    console.log('Summary');
    console.log(`  inquiries in window: ${totals.inquiries}`);
    console.log(`  inquiries with staged lines: ${totals.with_staged}`);
    console.log(`  inquiries with delivered content (facts, fields or summary): ${totals.with_delivered_content}`);
    console.log(`  inquiries with delivered facts: ${totals.with_delivered_facts}`);
    console.log(`  inquiries with both: ${totals.with_both}`);
    console.log(`  >> staged but NOTHING delivered: ${totals.staged_but_nothing_delivered}`);
    console.log(`  staged but no delivered facts (fields/summary only): ${totals.staged_but_no_delivered_facts}`);
    console.log(`  inquiries where we declined a field: ${totals.deliveries_with_skipped_fields}`);
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
