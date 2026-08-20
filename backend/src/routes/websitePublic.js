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
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');

const router = express.Router();

// A public locator, not a secret and not authorisation: it only says WHICH organisation's
// published FAQs to return. Same expression the master migration constrains the column with.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$/;

// Explicit origins rather than '*'. Server-to-server callers send no Origin and are unaffected;
// this only decides which BROWSERS may read the response cross-site.
const origins = new Set(
  String(process.env.WEBSITE_CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
);

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

    const propertyId = req.query.property_id == null ? null : String(req.query.property_id);
    if (propertyId !== null && (!/^\d+$/.test(propertyId) || propertyId === '0')) {
      return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
    }

    // A property that does not exist, or has been removed, is refused outright. It never falls
    // back to the global set, because silently answering a different question than the one asked
    // is how the wrong building's details reach someone.
    let property_context = null;
    if (propertyId !== null) {
      const [ps] = await pool.execute(
        'SELECT id,display_name FROM property WHERE id=? AND deleted_at IS NULL',
        [propertyId]
      );
      if (!ps.length) return res.status(400).json({ code: 'INVALID_PROPERTY', message: 'Invalid property.' });
      property_context = { id: String(ps[0].id), display_name: ps[0].display_name };
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
    const [rows] = await pool.execute(
      `SELECT DISTINCT ck.id,ck.category,ck.title,ck.body,ck.updated_at,ck.sort_order,ck.created_at FROM chat_knowledge ck WHERE ck.kind='faq' AND ck.status=1 AND ck.publish_website=1 AND (NOT EXISTS(SELECT 1 FROM chat_knowledge_property s WHERE s.chat_knowledge_id=ck.id) OR EXISTS(SELECT 1 FROM chat_knowledge_property s JOIN property p ON p.id=s.property_id AND p.deleted_at IS NULL WHERE s.chat_knowledge_id=ck.id AND s.property_id=?)) ORDER BY ck.sort_order,ck.created_at LIMIT 500`,
      [propertyId]
    );

    // Which buildings the site should offer in its selector — names only, never their answers.
    const [available] = await pool.execute(
      `SELECT DISTINCT p.id,p.display_name FROM property p JOIN chat_knowledge_property s ON s.property_id=p.id JOIN chat_knowledge ck ON ck.id=s.chat_knowledge_id WHERE p.deleted_at IS NULL AND ck.kind='faq' AND ck.status=1 AND ck.publish_website=1 ORDER BY p.display_name,p.id`
    );

    const faqs = rows.map(r => ({
      id: String(r.id), category: r.category || 'other', title: r.title, body: r.body, updated_at: r.updated_at,
    }));
    const available_properties = available.map(p => ({ id: String(p.id), display_name: p.display_name }));

    // Hashed over the response itself, so an edit anywhere — text, order, scope, a renamed
    // building — changes the tag and the site picks it up rather than serving a stale answer.
    const version = crypto.createHash('sha256')
      .update(JSON.stringify({ property_context, faqs, available_properties }))
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

    const payload = { code: 200, data: { version, property_context, faqs, available_properties } };
    if (Buffer.byteLength(JSON.stringify(payload)) > 1_000_000) {
      return res.status(503).json({ code: 503, message: 'Response too large' });
    }
    res.json(payload);
  } catch (err) {
    console.error('[website/faqs]', err);
    res.status(500).json({ code: 500, message: 'Failed to fetch FAQs' });
  }
});

module.exports = router;
module.exports.SLUG_RE = SLUG_RE;
