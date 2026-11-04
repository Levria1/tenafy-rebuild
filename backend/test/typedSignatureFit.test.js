const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Typed signatures were drawn centred on a fixed 700px canvas, so a long name ran
// off both edges: "Vaibhav Chandrashekhar Pradhan" signed as "ibhav ... Prad".
// Checked in headless Chrome with the real fonts: at 72px that name is 811–907px
// of ink, cut in all three fonts before, whole after. These tests pin the sizing
// logic with a fake canvas.

const FRONTEND = path.join(__dirname, '../../frontend/src');
const HELPER = path.join(FRONTEND, 'lib/typedSignature.js');

async function loadHelper() {
  const src = fs.readFileSync(HELPER, 'utf8');
  return import('data:text/javascript,' + encodeURIComponent(src));
}

function fakeCanvas(inkLeft, inkRight) {
  const drawn = [];
  const canvas = {
    width: 300, height: 150,
    getContext: () => ({
      clearRect() {}, set font(v) {}, set fillStyle(v) {}, set textAlign(v) {}, set textBaseline(v) {},
      measureText: () => ({ width: inkRight - 10, actualBoundingBoxLeft: inkLeft, actualBoundingBoxRight: inkRight }),
      fillText: (text, x, y) => drawn.push({ text, x, y }),
    }),
    toDataURL: () => 'data:image/png;base64,x',
  };
  return { canvas, drawn };
}

test('a long name widens the canvas so the whole signature fits', async () => {
  const { renderCursivePng } = await loadHelper();
  const { canvas, drawn } = fakeCanvas(6, 900);
  renderCursivePng('Vaibhav Chandrashekhar Pradhan', { font: 'Great Vibes', createCanvas: () => canvas });
  assert.equal(canvas.width, 906 + 48);
  assert.equal(canvas.height, 160);
  // Ink spans x - left .. x + right, and stays inside the padding.
  const { x } = drawn[0];
  assert.ok(x - 6 >= 24 - 0.5 && x + 900 <= canvas.width - 24 + 0.5, JSON.stringify({ x, w: canvas.width }));
});

test('a short name keeps the usual size, centred', async () => {
  const { renderCursivePng } = await loadHelper();
  const { canvas, drawn } = fakeCanvas(2, 80);
  renderCursivePng('Al', { font: 'Allura', createCanvas: () => canvas });
  assert.equal(canvas.width, 700);
  assert.ok(Math.abs((drawn[0].x - 2 + drawn[0].x + 80) / 2 - 350) < 1);
});

test('initials use the same fitting', async () => {
  const { renderCursivePng } = await loadHelper();
  const { canvas } = fakeCanvas(4, 400);
  renderCursivePng('VCPX', { font: 'Allura', size: 64, minWidth: 260, height: 120, createCanvas: () => canvas });
  assert.equal(canvas.width, 404 + 48);
  assert.equal(canvas.height, 120);
});

test('the sign page draws typed signatures and initials through the fitting helper', () => {
  const page = fs.readFileSync(path.join(FRONTEND, 'app/sign/[token]/page.js'), 'utf8');
  assert.equal((page.match(/renderCursivePng\(text, \{ font: typedFont/g) || []).length, 2);
  assert.doesNotMatch(page, /canvas\.width = 700;/);
});
