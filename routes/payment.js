const express = require('express');
const mongoose = require('mongoose');
const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
const { PLANS, initiateStkPush, queryStkPush } = require('../services/mpesa');
const { activatePendingPayment } = require('../services/payment-reconciliation');
const { normalizeMac } = require('../services/network');

const router = express.Router();
// Safaricom numbers: 2547XXXXXXXX and the newer 2541XXXXXXXX (0110/0111 ranges).
const PHONE_PATTERN = /^254(7|1)\d{8}$/;
const PAY_COOLDOWN_MS = 60 * 1000;

router.post('/pay', async (req, res, next) => {
  try {
    const { phone, plan } = req.body;
    if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone) || !PLANS[plan]) {
      return res.status(400).json({ error: 'Provide a valid phone (2547XXXXXXXX or 2541XXXXXXXX) and plan (weekly or monthly).' });
    }
    // The MikroTik hotspot login page passes the device's MAC to the portal (?mac=...),
    // and the portal sends it here. Optional: admins can also set MACs by hand.
    // An unusable value (e.g. the page was opened outside the hotspot) is ignored, never a reason to refuse payment.
    const macAddress = normalizeMac(req.body.mac) || undefined;
    const customer = await Customer.findOne({ phone });
    if (!customer) return res.status(404).json({ error: 'No customer account found for this phone number.' });
    if (customer.status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Contact support to restore service.' });
    }

    // Stop anyone from spamming STK prompts to a customer's phone.
    // ObjectIds embed their creation time, so this works without a createdAt field.
    const cooldownStart = mongoose.Types.ObjectId.createFromTime(Math.floor((Date.now() - PAY_COOLDOWN_MS) / 1000));
    const recent = await Payment.exists({ phone, status: 'pending', _id: { $gt: cooldownStart } });
    if (recent) {
      return res.status(429).json({ error: 'A payment request was just sent to this phone. Check your phone or try again in a minute.' });
    }

    const payment = await Payment.create({ phone, plan, amount: PLANS[plan].amount, ...(macAddress ? { macAddress } : {}) });
    try {
      const stk = await initiateStkPush({ phone, plan });
      if (stk.ResponseCode !== '0' || !stk.CheckoutRequestID) {
        await Payment.updateOne({ _id: payment._id }, {
          $set: { status: 'failed', resultDescription: stk.ResponseDescription || 'STK request was not accepted.' }
        });
        return res.status(502).json({ error: stk.ResponseDescription || 'M-Pesa did not accept the payment request.' });
      }
      await Payment.updateOne({ _id: payment._id }, {
        $set: { checkoutRequestId: stk.CheckoutRequestID, merchantRequestId: stk.MerchantRequestID }
      });
      return res.status(202).json({ message: 'STK push sent. Enter your M-Pesa PIN to complete payment.', checkoutRequestId: stk.CheckoutRequestID });
    } catch (error) {
      await Payment.updateOne({ _id: payment._id }, {
        $set: { status: 'failed', resultDescription: error.message }
      });
      throw error;
    }
  } catch (error) { next(error); }
});

router.post('/mpesa/callback', async (req, res) => {
  // Daraja expects a prompt 200 response; process asynchronously below.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const callback = req.body?.Body?.stkCallback;
    const checkoutRequestId = callback?.CheckoutRequestID;
    if (typeof checkoutRequestId !== 'string' || !checkoutRequestId) return;

    const payment = await Payment.findOne({ checkoutRequestId });
    if (!payment || payment.status !== 'pending') return;

    // SECURITY: this URL is public and the customer receives the CheckoutRequestID,
    // so anyone could POST a fake "success" here. Never trust the callback's
    // ResultCode — confirm the outcome with Safaricom first.
    let verified;
    try {
      verified = await queryStkPush(checkoutRequestId);
    } catch (error) {
      // Still processing, or Daraja rate-limited us. Leave it pending;
      // the scheduler's reconciliation should retry later.
      console.warn(`STK query not final for ${checkoutRequestId}; leaving pending.`, {
        status: error.response?.status, code: error.response?.data?.errorCode
      });
      return;
    }

    if (Number(verified.ResultCode) !== 0) {
      await Payment.updateOne({ _id: payment._id, status: 'pending' }, {
        $set: { status: 'failed', resultDescription: verified.ResultDesc || 'Payment was not completed.' }
      });
      return;
    }

    // Safaricom confirmed success. The query response has no receipt number,
    // so take it from the callback metadata.
    const metadata = Array.isArray(callback.CallbackMetadata?.Item) ? callback.CallbackMetadata.Item : [];
    const valueFor = (name) => metadata.find((item) => item?.Name === name)?.Value;
    const receiptNumber = valueFor('MpesaReceiptNumber');
    const paidAmount = Number(valueFor('Amount'));
    if (paidAmount !== payment.amount) {
      // Safaricom confirmed the STK push we created for payment.amount, so that amount stands.
      console.warn(`Callback amount ${paidAmount} differs from expected ${payment.amount} for ${checkoutRequestId}`);
    }

    const $set = { status: 'paid_pending_activation', paidAt: new Date(), resultDescription: verified.ResultDesc };
    if (typeof receiptNumber === 'string' && /^[A-Z0-9]{6,20}$/.test(receiptNumber)) $set.receiptNumber = receiptNumber;
    const updated = await Payment.updateOne({ _id: payment._id, status: 'pending' }, { $set });
    if (!updated.modifiedCount) return; // already handled by the scheduler or a duplicate callback

    await activatePendingPayment(payment._id);
  } catch (error) {
    console.error('M-Pesa callback processing failed:', {
      name: error.name, message: error.message, code: error.code
    });
  }
});

module.exports = router;
