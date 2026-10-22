'use strict';

const { before, after, beforeEach, afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const nock = require('nock').default;
const request = require('supertest');
const cron = require('node-cron');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Test-only credentials and callback destination. All outbound HTTP is blocked
// except explicit Daraja mocks below; no real provider call can be made.
Object.assign(process.env, {
  MONGODB_URI: 'mongodb://throwaway.invalid/test',
  PORT: '0',
  MPESA_ENV: 'sandbox',
  MPESA_SANDBOX_CONSUMER_KEY: 'test-consumer-key',
  MPESA_SANDBOX_CONSUMER_SECRET: 'test-consumer-secret',
  MPESA_SHORTCODE: '174379',
  MPESA_PASSKEY: 'test-passkey',
  MPESA_CALLBACK_URL: 'https://callback.test/api/mpesa/callback',
  AT_API_KEY: '',
  AT_USERNAME: 'sandbox',
  AT_SENDER_ID: ''
});

nock.disableNetConnect();
nock.enableNetConnect('127.0.0.1');

const app = require('../index');
const Customer = require('../models/Customer');
const Payment = require('../models/Payment');
let mongo;
let schedulerTask;
let schedulerStarted = false;

const sampleCustomer = (overrides = {}) => ({
  name: 'Test Customer',
  phone: '254712345678',
  macAddress: '02:00:00:00:00:01',
  plan: 'weekly',
  status: 'expired',
  ...overrides
});

async function createCustomer(overrides = {}) {
  return Customer.create(sampleCustomer(overrides));
}

function callbackBody(checkoutRequestId, resultCode = 0, amount = 300) {
  return {
    Body: {
      stkCallback: {
        CheckoutRequestID: checkoutRequestId,
        ResultCode: resultCode,
        ResultDesc: resultCode === 0 ? 'Success' : 'Cancelled',
        CallbackMetadata: { Item: [
          { Name: 'Amount', Value: amount },
          { Name: 'MpesaReceiptNumber', Value: `R${checkoutRequestId}` }
        ] }
      }
    }
  };
}

async function sendCallback(id, resultCode = 0, amount = 300) {
  return request(app).post('/api/mpesa/callback').send(callbackBody(id, resultCode, amount));
}

async function waitFor(predicate, message = 'condition did not become true') {
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function createPendingPayment(checkoutRequestId, overrides = {}) {
  return Payment.create({
    phone: '254712345678', plan: 'weekly', amount: 300,
    checkoutRequestId, merchantRequestId: `M-${checkoutRequestId}`,
    ...overrides
  });
}

function mockDaraja(checkoutRequestId) {
  nock('https://sandbox.safaricom.co.ke')
    .get('/oauth/v1/generate?grant_type=client_credentials')
    .reply(200, { access_token: 'mock-access-token', expires_in: '3599' });
  nock('https://sandbox.safaricom.co.ke')
    .post('/mpesa/stkpush/v1/processrequest')
    .reply(200, {
      ResponseCode: '0', ResponseDescription: 'Success',
      CheckoutRequestID: checkoutRequestId, MerchantRequestID: `M-${checkoutRequestId}`
    });
}

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Customer.init(), Payment.init()]);
  const { startScheduler } = require('../services/scheduler');
  const realSchedule = cron.schedule;
  cron.schedule = (_expression, task) => {
    schedulerTask = task;
    return { stop() {} };
  };
  if (!schedulerStarted) {
    startScheduler();
    schedulerStarted = true;
  }
  cron.schedule = realSchedule;
});

after(async () => {
  nock.cleanAll();
  nock.enableNetConnect();
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  nock.cleanAll();
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Customer.syncIndexes(), Payment.syncIndexes()]);
});

afterEach(() => {
  assert.equal(nock.pendingMocks().length, 0, `Unmatched HTTP mocks: ${nock.pendingMocks().join(', ')}`);
});

test('unauthenticated customer-management endpoints are rejected', async (t) => {
  await t.test('GET /api/customers', async () => {
    const response = await request(app).get('/api/customers');
    assert.ok([401, 403].includes(response.status), `got ${response.status}`);
  });
  await t.test('POST /api/customers cannot create an active customer', async () => {
    const response = await request(app).post('/api/customers').send(sampleCustomer({ status: 'active' }));
    assert.ok([401, 403].includes(response.status), `got ${response.status}`);
  });
  await t.test('GET /api/customers/:id', async () => {
    const customer = await createCustomer();
    const response = await request(app).get(`/api/customers/${customer.id}`);
    assert.ok([401, 403].includes(response.status), `got ${response.status}`);
  });
  await t.test('PATCH /api/customers/:id/suspend', async () => {
    const customer = await createCustomer();
    const response = await request(app).patch(`/api/customers/${customer.id}/suspend`).send({});
    assert.ok([401, 403].includes(response.status), `got ${response.status}`);
  });
  await t.test('GET /api/dashboard', async () => {
    const response = await request(app).get('/api/dashboard');
    assert.ok([401, 403].includes(response.status), `got ${response.status}`);
  });
});

test('payment polling identifies a specific checkout request', async () => {
  await createCustomer();
  mockDaraja('checkout-A');
  const first = await request(app).post('/api/pay').send({ phone: '254712345678', plan: 'weekly' });
  assert.equal(first.status, 202);
  assert.equal(first.body.checkoutRequestId, 'checkout-A');
  await sendCallback('checkout-A');
  await waitFor(async () => (await Payment.findOne({ checkoutRequestId: 'checkout-A' }))?.status === 'paid');

  mockDaraja('checkout-B');
  const second = await request(app).post('/api/pay').send({ phone: '254712345678', plan: 'weekly' });
  assert.equal(second.status, 202);
  const polled = await request(app).get('/api/payment-status').query({ checkoutRequestId: 'checkout-A' });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.status, 'paid');
});

test('callback activation failure remains recoverable and can be retried', async () => {
  const customer = await createCustomer();
  await createPendingPayment('save-failure');
  const originalSave = Customer.prototype.save;
  Customer.prototype.save = function saveWithFailure(...args) {
    if (this.id === customer.id) return Promise.reject(new Error('simulated customer write failure'));
    return originalSave.apply(this, args);
  };
  try {
    await sendCallback('save-failure');
    await waitFor(async () => (await Payment.findOne({ checkoutRequestId: 'save-failure' }))?.status !== 'pending');
  } finally {
    Customer.prototype.save = originalSave;
  }

  const pending = await Payment.findOne({ checkoutRequestId: 'save-failure' });
  assert.equal(pending.status, 'paid_pending_activation');
  const reconcile = require('../services/payment-reconciliation').reconcilePendingActivations;
  assert.equal(typeof reconcile, 'function');
  await reconcile();
  await waitFor(async () => (await Customer.findById(customer.id))?.status === 'active');
  assert.equal((await Payment.findOne({ checkoutRequestId: 'save-failure' })).status, 'paid');
});

test('successful callback activates and extends exactly once; duplicate callback is idempotent', async () => {
  const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const customer = await createCustomer({ status: 'active', expiresAt });
  await createPendingPayment('success-once');
  await sendCallback('success-once');
  await waitFor(async () => (await Payment.findOne({ checkoutRequestId: 'success-once' }))?.status === 'paid');
  const firstExpiry = (await Customer.findById(customer.id)).expiresAt;
  assert.ok(firstExpiry > expiresAt);
  await sendCallback('success-once');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await Customer.findById(customer.id)).expiresAt.getTime(), firstExpiry.getTime());
});

test('amount mismatch does not activate the customer', async () => {
  const customer = await createCustomer();
  await createPendingPayment('wrong-amount');
  const oldError = console.error;
  console.error = () => {};
  try { await sendCallback('wrong-amount', 0, 1); } finally { console.error = oldError; }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await Customer.findById(customer.id)).status, 'expired');
  assert.equal((await Payment.findOne({ checkoutRequestId: 'wrong-amount' })).status, 'pending');
});

test('failed callback does not activate the customer', async () => {
  const customer = await createCustomer();
  await createPendingPayment('cancelled');
  await sendCallback('cancelled', 1032, 0);
  await waitFor(async () => (await Payment.findOne({ checkoutRequestId: 'cancelled' }))?.status === 'failed');
  assert.equal((await Customer.findById(customer.id)).status, 'expired');
});

test('unknown checkout callback is acknowledged without crashing', async () => {
  const response = await sendCallback('unknown-checkout');
  assert.equal(response.status, 200);
  assert.equal(response.body.ResultCode, 0);
});

test('registration validates fields and handles duplicate phone and MAC', async (t) => {
  await t.test('rejects malformed phone', async () => {
    const response = await request(app).post('/api/register').send(sampleCustomer({ phone: 'bad' }));
    assert.equal(response.status, 400);
  });
  await t.test('rejects malformed MAC', async () => {
    const response = await request(app).post('/api/register').send({ ...sampleCustomer(), macAddress: 'no-mac' });
    assert.equal(response.status, 400);
  });
  await t.test('rejects unknown plan', async () => {
    const response = await request(app).post('/api/register').send(sampleCustomer({ plan: 'annual' }));
    assert.equal(response.status, 400);
  });
  await t.test('duplicate phone is reported as existing account', async () => {
    await createCustomer();
    const response = await request(app).post('/api/register').send(sampleCustomer({ macAddress: undefined }));
    assert.equal(response.body.code, 'ACCOUNT_EXISTS');
  });
  await t.test('duplicate MAC is rejected', async () => {
    await createCustomer();
    const response = await request(app).post('/api/register').send(sampleCustomer({ phone: '254712345679' }));
    assert.equal(response.status, 409);
  });
});

test('scheduler expires customers and sends a reminder once in the one-day window', async () => {
  const expired = await createCustomer({ status: 'active', expiresAt: new Date(Date.now() - 60_000) });
  const reminder = await createCustomer({
    phone: '254712345679', macAddress: '02:00:00:00:00:02', status: 'active',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
  await schedulerTask();
  assert.equal((await Customer.findById(expired.id)).status, 'expired');
  assert.ok((await Customer.findById(reminder.id)).expiryReminderSentAt);
  const reminderSentAt = (await Customer.findById(reminder.id)).expiryReminderSentAt;
  await schedulerTask();
  assert.equal((await Customer.findById(reminder.id)).expiryReminderSentAt.getTime(), reminderSentAt.getTime());
});

test('public portal and payment routes remain public', async () => {
  assert.equal((await request(app).get('/portal')).status, 200);
  const registration = await request(app).post('/api/register').send(sampleCustomer());
  assert.equal(registration.status, 201);
});
