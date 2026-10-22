const axios = require('axios');

const PLANS = Object.freeze({ weekly: { amount: 300, days: 7 }, monthly: { amount: 999, days: 30 } });
const isProduction = process.env.MPESA_ENV === 'production';
// TODO: Switch to the production Daraja URLs only after production credentials are configured.
const baseUrl = isProduction ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function getAccessToken() {
  const credentialPrefix = isProduction ? 'MPESA_PRODUCTION' : 'MPESA_SANDBOX';
  const credentials = Buffer.from(
    `${requiredEnv(`${credentialPrefix}_CONSUMER_KEY`)}:${requiredEnv(`${credentialPrefix}_CONSUMER_SECRET`)}`
  ).toString('base64');
  const response = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` }, timeout: 15000
  });
  return response.data.access_token;
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

async function initiateStkPush({ phone, plan }) {
  const selectedPlan = PLANS[plan];
  if (!selectedPlan) throw new Error('Unsupported payment plan');

  const shortcode = requiredEnv('MPESA_SHORTCODE');
  const passkey = requiredEnv('MPESA_PASSKEY');
  const callbackUrl = requiredEnv('MPESA_CALLBACK_URL');
  let parsedCallbackUrl;
  try { parsedCallbackUrl = new URL(callbackUrl); } catch (_) {}
  if (!parsedCallbackUrl || parsedCallbackUrl.protocol !== 'https:' ||
      /(^|\.)example$|^(localhost|127\.0\.0\.1)$/.test(parsedCallbackUrl.hostname)) {
    const error = new Error('Set MPESA_CALLBACK_URL to a publicly reachable HTTPS URL ending in /api/mpesa/callback (use an HTTPS tunnel such as ngrok for local testing).');
    error.code = 'MPESA_CONFIG_ERROR';
    throw error;
  }
  const timestamp = darajaTimestamp();
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  const accessToken = await getAccessToken();

  const response = await axios.post(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: selectedPlan.amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: `ISP-${plan}`,
    TransactionDesc: `${plan} internet subscription`
  }, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 });

  return response.data;
}

module.exports = { PLANS, initiateStkPush };
