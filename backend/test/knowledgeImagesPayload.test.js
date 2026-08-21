const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasKnowledgeImagesPayload,
  normalizeKnowledgeImages,
} = require('../src/routes/chat');

test('knowledge images preserve payload order and assign zero-based sort_order', async () => {
  const images = await normalizeKnowledgeImages([
    { file_id: '300', caption: 'First' },
    { file_id: '100', caption: 'Second' },
    { file_id: '200', caption: 'Third' },
  ], async () => true);

  assert.deepEqual(images.map((img) => img.file_id), ['300', '100', '200']);
  assert.deepEqual(images.map((img) => img.sort_order), [0, 1, 2]);
});

test('knowledge images trim captions and store empty captions as NULL', async () => {
  const images = await normalizeKnowledgeImages([
    { file_id: '123', caption: '  Fuse box in the hallway  ' },
    { file_id: '124', caption: '    ' },
    { file_id: '125' },
  ], async () => true);

  assert.equal(images[0].caption, 'Fuse box in the hallway');
  assert.equal(images[1].caption, null);
  assert.equal(images[2].caption, null);
});

test('knowledge images reject payloads over the cap', async () => {
  const overCap = Array.from({ length: 13 }, (_, i) => ({ file_id: String(100 + i) }));
  await assert.rejects(
    normalizeKnowledgeImages(overCap, async () => true),
    /at most 12 images/
  );
});

test('knowledge images reject non-numeric file_id values', async () => {
  await assert.rejects(
    normalizeKnowledgeImages([{ file_id: 'abc123' }], async () => true),
    /file_id must be numeric/
  );
});

test('knowledge images reject file_id values unavailable to this org', async () => {
  const allowed = new Set(['100', '101']);
  await assert.rejects(
    normalizeKnowledgeImages([{ file_id: '100' }, { file_id: '999' }], async (id) => allowed.has(id)),
    /invalid or unavailable/
  );
});

test('knowledge image update semantics distinguish omitted images from an explicit clear', async () => {
  assert.equal(hasKnowledgeImagesPayload({ body: 'Leave existing images alone' }), false);
  assert.equal(hasKnowledgeImagesPayload({ body: 'Clear existing images', images: [] }), true);

  const cleared = await normalizeKnowledgeImages([], async () => false);
  assert.deepEqual(cleared, []);
});
