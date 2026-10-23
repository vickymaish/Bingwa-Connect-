'use strict';

// Turns a customer's internet on or off on the router.
//
// NETWORK_DRIVER=stub      (default) logs only, for development and testing without a router
// NETWORK_DRIVER=mikrotik  MikroTik Hotspot on RouterOS v7+, via its built-in REST API
//
// MikroTik model: every customer device is identified by its MAC address.
//   activate   -> a Hotspot "IP binding" of type "bypassed" for that MAC (free access, no login page)
//   deactivate -> remove that binding and kick the device's current session, so it lands
//                 back on the captive portal (portal.html) where it can pay again.
// Both are idempotent: calling them twice is harmless, so the scheduler can safely retry.

const fs = require('fs');
const http = require('http');
const https = require('https');

const BINDING_TAG = 'isp-billing:'; // comment prefix marks bindings this system owns

function driverName() {
  return (process.env.NETWORK_DRIVER || 'stub').trim().toLowerCase();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Accepts AA:BB:CC:DD:EE:FF, aa-bb-cc-dd-ee-ff or aabbccddeeff; returns AA:BB:CC:DD:EE:FF or null.
function normalizeMac(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/[:\-.]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex) || /^0{12}$|^F{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}

function macOf(customer) {
  return normalizeMac(customer.macAddress);
}

// ---- Minimal RouterOS REST client (no external dependencies) ----

let caCache;
function routerRequest(method, path, { query, body } = {}) {
  const base = new URL(requiredEnv('MIKROTIK_URL'));
  const url = new URL(`${base.pathname.replace(/\/+$/, '')}/rest${path}`, base);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);

  const isHttps = url.protocol === 'https:';
  if (isHttps && process.env.MIKROTIK_CA_FILE && caCache === undefined) {
    caCache = fs.readFileSync(process.env.MIKROTIK_CA_FILE);
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const auth = Buffer.from(`${requiredEnv('MIKROTIK_USER')}:${requiredEnv('MIKROTIK_PASSWORD')}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(url, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      },
      ...(isHttps && caCache ? { ca: caCache } : {}),
      timeout: 10000
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = raw; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        // Never include the Authorization header in errors; it would end up in logs.
        const detail = data && typeof data === 'object' ? (data.detail || data.message) : '';
        const error = new Error(`Router ${method} ${path} failed with HTTP ${res.statusCode}${detail ? `: ${detail}` : ''}`);
        error.code = 'ROUTER_HTTP_ERROR';
        error.status = res.statusCode;
        reject(error);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`Router ${method} ${path} timed out`), { code: 'ROUTER_TIMEOUT' })));
    req.on('error', (err) => reject(Object.assign(new Error(`Router unreachable: ${err.message}`), { code: err.code || 'ROUTER_UNREACHABLE' })));
    if (payload) req.write(payload);
    req.end();
  });
}

async function list(path, query) {
  const data = await routerRequest('GET', path, { query });
  return Array.isArray(data) ? data : [];
}

async function removeIgnoringMissing(path, id) {
  try {
    await routerRequest('DELETE', `${path}/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error.status !== 404) throw error; // already gone is fine
  }
}

const mikrotik = {
  async activate(customer) {
    const mac = macOf(customer);
    if (!mac) {
      const error = new Error(`Customer ${customer._id} has no valid MAC address; add one before access can be enabled.`);
      error.code = 'CUSTOMER_MAC_MISSING';
      throw error;
    }
    const comment = `${BINDING_TAG}${customer._id} ${customer.phone || ''}`.trim();
    const bindings = await list('/ip/hotspot/ip-binding', { 'mac-address': mac });
    if (!bindings.length) {
      await routerRequest('PUT', '/ip/hotspot/ip-binding', { body: { 'mac-address': mac, type: 'bypassed', comment } });
      return;
    }
    for (const binding of bindings) {
      if (binding.type !== 'bypassed' || binding.disabled === 'true') {
        await routerRequest('PATCH', `/ip/hotspot/ip-binding/${encodeURIComponent(binding['.id'])}`, {
          body: { type: 'bypassed', disabled: 'false' }
        });
      }
    }
  },

  async deactivate(customer) {
    const mac = macOf(customer);
    if (!mac) return; // never had a binding, nothing to revoke

    const bindings = await list('/ip/hotspot/ip-binding', { 'mac-address': mac });
    for (const binding of bindings) {
      if (String(binding.comment || '').startsWith(BINDING_TAG)) {
        await removeIgnoringMissing('/ip/hotspot/ip-binding', binding['.id']);
      } else if (binding.type === 'bypassed') {
        // Someone added this by hand on the router (e.g. staff device). Leave it, but say so.
        console.warn('Untagged bypass binding left in place on router:', { customerId: String(customer._id) });
      }
    }
    // Kick the device's current session/host entry so the cutoff takes effect now.
    for (const path of ['/ip/hotspot/active', '/ip/hotspot/host']) {
      for (const entry of await list(path, { 'mac-address': mac })) {
        await removeIgnoringMissing(path, entry['.id']);
      }
    }
  }
};

const stub = {
  async activate(customer) {
    console.info('Network activation (stub driver, no router):', { customerId: String(customer._id) });
  },
  async deactivate(customer) {
    console.info('Network deactivation (stub driver, no router):', { customerId: String(customer._id) });
  }
};

function driver() {
  const name = driverName();
  if (name === 'mikrotik') return mikrotik;
  if (name === 'stub') return stub;
  throw new Error(`Unknown NETWORK_DRIVER "${name}". Use "stub" or "mikrotik".`);
}

async function activate(customer) { return driver().activate(customer); }
async function deactivate(customer) { return driver().deactivate(customer); }

/** Confirms the router is reachable, the login works and a Hotspot exists. Never throws. */
async function checkConnection() {
  const name = driverName();
  if (name === 'stub') return { ok: true, driver: 'stub', message: 'Test mode: no router is being controlled.' };
  if (name !== 'mikrotik') return { ok: false, driver: name, message: `Unknown NETWORK_DRIVER "${name}".` };
  try {
    const resource = await routerRequest('GET', '/system/resource');
    const hotspots = await list('/ip/hotspot');
    const version = resource?.version || 'unknown';
    if (!hotspots.length) {
      return { ok: false, driver: name, version, message: 'Connected, but no Hotspot is configured on the router. Run the hotspot setup first (see ROUTER_SETUP.md).' };
    }
    return {
      ok: true, driver: name, version, board: resource?.['board-name'],
      hotspots: hotspots.map((h) => `${h.name} on ${h.interface}${h.disabled === 'true' ? ' (DISABLED)' : ''}`),
      message: 'Router connected.'
    };
  } catch (error) {
    const hint = error.status === 401 ? ' Check MIKROTIK_USER / MIKROTIK_PASSWORD.'
      : error.status === 404 ? ' REST API not found: the router needs RouterOS v7.1+ with the www or www-ssl service enabled.'
      : ' Check MIKROTIK_URL, that the router is on, and that the www/www-ssl service allows this server.';
    return { ok: false, driver: name, message: `${error.message}.${hint}` };
  }
}

module.exports = { activate, deactivate, driverName, normalizeMac, checkConnection };
