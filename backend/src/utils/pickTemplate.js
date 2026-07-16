// Pick the winning template from candidate rows: an explicit default first,
// otherwise the newest by created_time. Pure — no DB.
function isDefault(v) {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return v === 1 || v === '1' || v === true;
}

function pickTemplate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const def = rows.find(r => isDefault(r.is_default_template));
  if (def) return def;
  return rows.slice().sort((a, b) =>
    String(b.created_time || '').localeCompare(String(a.created_time || '')))[0];
}

module.exports = { pickTemplate };
