const axios = require('axios');

const PLANS = Object.freeze({ weekly: { amount: 300, days: 7 }, monthly: { amount: 999, days: 30 } });
const isProduction = process.env.MPESA_ENV === 'production';
const baseUrl = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Daraja tokens last ~3600s. Cache one so every STK push/query doesn't hit /oauth.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  const credentialPrefix = isProduction ? 'MPESA_PRODUCTION' : 'MPESA_SANDBOX';
  const credentials = Buffer.from(
    `${requiredEnv(`${credentialPrefix}_CONSUMER_KEY`)}:${requiredEnv(`${credentialPrefix}_CONSUMER_SECRET`)}`
  ).toString('base64');
  const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }, timeout: 15000
  });
  const expiresInSeconds = Number(response.data.expires_in) || 3599;
  cachedToken = response.data.access_token;
  cachedTokenExpiresAt = Date.now() + (expiresInSeconds - 60) * 1000; // refresh a minute early
  return cachedToken;
}

function darajaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
}

function stkCredentials() {
  const shortcode = requiredEnv('MPESA_SHORTCODE');
  const passkey = requiredEnv('MPESA_PASSKEY');
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  return { shortcode, timestamp, password };
}

function validatedCallbackUrl() {
  const callbackUrl = requiredEnv('MPESA_CALLBACK_URL');
  let parsed;
  try { parsed = new URL(callbackUrl); } catch (_) {}
  if (!parsed || parsed.protocol !== 'https:' ||
      /(^|\.)example$|^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) {
    const error = new Error('Set MPESA_CALLBACK_URL to a publicly reachable HTTPS URL ending in /api/mpesa/callback (use an HTTPS tunnel such as ngrok for local testing).');
    error.code = 'MPESA_CONFIG_ERROR';
    throw error;
  }
  return callbackUrl;
}

/**
 * Sends an M-Pesa prompt (STK push) for any amount.
 * Where the money goes:
 *  - MPESA_TILL_NUMBER unset (sandbox/paybill): CustomerPayBillOnline to MPESA_SHORTCODE.
 *  - MPESA_TILL_NUMBER set (Buy Goods till, after Daraja Go Live): CustomerBuyGoodsOnline,
 *    paid INTO the till. MPESA_SHORTCODE must then be the till's store / head-office number
 *    that Safaricom issued with the passkey (not the till number itself).
 */
async function initiateStkPayment({ phone, amount, accountReference, description }) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error('Invalid payment amount');

  const callbackUrl = validatedCallbackUrl();
  const { shortcode, timestamp, password } = stkCredentials();
  const tillNumber = (process.env.MPESA_TILL_NUMBER || '').trim();
  const accessToken = await getAccessToken();

  const response = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: tillNumber ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
    Amount: amount,
    PartyA: phone,
    PartyB: tillNumber || shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: String(accountReference).slice(0, 12),
    TransactionDesc: String(description).slice(0, 13)
  }, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 });

  return response.data;
}

/** Home WiFi plan payment (weekly / monthly). */
async function initiateStkPush({ phone, plan }) {
  const selectedPlan = PLANS[plan];
  if (!selectedPlan) throw new Error('Unsupported payment plan');
  return initiateStkPayment({
    phone, amount: selectedPlan.amount,
    accountReference: `ISP-${plan}`, description: `${plan} WiFi`
  });
}

/**
 * Ask Safaricom directly what happened to an STK push.
 * The callback endpoint is public, so its body can be forged; this answer cannot.
 * Resolves with { ResultCode, ResultDesc, ... } once the transaction is final.
 * Throws (Daraja returns HTTP 500 / errorCode 500.001.1001) while it is still processing.
 */
async function queryStkPush(checkoutRequestId) {
  const { shortcode, timestamp, password } = stkCredentials();
  const accessToken = await getAccessToken();
  const response = await axios.post(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestId
  }, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 });
  return response.data;
}

module.exports = { PLANS, initiateStkPush, initiateStkPayment, queryStkPush };
