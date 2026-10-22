const express = require('express');
const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
const { PLANS, initiateStkPush } = require('../services/mpesa');
const { activatePendingPayment } = require('../services/payment-reconciliation');

const router = express.Router();
const PHONE_PATTERN = /^2547\d{8}$/;

router.post('/pay', async (req, res, next) => {
  try {
    const { phone, plan } = req.body;
    if (!PHONE_PATTERN.test(phone || '') || !PLANS[plan]) {
      return res.status(400).json({ error: 'Provide a valid phone (2547XXXXXXXX) and plan (weekly or monthly).' });
    }
    const customer = await Customer.findOne({ phone });
    if (!customer) return res.status(404).json({ error: 'No customer account found for this phone number.' });
    if (customer.status === 'suspended') {
      return res.status(403).json({ error: 'This account is suspended. Contact support to restore service.' });
    }

    const payment = await Payment.create({ phone, plan, amount: PLANS[plan].amount });
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

router.post('/mpesa/callback', async (req, res, next) => {
  // Daraja expects a prompt 200 response; process the saved transaction asynchronously below.
  res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback?.CheckoutRequestID) return;
    const payment = await Payment.findOne({ checkoutRequestId: callback.CheckoutRequestID });
    if (!payment || payment.status !== 'pending') return;

    if (Number(callback.ResultCode) !== 0) {
      await Payment.updateOne({ _id: payment._id, status: 'pending' }, {
        $set: { status: 'failed', resultDescription: callback.ResultDesc || 'Payment was not completed.' }
      });
      return;
    }

    const metadata = callback.CallbackMetadata?.Item || [];
    const valueFor = (name) => metadata.find((item) => item.Name === name)?.Value;
    const paidAmount = Number(valueFor('Amount'));
    const receiptNumber = valueFor('MpesaReceiptNumber');
    const receipt = await Payment.updateOne({ _id: payment._id, status: 'pending', amount: paidAmount }, {
      $set: { status: 'paid_pending_activation', receiptNumber, paidAt: new Date(), resultDescription: callback.ResultDesc }
    });
    if (!receipt.modifiedCount) {
      console.error(`Payment callback amount mismatch or duplicate for ${callback.CheckoutRequestID}`);
      return;
    }

    await activatePendingPayment(payment._id);
  } catch (error) {
    // The callback already received its 200 response; log safe fields only and
    // avoid passing a possibly credential-bearing Axios object to Express.
    console.error('M-Pesa callback processing failed:', {
      name: error.name,
      message: error.message,
      code: error.code
    });
  }
});

module.exports = router;
