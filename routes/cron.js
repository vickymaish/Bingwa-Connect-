'use strict';

// Background jobs over HTTP, for hosts without a long-running process (Vercel).
// Called every few minutes by an external scheduler (e.g. cron-job.org) and once a day by Vercel Cron.
// Protected by CRON_SECRET: send "Authorization: Bearer <secret>" (Vercel Cron does this automatically)
// or ?key=<secret> for schedulers that can't set headers.
const crypto = require('crypto');
const express = require('express');
const { runAllJobs } = require('../services/scheduler');
const { syncDatabaseIndexes } = require('../services/db');

const router = express.Router();

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return false;
  const header = req.get('authorization') || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.key || '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let running = false;
router.get('/cron/tick', async (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized.' });
  if (running) return res.json({ skipped: 'previous run still in progress' });
  running = true;
  try {
    const started = Date.now();
    const results = await runAllJobs();
    res.json({ ok: true, ms: Date.now() - started, results });
  } catch (error) { next(error); } finally { running = false; }
});

// Daily maintenance (Vercel Cron, Hobby plan allows once a day).
router.get('/cron/daily', async (req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    const indexes = await syncDatabaseIndexes();
    const results = await runAllJobs();
    res.json({ ok: true, indexes, results });
  } catch (error) { next(error); }
});

module.exports = router;
