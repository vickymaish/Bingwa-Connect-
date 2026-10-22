require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const paymentRoutes = require('./routes/payment');
const customerRoutes = require('./routes/customers');
const portalRoutes = require('./routes/portal');
const { startScheduler } = require('./services/scheduler');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use('/api', paymentRoutes);
app.use('/api', customerRoutes);
app.use('/', portalRoutes);

app.get('/api/payment-status', async (req, res, next) => {
  try {
    const phone = req.query.phone;
    if (!/^2547\d{8}$/.test(phone || '')) return res.status(400).json({ error: 'Invalid phone number.' });
    const Payment = require('./models/Payment');
    const payment = await Payment.findOne({ phone }).sort({ createdAt: -1 }).select('status').lean();
    if (!payment) return res.status(404).json({ error: 'No payment request found.' });
    res.json({ status: payment.status });
  } catch (error) { next(error); }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const isUpstreamError = Boolean(error.isAxiosError);
  const isValidationError = error.name === 'ValidationError' || error.name === 'CastError';
  const isDarajaAuthError = isUpstreamError && error.config?.url?.includes('/oauth/v1/generate');
  const isMpesaConfigError = error.code === 'MPESA_CONFIG_ERROR';

  // Axios errors contain request headers, including the encoded Daraja credentials.
  // Log only safe diagnostic fields instead of the complete error/config object.
  if (isUpstreamError) {
    console.error('Upstream request failed:', {
      status: error.response?.status,
      code: error.code,
      message: error.message
    });
  } else {
    console.error('Request failed:', { name: error.name, message: error.message, code: error.code });
  }

  const status = isValidationError ? 400 : isUpstreamError ? 502 : isMpesaConfigError ? 503 : 500;
  const message = isValidationError
    ? error.message
    : isMpesaConfigError
      ? error.message
      : isDarajaAuthError
      ? 'Safaricom rejected the Daraja credentials. Verify that MPESA_ENV and the consumer key and secret are for the same environment.'
      : isUpstreamError
        ? 'The M-Pesa service could not process the request. Please try again later.'
        : 'Internal server error.';
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT) || 3000;
async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required. Copy .env.example to .env and configure it.');
  await mongoose.connect(process.env.MONGODB_URI);
  startScheduler();
  app.listen(port, () => console.log(`ISP customer system listening on port ${port}`));
}

if (require.main === module) {
  start().catch((error) => { console.error('Application startup failed:', error); process.exit(1); });
}

module.exports = app;
