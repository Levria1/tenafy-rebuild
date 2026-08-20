const test = require('node:test');
const assert = require('node:assert/strict');

const publicRouter = require('../src/routes/public');

/**
 * Does a scoped answer stay out of a response that has no business carrying it?
 *
 * The sibling suite answers this with a pool that returns canned rows keyed on
 * `sql.includes(...)`, which cannot fail: the WHERE clause is never executed, so the scoped
 * row is absent because the fixture never offered it, not because the query excluded it.
 * Deleting the property filter outright left that suite green. A faked database cannot
 * verify a SQL contract — the same lesson that let an invalid statement reach production
 * earlier today.
 *
 * So this fake EMULATES the statement it is handed rather than pattern-matching it. It reads
 * the clauses actually present and applies them to fixture rows. Remove a filter from the
 * route and the fake stops filtering too, exactly as MySQL would, and the scoped body
 * surfaces in the response where the assertions can see it.
 *
 * It is still a simulation, and simulations drift. The authoritative check is
 * `scripts/rehearse-knowledge-scope.js`, which runs the real statements against a real
 * database. This suite exists so the property is guarded on every commit, not only when
 * someone remembers to rehearse.
 */
function emulatedPool({ knowledge, links, deletedProperties = [] }) {
  const linkedTo = (id) => links.filter(l => String(l.knowledge_id) === String(id));
  const isDeleted = (pid) => deletedProperties.map(String).includes(String(pid));

  return {
    execute: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ');

      // The three statements are told apart by what they SELECT, never by a filter clause —
      // reading a filter to decide which query this is would reintroduce the blind spot.
      const selectsBodies = /SELECT DISTINCT ck\.id/.test(flat) || /SELECT DISTINCT ck\.id,ck\.category/.test(flat);
      const selectsTopics = /SELECT ck\.id, ck\.kind, ck\.category/.test(flat);
      const selectsPropertyRow = /FROM property WHERE id/.test(flat);

      if (selectsPropertyRow) {
        const pid = params[0];
        if (isDeleted(pid) && /deleted_at IS NULL/.test(flat)) return [[]];
        return [[{ id: pid, display_name: 'Right Building' }]];
      }

      if (selectsBodies) {
        // Clauses the route may or may not have written. Absent clause, absent filtering — that
        // is the whole point: a deleted filter must change what comes back.
        const excludesDeleted = /p\.deleted_at IS NULL/.test(flat);
        const faqOnly = /ck\.kind='faq'/.test(flat);
        const activeOnly = /ck\.status=1/.test(flat) || /ck\.status = 1/.test(flat);
        const publicOnly = /ck\.visibility='public'/.test(flat) || /ck\.visibility = 'public'/.test(flat);
        const websiteOnly = /ck\.publish_website=1/.test(flat);

        // The two halves of the scope expression are read SEPARATELY. Detecting the join table
        // and treating the whole thing as "scoping happens" cannot tell the difference between
        // the branches, so deleting only the NOT EXISTS half — which in MySQL drops every global
        // entry from every variant — would go unnoticed.
        const hasGlobalBranch = /NOT EXISTS\s*\(\s*SELECT 1 FROM chat_knowledge_property/.test(flat);
        const hasScopedBranch = /OR EXISTS\s*\(\s*SELECT 1 FROM chat_knowledge_property/.test(flat);
        const askedFor = params.length ? params[params.length - 1] : null;

        const rows = knowledge.filter((k) => {
          if (faqOnly && k.kind !== 'faq') return false;
          if (activeOnly && k.status !== 1) return false;
          if (publicOnly && k.visibility !== 'public') return false;
          if (websiteOnly && k.publish_website !== 1) return false;
          if (!hasGlobalBranch && !hasScopedBranch) return true;   // no scoping written at all

          // Globality is decided by whether ANY link row exists, deleted or not — matching the
          // route's `NOT EXISTS (... FROM chat_knowledge_property ...)`, which joins no property
          // and reads no deleted_at. Applying the deletion filter here instead would quietly
          // promote an entry whose only building was removed back to global, which is the
          // opposite of what the statement does.
          const all = linkedTo(k.id);
          const isGlobal = all.length === 0;
          const matchesAsked = all.some(l => String(l.property_id) === String(askedFor)
            && !(excludesDeleted && isDeleted(l.property_id)));
          return (hasGlobalBranch && isGlobal) || (hasScopedBranch && matchesAsked);
        });
        return [rows.map(r => ({ ...r }))];
      }

      if (selectsTopics) {
        const excludesDeleted = /p\.deleted_at IS NULL/.test(flat);
        const activeOnly = /ck\.status=1/.test(flat) || /ck\.status = 1/.test(flat);
        const publicOnly = /ck\.visibility='public'/.test(flat) || /ck\.visibility = 'public'/.test(flat);
        const out = [];
        for (const k of knowledge) {
          if (activeOnly && k.status !== 1) continue;
          if (publicOnly && k.visibility !== 'public') continue;
          for (const l of linkedTo(k.id)) {
            if (excludesDeleted && isDeleted(l.property_id)) continue;
            // Only the columns the statement names reach the caller — a query that asks for
            // a title gets one, which is how a widened SELECT is caught.
            const row = { id: k.id, kind: k.kind, category: k.category,
              property_id: l.property_id, display_name: 'Right Building' };
            if (/ck\.title/.test(flat)) row.title = k.title;
            if (/ck\.body/.test(flat)) row.body = k.body;
            out.push(row);
          }
        }
        return [out];
      }

      // available_properties — the selector's list of buildings, names only.
      if (/SELECT DISTINCT p\.id/.test(flat)) {
        const excludesDeleted = /p\.deleted_at IS NULL/.test(flat);
        const faqOnly = /ck\.kind='faq'/.test(flat);
        const activeOnly = /ck\.status=1/.test(flat);
        const websiteOnly = /ck\.publish_website=1/.test(flat);
        const seen = new Map();
        for (const k of knowledge) {
          if (faqOnly && k.kind !== 'faq') continue;
          if (activeOnly && k.status !== 1) continue;
          if (websiteOnly && k.publish_website !== 1) continue;
          for (const l of linkedTo(k.id)) {
            if (excludesDeleted && isDeleted(l.property_id)) continue;
            // Only the columns named. A statement that asks for a body gets one — which is how a
            // widened SELECT on this query would be caught.
            const row = { id: l.property_id, display_name: 'Right Building' };
            if (/ck\.body/.test(flat)) row.body = k.body;
            if (/ck\.title/.test(flat)) row.title = k.title;
            seen.set(String(l.property_id), row);
          }
        }
        return [[...seen.values()]];
      }

      throw new Error('Unemulated SQL: ' + flat.slice(0, 120));
    },
  };
}

const SCOPED_TITLE = 'SCOPED TITLE ACCOUNT 12345678';
const SCOPED_BODY = 'SCOPED BODY pay to account 12345678';
const INTERNAL_TITLE = 'INTERNAL ONLY TITLE';
const INTERNAL_BODY = 'INTERNAL ONLY never leaves the building';
const ARCHIVED_TITLE = 'ARCHIVED TITLE';
const ARCHIVED_BODY = 'ARCHIVED BODY should stay archived';
const RULE_TITLE = 'RULE TITLE';
const RULE_BODY = 'RULE BODY team instruction not for customers';

const FIXTURES = {
  knowledge: [
    { id: '1', kind: 'faq', category: 'other', title: 'Global question', body: 'Global answer',
      status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    { id: '2', kind: 'faq', category: 'payments', title: SCOPED_TITLE, body: SCOPED_BODY,
      status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    // Never shareable, never publishable. Present so that dropping a visibility or status filter
    // has something to leak.
    { id: '3', kind: 'faq', category: 'other', title: INTERNAL_TITLE, body: INTERNAL_BODY,
      status: 1, visibility: 'internal', publish_website: 0, tags: null, sort_order: 0, updated_at: new Date(0) },
    { id: '4', kind: 'faq', category: 'other', title: ARCHIVED_TITLE, body: ARCHIVED_BODY,
      status: 0, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    { id: '5', kind: 'rule', category: null, title: RULE_TITLE, body: RULE_BODY,
      status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    { id: '6', kind: 'faq', category: 'building_access', title: 'Internal scoped', body: 'Internal scoped body',
      status: 1, visibility: 'internal', publish_website: 0, tags: null, sort_order: 0, updated_at: new Date(0) },
  ],
  links: [
    { knowledge_id: '2', property_id: '42' },
    // An INTERNAL entry that is also property-scoped. Without a link it could never reach the
    // topics query, so dropping that query's visibility filter would go unnoticed.
    { knowledge_id: '6', property_id: '42' },
  ],
};

function handlerFor(router, routePath) {
  const layer = router.stack.find(x => x.route && x.route.path === routePath && x.route.methods.get);
  return layer.route.stack.at(-1).handle;
}

async function callKnowledge(propertyId, fixtures = FIXTURES) {
  let body = null; let status = 200;
  const res = { setHeader() {}, status(n) { status = n; return this; }, json(v) { body = v; return v; }, end() {} };
  await handlerFor(publicRouter, '/chat/knowledge')(
    { query: propertyId == null ? {} : { property_id: String(propertyId) },
      headers: {}, pool: emulatedPool(fixtures) }, res);
  return { status, wire: JSON.stringify(body), body };
}

test('a scoped answer is absent when the property is unknown', async () => {
  const r = await callKnowledge(null);
  assert.equal(r.status, 200);
  assert.ok(!r.wire.includes(SCOPED_TITLE), 'the scoped title must not appear anywhere in the response');
  assert.ok(!r.wire.includes(SCOPED_BODY), 'the scoped body must not appear anywhere in the response');
  assert.ok(r.wire.includes('Global answer'), 'global content must still be served');
});

test('a scoped answer is absent when a DIFFERENT property is named', async () => {
  const r = await callKnowledge('77');
  assert.ok(!r.wire.includes(SCOPED_TITLE));
  assert.ok(!r.wire.includes(SCOPED_BODY), 'Poplar must never receive Nam Pak Hong\'s bank details');
  assert.ok(r.wire.includes('Global answer'));
});

test('a scoped answer IS served to its own property', async () => {
  // The counterpart. Without this the filter could simply return nothing and pass everything above.
  const r = await callKnowledge('42');
  assert.ok(r.wire.includes(SCOPED_BODY), 'the right building must get its own answer');
});

test('topic metadata carries the category but never the words', async () => {
  const r = await callKnowledge(null);
  const topics = r.body.data.property_topics;
  // Exactly one: the public scoped entry. The internal scoped entry must not be advertised at
  // all — its existence and category are still information the partner has no business holding.
  assert.equal(topics.length, 1, 'an internal entry was advertised in topic metadata');
  assert.equal(topics[0].id, '2');
  assert.equal(topics[0].category, 'payments', 'the category is what lets the bot know it must ask');
  assert.ok(!JSON.stringify(topics).includes(SCOPED_TITLE));
  assert.ok(!JSON.stringify(topics).includes(SCOPED_BODY));
});

test('an entry scoped only to a deleted property reaches nobody', async () => {
  // Its link row still exists, so it stays scoped — and is therefore served to no one. Safe,
  // but silent, which is why staff are shown it separately.
  const fixtures = { ...FIXTURES, deletedProperties: ['42'] };
  for (const asked of [null, '42', '77']) {
    const r = await callKnowledge(asked, fixtures);
    assert.ok(!r.wire.includes(SCOPED_BODY), `deleted-property entry leaked when asked for ${asked}`);
  }
});

// ── The website feed, through the same emulator ──────────────────────────────
//
// This is the boundary that was left unguarded: the mutations already demonstrated against it —
// deleting its scope expression, and serving rules alongside FAQs — passed the original suite
// untouched. Fixing the partner path and leaving this one was the same mistake in a second place.

const registry = require('../src/config/poolRegistry');

/**
 * The router DESTRUCTURES its pool functions at import time, so patching the registry afterwards
 * changes nothing and the handler quietly dials a real database. That produced a 500, and two of
 * these tests passed on it — a response containing no scoped body because it contained no body at
 * all. Hence the counterpart test that demands the right building DOES get its answer: without it,
 * "nothing leaked" and "nothing worked" are indistinguishable.
 *
 * So: patch first, then re-require the router so it closes over the patched functions.
 */
async function callWebsite(propertyId, fixtures = FIXTURES, { origin } = {}) {
  const originalMaster = registry.getMasterPool;
  const originalOrg = registry.getOrgPool;
  registry.getMasterPool = () => ({ execute: async () => [[{ id: 'ORG' }]] });
  registry.getOrgPool = async () => emulatedPool(fixtures);
  delete require.cache[require.resolve('../src/routes/websitePublic')];
  const websiteRouter = require('../src/routes/websitePublic');
  try {
    const layer = websiteRouter.stack.find(x => x.route && x.route.path === '/:org_slug/faqs');
    const handle = layer.route.stack.at(-1).handle;
    let body = null; let status = 200; const headers = {};
    const res = {
      setHeader(k, v) { headers[k] = v; }, status(n) { status = n; return this; },
      json(v) { body = v; return v; }, end() {},
    };
    await handle({
      params: { org_slug: 'taneres' },
      query: propertyId == null ? {} : { property_id: String(propertyId) },
      headers: origin ? { origin } : {}, ip: '127.0.0.1', setTimeout() {},
    }, res);
    return { status, headers, body, wire: JSON.stringify(body) };
  } finally {
    registry.getMasterPool = originalMaster;
    registry.getOrgPool = originalOrg;
    delete require.cache[require.resolve('../src/routes/websitePublic')];
  }
}

test('website: a scoped answer is absent until a building is chosen', async () => {
  const r = await callWebsite(null);
  assert.equal(r.status, 200);
  assert.ok(!r.wire.includes(SCOPED_TITLE));
  assert.ok(!r.wire.includes(SCOPED_BODY), 'a visitor must not receive a building-specific answer unasked');
  assert.ok(r.wire.includes('Global answer'), 'global FAQs must still render');
});

test('website: a scoped answer is absent for a DIFFERENT building', async () => {
  const r = await callWebsite('77');
  assert.ok(!r.wire.includes(SCOPED_BODY));
});

test('website: the right building gets its own answer', async () => {
  const r = await callWebsite('42');
  assert.ok(r.wire.includes(SCOPED_BODY));
});

test('website: rules, internal entries and archived entries can never be published', async () => {
  // Three separate filters, each with something in the fixtures to leak if it were dropped.
  for (const asked of [null, '42']) {
    const r = await callWebsite(asked);
    assert.ok(!r.wire.includes(RULE_BODY), `a team rule reached the website (asked ${asked})`);
    assert.ok(!r.wire.includes(INTERNAL_BODY), `an internal entry reached the website (asked ${asked})`);
    assert.ok(!r.wire.includes(ARCHIVED_BODY), `an archived entry reached the website (asked ${asked})`);
  }
});

test('website: the building selector lists names, never answers', async () => {
  const r = await callWebsite(null);
  const available = r.body.data.available_properties;
  assert.equal(available.length, 1);
  assert.ok(!JSON.stringify(available).includes(SCOPED_BODY));
  assert.ok(!JSON.stringify(available).includes(SCOPED_TITLE));
});

test('website: an unknown building is refused rather than answered globally', async () => {
  const r = await callWebsite('999999', { ...FIXTURES, deletedProperties: ['999999'] });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_PROPERTY');
});

test('website: CORS is granted to a configured origin and to nobody else', async () => {
  const prior = process.env.WEBSITE_CORS_ORIGINS;
  process.env.WEBSITE_CORS_ORIGINS = 'https://taneresidence.com';
  try {
    const call = async (origin) => {
      const originalMaster = registry.getMasterPool; const originalOrg = registry.getOrgPool;
      registry.getMasterPool = () => ({ execute: async () => [[{ id: 'ORG' }]] });
      registry.getOrgPool = async () => emulatedPool(FIXTURES);
      delete require.cache[require.resolve('../src/routes/websitePublic')];
      const fresh = require('../src/routes/websitePublic');
      const layer = fresh.stack.find(x => x.route && x.route.path === '/:org_slug/faqs');
      const handle = layer.route.stack.at(-1).handle;
      const headers = {};
      const res = { setHeader(k, v) { headers[k] = v; }, status() { return this; }, json(v) { return v; }, end() {} };
      try {
        await handle({ params: { org_slug: 'taneres' }, query: {}, headers: { origin }, ip: '1.1.1.1', setTimeout() {} }, res);
      } finally { registry.getMasterPool = originalMaster; registry.getOrgPool = originalOrg; }
      return headers;
    };
    const allowed = await call('https://taneresidence.com');
    assert.equal(allowed['Access-Control-Allow-Origin'], 'https://taneresidence.com');
    assert.equal(allowed.Vary, 'Origin', 'without Vary a CDN serves one site\'s grant to another');
    const denied = await call('https://not-your-site.example');
    assert.equal(denied['Access-Control-Allow-Origin'], undefined);
  } finally {
    if (prior === undefined) delete process.env.WEBSITE_CORS_ORIGINS;
    else process.env.WEBSITE_CORS_ORIGINS = prior;
    delete require.cache[require.resolve('../src/routes/websitePublic')];
  }
});
