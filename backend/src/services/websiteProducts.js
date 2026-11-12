const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const MAX_ID = 9223372036854775807n;
function productId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  const s = String(value ?? '');
  return /^[1-9]\d*$/.test(s) && BigInt(s) <= MAX_ID ? s : null;
}
function websiteBase(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port ||
        isIP(u.hostname.replace(/^\[|\]$/g, '')) || !u.hostname.includes('.') || /\.localhost$/i.test(u.hostname)) return null;
    u.search = ''; u.hash = '';
    u.pathname = u.pathname.replace(/\/*$/, '/');
    return u;
  } catch { return null; }
}
const host = u => u.hostname.toLowerCase().replace(/^www\./, '');
function sameWebsite(value, base) {
  try {
    const u = new URL(value, base);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password &&
      !u.port && host(u) === host(base) ? u : null;
  } catch { return null; }
}
function decodeName(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/ig, (whole, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] || whole;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

// No redirect handling, cookies, API keys, or request-body forwarding. The absolute
// timer covers DNS/connect/body time, not just inactivity on an open socket.
function requestWebsite(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Tenafy-listing-resolver' } }, res => {
      let body = ''; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 10 * 1024 * 1024) req.destroy(new Error('Website response too large'));
        else body += chunk;
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body }); });
      res.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error('Website timeout')), 2000);
    req.on('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function fetchProducts(baseValue, request = requestWebsite) {
  const base = websiteBase(String(baseValue));
  if (!base) throw new Error('A public website base URL is required');
  const products = [];
  for (let page = 1; page <= 100; page++) {
    const url = new URL('wp-json/wc/store/v1/products', base);
    url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
    const response = await request(url);
    if (response.status !== 200) throw new Error('Website product list unavailable');
    const rows = JSON.parse(response.body);
    if (!Array.isArray(rows)) throw new Error('Invalid website product list');
    for (const row of rows) {
      const id = productId(row.id), permalink = sameWebsite(row.permalink, base);
      if (!id || !permalink || !row.slug || !row.name) throw new Error('Invalid website product');
      products.push({ product_id: id, name: decodeName(row.name), slug: String(row.slug), permalink: permalink.href });
    }
    if (rows.length < 100) return products;
  }
  throw new Error('Website product list exceeds page limit');
}

function createWebsiteResolver({ request = requestWebsite, now = Date.now } = {}) {
  const cache = new Map();
  async function index(orgId, base, force = false) {
    const key = `${orgId}:${base.href}`;
    let entry = cache.get(key);
    if (!entry) { entry = { at: -Infinity, products: [], slugs: new Map(), missRefreshed: false }; cache.set(key, entry); }
    if (entry.pending) return entry.pending;
    if (!force && now() - entry.at < SIX_HOURS) return entry;
    entry.pending = (async () => {
      const products = await fetchProducts(base.href, request);
      const byId = new Map(products.map(p => [p.product_id, p]));
      const slugs = new Map([...entry.slugs].filter(([, id]) => byId.has(id)));
      for (const p of products) slugs.set(p.slug.toLowerCase(), p.product_id);
      entry.products = products; entry.byId = byId; entry.slugs = slugs;
      entry.at = now(); entry.missRefreshed = force;
      return entry;
    })();
    try { return await entry.pending; }
    finally { entry.pending = null; }
  }
  return async function recognise(pool, orgId, value) {
    try {
      const [[setting]] = await pool.execute('SELECT website_base_url FROM organization WHERE id = ?', [orgId]);
      const base = websiteBase(setting?.website_base_url);
      if (!base) return null;
      let incoming = sameWebsite(value, base);
      if (!incoming) return null;
      let entry = await index(orgId, base);
      function find(url) {
        const id = productId(url.searchParams.get('p')) || productId(url.searchParams.get('product_id'));
        if (id) return entry.byId.get(id);
        const slug = url.pathname.match(/\/product\/([^/]+)\/?$/i)?.[1];
        return slug ? entry.byId.get(entry.slugs.get(decodeURIComponent(slug).toLowerCase())) : null;
      }
      let product = find(incoming);
      // Only one extra refresh per cache cycle (and shared pending refresh), so
      // random unknown links cannot make every request re-download the catalogue.
      if (!product && !entry.missRefreshed) { entry.missRefreshed = true; entry = await index(orgId, base, true); product = find(incoming); }
      for (let hop = 0; !product && hop < 3; hop++) {
        if (!/\/product\/[^/]+\/?$/i.test(incoming.pathname)) break;
        // Use the configured origin; discard tracking parameters and fragments.
        const target = new URL(incoming.pathname, base.origin);
        const response = await request(target);
        if (response.status !== 301 || !response.headers.location) break;
        incoming = sameWebsite(response.headers.location, target);
        if (!incoming || !sameWebsite(incoming, base)) break;
        product = find(incoming);
      }
      return product ? { product_id: product.product_id, name: product.name, permalink: product.permalink } : null;
    } catch { return null; } // Website/settings failures never fail unit resolution.
  };
}

async function exactWebsiteListing(pool, orgId, unitId, listingUrl) {
  try {
    const { normalizeListingUrl } = require('../utils/listingUrl');
    const [rows] = await pool.execute('SELECT product_id,name,permalink FROM unit_website_product WHERE org_id=? AND unit_id=?', [orgId, unitId]);
    const product = rows.find(p => normalizeListingUrl(p.permalink) === normalizeListingUrl(listingUrl));
    return product ? { product_id: String(product.product_id), name: product.name, permalink: product.permalink } : null;
  } catch { return null; }
}

module.exports = { productId, websiteBase, sameWebsite, fetchProducts, requestWebsite, decodeName, exactWebsiteListing,
  createWebsiteResolver, recogniseWebsiteListing: createWebsiteResolver() };
