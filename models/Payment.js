const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  plan: { type: String, enum: ['weekly', 'monthly'], required: true },
  amount: { type: Number, required: true },
  checkoutRequestId: { type: String, unique: true, sparse: true, index: true },
  merchantRequestId: String,
  receiptNumber: { type: String, sparse: true, unique: true },
  status: { type: String, enum: ['pending', 'paid_pending_activation', 'paid', 'failed'], default: 'pending', index: true },
  resultDescription: String,
  paidAt: Date,
  // Device that asked to be connected (passed from the hotspot login page). Applied on activation.
  macAddress: { type: String, uppercase: true, match: /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/ },
  // Last time we asked Safaricom about this payment (when its callback is late/missing).
  lastQueriedAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
