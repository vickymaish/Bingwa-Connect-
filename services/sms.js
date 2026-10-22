const AfricasTalking = require('africastalking');

let smsClient;
function getSmsClient() {
  if (!process.env.AT_API_KEY) return null;
  if (!smsClient) {
    const at = AfricasTalking({
      apiKey: process.env.AT_API_KEY,
      username: process.env.AT_USERNAME || 'sandbox'
    });
    smsClient = at.SMS;
  }
  return smsClient;
}

async function sendSms(phone, message) {
  const client = getSmsClient();
  if (!client) {
    console.warn('SMS skipped: AT_API_KEY is not configured.');
    return;
  }
  const options = { to: [phone], message };
  if (process.env.AT_SENDER_ID) options.from = process.env.AT_SENDER_ID;
  try {
    await client.send(options);
  } catch (error) {
    // Messaging provider outages should not roll back a confirmed payment or expiry update.
    console.error('Africa\'s Talking SMS failed:', error.message);
  }
}

module.exports = { sendSms };
