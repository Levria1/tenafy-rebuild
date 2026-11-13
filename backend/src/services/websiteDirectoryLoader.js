const { sameWebsite, websiteBase } = require('./websiteProducts');

const HEADERS = ['Property name in Tenafy', 'Unit name in Tenafy', 'Unit link in Tenafy', 'Unit name on website', 'Unit link on website', 'Unit status', 'Property status', 'Notes'];
function parseDirectoryCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field); field = '';
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else field += c;
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift() || [];
  if (HEADERS.some(h => !headers.includes(h))) throw new Error('Units.csv is missing required columns');
  return rows.map((r, i) => {
    if (r.length !== headers.length) throw new Error(`CSV row ${i + 2} has the wrong number of columns`);
    return Object.fromEntries(headers.map((h, j) => [h, r[j]]));
  });
}
function directoryUrl(value) {
  try {
    const url = new URL(String(value || '').trim().replace(/\)+$/, ''));
    url.hash = ''; url.search = '';
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}
function active(unit) {
  return Number(unit.active_status) === 1 && Number(unit.property_status) === 1 &&
    !Number(unit.deleted) && !Number(unit.property_deleted);
}

function planDirectory(rows, products, units, existing = [], baseValue) {
  const base = websiteBase(baseValue);
  if (!base) throw new Error('Configure a website base URL before loading products');
  const byUnit = new Map(units.map(u => [String(u.id), u]));
  const byLink = new Map(), byName = new Map();
  for (const p of products) {
    const link = directoryUrl(p.permalink);
    if (!sameWebsite(p.permalink, base)) throw new Error('Product list contains a foreign website host');
    byLink.set(link, [...(byLink.get(link) || []), p]);
    byName.set(p.name, [...(byName.get(p.name) || []), p]);
  }
  const nameUnits = new Map();
  for (const r of rows) {
    const id = r['Unit link in Tenafy'].match(/\/unit\/(\d+)\/?$/)?.[1];
    if (id && r['Unit status'] === 'Active' && r['Property status'] === 'Active' && r['Unit name on website']) {
      const set = nameUnits.get(r['Unit name on website']) || new Set(); set.add(id); nameUnits.set(r['Unit name on website'], set);
    }
  }
  const needsStaff = [], proposed = [];
  for (const r of rows) {
    const unitId = r['Unit link in Tenafy'].match(/\/unit\/(\d+)\/?$/)?.[1];
    const entry = { unit_id: unitId || null, property: r['Property name in Tenafy'], unit: r['Unit name in Tenafy'], website_name: r['Unit name on website'], link: r['Unit link on website'] };
    let reason;
    const unit = byUnit.get(unitId);
    if (!unit) reason = 'Unit ID not found in this organization';
    else if (r['Unit status'] !== 'Active' || r['Property status'] !== 'Active' || !active(unit)) reason = 'Inactive or deleted unit/property';
    else if (!entry.link.trim()) reason = 'No website link';
    else if (!entry.website_name.trim() || /unverified/i.test(r.Notes) || /^unverified$/i.test(entry.website_name)) reason = 'Website name unverified';
    else if (nameUnits.get(entry.website_name)?.size > 1) reason = 'Website name is on more than one unit';
    const primary = byLink.get(directoryUrl(entry.link)) || [];
    if (!reason && primary.length !== 1) reason = primary.length ? 'Website permalink has multiple products' : 'Link has no website product';
    if (!reason && primary[0].name !== entry.website_name) reason = 'Website product name differs from the checked sheet';
    if (reason) { needsStaff.push({ ...entry, reason }); continue; }
    const copies = (byName.get(primary[0].name) || []).filter(p => p.product_id !== primary[0].product_id);
    proposed.push({ ...entry, primary: primary[0], copies });
  }
  const assignments = new Map();
  for (const p of existing) assignments.set(String(p.product_id), new Set([String(p.unit_id)]));
  for (const e of proposed) for (const p of [e.primary, ...e.copies]) {
    const set = assignments.get(p.product_id) || new Set(); set.add(e.unit_id); assignments.set(p.product_id, set);
  }
  const loaded = [], copies = [], used = new Set(), seenUnits = new Set();
  for (const e of proposed) {
    if (seenUnits.has(e.unit_id)) throw new Error('Directory contains the same unit ID more than once');
    seenUnits.add(e.unit_id);
    if ([e.primary, ...e.copies].some(p => assignments.get(p.product_id).size > 1)) {
      needsStaff.push({ ...e, reason: 'Product number is assigned to another unit' }); continue;
    }
    loaded.push(e);
    for (const p of [e.primary, ...e.copies]) used.add(p.product_id);
    for (const p of e.copies) copies.push({ ...p, unit_id: e.unit_id, property: e.property, unit: e.unit });
  }
  return { loaded, copies, needsStaff, noUnit: products.filter(p => !used.has(p.product_id)) };
}
function counts(plan) {
  return { loaded: plan.loaded.length, copies: plan.copies.length, needs_staff: plan.needsStaff.length, no_unit: plan.noUnit.length };
}
function reportMarkdown(plan) {
  const clean = v => String(v ?? '').replace(/[\r\n|]/g, ' ');
  const group = (title, rows, describe) => `## ${title} (${rows.length})\n\n${rows.map(r => `- ${clean(describe(r))}`).join('\n') || 'None.'}\n`;
  return '# Website directory loader report\n\n' +
    group('Loaded', plan.loaded, r => `${r.property} / ${r.unit} [${r.unit_id}]: ${r.primary.product_id}, ${r.website_name}, ${r.primary.permalink}`) + '\n' +
    group('Copies added', plan.copies, r => `${r.property} / ${r.unit} [${r.unit_id}]: ${r.product_id}, ${r.name}, ${r.permalink}`) + '\n' +
    group('Needs staff', plan.needsStaff, r => `${r.property} / ${r.unit} [${r.unit_id}]: ${r.reason}; ${r.website_name}; ${r.link}`) + '\n' +
    group('Website products with no unit', plan.noUnit, r => `${r.product_id}: ${r.name}, ${r.permalink}`);
}
async function applyDirectory(conn, orgId, plan) {
  // Caller holds the org lock and has rebuilt the plan from transaction reads.
  for (const row of plan.loaded) {
    await conn.execute('UPDATE unit u JOIN property p ON p.id=u.property_id SET u.website_name=?,u.listing_url=? WHERE u.id=? AND p.org_id=?', [row.website_name, row.primary.permalink, row.unit_id, orgId]);
    await conn.execute('UPDATE unit_website_product SET is_primary=0 WHERE org_id=? AND unit_id=?', [orgId, row.unit_id]);
    for (const [i, p] of [row.primary, ...row.copies].entries()) {
      await conn.execute(`INSERT INTO unit_website_product (org_id,unit_id,product_id,permalink,name,is_primary)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE permalink=VALUES(permalink),name=VALUES(name),is_primary=VALUES(is_primary),updated_at=CURRENT_TIMESTAMP`,
      [orgId, row.unit_id, p.product_id, p.permalink, p.name, i === 0 ? 1 : 0]);
    }
  }
}
module.exports = { parseDirectoryCsv, directoryUrl, planDirectory, counts, reportMarkdown, applyDirectory, active };
