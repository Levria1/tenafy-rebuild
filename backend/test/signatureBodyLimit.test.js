const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { signatureJsonParser, payloadTooLargeResponse } = require('../src/middleware/signatureBody');

async function startApp() {
  const app = express();
  // Same ordering as src/index.js: the public signing parser precedes the
  // generic 100 KB parser, without expanding limits on other endpoints.
  app.post('/api/signature/public/:token/sign', signatureJsonParser);
  app.use(express.json());
  app.post('/api/signature/public/:token/sign', (req, res) => res.json({ bytes: req.body.signature_png.length }));
  app.post('/api/other', (req, res) => res.json({ ok: true }));
  app.use(payloadTooLargeResponse);
  app.use((err, req, res, next) => res.status(500).json({ code: 500, message: 'Internal server error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return server;
}

async function post(server, url, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

test('a 2 MB uploaded signature plus initials reaches the signing handler', async () => {
  const server = await startApp();
  try {
    const signature_png = 'data:image/jpeg;base64,' + 'A'.repeat(2_800_000);
    const result = await post(server, '/api/signature/public/test/sign', {
      signature_png, typed_name: 'Test Signer', initials_png: 'data:image/png;base64,' + 'A'.repeat(5000),
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.bytes, signature_png.length);
  } finally { server.close(); }
});

test('signing request over the dedicated cap returns an actionable 413', async () => {
  const server = await startApp();
  try {
    const result = await post(server, '/api/signature/public/test/sign', {
      signature_png: 'A'.repeat(4_300_000), typed_name: 'Test Signer',
    });
    assert.equal(result.status, 413);
    assert.match(result.data.message, /signature image.*too large/i);
  } finally { server.close(); }
});

test('other JSON endpoints retain the default 100 KB limit', async () => {
  const server = await startApp();
  try {
    const result = await post(server, '/api/other', { payload: 'A'.repeat(140_000) });
    assert.equal(result.status, 413);
  } finally { server.close(); }
});
