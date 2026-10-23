const express = require('express');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const { adminAuth } = require('../middleware/admin-auth');
const { normalizeMac } = require('../services/network');
const { trySyncCustomerAccess } = require('../services/access-sync');

const router = express.Router();
// Safaricom 07XX and 01XX numbers in international format.
const PHONE_PATTERN = /^254(7|1)\d{8}$/;

router.get('/customers', adminAuth, async (req, res, next) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 }).lean();
    res.json(customers);
  } catch (error) { next(error); }
});

// Public customer onboarding. New accounts stay expired until a confirmed
// M-Pesa payment activates the selected plan. The device (MAC) is linked at
// payment time, not here, so nobody can claim a device without paying for it.
router.post('/register', async (req, res, next) => {
  try {
    const { name, phone, plan } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        typeof phone !== 'string' || !PHONE_PATTERN.test(phone) ||
        !['weekly', 'monthly'].includes(plan)) {
      return res.status(400).json({ error: 'Enter your name, phone in 2547XXXXXXXX or 2541XXXXXXXX format, and a valid plan.' });
    }
    if (await Customer.exists({ phone })) {
      return res.json({ code: 'ACCOUNT_EXISTS', message: 'Existing account found.' });
    }
    await Customer.create({ name: name.trim(), phone, plan, status: 'expired' });
    return res.status(201).json({ message: 'Account created. Continue to M-Pesa to activate your plan.' });
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'unknown';
      if (field === 'phone') return res.json({ code: 'ACCOUNT_EXISTS', message: 'Existing account found.' });
      // Anything else is a database setup problem, not the customer's fault.
      console.error('Registration blocked by a database index:', { index: field, keyValue: error.keyValue });
      return res.status(500).json({ error: 'We could not create your account right now. Please contact support.' });
    }
    next(error);
  }
});

router.post('/customers', adminAuth, async (req, res, next) => {
  try {
    const { name, phone, plan, status = 'expired', expiresAt = null } = req.body;
    const macAddress = req.body.macAddress ? normalizeMac(req.body.macAddress) : undefined;
    if (typeof name !== 'string' || !name.trim() || typeof phone !== 'string' || !PHONE_PATTERN.test(phone) ||
        (req.body.macAddress && !macAddress) || !['weekly', 'monthly'].includes(plan) ||
        !['active', 'expired', 'suspended'].includes(status) ||
        (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
      return res.status(400).json({ error: 'Valid name, phone, plan and status are required; MAC address and expiry date are optional.' });
    }
    const customer = await Customer.create({
      name: name.trim(), phone, plan, status, expiresAt, ...(macAddress ? { macAddress } : {})
    });
    await trySyncCustomerAccess(customer.toObject());
    return res.status(201).json(customer);
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'A customer with this phone or MAC address already exists.' });
    next(error);
  }
});

router.get('/customers/:id', adminAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid customer ID.' });
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    res.json(customer);
  } catch (error) { next(error); }
});

router.patch('/customers/:id/suspend', adminAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid customer ID.' });
    const customer = await Customer.findByIdAndUpdate(req.params.id,
      { $set: { status: 'suspended', networkState: 'pending' } }, { new: true, runValidators: true }).lean();
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    // Cut off on the router now; if the router is down, the scheduler retries.
    await trySyncCustomerAccess(customer);
    res.json(await Customer.findById(customer._id).lean());
  } catch (error) { next(error); }
});

router.get('/dashboard', adminAuth, async (req, res, next) => {
  try {
    const [total, grouped, outOfSync] = await Promise.all([
      Customer.countDocuments(),
      Customer.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Customer.countDocuments({ networkState: 'pending' })
    ]);
    const counts = Object.fromEntries(grouped.map(({ _id, count }) => [_id, count]));
    res.json({
      total, active: counts.active || 0, expired: counts.expired || 0, suspended: counts.suspended || 0,
      routerPending: outOfSync
    });
  } catch (error) { next(error); }
});

module.exports = router;
