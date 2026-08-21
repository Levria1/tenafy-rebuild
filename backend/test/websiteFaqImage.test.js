const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/config/poolRegistry');
const fs = require('node:fs');
const path = require('node:path');

// Real files on disk. Without them EVERY case 404s at the path-resolve step and the refusals prove
// nothing — "the guard rejected it" and "there was no file anyway" look identical. The positive
// control below is what makes the negatives mean something.
const UPLOADS = path.join(__dirname, '../uploads');
const MADE = [];
function plant(name) {
  fs.mkdirSync(UPLOADS, { recursive: true });
  const p = path.join(UPLOADS, name);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  MADE.push(p);
}
test.before(() => ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.pdf', 'f.jpg'].forEach(plant));
test.after(() => MADE.forEach(p => { try { fs.unlinkSync(p); } catch {} }));

/**
 * GET /api/website/:org_slug/faq-image/:file_id is anonymous and public, so what it REFUSES is the
 * whole point. It exists because the obvious URL — /api/file/preview/:id — resolves the org for an
 * anonymous caller by an unordered `LIMIT 1` over organizations, i.e. by luck.
 *
 * This route is deliberately narrower than the one it replaced: /api/file/preview serves any image
 * in the org, while this serves only a file attached to a live, website-published FAQ.
 *
 * The fake EMULATES the clauses the route wrote rather than matching its text, for the same reason
 * as knowledgeScopeEmulated.test.js — a fake that returns canned rows on `sql.includes(...)` stays
 * green when the WHERE clause is deleted.
 *
 * Verified by mutation: deleting `AND ck.kind='faq' AND ck.status=1 AND ck.publish_website=1` from
 * the route turns three of these tests red. The tripwire at the bottom is a second line, catching a
 * clause that is neutralised rather than removed.
 *
 * The positive control matters as much as the refusals. Every case here 404s if no fixture file
 * exists on disk, so without it "the guard rejected this" and "there was no file anyway" are
 * indistinguishable — which is exactly how the first version of this suite passed while proving
 * nothing.
 *
 * Still a simulation. Only running the statement against a real database proves the contract.
 */
function fakePool({ images, knowledge, files }) {
  return {
    execute: async (sql, params = []) => {
      const flat = sql.replace(/\s+/g, ' ');
      const wantsFaqOnly = /ck\.kind='faq'/.test(flat);
      const wantsLive = /ck\.status=1/.test(flat);
      const wantsPublished = /ck\.publish_website=1/.test(flat);
      const wantsLiveFile = /f\.deleted_at IS NULL/.test(flat);
      const fileId = String(params[0]);

      const rows = images
        .filter(i => String(i.file_id) === fileId)
        .filter((i) => {
          const k = knowledge.find(k => String(k.id) === String(i.chat_knowledge_id));
          if (!k) return false;
          if (wantsFaqOnly && k.kind !== 'faq') return false;
          if (wantsLive && k.status !== 1) return false;
          if (wantsPublished && k.publish_website !== 1) return false;
          return true;
        })
        .map((i) => files.find(f => String(f.id) === String(i.file_id)))
        .filter(Boolean)
        .filter(f => !(wantsLiveFile && f.deleted_at != null))
        .map(f => ({ item_name: f.item_name, mime_type: f.mime_type }));
      return [rows];
    },
  };
}

const FIXTURES = {
  knowledge: [
    { id: 'k1', kind: 'faq', status: 1, publish_website: 1 },   // published
    { id: 'k2', kind: 'faq', status: 1, publish_website: 0 },   // NOT on the website
    { id: 'k3', kind: 'faq', status: 0, publish_website: 1 },   // archived
    { id: 'k4', kind: 'rule', status: 1, publish_website: 1 },  // a team rule, never public
  ],
  images: [
    { file_id: '200', chat_knowledge_id: 'k1' },
    { file_id: '201', chat_knowledge_id: 'k2' },
    { file_id: '202', chat_knowledge_id: 'k3' },
    { file_id: '203', chat_knowledge_id: 'k4' },
    { file_id: '204', chat_knowledge_id: 'k1' },   // a PDF smuggled onto a published FAQ
    { file_id: '205', chat_knowledge_id: 'k1' },   // deleted file
  ],
  files: [
    { id: '200', item_name: 'a.jpg', mime_type: 'IMAGE/JPEG', deleted_at: null },
    { id: '201', item_name: 'b.jpg', mime_type: 'IMAGE/JPEG', deleted_at: null },
    { id: '202', item_name: 'c.jpg', mime_type: 'IMAGE/JPEG', deleted_at: null },
    { id: '203', item_name: 'd.jpg', mime_type: 'IMAGE/JPEG', deleted_at: null },
    { id: '204', item_name: 'e.pdf', mime_type: 'APPLICATION/PDF', deleted_at: null },
    { id: '205', item_name: 'f.jpg', mime_type: 'IMAGE/JPEG', deleted_at: new Date(0) },
  ],
};

async function callImage(slug, fileId, { orgFound = true } = {}) {
  const originalMaster = registry.getMasterPool;
  const originalOrg = registry.getOrgPool;
  registry.getMasterPool = () => ({ execute: async () => [orgFound ? [{ id: 'ORG' }] : []] });
  registry.getOrgPool = async () => fakePool(FIXTURES);
  delete require.cache[require.resolve('../src/routes/websitePublic')];
  const router = require('../src/routes/websitePublic');
  try {
    const layer = router.stack.find(x => x.route && x.route.path === '/:org_slug/faq-image/:file_id');
    assert.ok(layer, 'the faq-image route must exist');
    const handle = layer.route.stack.at(-1).handle;
    let status = 200; let piped = false;
    // The handler either json()s a refusal or pipes a file. Both finish through end(), so awaiting
    // it keeps the read stream from outliving the test and tripping over its own fixtures.
    let settle; const finished = new Promise((r) => { settle = r; });
    const res = {
      setHeader() {}, status(n) { status = n; return this; },
      json() { settle(); return this; },
      end() { settle(); },
      on() { return this; }, once() { return this; }, emit() { return this; },
      write() { piped = true; return true; },
    };
    await handle({ params: { org_slug: slug, file_id: String(fileId) }, headers: {}, ip: '127.0.0.1' }, res);
    await Promise.race([finished, new Promise((r) => setTimeout(r, 2000))]);
    return { status, piped };
  } finally {
    registry.getMasterPool = originalMaster;
    registry.getOrgPool = originalOrg;
    delete require.cache[require.resolve('../src/routes/websitePublic')];
  }
}

test('faq-image: a file on an unpublished FAQ is refused', async () => {
  assert.equal((await callImage('taneres', '201')).status, 404);
});

test('faq-image: a file on an ARCHIVED FAQ is refused', async () => {
  assert.equal((await callImage('taneres', '202')).status, 404);
});

test('faq-image: a file on a team RULE is refused', async () => {
  assert.equal((await callImage('taneres', '203')).status, 404);
});

test('faq-image: a non-image on a published FAQ is refused', async () => {
  assert.equal((await callImage('taneres', '204')).status, 404);
});

test('faq-image: a deleted file is refused', async () => {
  assert.equal((await callImage('taneres', '205')).status, 404);
});

test('faq-image: a file attached to no FAQ at all is refused', async () => {
  assert.equal((await callImage('taneres', '999')).status, 404);
});

test('faq-image: an unknown organisation slug is refused', async () => {
  assert.equal((await callImage('taneres', '200', { orgFound: false })).status, 404);
});

test('faq-image: a malformed slug or file id never reaches the database', async () => {
  assert.equal((await callImage('Not A Slug', '200')).status, 404);
  assert.equal((await callImage('taneres', 'abc')).status, 404);
  assert.equal((await callImage('taneres', '0')).status, 404);
});

// THE POSITIVE CONTROL. Without this the suite passes even if the route 404s everything, which is
// precisely what happened the first time it was written.
test('faq-image: a real image on a published FAQ IS served', async () => {
  const r = await callImage('taneres', '200');
  assert.equal(r.status, 200, 'a published FAQ image must actually be served, not merely not-leaked');
});

// A TRIPWIRE, not a proof — see the header. Pins the three conditions that decide whether an image
// is public at all, so removing or loosening any of them fails here instead of silently serving
// archived, unpublished, or staff-only-rule pictures to the open internet.
test('faq-image: the publication predicate is exactly what it should be', () => {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const src = fs2.readFileSync(path2.join(__dirname, '../src/routes/websitePublic.js'), 'utf8');
  assert.ok(
    src.includes("AND ck.kind='faq' AND ck.status=1 AND ck.publish_website=1"),
    'The faq-image route no longer restricts to live, website-published FAQs. That clause is the ' +
    'only thing standing between an archived or internal image and an anonymous visitor. If the ' +
    'change is deliberate, update this string and re-check the route by hand.'
  );
});
