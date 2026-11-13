const http = require('node:http');
const https = require('node:https');
const { isIP } = require('node:net');

const SIX_HOURS = 6 * 60 * 60 * 1000;
const LOOKUP_BUDGET_MS = 3000;
const FAILURE_COOLDOWN_MS = 3 * 60 * 1000;
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
function requestWebsite(url, { timeoutMs = 2000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'Tenafy-listing-resolver' }, signal }, res => {
      let body = ''; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 10 * 1024 * 1024) req.destroy(new Error('Website response too large'));
        else body += chunk;
      });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body }); });
      res.on('error', error => { clearTimeout(timer); reject(error); });
    });
    const timer = setTimeout(() => req.destroy(new Error('Website timeout')), Math.min(2000, timeoutMs));
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

// Bound both a live request and a wait on another caller's in-flight catalogue.
// The transport receives the same abort signal, so timing out stops further I/O.
function withSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Website lookup budget exhausted'));
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); }
    );
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function createWebsiteResolver({ request = requestWebsite, now = Date.now } = {}) {
  const cache = new Map();
  function cacheEntry(orgId, base) {
    const key = `${orgId}:${base.href}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { at: -Infinity, products: [], slugs: new Map(), missRefreshed: false, failedUntil: -Infinity };
      cache.set(key, entry);
    }
    return entry;
  }
  async function index(entry, base, requestInBudget, force = false) {
    if (entry.pending) return entry.pending;
    if (!force && now() - entry.at < SIX_HOURS) return entry;
    entry.pending = (async () => {
      const products = await fetchProducts(base.href, requestInBudget);
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
    let entry, timer;
    try {
      const [[setting]] = await pool.execute('SELECT website_base_url FROM organization WHERE id = ?', [orgId]);
      const base = websiteBase(setting?.website_base_url);
      if (!base) return null;
      let incoming = sameWebsite(value, base);
      if (!incoming) return null;
      entry = cacheEntry(orgId, base);
      if (entry.failedUntil > now()) return null;
      const deadline = now() + LOOKUP_BUDGET_MS;
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), LOOKUP_BUDGET_MS);
      const requestInBudget = async url => {
        const remaining = deadline - now();
        if (controller.signal.aborted || remaining <= 0) throw new Error('Website lookup budget exhausted');
        const response = await withSignal(request(url, {
          timeoutMs: Math.min(2000, remaining), signal: controller.signal,
        }), controller.signal);
        if (now() >= deadline) throw new Error('Website lookup budget exhausted');
        return response;
      };
      await withSignal(index(entry, base, requestInBudget), controller.signal);
      function find(url) {
        const id = productId(url.searchParams.get('p')) || productId(url.searchParams.get('product_id'));
        if (id) return entry.byId.get(id);
        const slug = url.pathname.match(/\/product\/([^/]+)\/?$/i)?.[1];
        if (!slug) return null;
        // Malformed renter URLs are misses, not a website outage.
        try { return entry.byId.get(entry.slugs.get(decodeURIComponent(slug).toLowerCase())); }
        catch { return null; }
      }
      let product = find(incoming);
      // Only one extra refresh per cache cycle, inside the same total budget.
      if (!product && !entry.missRefreshed) {
        entry.missRefreshed = true;
        await withSignal(index(entry, base, requestInBudget, true), controller.signal);
        product = find(incoming);
      }
      for (let hop = 0; !product && hop < 3; hop++) {
        if (!/\/product\/[^/]+\/?$/i.test(incoming.pathname)) break;
        const target = new URL(incoming.pathname, base.origin);
        const response = await requestInBudget(target);
        if (response.status >= 500) throw new Error('Website unavailable');
        if (response.status !== 301 || !response.headers.location) break;
        incoming = sameWebsite(response.headers.location, target);
        if (!incoming || !sameWebsite(incoming, base)) break;
        product = find(incoming);
      }
      return product ? { product_id: product.product_id, name: product.name, permalink: product.permalink } : null;
    } catch {
      // Failures belong to the org + configured base URL, never all tenants.
      // Unknown products/404 redirects are ordinary misses and do not set this.
      if (entry) entry.failedUntil = now() + FAILURE_COOLDOWN_MS;
      return null;
    } finally { clearTimeout(timer); }
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
