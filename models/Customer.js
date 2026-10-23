const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: {
    type: String,
    required: true,
    unique: true,
    // Safaricom 07XX and 01XX numbers in international format.
    match: /^254(7|1)\d{8}$/,
    index: true
  },
  macAddress: {
    type: String,
    unique: true,
    sparse: true,
    index: true,
    trim: true,
    uppercase: true,
    match: /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/
  },
  plan: { type: String, enum: ['weekly', 'monthly'], required: true },
  status: {
    type: String,
    enum: ['active', 'expired', 'suspended'],
    default: 'expired',
    index: true
  },
  expiresAt: { type: Date, default: null, index: true },
  // Prevent hourly scheduler runs from sending the same reminder more than once.
  expiryReminderSentAt: { type: Date, default: null },
  // Payment IDs are retained so recovery cannot extend one payment twice.
  activatedPaymentIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  // What the router was last successfully told. Anything other than the state matching
  // `status` means "out of sync" and the scheduler will retry.
  networkState: { type: String, enum: ['enabled', 'disabled', 'pending'], default: null, index: true },
  networkSyncedAt: { type: Date, default: null },
  networkError: { type: String, default: null },
  // Devices the customer used before switching. The router sync removes their access.
  staleMacAddresses: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });

module.exports = mongoose.model('Customer', customerSchema);
