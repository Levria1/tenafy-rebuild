// Pick the winning template from candidate rows: an explicit default first,
// otherwise the newest by created_time. Pure — no DB.
// `is_default_template` is NOT a bit(1) and NOT a boolean. It is a tinyint encoding
// 1 = default, 2 = NON-default (verified in production: 66 rows at 1, 20 at 2). Do not
// route it through utils/mysqlBit.bitToBool — that returns true for 2, which would make
// every ordinary template look like the default and break template selection outright.
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
