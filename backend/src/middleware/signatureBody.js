const express = require('express');

// The signer can upload a 2 MB PNG/JPEG. Its base64 JSON representation is
// about 2.8 MB, plus an optional initials image. Keep the larger limit scoped
// to this one POST; other endpoints retain Express's default 100 KB limit.
const signatureJsonParser = express.json({ limit: '4mb' });

function payloadTooLargeResponse(err, req, res, next) {
  if (err?.type !== 'entity.too.large') return next(err);
  const isSigning = /^\/api\/signature\/public\/[^/]+\/sign\/?$/.test(req.path);
  return res.status(413).json({
    code: 413,
    message: isSigning
      ? 'Signature image is too large. Please use a PNG or JPG under 2 MB.'
      : 'Request body is too large.',
  });
}

module.exports = { signatureJsonParser, payloadTooLargeResponse };
