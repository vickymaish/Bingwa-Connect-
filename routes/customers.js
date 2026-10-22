const express = require('express');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const { adminAuth } = require('../middleware/admin-auth');

const router = express.Router();
const PHONE_PATTERN = /^2547\d{8}$/;
const MAC_PATTERN = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

router.get('/customers', adminAuth, async (req, res, next) => {
  try {
    const customers = await Customer.find().sort({ createdAt: -1 }).lean();
    res.json(customers);
  } catch (error) { next(error); }
});

// Public customer onboarding. New accounts stay expired until a successful
// M-Pesa callback activates the selected plan.
router.post('/register', async (req, res, next) => {
  try {
    const { name, phone, macAddress, plan } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        !PHONE_PATTERN.test(phone || '') ||
        (macAddress !== undefined && macAddress !== '' && !MAC_PATTERN.test(macAddress)) ||
        !['weekly', 'monthly'].includes(plan)) {
      return res.status(400).json({ error: 'Enter your name, phone in 2547XXXXXXXX format, and a valid plan.' });
    }
    const customer = await Customer.create({
      name: name.trim(), phone,
      ...(macAddress ? { macAddress: macAddress.toUpperCase() } : {}),
      plan, status: 'expired'
    });
    return res.status(201).json({ message: 'Account created. Continue to M-Pesa to activate your plan.' });
  } catch (error) {
    if (error.code === 11000) {
      const phoneExists = await Customer.exists({ phone: req.body.phone });
      if (phoneExists) return res.json({ code: 'ACCOUNT_EXISTS', message: 'Existing account found.' });
      return res.status(409).json({ code: 'DEVICE_EXISTS', error: 'This device is already linked to another account. Contact support.' });
    }
    next(error);
  }
});

router.post('/customers', adminAuth, async (req, res, next) => {
  try {
    const { name, phone, macAddress, plan, status = 'expired', expiresAt = null } = req.body;
    if (typeof name !== 'string' || !name.trim() || !PHONE_PATTERN.test(phone || '') ||
        !MAC_PATTERN.test(macAddress || '') || !['weekly', 'monthly'].includes(plan) ||
        !['active', 'expired', 'suspended'].includes(status) ||
        (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
      return res.status(400).json({ error: 'Valid name, phone, MAC address, plan, status, and optional expiry date are required.' });
    }
    const customer = await Customer.create({ name, phone, macAddress, plan, status, expiresAt });
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
    const customer = await Customer.findByIdAndUpdate(req.params.id, { $set: { status: 'suspended' } }, { new: true, runValidators: true });
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    res.json(customer);
  } catch (error) { next(error); }
});

router.get('/dashboard', adminAuth, async (req, res, next) => {
  try {
    const [total, grouped] = await Promise.all([
      Customer.countDocuments(),
      Customer.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    ]);
    const counts = Object.fromEntries(grouped.map(({ _id, count }) => [_id, count]));
    res.json({ total, active: counts.active || 0, expired: counts.expired || 0, suspended: counts.suspended || 0 });
  } catch (error) { next(error); }
});

module.exports = router;
