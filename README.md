# Small ISP Customer Management System

A small Express and MongoDB service for customer records, M-Pesa STK Push payments, a captive portal, SMS notices, and hourly expiry processing.

## Requirements

- Node.js 20 or newer
- MongoDB (local or hosted)
- Safaricom Daraja sandbox app credentials
- Africa's Talking account and API key for SMS (optional while developing)
- A publicly reachable HTTPS callback URL for Daraja callbacks

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in the MongoDB URI and Daraja credentials. Set `ADMIN_API_KEY` to a private random key for customer-management API access; those routes fail closed when it is missing.
3. Start the server: `npm start` (or `npm run dev` while developing).
4. Open `http://localhost:3000/portal` for the captive portal.

The default Daraja environment is sandbox. Use a tunnel such as ngrok during local testing and set `MPESA_CALLBACK_URL` to its HTTPS URL plus `/api/mpesa/callback`. Set `PORTAL_URL` to the externally reachable portal address for reminder SMS messages.

## Sandbox STK Push test

1. Create a Daraja sandbox app and configure its consumer key, consumer secret, shortcode, and passkey in `.env`.
2. Ensure the callback URL is reachable over HTTPS from Safaricom. Sandbox STK push testing uses the sandbox test phone/account configured for your Daraja app.
3. Add a customer with a sandbox test phone number and a valid MAC address:

   ```http
   POST http://localhost:3000/api/customers
   Content-Type: application/json

   {"name":"Test Customer","phone":"2547XXXXXXXX","macAddress":"02:00:00:00:00:01","plan":"weekly"}
   ```

4. Request a payment:

   ```http
   POST http://localhost:3000/api/pay
   Content-Type: application/json

   {"phone":"2547XXXXXXXX","plan":"weekly"}
   ```

5. Approve the sandbox prompt. Daraja calls the callback endpoint; the payment record is marked paid and the customer's access is activated for 7 days (30 days for monthly). Sandbox behavior and test-number requirements are controlled by Safaricom and may differ from live M-Pesa.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/portal` | Captive portal page |
| POST | `/api/pay` | Request STK push with `{ "phone": "2547XXXXXXXX", "plan": "weekly" }` |
| POST | `/api/mpesa/callback` | Daraja callback endpoint |
| GET | `/api/payment-status?checkoutRequestId=...` | Portal polling for one checkout request |
| GET | `/api/customers` | List customers |
| POST | `/api/customers` | Add customer |
| GET | `/api/customers/:id` | Read customer |
| PATCH | `/api/customers/:id/suspend` | Suspend customer |
| GET | `/api/dashboard` | Status counts |

Customer phone numbers must be `2547XXXXXXXX`. MAC addresses are optional during customer self-registration and can be linked later by the ISP; admin-created records still require a colon-separated MAC address. Plans cost KES 300 weekly or KES 999 monthly. The expiry scheduler runs hourly in the `Africa/Nairobi` timezone.

The payment-status endpoint uses `checkoutRequestId` returned by `/api/pay`, for example `/api/payment-status?checkoutRequestId=ws_CO_...`. The old phone-based status lookup is no longer supported. Customer management and dashboard endpoints require the `x-api-key` header whose value matches `ADMIN_API_KEY`. `/api/register`, `/api/pay`, `/api/mpesa/callback`, `/api/payment-status`, and `/portal` remain public.

`services/network.js` exposes `activate(customer)` and `deactivate(customer)` stubs. They only log when payment activation, expiry, or suspension changes entitlement state; they do not configure router, RADIUS, or other network equipment. Real internet access is still not controlled by this app.

## Production notes

- Set `MPESA_ENV=production` only after Safaricom issues production credentials and the shortcode/passkey are configured. The service then uses `https://api.safaricom.co.ke` instead of sandbox. TODO comments mark the URL switch in the M-Pesa service.
- Configure Africa's Talking live API credentials and an approved sender ID before enabling outbound SMS.
- Serve the app over HTTPS before exposing it publicly. Protect and keep the `ADMIN_API_KEY` secret.
- Restrict callback traffic at the network edge where feasible. Daraja callbacks have no application-level signature verification here; payment state is only applied to a previously created checkout request and the callback amount must match the stored plan amount.
- Payment callbacks are idempotent by checkout request ID and pending status. Repeated callbacks do not extend a subscription twice.
- Connect `status` and `macAddress` changes to the ISP's router/RADIUS or network access controller to actually enable or block internet access. This app stores entitlement state; it does not configure network equipment.

## TBD (to be discussed with client)

- Bundles are paid manually to the Buy Goods till; delivery relies on the client's existing Bingwa auto app. STK push for bundles and automatic delivery: TBD.
- Bundle price list is hardcoded in public\portal.html (const BUNDLES); move to database + admin: TBD.
- Home WiFi STK push runs on Daraja SANDBOX (no real money). Daraja Go Live for the client's till: TBD.
- Final price list from client: TBD.