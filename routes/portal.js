const express = require('express');
const path = require('path');

const router = express.Router();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// The page lives at public/index.html and fills its till/support details from /api/config.
// On Vercel, public/ is served by the CDN directly (express.static is ignored there);
// locally, express.static serves the same files so both behave identically.
router.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  setHeaders(res, file) { if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); }
}));

// Old address. Keep ?mac=... from the hotspot login page.
router.get('/portal', (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(302, `/${query}`);
});

module.exports = router;
