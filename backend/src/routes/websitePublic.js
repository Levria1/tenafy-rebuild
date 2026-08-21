/**
 * The marketing site's FAQ feed. Keyless, and deliberately the narrowest route in the system.
 *
 * Mounted at /api/website, OUTSIDE the API-key router in index.js. That separation is the whole
 * design: every key under /api/public is either read-only or read-write, with no per-endpoint
 * scoping, so a key held by WordPress in order to fetch FAQs could also read tenants, leases,
 * invoices, payments and accounting. A compromised website would become a compromised tenant
 * database. Since the content here is published to the open internet by definition, there is
 * nothing for a credential to protect — so there is no credential, and this file physically
 * cannot reach anything else.
 *
 * Everything below narrows rather than widens. If you are adding to it, the question to ask is
 * whether a stranger on the internet may have the thing you are about to return.
 */
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');

// Resolve a stored file name inside the uploads directory. The name comes from our own DB, but
// this still refuses anything that escapes the directory — a traversal in stored data would
// otherwise become a file read.
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
function resolveUploadPath(itemName) {
  if (!itemName) return null;
  const candidate = path.resolve(UPLOADS_DIR, String(itemName));
  if (candidate !== path.join(UPLOADS_DIR, path.basename(candidate))) return null;
  return fs.existsSync(candidate) ? candidate : null;
}

const router = express.Router();

// A public locator, not a secret and not authorisation: it only says WHICH organisation's
// published FAQs to return. Same expression the master migration constrains the column with.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/;

// Explicit origins rather than '*'. Server-to-server callers send no Origin and are unaffected;
// this only decides which BROWSERS may read the response cross-site.
const origins = new Set(
  String(process.env.WEBSITE_CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
);

function slugForPublicLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'building';
}

function parseAliases(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addSearchTerm(list, seen, value) {
  if (value == null) return;
  const text = String(value).trim();
  if (!text) return;
  const key = text.toLocaleLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(text);
}

function groupedProperties(rows) {
  const groups = new Map();

  for (const p of rows) {
    const publicLabel = String(p.public_label || '').trim();
    const label = publicLabel || String(p.display_name || '').trim();
    if (!label) continue;
    const buildingName = String(p.public_building_name || '').trim();
    const groupKey = label.toLocaleLowerCase();
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: slugForPublicLabel(label),
        label,
        building_name: buildingName || null,
        property_ids: [],
        search_terms: [],
        _seenTerms: new Set(),
      };
      addSearchTerm(group.search_terms, group._seenTerms, label);
      addSearchTerm(group.search_terms, group._seenTerms, buildingName);
      groups.set(groupKey, group);
    } else if (!group.building_name && buildingName) {
      group.building_name = buildingName;
      addSearchTerm(group.search_terms, group._seenTerms, buildingName);
    }

    group.property_ids.push(String(p.id));
    addSearchTerm(group.search_terms, group._seenTerms, p.display_name);
    addSearchTerm(group.search_terms, group._seenTerms, p.street_address);
    addSearchTerm(group.search_terms, group._seenTerms, p.district);
    for (const alias of parseAliases(p.public_aliases)) addSearchTerm(group.search_terms, group._seenTerms, alias);
  }

  // Slugs are lossy: "95 Tung Choi St" and "95 Tung Choi St." both reduce to the same string, and a
  // punctuation-only label reduces to the fallback. Two groups sharing a key would make a shared
  // ?building= link resolve to whichever sorted first — i.e. quietly serve the other building.
  // Suffix duplicates so a key always identifies exactly one group.
  const ordered = [...groups.values()]
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const usedKeys = new Set();
  for (const group of ordered) {
    let key = group.key;
    let n = 2;
    while (usedKeys.has(key)) key = `${group.key}-${n++}`;
    usedKeys.add(key);
    group.key = key;
  }
  return ordered.map(({ _seenTerms, ...group }) => group);
}

// Keyed by IP AND slug so one noisy site cannot exhaust another organisation's allowance.
const limiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => `${req.ip}:${req.params.org_slug || ''}`,
  message: { code: 429, message: 'Too many requests.' },
});

router.get('/:org_slug/faqs', limiter, async (req, res) => {
  try {
    req.setTimeout?.(5000);

    const slug = String(req.params.org_slug || '');
    if (!SLUG_RE.test(slug)) return res.status(404).json({ code: 404, message: 'Not found' });

    // An organisation with no slug is unreachable here, which is the intended default: the
    // feature stays off until someone deliberately publishes an organisation.
    const [orgs] = await getMasterPool().execute(
      'SELECT id FROM organizations WHERE public_slug=? AND status=1 AND public_api_enabled=1 LIMIT 1',
      [slug]
    );
    if (!orgs.length) return res.status(404).json({ code: 404, message: 'Not found' });

    const pool = await getOrgPool(orgs[0].id);

    const rawPropertyId = req.query.property_id == null ? null : String(req.query.property_id);
    const propertyIds = rawPropertyId == null ? [] : rawPropertyId.split(',').map(x => x.trim());
    if (propertyIds.length > 20 || propertyIds.some(id => !/^\d+$/.test(id) || id === '0')) {
      return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
    }
    const uniquePropertyIds = [...new Set(propertyIds)];

    // A property that does not exist, or has been removed, is refused outright. It never falls
    // back to the global set, because silently answering a different question than the one asked
    // is how the wrong building's details reach someone.
    let property_context = null;
    if (uniquePropertyIds.length) {
      const propertyPlaceholders = uniquePropertyIds.map(() => '?').join(',');
      const [ps] = await pool.execute(
        `SELECT id,display_name FROM property WHERE id IN (${propertyPlaceholders}) AND deleted_at IS NULL`,
        uniquePropertyIds
      );
      if (ps.length !== uniquePropertyIds.length) {
        return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
      }
      const byId = new Map(ps.map(p => [String(p.id), p]));
      const properties = uniquePropertyIds.map(id => {
        const p = byId.get(String(id));
        return { id: String(p.id), display_name: p.display_name };
      });
      property_context = propertyIds.length === 1
        ? properties[0]
        : { property_ids: properties.map(p => p.id), properties };
    }

    // The one statement that returns text, and every clause in it is load-bearing:
    //   kind='faq'          rules are team instructions and can never be published
    //   status=1            archived entries stay archived
    //   publish_website=1   the operator's explicit choice, and the ONLY thing that puts an entry
    //                       here. Deliberately independent of `visibility`: the operator asked for
    //                       three separate audiences — their own assistant, TaneChat, the website —
    //                       rather than a ladder where each implies the last. The consequence,
    //                       which the UI states plainly: turning OFF sharing with TaneChat does
    //                       not take a page off the website. Two switches, managed separately.
    //   NOT EXISTS(...)     an entry with no property links is global
    //   OR EXISTS(...)      an entry WITH links appears only for the property asked for, and
    //                       only while that property still exists
    // With no property_id the parameter is NULL, which matches nothing — so scoped bodies are
    // absent from the response rather than filtered out of it later.
    const scopedPlaceholders = uniquePropertyIds.length ? uniquePropertyIds.map(() => '?').join(',') : '?';
    const scopedParams = uniquePropertyIds.length ? uniquePropertyIds : [null];
    const [rows] = await pool.execute(
      `SELECT DISTINCT ck.id,ck.category,ck.title,ck.body,ck.updated_at,ck.sort_order,ck.created_at FROM chat_knowledge ck WHERE ck.kind='faq' AND ck.status=1 AND ck.publish_website=1 AND (NOT EXISTS(SELECT 1 FROM chat_knowledge_property s WHERE s.chat_knowledge_id=ck.id) OR EXISTS(SELECT 1 FROM chat_knowledge_property s JOIN property p ON p.id=s.property_id AND p.deleted_at IS NULL WHERE s.chat_knowledge_id=ck.id AND s.property_id IN (${scopedPlaceholders}))) ORDER BY ck.sort_order,ck.created_at LIMIT 500`,
      scopedParams
    );

    // Which buildings the site should offer in its selector — public facts only, never their answers.
    const [available] = await pool.execute(
      `SELECT DISTINCT p.id,p.display_name,p.public_label,p.public_building_name,p.public_aliases,p.street_address,p.district FROM property p JOIN chat_knowledge_property s ON s.property_id=p.id JOIN chat_knowledge ck ON ck.id=s.chat_knowledge_id WHERE p.deleted_at IS NULL AND ck.kind='faq' AND ck.status=1 AND ck.publish_website=1 ORDER BY COALESCE(NULLIF(TRIM(p.public_label),''),p.display_name),p.id`
    );

    const faqs = rows.map(r => ({
      id: String(r.id), category: r.category || 'other', title: r.title, body: r.body, updated_at: r.updated_at, images: [],
    }));

    if (faqs.length) {
      const ids = faqs.map(f => f.id);
      const byFaq = new Map(faqs.map(f => [f.id, f.images]));
      const placeholders = ids.map(() => '?').join(',');
      const [images] = await pool.execute(
        `SELECT cki.id,cki.chat_knowledge_id,cki.file_id,cki.caption FROM chat_knowledge_image cki JOIN file f ON f.id=cki.file_id WHERE cki.chat_knowledge_id IN (${placeholders}) AND f.deleted_at IS NULL ORDER BY cki.sort_order,cki.id`,
        ids
      );
      for (const img of images) {
        const list = byFaq.get(String(img.chat_knowledge_id));
        if (!list) continue;
        list.push({
          id: String(img.id),
          url: `/api/website/${encodeURIComponent(slug)}/faq-image/${String(img.file_id)}`,
          caption: img.caption || null,
        });
      }
    }
    const available_properties = available.map(p => ({ id: String(p.id), display_name: p.display_name }));
    const available_property_groups = groupedProperties(available);

    // Hashed over the response itself, so an edit anywhere — text, order, scope, a renamed
    // building — changes the tag and the site picks it up rather than serving a stale answer.
    const version = crypto.createHash('sha256')
      .update(JSON.stringify({ property_context, faqs, available_properties, available_property_groups }))
      .digest('hex');

    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');   // or a CDN caches one site's grant and serves it to another
    }
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.setHeader('ETag', `"${version}"`);
    if (String(req.headers['if-none-match'] || '').replace(/"/g, '') === version) {
      return res.status(304).end();
    }

    const payload = { code: 200, data: { version, property_context, faqs, available_properties, available_property_groups } };
    if (Buffer.byteLength(JSON.stringify(payload)) > 1_000_000) {
      return res.status(503).json({ code: 503, message: 'Response too large' });
    }
    res.json(payload);
  } catch (err) {
    console.error('[website/faqs]', err);
    res.status(500).json({ code: 500, message: 'Failed to fetch FAQs' });
  }
});

// An image belonging to a published FAQ, addressed THROUGH the organisation that published it.
//
// The obvious URL was /api/file/preview/:id, and it worked here only by accident: with no session
// that route falls back to "the first active organisation" (an unordered LIMIT 1 in file.js), which
// today happens to be the right one. That is a coincidence, not a guarantee — MySQL may return a
// different row at any time, and a second organisation publishing FAQ images would either 404 or be
// served someone else's picture.
//
// This route is also NARROWER than the one it replaces. /api/file/preview will serve any image in
// the org to an anonymous caller; this serves only a file that is actually attached to a published,
// website-visible FAQ. A file id that is not on such an FAQ is a 404 here even though the same id
// is fetchable there.
router.get('/:org_slug/faq-image/:file_id', limiter, async (req, res) => {
  try {
    const slug = String(req.params.org_slug || '');
    const fileId = String(req.params.file_id || '');
    if (!SLUG_RE.test(slug) || !/^\d+$/.test(fileId) || fileId === '0') {
      return res.status(404).json({ code: 404, message: 'Not found' });
    }

    const [orgs] = await getMasterPool().execute(
      'SELECT id FROM organizations WHERE public_slug=? AND status=1 AND public_api_enabled=1 LIMIT 1',
      [slug]
    );
    if (!orgs.length) return res.status(404).json({ code: 404, message: 'Not found' });
    const pool = await getOrgPool(orgs[0].id);

    // Attached to a live, website-published FAQ — the same three conditions the feed itself uses.
    const [rows] = await pool.execute(
      `SELECT f.item_name, f.mime_type FROM chat_knowledge_image cki
         JOIN chat_knowledge ck ON ck.id = cki.chat_knowledge_id
         JOIN file f ON f.id = cki.file_id
        WHERE cki.file_id = ? AND f.deleted_at IS NULL
          AND ck.kind='faq' AND ck.status=1 AND ck.publish_website=1
        LIMIT 1`,
      [fileId]
    );
    if (!rows.length) return res.status(404).json({ code: 404, message: 'Not found' });

    const mime = String(rows[0].mime_type || '').toLowerCase();
    if (!mime.startsWith('image/')) return res.status(404).json({ code: 404, message: 'Not found' });

    const filePath = resolveUploadPath(rows[0].item_name);
    if (!filePath) return res.status(404).json({ code: 404, message: 'Not found' });

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[website/faq-image]', err);
    res.status(500).json({ code: 500, message: 'Failed to fetch image' });
  }
});

module.exports = router;
module.exports.SLUG_RE = SLUG_RE;
