'use strict';

// Keeps the router in line with the database.
// The database (Customer.status) is the source of truth; the router is made to match it.
// If the router is offline or a call fails, nothing is lost: the customer stays
// "out of sync" and the scheduler retries every few minutes until it succeeds.

const Customer = require('../models/Customer');
const network = require('./network');

function desiredState(customer) {
  return customer.status === 'active' ? 'enabled' : 'disabled';
}

function safeError(error) {
  return { name: error.name, message: error.message, code: error.code, status: error.status ?? error.response?.status };
}

async function syncCustomerAccess(customerOrId) {
  const customer = customerOrId && typeof customerOrId === 'object' && customerOrId.status
    ? customerOrId
    : await Customer.findById(customerOrId?._id || customerOrId).lean();
  if (!customer) return false;

  const desired = desiredState(customer);
  // Mark "pending" first. If the status changes while we talk to the router,
  // the final guarded write below misses and the next sync run fixes it.
  await Customer.updateOne({ _id: customer._id }, { $set: { networkState: 'pending' } });

  // Devices the customer switched away from lose access first.
  for (const oldMac of customer.staleMacAddresses || []) {
    if (oldMac !== customer.macAddress) await network.deactivate({ _id: customer._id, macAddress: oldMac });
    await Customer.updateOne({ _id: customer._id }, { $pull: { staleMacAddresses: oldMac } });
  }

  if (desired === 'enabled') await network.activate(customer);
  else await network.deactivate(customer);

  await Customer.updateOne(
    { _id: customer._id, status: customer.status },
    { $set: { networkState: desired, networkSyncedAt: new Date(), networkError: null } }
  );
  return true;
}

async function trySyncCustomerAccess(customerOrId) {
  try {
    return await syncCustomerAccess(customerOrId);
  } catch (error) {
    const id = String(customerOrId?._id || customerOrId);
    console.error('Router sync failed (will retry):', { customerId: id, ...safeError(error) });
    await Customer.updateOne({ _id: customerOrId?._id || customerOrId }, {
      $set: { networkError: String(error.message).slice(0, 300) }
    }).catch(() => {});
    return false;
  }
}

async function syncAllAccess({ limit = 50 } = {}) {
  const outOfSync = await Customer.find({
    $or: [
      { status: 'active', networkState: { $ne: 'enabled' } },
      { status: { $in: ['expired', 'suspended'] }, networkState: { $ne: 'disabled' } },
      { 'staleMacAddresses.0': { $exists: true } }
    ]
  }).sort({ networkSyncedAt: 1 }).limit(limit).lean();

  let synced = 0;
  for (const customer of outOfSync) {
    if (await trySyncCustomerAccess(customer)) synced += 1;
  }
  return { checked: outOfSync.length, synced };
}

module.exports = { syncCustomerAccess, trySyncCustomerAccess, syncAllAccess, safeError };
