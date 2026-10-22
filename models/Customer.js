const mongoose = require('mongoose');

const customerSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: {
    type: String,
    required: true,
    unique: true,
    match: /^2547\d{8}$/,
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
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { versionKey: false });

module.exports = mongoose.model('Customer', customerSchema);
