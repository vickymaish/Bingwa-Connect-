const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();
const PORTAL_FILE = path.join(__dirname, '..', 'public', 'portal.html');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fill the support contacts from .env (SUPPORT_PHONE, WHATSAPP_NUMBER) instead of
// showing "{{SUPPORT_PHONE}}" to customers.
let cached;
function renderPortal() {
  if (cached && process.env.NODE_ENV === 'production') return cached;
  const supportPhone = (process.env.SUPPORT_PHONE || '').trim() || '+254 700 000 000';
  const whatsapp = (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '') || '254700000000';
  // Bundles are paid manually to the client's Buy Goods till (TBD: STK push / auto-delivery).
  const tillNumber = (process.env.TILL_NUMBER || '').replace(/\D/g, '') || '4134662';
  const tillName = (process.env.TILL_NAME || '').trim() || 'Emmanuel Bingwa';
  cached = fs.readFileSync(PORTAL_FILE, 'utf8')
    .replaceAll('{{SUPPORT_PHONE}}', escapeHtml(supportPhone))
    .replaceAll('{{WHATSAPP_NUMBER}}', escapeHtml(whatsapp))
    .replaceAll('{{TILL_NUMBER}}', escapeHtml(tillNumber))
    .replaceAll('{{TILL_NAME}}', escapeHtml(tillName));
  return cached;
}

// Portal photos, served from this server so they load before a customer has paid.
router.use('/img', express.static(path.join(__dirname, '..', 'public', 'img'), {
  maxAge: '7d'
}));

// "/" is where the MikroTik hotspot login page sends customers (with ?mac=...).
router.get(['/', '/portal'], (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(renderPortal());
  } catch (error) { next(error); }
});

module.exports = router;
