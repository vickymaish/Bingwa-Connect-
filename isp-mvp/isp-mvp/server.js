'use strict';
// ISP MVP server: serves the site and handles M-Pesa (Daraja STK push).
// No dependencies. Needs Node 18+ (built-in fetch).   Run:  node server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- tiny .env loader ----------
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (_) { /* no .env: demo mode */ }

const PORT = Number(process.env.PORT || 3000);
const DARAJA_ENV = (process.env.DARAJA_ENV || 'sandbox').toLowerCase();
const BASE = DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
const KEY = process.env.DARAJA_KEY;
const SECRET = process.env.DARAJA_SECRET;
const SHORTCODE = process.env.DARAJA_SHORTCODE || '174379';
const PASSKEY = process.env.DARAJA_PASSKEY;
const TXN_TYPE = process.env.DARAJA_TXN_TYPE || 'CustomerPayBillOnline'; // till numbers: CustomerBuyGoodsOnline
const PARTY_B = process.env.DARAJA_PARTYB || SHORTCODE;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || 'change-this-secret';
const CALLBACK_PATH = `/api/mpesa/callback/${CALLBACK_SECRET}`;
const DEMO = !(KEY && SECRET && PASSKEY && PUBLIC_URL);

const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_FILE = path.join(__dirname, 'payments.log');

// ---------- helpers ----------
const loadSite = () => JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'site.json'), 'utf8'));

function normalizePhone(p) {
  p = String(p || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (/^0[17]\d{8}$/.test(p)) p = '254' + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = '254' + p;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// payments are kept in memory and appended to payments.log (MVP: no database yet)
const payments = new Map();
const logPayment = (p) => fs.appendFile(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...p }) + '\n', () => {});

// very small rate limit: 6 payment attempts per minute per IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 6;
}

// ---------- Daraja ----------
async function getToken() {
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64') },
  });
  if (!r.ok) throw new Error(`Daraja auth failed (${r.status}). Check key/secret belong to the same app.`);
  return (await r.json()).access_token;
}

function timestamp() {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

async function stkPush({ phone, amount, reference, description }) {
  const token = await getToken();
  const ts = timestamp();
  const password = Buffer.from(`${SHORTCODE}${PASSKEY}${ts}`).toString('base64');
  const r = await fetch(`${BASE}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: SHORTCODE, Password: password, Timestamp: ts,
      TransactionType: TXN_TYPE, Amount: amount, PartyA: phone, PartyB: PARTY_B, PhoneNumber: phone,
      CallBackURL: PUBLIC_URL + CALLBACK_PATH,
      AccountReference: reference.slice(0, 12), TransactionDesc: description.slice(0, 20),
    }),
  });
  return r.json();
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return send(res, 200, { demo: DEMO, env: DARAJA_ENV });
  }

  if (req.method === 'POST' && url.pathname === '/api/pay') {
    if (limited(req.socket.remoteAddress)) return send(res, 429, { error: 'Too many attempts. Please wait a minute.' });
    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: 'Bad request.' }); }

    const plan = (loadSite().plans || []).find((p) => p.id === body.planId); // price comes from the server, never the browser
    if (!plan) return send(res, 400, { error: 'Unknown plan.' });
    const phone = normalizePhone(body.phone);
    if (!phone) return send(res, 400, { error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });

    const rec = { id: null, status: 'pending', planId: plan.id, plan: plan.name, amount: plan.price, phone, created: Date.now(), demo: DEMO };

    if (DEMO) {
      rec.id = 'demo_' + crypto.randomBytes(6).toString('hex');
    } else {
      try {
        const d = await stkPush({ phone, amount: plan.price, reference: plan.id, description: plan.name });
        if (d.ResponseCode !== '0') {
          console.error('STK push rejected:', d);
          return send(res, 502, { error: d.errorMessage || d.ResponseDescription || 'M-Pesa rejected the request.' });
        }
        rec.id = d.CheckoutRequestID;
      } catch (e) {
        console.error(e);
        return send(res, 502, { error: 'Could not reach M-Pesa. Try again shortly.' });
      }
    }
    payments.set(rec.id, rec); logPayment(rec);
    return send(res, 200, { checkoutId: rec.id, demo: DEMO });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/status/')) {
    const p = payments.get(decodeURIComponent(url.pathname.split('/').pop()));
    if (!p) return send(res, 404, { status: 'unknown' });
    if (p.demo && p.status === 'pending' && Date.now() - p.created > 5000) {
      p.status = 'paid'; p.receipt = 'DEMO' + crypto.randomBytes(4).toString('hex').toUpperCase(); logPayment(p);
    }
    return send(res, 200, { status: p.status, receipt: p.receipt || null, message: p.message || null, plan: p.plan, amount: p.amount });
  }

  if (req.method === 'POST' && url.pathname === CALLBACK_PATH) {
    try {
      const cb = (await readJson(req, 100000))?.Body?.stkCallback;
      const p = cb && payments.get(cb.CheckoutRequestID);
      if (p) {
        if (cb.ResultCode === 0) {
          const items = cb.CallbackMetadata?.Item || [];
          const get = (n) => items.find((i) => i.Name === n)?.Value;
          p.status = 'paid'; p.receipt = get('MpesaReceiptNumber'); p.paidAmount = get('Amount');
        } else {
          p.status = 'failed'; p.message = cb.ResultDesc;
        }
        logPayment(p);
      }
    } catch (e) { console.error('callback error', e.message); }
    return send(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' }); // always acknowledge
  }

  return send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  (url.pathname.startsWith('/api/') ? handleApi(req, res, url) : Promise.resolve(serveStatic(req, res, url)))
    .catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: 'Server error' }); });
}).listen(PORT, () => {
  console.log(`\n  ISP MVP running:  http://localhost:${PORT}`);
  if (DEMO) {
    console.log('  Mode: DEMO (payments are simulated). To use real Daraja, fill DARAJA_KEY, DARAJA_SECRET,');
    console.log('        DARAJA_PASSKEY and PUBLIC_URL in .env  (see README.md).');
  } else {
    console.log(`  Mode: DARAJA ${DARAJA_ENV.toUpperCase()}   callback: ${PUBLIC_URL}${CALLBACK_PATH}`);
  }
  console.log('');
});
