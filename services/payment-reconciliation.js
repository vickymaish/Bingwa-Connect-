'use strict';

const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
const { PLANS, queryStkPush } = require('./mpesa');
const { trySyncCustomerAccess, safeError } = require('./access-sync');
const { normalizeMac } = require('./network');
const { sendSms } = require('./sms');

const MINUTE = 60 * 1000;
const STALE_PENDING_AFTER_MS = 90 * 1000;          // give Safaricom's callback a chance first
const QUERY_RETRY_EVERY_MS = 2 * MINUTE;
const GIVE_UP_QUERYING_AFTER_MS = 7 * 24 * 60 * MINUTE;
const UNSENT_STK_FAIL_AFTER_MS = 10 * MINUTE;      // a payment row whose STK push never went out

async function trySendSms(phone, text) {
  try { await sendSms(phone, text); } catch (error) {
    console.error('SMS failed:', safeError(error));
  }
}

/**
 * If the customer paid from a device the system doesn't know yet, link that device.
 * The previous device is queued for cutoff (staleMacAddresses) so one payment = one device.
 * Only the phone owner can complete an STK push, so only they can move their access.
 */
async function applyDeviceMac(payment, customer) {
  const mac = normalizeMac(payment.macAddress);
  if (!mac || mac === customer.macAddress) return customer;
  try {
    const moved = await Customer.updateOne(
      { _id: customer._id, macAddress: customer.macAddress ?? null },
      {
        $set: { macAddress: mac, networkState: 'pending' },
        ...(customer.macAddress ? { $addToSet: { staleMacAddresses: customer.macAddress } } : {})
      }
    );
    if (!moved.modifiedCount) return (await Customer.findById(customer._id).lean()) || customer;
  } catch (error) {
    if (error.code === 11000) {
      console.error('Device is already registered to another customer; keeping the existing device.', {
        customerId: String(customer._id), paymentId: String(payment._id)
      });
      return customer;
    }
    throw error;
  }
  return (await Customer.findById(customer._id).lean()) || customer;
}

/**
 * Applies a confirmed payment to the customer exactly once, then switches the router on.
 * Safe to call repeatedly: entitlement is guarded by activatedPaymentIds, the router
 * call is idempotent, and the SMS goes out only on the transition to "paid".
 */
async function activatePendingPayment(paymentOrId) {
  const payment = paymentOrId && typeof paymentOrId === 'object' && paymentOrId.status
    ? paymentOrId
    : await Payment.findById(paymentOrId?._id || paymentOrId).lean();
  if (!payment || payment.status !== 'paid_pending_activation') return false;

  // Bundles have nothing to switch on here: the money is in the till and the client's
  // Bingwa auto app sends the bundle from the till's payment SMS. Just mark it paid.
  if (payment.kind === 'bundle') {
    await Payment.updateOne({ _id: payment._id, status: 'paid_pending_activation' }, { $set: { status: 'paid' } });
    return true;
  }

  const plan = PLANS[payment.plan];
  if (!plan) throw new Error(`Cannot activate payment with unknown plan: ${payment.plan}`);

  const now = new Date();
  const expiresInMs = plan.days * 24 * 60 * MINUTE;
  const paymentId = payment._id;
  const applied = await Customer.collection.updateOne(
    { phone: payment.phone, activatedPaymentIds: { $ne: paymentId } },
    [{ $set: {
      plan: payment.plan,
      status: 'active',
      // Renewing early stacks on top of the remaining time instead of wasting it.
      expiresAt: { $add: [
        { $cond: [
          { $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$expiresAt', now] }] },
          '$expiresAt', now
        ] },
        expiresInMs
      ] },
      expiryReminderSentAt: null,
      networkState: 'pending',
      activatedPaymentIds: { $setUnion: [{ $ifNull: ['$activatedPaymentIds', []] }, [paymentId]] }
    } }]
  );

  let customer = await Customer.findOne({ phone: payment.phone }).lean();
  if (!customer) throw new Error(`No customer exists for payment ${payment._id}`);
  customer = await applyDeviceMac(payment, customer);

  const alreadyApplied = (customer.activatedPaymentIds || []).some((id) => String(id) === String(paymentId));
  if (!applied.modifiedCount && !alreadyApplied) {
    throw new Error(`Customer entitlement was not updated for payment ${payment._id}`);
  }

  // Router on. If it fails, the customer is still marked out of sync and the
  // scheduler retries every 2 minutes; the payment itself is never lost.
  await trySyncCustomerAccess(customer);

  const marked = await Payment.updateOne(
    { _id: payment._id, status: 'paid_pending_activation' },
    { $set: { status: 'paid' } }
  );
  if (marked.modifiedCount && customer.status === 'active') {
    const date = new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short'
    }).format(customer.expiresAt);
    await trySendSms(customer.phone, `Hello ${customer.name}, your ${payment.plan} internet is now active until ${date}. Enjoy!`);
  }
  return true;
}

async function reconcilePendingActivations() {
  const pending = await Payment.find({ status: 'paid_pending_activation' }).sort({ createdAt: 1 }).lean();
  for (const payment of pending) {
    try {
      await activatePendingPayment(payment);
    } catch (error) {
      console.error('Payment activation reconciliation failed:', { paymentId: String(payment._id), ...safeError(error) });
    }
  }
  return pending.length;
}

/**
 * Safaricom's callback sometimes arrives late or never (very common in sandbox).
 * For payments still "pending", ask Safaricom directly what happened.
 */
async function reconcileStalePendingPayments({ limit = 20 } = {}) {
  const now = Date.now();

  // STK push never went out (server crashed between saving and calling Safaricom).
  await Payment.updateMany(
    { status: 'pending', checkoutRequestId: { $exists: false }, createdAt: { $lte: new Date(now - UNSENT_STK_FAIL_AFTER_MS) } },
    { $set: { status: 'failed', resultDescription: 'Payment request was never sent to M-Pesa.' } }
  );

  const stale = await Payment.find({
    status: 'pending',
    checkoutRequestId: { $exists: true },
    createdAt: { $lte: new Date(now - STALE_PENDING_AFTER_MS), $gte: new Date(now - GIVE_UP_QUERYING_AFTER_MS) },
    $or: [{ lastQueriedAt: null }, { lastQueriedAt: { $lte: new Date(now - QUERY_RETRY_EVERY_MS) } }]
  }).sort({ lastQueriedAt: 1, createdAt: 1 }).limit(limit).lean();

  let resolved = 0;
  for (const payment of stale) {
    await Payment.updateOne({ _id: payment._id }, { $set: { lastQueriedAt: new Date() } });
    let result;
    try {
      result = await queryStkPush(payment.checkoutRequestId);
    } catch (error) {
      continue; // still processing or rate-limited; try again next run
    }
    const code = Number(result?.ResultCode);
    if (!Number.isFinite(code)) continue;

    if (code === 0) {
      const moved = await Payment.updateOne({ _id: payment._id, status: 'pending' }, {
        $set: { status: 'paid_pending_activation', paidAt: new Date(), resultDescription: result.ResultDesc }
      });
      if (moved.modifiedCount) {
        resolved += 1;
        try { await activatePendingPayment(payment._id); } catch (error) {
          console.error('Activation after STK query failed (will retry):', { paymentId: String(payment._id), ...safeError(error) });
        }
      }
    } else {
      const failed = await Payment.updateOne({ _id: payment._id, status: 'pending' }, {
        $set: { status: 'failed', resultDescription: result.ResultDesc || 'Payment was not completed.' }
      });
      if (failed.modifiedCount) resolved += 1;
    }
  }
  return { checked: stale.length, resolved };
}

module.exports = { activatePendingPayment, reconcilePendingActivations, reconcileStalePendingPayments };
