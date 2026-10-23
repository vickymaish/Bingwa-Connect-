'use strict';

const cron = require('node-cron');
const Customer = require('../models/Customer');
const { PLANS } = require('./mpesa');
const { sendSms } = require('./sms');
const { reconcilePendingActivations, reconcileStalePendingPayments } = require('./payment-reconciliation');
const { trySyncCustomerAccess, syncAllAccess, safeError } = require('./access-sync');

async function trySendSms(phone, text) {
  try { await sendSms(phone, text); } catch (error) { console.error('SMS failed:', safeError(error)); }
}

// Runs a job, skipping a tick if the previous run is still going and never letting one error stop the schedule.
function guarded(name, job) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try { await job(); } catch (error) {
      console.error(`Scheduled job "${name}" failed:`, safeError(error));
    } finally { running = false; }
  };
}

async function expireCustomers() {
  const now = new Date();
  const expired = await Customer.find({ status: 'active', expiresAt: { $lte: now } }).lean();
  for (const customer of expired) {
    try {
      const update = await Customer.updateOne(
        { _id: customer._id, status: 'active', expiresAt: { $lte: now } },
        { $set: { status: 'expired', networkState: 'pending' } }
      );
      if (!update.modifiedCount) continue;
      await trySyncCustomerAccess({ ...customer, status: 'expired' }); // cut off on the router now
      const amount = PLANS[customer.plan]?.amount;
      await trySendSms(customer.phone,
        `Hi ${customer.name}, your internet has expired.${amount ? ` Pay KES ${amount} to reconnect.` : ' Renew to reconnect.'}`);
    } catch (error) {
      console.error('Expiring customer failed:', { customerId: String(customer._id), ...safeError(error) });
    }
  }
}

async function sendExpiryReminders() {
  const now = new Date();
  const dueForReminder = await Customer.find({
    status: 'active',
    expiresAt: { $gt: new Date(now.getTime() + 23 * 3600e3), $lte: new Date(now.getTime() + 25 * 3600e3) },
    expiryReminderSentAt: null
  }).lean();
  const portalUrl = process.env.PORTAL_URL || 'the customer portal';
  for (const customer of dueForReminder) {
    const claimed = await Customer.updateOne(
      { _id: customer._id, status: 'active', expiryReminderSentAt: null },
      { $set: { expiryReminderSentAt: now } }
    );
    if (claimed.modifiedCount) {
      await trySendSms(customer.phone, `Hi ${customer.name}, your internet expires tomorrow. Visit ${portalUrl} to renew.`);
    }
  }
}

function startScheduler() {
  const tz = { timezone: 'Africa/Nairobi' };
  // Payments: resolve late/missing M-Pesa callbacks, finish activations, fix router drift.
  cron.schedule('*/2 * * * *', guarded('payments-and-router', async () => {
    await reconcileStalePendingPayments();
    await reconcilePendingActivations();
    await syncAllAccess();
  }), tz);
  // Cut off expired customers within 5 minutes of expiry.
  cron.schedule('*/5 * * * *', guarded('expiry', expireCustomers), tz);
  // Renewal reminders ~24h before expiry.
  cron.schedule('7 * * * *', guarded('reminders', sendExpiryReminders), tz);
}

module.exports = { startScheduler, expireCustomers, sendExpiryReminders };
