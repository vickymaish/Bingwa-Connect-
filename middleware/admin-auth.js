'use strict';

const { timingSafeEqual } = require('node:crypto');

function adminAuth(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(503).json({ error: 'Admin API authentication is not configured.' });

  const supplied = req.get('x-api-key') || '';
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  const matches = expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
  if (!matches) return res.status(401).json({ error: 'Admin authentication required.' });
  return next();
}

module.exports = { adminAuth };
