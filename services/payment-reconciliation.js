'use strict';

const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
const { PLANS } = require('./mpesa');
const network = require('./network');
const { sendSms } = require('./sms');

async function activatePendingPayment(paymentOrId) {
  const payment = paymentOrId && typeof paymentOrId === 'object' && paymentOrId.status
    ? paymentOrId
    : await Payment.findById(paymentOrId?._id || paymentOrId).lean();
  if (!payment || payment.status !== 'paid_pending_activation') return false;
  const plan = PLANS[payment.plan];
  if (!plan) throw new Error(`Cannot activate payment with unknown plan: ${payment.plan}`);

  const now = new Date();
  const expiresInMs = plan.days * 24 * 60 * 60 * 1000;
  const paymentId = payment._id;
  const applied = await Customer.collection.updateOne(
    { phone: payment.phone, activatedPaymentIds: { $ne: paymentId } },
    [{ $set: {
      plan: payment.plan,
      status: 'active',
      expiresAt: { $add: [
        { $cond: [
          { $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiresAt', now] }] },
          '$expiresAt', now
        ] },
        expiresInMs
      ] },
      expiryReminderSentAt: null,
      activatedPaymentIds: { $setUnion: [{ $ifNull: ['$activatedPaymentIds', []] }, [paymentId]] }
    } }]
  );

  const customer = await Customer.findOne({ phone: payment.phone }).lean();
  if (!customer) throw new Error(`No customer exists for payment ${payment._id}`);

  const alreadyApplied = (customer.activatedPaymentIds || []).some((id) => String(id) === String(paymentId));
  if (!applied.modifiedCount && !alreadyApplied) {
    throw new Error(`Customer entitlement was not updated for payment ${payment._id}`);
  }

  if (applied.modifiedCount) {
    await network.activate(customer);
    const date = new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', dateStyle: 'medium'
    }).format(customer.expiresAt);
    await sendSms(customer.phone, `Hello ${customer.name}, your ${payment.plan} internet is now active until ${date}. Enjoy!`);
  }

  await Payment.updateOne(
    { _id: payment._id, status: 'paid_pending_activation' },
    { $set: { status: 'paid' } }
  );
  return true;
}

async function reconcilePendingActivations() {
  const pending = await Payment.find({ status: 'paid_pending_activation' }).sort({ createdAt: 1 }).lean();
  for (const payment of pending) {
    try {
      await activatePendingPayment(payment);
    } catch (error) {
      console.error('Payment activation reconciliation failed:', {
        paymentId: String(payment._id), name: error.name, message: error.message
      });
    }
  }
  return pending.length;
}

module.exports = { activatePendingPayment, reconcilePendingActivations };
