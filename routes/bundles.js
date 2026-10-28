'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const { initiateStkPayment } = require('../services/mpesa');
const { findBundle } = require('../services/bundles');

const router = express.Router();
const PHONE_PATTERN = /^254(7|1)\d{8}$/;
const PAY_COOLDOWN_MS = 60 * 1000;

/**
 * POST /api/bundles/pay  { phone, category: 'data'|'minutes'|'sms', price }
 * Sends an M-Pesa prompt for a data, minutes or SMS deal. No account needed.
 * The amount always comes from the server's price list, never from the browser.
 * Progress is checked with the existing GET /api/payment-status?checkoutRequestId=...
 */
router.post('/bundles/pay', async (req, res, next) => {
  try {
    const { phone, category, price } = req.body || {};
    if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid Safaricom number, e.g. 0712 345 678.' });
    }
    const bundle = findBundle(category, price);
    if (!bundle) return res.status(400).json({ error: 'That deal is not available. Refresh the page and try again.' });

    // Stop anyone from spamming M-Pesa prompts to someone's phone.
    const cooldownStart = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - PAY_COOLDOWN_MS) / 1000));
    if (await Payment.exists({ phone, status: 'pending', _id: { $gt: cooldownStart } })) {
      return res.status(429).json({ error: 'A payment request was just sent to this phone. Check your phone or try again in a minute.' });
    }

    const payment = await Payment.create({
      kind: 'bundle', phone, amount: bundle.price,
      bundle: { category: bundle.category, size: bundle.size, valid: bundle.valid }
    });
    try {
      const stk = await initiateStkPayment({
        phone, amount: bundle.price,
        accountReference: `BINGWA${bundle.price}`, description: `${bundle.category} deal`
      });
      if (stk.ResponseCode !== '0' || !stk.CheckoutRequestID) {
        await Payment.updateOne({ _id: payment._id }, {
          $set: { status: 'failed', resultDescription: stk.ResponseDescription || 'STK request was not accepted.' }
        });
        return res.status(502).json({ error: stk.ResponseDescription || 'M-Pesa did not accept the payment request.' });
      }
      await Payment.updateOne({ _id: payment._id }, {
        $set: { checkoutRequestId: stk.CheckoutRequestID, merchantRequestId: stk.MerchantRequestID }
      });
      return res.status(202).json({
        message: 'Check your phone and enter your M-Pesa PIN.',
        checkoutRequestId: stk.CheckoutRequestID,
        amount: bundle.price
      });
    } catch (error) {
      await Payment.updateOne({ _id: payment._id }, { $set: { status: 'failed', resultDescription: error.message } });
      throw error;
    }
  } catch (error) { next(error); }
});

module.exports = router;
