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
 * KNOW WHAT THIS DOES AND DOES NOT CATCH. It reads whether a clause is PRESENT and then applies
 * that clause itself. So:
 *
 *   DELETING the property predicate      -> caught. These tests go red.
 *   NEUTRALISING it while keeping the    -> NOT caught. `AND (1=1 OR s.property_id IN (...))`
 *   text, e.g. an OR short-circuit          still contains the text this fake looks for, so the
 *                                           fake keeps filtering when MySQL would not.
 *
 * The tripwire test at the bottom of this file covers that second case by pinning the predicate
 * itself, so any edit to it has to be deliberate.
 *
 * There is NO real-database rehearsal yet. An earlier version of this comment claimed one existed
 * at `scripts/rehearse-knowledge-scope.js`; it never did. Until it does, this fake plus the
 * tripwire is the whole guard — do not read it as more than that.
 */
function emulatedPool({ knowledge, links, images = [], files = [], deletedProperties = [], properties }) {
  const linkedTo = (id) => links.filter(l => String(l.knowledge_id) === String(id));
  const isDeleted = (pid) => deletedProperties.map(String).includes(String(pid));
  const fileFor = (id) => files.find(f => String(f.id) === String(id));
  const propertyFixtures = Array.isArray(properties) ? properties : null;
  const propertyFor = (id) => {
    const found = propertyFixtures && propertyFixtures.find(p => String(p.id) === String(id));
    if (found) return found;
    if (propertyFixtures) return null;
    return { id, display_name: 'Right Building', public_label: null, public_building_name: null,
      public_aliases: null, street_address: null, district: null };
  };

  return {
    execute: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ');

      // The three statements are told apart by what they SELECT, never by a filter clause —
      // reading a filter to decide which query this is would reintroduce the blind spot.
      const selectsBodies = /SELECT DISTINCT ck\.id/.test(flat) || /SELECT DISTINCT ck\.id,ck\.category/.test(flat);
      const selectsTopics = /SELECT ck\.id, ck\.kind, ck\.category/.test(flat);
      const selectsPropertyRow = /FROM property WHERE id/.test(flat);
      const selectsImages = /FROM chat_knowledge_image cki JOIN file f ON f\.id=cki\.file_id/.test(flat);

      if (selectsPropertyRow) {
        const excludesDeleted = /deleted_at IS NULL/.test(flat);
        const rows = params
          .map(pid => propertyFor(pid))
          .filter(Boolean)
          .filter(p => !(excludesDeleted && isDeleted(p.id)))
          .map(p => ({ id: p.id, display_name: p.display_name }));
        return [rows];
      }

      if (selectsImages) {
        const askedFor = new Set(params.map(String));
        const excludesDeletedFiles = /f\.deleted_at IS NULL/.test(flat);
        const rows = images
          .filter(img => askedFor.has(String(img.chat_knowledge_id)))
          .filter((img) => {
            const file = fileFor(img.file_id);
            if (!file) return false;
            if (excludesDeletedFiles && file.deleted_at != null) return false;
            return true;
          })
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)
            || (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0))
          .map(img => ({ ...img }));
        return [rows];
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
        const hasPropertyPredicate = /s\.property_id\s*(?:=\s*\?|IN\s*\()/.test(flat);
        const askedFor = new Set(params.filter(v => v != null).map(String));

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
          const matchesAsked = all.some(l => (!hasPropertyPredicate || askedFor.has(String(l.property_id)))
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
            const p = propertyFor(l.property_id);
            if (!p) continue;
            // Only the columns named. A statement that asks for a body gets one — which is how a
            // widened SELECT on this query would be caught.
            const row = { id: p.id, display_name: p.display_name };
            if (/p\.public_label/.test(flat)) row.public_label = p.public_label;
            if (/p\.public_building_name/.test(flat)) row.public_building_name = p.public_building_name;
            if (/p\.public_aliases/.test(flat)) row.public_aliases = p.public_aliases;
            if (/p\.street_address/.test(flat)) row.street_address = p.street_address;
            if (/p\.district/.test(flat)) row.district = p.district;
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
  images: [
    { id: '100', chat_knowledge_id: '2', file_id: '200', caption: 'Fuse box in the hallway', sort_order: 0 },
  ],
  files: [
    { id: '200', deleted_at: null },
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

test('website: multiple buildings include FAQs scoped to any requested property once', async () => {
  const fixtures = {
    knowledge: [
      { id: '1', kind: 'faq', category: 'other', title: 'Global question', body: 'Global answer',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
      { id: '2', kind: 'faq', category: 'payments', title: 'Shared title', body: 'Shared answer',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
      { id: '7', kind: 'faq', category: 'maintenance', title: 'Second title', body: 'Second answer',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
      { id: '8', kind: 'faq', category: 'other', title: 'Third title', body: 'Third answer',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    ],
    links: [
      { knowledge_id: '2', property_id: '42' },
      { knowledge_id: '2', property_id: '77' },
      { knowledge_id: '7', property_id: '77' },
      { knowledge_id: '8', property_id: '99' },
    ],
  };

  const r = await callWebsite('42,77', fixtures);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.faqs.filter(f => f.id === '2').length, 1);
  assert.ok(r.wire.includes('Shared answer'));
  assert.ok(r.wire.includes('Second answer'));
  assert.ok(!r.wire.includes('Third answer'));
  assert.deepEqual(r.body.data.property_context.property_ids, ['42', '77']);
});

test('website: one invalid building among valid ids is refused without content', async () => {
  const r = await callWebsite('42,77,999', {
    ...FIXTURES,
    properties: [
      { id: '42', display_name: 'Right Building' },
      { id: '77', display_name: 'Second Building' },
    ],
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_PROPERTY');
  assert.equal(r.body.data, undefined);
  assert.ok(!r.wire.includes(SCOPED_BODY));
});

test('website: a deleted building among requested ids is refused, not treated as global', async () => {
  const r = await callWebsite('42,77', {
    ...FIXTURES,
    properties: [
      { id: '42', display_name: 'Right Building' },
      { id: '77', display_name: 'Deleted Building' },
    ],
    deletedProperties: ['77'],
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_PROPERTY');
  assert.ok(!r.wire.includes('Global answer'));
});

test('website: an image on a scoped FAQ is absent until the right building is chosen', async () => {
  const unscoped = await callWebsite(null);
  assert.ok(!unscoped.wire.includes('/api/file/preview/200'));
  assert.equal(unscoped.body.data.faqs.find(f => f.id === '1').images.length, 0);

  const right = await callWebsite('42');
  const scoped = right.body.data.faqs.find(f => f.id === '2');
  assert.deepEqual(scoped.images, [
    { id: '100', url: '/api/file/preview/200', caption: 'Fuse box in the hallway' },
  ]);
});

test('website: an image whose file was deleted does not appear', async () => {
  const r = await callWebsite('42', {
    ...FIXTURES,
    files: [{ id: '200', deleted_at: new Date(0) }],
  });
  const scoped = r.body.data.faqs.find(f => f.id === '2');
  assert.deepEqual(scoped.images, []);
});

test('website: FAQ entries without images return an empty array', async () => {
  const r = await callWebsite(null);
  const global = r.body.data.faqs.find(f => f.id === '1');
  assert.deepEqual(global.images, []);
});

test('website: version changes when an image is added or captioned', async () => {
  const bare = await callWebsite(null, {
    ...FIXTURES,
    images: [],
    files: [],
  });
  const withImage = await callWebsite(null, {
    ...FIXTURES,
    images: [{ id: '101', chat_knowledge_id: '1', file_id: '201', caption: null, sort_order: 0 }],
    files: [{ id: '201', deleted_at: null }],
  });
  const captioned = await callWebsite(null, {
    ...FIXTURES,
    images: [{ id: '101', chat_knowledge_id: '1', file_id: '201', caption: 'Lobby panel', sort_order: 0 }],
    files: [{ id: '201', deleted_at: null }],
  });

  assert.notEqual(bare.body.data.version, withImage.body.data.version);
  assert.notEqual(withImage.body.data.version, captioned.body.data.version);
});

test('website: FAQ body text is unchanged when images are attached', async () => {
  const r = await callWebsite('42');
  const scoped = r.body.data.faqs.find(f => f.id === '2');
  assert.equal(scoped.body, SCOPED_BODY);
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

test('website: properties sharing a public label produce one public group with both ids', async () => {
  const fixtures = {
    knowledge: [
      { id: '10', kind: 'faq', category: 'other', title: 'Pearl title', body: 'Pearl body',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
      { id: '11', kind: 'faq', category: 'other', title: 'Lai Yuen title', body: 'Lai Yuen body',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    ],
    links: [
      { knowledge_id: '10', property_id: '12' },
      { knowledge_id: '10', property_id: '13' },
      { knowledge_id: '11', property_id: '14' },
    ],
    properties: [
      { id: '12', display_name: '12-B6 Pearl City Mansion', public_label: '22-36 Paterson St, Causeway Bay',
        public_building_name: 'Pearl City Mansion', public_aliases: '["PCM","12-B6"]',
        street_address: '22-36 Paterson Street', district: 'Causeway Bay' },
      { id: '13', display_name: '12-C1 Pearl City Mansion', public_label: '22-36 Paterson St, Causeway Bay',
        public_building_name: 'Pearl City Mansion', public_aliases: '["12-C1"]',
        street_address: '22-36 Paterson Street', district: 'Causeway Bay' },
      { id: '14', display_name: '13B Lai Yuen Apartments', public_label: null,
        public_building_name: null, public_aliases: null,
        street_address: '56-61 Russell Street', district: 'Causeway Bay' },
    ],
  };

  const r = await callWebsite(null, fixtures);
  const groups = r.body.data.available_property_groups;
  const pearl = groups.find(g => g.label === '22-36 Paterson St, Causeway Bay');
  assert.ok(pearl);
  assert.equal(pearl.key, '22-36-paterson-st-causeway-bay');
  assert.equal(pearl.building_name, 'Pearl City Mansion');
  assert.deepEqual(pearl.property_ids, ['12', '13']);
});

test('website: a property without a public label falls back to display_name', async () => {
  const r = await callWebsite(null, {
    knowledge: [
      { id: '11', kind: 'faq', category: 'other', title: 'Lai Yuen title', body: 'Lai Yuen body',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    ],
    links: [{ knowledge_id: '11', property_id: '14' }],
    properties: [
      { id: '14', display_name: '13B Lai Yuen Apartments', public_label: null,
        public_building_name: null, public_aliases: null,
        street_address: '56-61 Russell Street', district: 'Causeway Bay' },
    ],
  });
  assert.deepEqual(r.body.data.available_property_groups.map(g => g.label), ['13B Lai Yuen Apartments']);
});

test('website: public group search terms never contain FAQ title or body text', async () => {
  const r = await callWebsite(null, {
    knowledge: [
      { id: '20', kind: 'faq', category: 'other', title: 'SECRET FAQ TITLE', body: 'SECRET FAQ BODY',
        status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
    ],
    links: [{ knowledge_id: '20', property_id: '21' }],
    properties: [
      { id: '21', display_name: 'Public Display', public_label: '95 Tung Choi St, Mong Kok',
        public_building_name: 'Mong Kok', public_aliases: '["TC95","FLT"]',
        street_address: '95 Tung Choi Street', district: 'Mong Kok' },
    ],
  });
  const terms = JSON.stringify(r.body.data.available_property_groups[0].search_terms);
  assert.ok(terms.includes('95 Tung Choi St, Mong Kok'));
  assert.ok(terms.includes('Mong Kok'));
  assert.ok(terms.includes('TC95'));
  assert.ok(!terms.includes('SECRET FAQ TITLE'));
  assert.ok(!terms.includes('SECRET FAQ BODY'));
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

test('the website and TaneChat audiences are independent, in both directions', async () => {
  // Operator decision, 2026-08-20: three separate audiences, not a ladder. An entry can be on
  // the website without being handed to TaneChat, and the reverse — so neither switch may be
  // quietly inferred from the other. Coupling them was the previous design, and something that
  // silently re-derived one from the other would make the UI a liar.
  const onlyWebsite = {
    knowledge: [{ id: '9', kind: 'faq', category: 'other', title: 'Web only', body: 'WEB ONLY BODY',
      status: 1, visibility: 'internal', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) }],
    links: [],
  };
  const web = await callWebsite(null, onlyWebsite);
  assert.ok(web.wire.includes('WEB ONLY BODY'), 'website publication must not require TaneChat sharing');

  const onlyChat = {
    knowledge: [{ id: '9', kind: 'faq', category: 'other', title: 'Chat only', body: 'CHAT ONLY BODY',
      status: 1, visibility: 'public', publish_website: 0, tags: null, sort_order: 0, updated_at: new Date(0) }],
    links: [],
  };
  const off = await callWebsite(null, onlyChat);
  assert.ok(!off.wire.includes('CHAT ONLY BODY'), 'sharing with TaneChat must not publish to the website');
  const chat = await callKnowledge(null, onlyChat);
  assert.ok(chat.wire.includes('CHAT ONLY BODY'), 'and TaneChat must still receive it');
});

// A TRIPWIRE, not a proof. The emulated pool above cannot tell a live predicate from a neutralised
// one, because both contain the same text. This pins the predicate so that changing it at all —
// including the `1=1 OR` short-circuit that would publish every building's answers to everyone —
// fails here and has to be a conscious decision.
test('website: the scoped-branch predicate is exactly what it should be', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/websitePublic.js'), 'utf8');

  const expected =
    "OR EXISTS(SELECT 1 FROM chat_knowledge_property s JOIN property p ON p.id=s.property_id " +
    "AND p.deleted_at IS NULL WHERE s.chat_knowledge_id=ck.id AND s.property_id IN (${scopedPlaceholders}))";

  assert.ok(
    src.includes(expected),
    'The scoped branch of the FAQ query changed. That expression is the only thing keeping one ' +
    'building\'s answers away from another building\'s tenants. If the change is intentional, ' +
    'update this string AND re-check that a neutralising edit (1=1, OR TRUE, a commented-out ' +
    'clause) has not crept in.'
  );
  assert.ok(!/\(\s*1\s*=\s*1\s*OR/i.test(src), 'a 1=1 OR short-circuit is present in the route');
});

test('website: two labels that slugify alike still get distinct keys', async () => {
  const fixtures = JSON.parse(JSON.stringify(FIXTURES));
  fixtures.knowledge = FIXTURES.knowledge;
  fixtures.properties = [
    { id: '10', display_name: 'A', public_label: '95 Tung Choi St', public_building_name: 'Mong Kok',
      public_aliases: null, street_address: null, district: null },
    { id: '11', display_name: 'B', public_label: '95 Tung Choi St.', public_building_name: 'Other',
      public_aliases: null, street_address: null, district: null },
  ];
  fixtures.links = [{ knowledge_id: '2', property_id: '10' }, { knowledge_id: '7', property_id: '11' }];
  fixtures.knowledge = FIXTURES.knowledge.concat([
    { id: '7', kind: 'faq', category: 'other', title: 'Other building', body: 'Other body',
      status: 1, visibility: 'public', publish_website: 1, tags: null, sort_order: 0, updated_at: new Date(0) },
  ]);
  const r = await callWebsite(null, fixtures);
  const groups = r.body.data.available_property_groups;
  const keys = groups.map(g => g.key);
  assert.equal(new Set(keys).size, keys.length,
    'two groups sharing a key make a ?building= link resolve to whichever sorted first');
});
