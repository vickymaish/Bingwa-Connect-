const cron = require('node-cron');
const Customer = require('../models/Customer');
const { PLANS } = require('./mpesa');
const { sendSms } = require('./sms');
const { reconcilePendingActivations } = require('./payment-reconciliation');

function dateText(date) {
  return new Intl.DateTimeFormat('en-KE', {
    timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short'
  }).format(date);
}

function startScheduler() {
  cron.schedule('0 * * * *', async () => {
    const now = new Date();
    try {
      const expired = await Customer.find({ status: 'active', expiresAt: { $lte: now } });
      for (const customer of expired) {
        const update = await Customer.updateOne(
          { _id: customer._id, status: 'active', expiresAt: { $lte: now } },
          { $set: { status: 'expired' } }
        );
        if (update.modifiedCount) {
          await sendSms(customer.phone,
            `Hi ${customer.name}, your internet has expired. Pay KES ${PLANS[customer.plan].amount} to reconnect.`);
        }
      }

      const reminderStart = new Date(now.getTime() + 23 * 60 * 60 * 1000);
      const reminderEnd = new Date(now.getTime() + 25 * 60 * 60 * 1000);
      const dueForReminder = await Customer.find({
        status: 'active', expiresAt: { $gt: reminderStart, $lte: reminderEnd }, expiryReminderSentAt: null
      });
      for (const customer of dueForReminder) {
        const claimed = await Customer.updateOne(
          { _id: customer._id, status: 'active', expiryReminderSentAt: null },
          { $set: { expiryReminderSentAt: now } }
        );
        if (claimed.modifiedCount) {
          const portalUrl = process.env.PORTAL_URL || 'the customer portal';
          await sendSms(customer.phone,
            `Hi ${customer.name}, your internet expires tomorrow. Dial *384*# or visit ${portalUrl} to renew.`);
        }
      }

      await reconcilePendingActivations();
    } catch (error) {
      console.error('Expiry scheduler failed:', error);
    }
  }, { timezone: 'Africa/Nairobi' });
}

module.exports = { startScheduler };
