#!/usr/bin/env node
// Read-only, measured replay. Uses the same directory plan as the loader, so
// disputed names are never silently supplied as website aliases in the after run.
const fs = require('node:fs/promises');
const { isDeepStrictEqual } = require('node:util');
const { parseDirectoryCsv, planDirectory, active } = require('../src/services/websiteDirectoryLoader');
const { scoreUnits } = require('../src/services/unitResolver');
const { options } = require('./loadWebsiteDirectory');

async function replay(argv) {
  const args = options(argv);
  if (args.apply || !args.snapshot || !args.products || !args.website) throw new Error('Replay requires --snapshot, --products, --website and never --apply');
  const snapshot = JSON.parse(await fs.readFile(args.snapshot, 'utf8'));
  if (String(snapshot.org_id) !== args.org) throw new Error('Snapshot belongs to another org');
  const rows = parseDirectoryCsv(await fs.readFile(args.csv, 'utf8'));
  const products = JSON.parse(await fs.readFile(args.products, 'utf8'));
  const plan = planDirectory(rows, products, snapshot.units, snapshot.mappings || [], args.website);
  const eligible = rows.filter(r => r['Unit status'] === 'Active' && r['Property status'] === 'Active' && r['Unit name on website'] && r['Unit link on website']);
  const units = snapshot.units.filter(u => active(u) && !/test/i.test(u.name) && !/test/i.test(u.property_name)).map(u => ({ ...u, marketable: true }));
  const names = new Map(plan.loaded.map(r => [r.unit_id, r.website_name]));
  const afterUnits = units.map(u => ({ ...u, website_name: names.get(String(u.id)) || null }));
  const result = { total: eligible.length, before: 0, after: 0, regressions: [], unresolved: [], phraseChecks: [], specificChecks: [] };
  for (const r of eligible) {
    const id = r['Unit link in Tenafy'].match(/\/unit\/(\d+)\/?$/)[1];
    const name = r['Unit name on website'];
    const before = scoreUnits(name, units), after = scoreUnits(name, afterUnits);
    const wasRight = before.status === 'confident' && before.match?.unit_id === id;
    const isRight = after.status === 'confident' && after.match?.unit_id === id;
    result.before += Number(wasRight); result.after += Number(isRight);
    if (wasRight && !isRight) result.regressions.push({ unit_id: id, name });
    if (!isRight) result.unresolved.push({ unit_id: id, name, status: after.status });
  }
  for (const query of ['studio A', 'Studio B available?', 'do you have a 1 bedroom', 'studio in Central', 'a studio near central station']) {
    const before = scoreUnits(query, units), after = scoreUnits(query, afterUnits);
    const unchanged = isDeepStrictEqual(after, before);
    result.phraseChecks.push({ query, before: before.status, after: after.status, candidate_count: after.candidate_count, unchanged });
    if (!unchanged) result.regressions.push({ query, reason: 'Vague phrase changed from canonical resolution' });
  }
  for (const [query, websiteName] of [['Central 4B', 'Central Studio 4B'], ['Central 1-Bedroom 2A', 'Central 1-Bedroom 2A'], ['Bonham Strand West Studio D', 'Bonham Strand West Studio D']]) {
    const expected = plan.loaded.find(r => r.website_name === websiteName);
    const out = scoreUnits(query, afterUnits);
    const correct = out.status === 'confident' && out.match?.unit_id === expected?.unit_id;
    result.specificChecks.push({ query, status: out.status, correct });
    if (!correct) result.regressions.push({ query, reason: 'Specific website name failed' });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.regressions.length) process.exitCode = 1;
  return result;
}
if (require.main === module) replay(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { replay };
