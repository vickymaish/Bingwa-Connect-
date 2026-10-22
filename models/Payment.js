const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  plan: { type: String, enum: ['weekly', 'monthly'], required: true },
  amount: { type: Number, required: true },
  checkoutRequestId: { type: String, unique: true, sparse: true, index: true },
  merchantRequestId: String,
  receiptNumber: { type: String, sparse: true, unique: true },
  status: { type: String, enum: ['pending', 'paid', 'failed'], default: 'pending', index: true },
  resultDescription: String,
  paidAt: Date
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);
