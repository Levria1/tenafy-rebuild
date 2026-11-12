const { productId, websiteBase, sameWebsite } = require('./websiteProducts');

function inputError(message) { const error = new Error(message); error.status = 400; return error; }
function validateWebsiteProducts(websiteName, products, baseValue) {
  if (websiteName !== null && (typeof websiteName !== 'string' || websiteName.length > 255)) throw inputError('Website name must be at most 255 characters');
  if (!Array.isArray(products) || products.length > 100) throw inputError('Website products must be a list of at most 100 products');
  const seen = new Set(), base = websiteBase(baseValue);
  if (products.length && !base) throw inputError('Set the organization public listings website first');
  return products.map((p, i) => {
    const id = productId(p?.product_id);
    if (!id || seen.has(id)) throw inputError('Product numbers must be positive, unique BIGINT strings');
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 255) throw inputError('Each product needs a name of at most 255 characters');
    const permalink = typeof p.permalink === 'string' && p.permalink.length <= 1000 && sameWebsite(p.permalink, base);
    if (!permalink) throw inputError('Product links must use the organization website host');
    seen.add(id);
    return { product_id: id, name: p.name.trim(), permalink: permalink.href, is_primary: i === 0 ? 1 : 0 };
  });
}

// Both the loader and staff editor lock the org row before changing mappings.
// The primary key is a second, database-enforced barrier against reassignment.
async function saveUnitWebsiteProducts(pool, orgId, unitId, websiteName, products) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[org]] = await conn.execute('SELECT website_base_url FROM organization WHERE id = ? FOR UPDATE', [orgId]);
    const cleaned = validateWebsiteProducts(websiteName, products, org?.website_base_url);
    const [[unit]] = await conn.execute('SELECT u.id FROM unit u JOIN property p ON p.id=u.property_id WHERE u.id=? AND p.org_id=? AND u.deleted_at IS NULL AND p.deleted_at IS NULL FOR UPDATE', [unitId, orgId]);
    if (!unit) { const e = new Error('Unit not found'); e.status = 404; throw e; }
    for (const p of cleaned) {
      const [[mapped]] = await conn.execute('SELECT unit_id FROM unit_website_product WHERE org_id=? AND product_id=? FOR UPDATE', [orgId, p.product_id]);
      if (mapped && String(mapped.unit_id) !== String(unitId)) {
        const e = new Error('A website product is already assigned to another unit'); e.status = 409; throw e;
      }
    }
    await conn.execute('DELETE FROM unit_website_product WHERE org_id=? AND unit_id=?', [orgId, unitId]);
    for (const p of cleaned) await conn.execute('INSERT INTO unit_website_product (org_id,unit_id,product_id,permalink,name,is_primary) VALUES (?,?,?,?,?,?)', [orgId, unitId, p.product_id, p.permalink, p.name, p.is_primary]);
    await conn.execute('UPDATE unit u JOIN property p ON p.id=u.property_id SET u.website_name=?, u.listing_url=COALESCE(?,u.listing_url) WHERE u.id=? AND p.org_id=?', [websiteName?.trim() || null, cleaned[0]?.permalink || null, unitId, orgId]);
    await conn.commit();
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}

module.exports = { validateWebsiteProducts, saveUnitWebsiteProducts };
