# ISP Project Status Handout

**Review date:** 22 October 2026  
**Workspace:** `C:\dev\internet`

## Executive summary

There are two different ISP applications in this folder. The root project is the more complete system: it has a customer portal, an Express API, MongoDB records, Daraja STK Push integration, SMS hooks, and an expiry scheduler. Its frontend is `public/portal.html`, served at `/portal`. The second project at `isp-mvp/isp-mvp/` is a standalone landing page and payment demo with a separate lightweight server. The root server does not serve or call the nested project.

The root code parses successfully and its dependencies are installed. That confirms the code is syntactically loadable, not that a database, M-Pesa, SMS, callback, or router connection works. No test script is defined, and no end-to-end or live-provider test was run in this review.

## Which project is the current app?

| Path | What it is | How to start | State |
| --- | --- | --- | --- |
| `index.js` + `routes/`, `services/`, `models/`, `public/` | Main customer management and renewal application | `npm start` from workspace root | Requires MongoDB and configured environment variables. Portal: `http://localhost:3000/portal`. |
| `isp-mvp/isp-mvp/server.js` + `public/` | Independent marketing site and simulated/Daraja checkout prototype | `node server.js` from `isp-mvp/isp-mvp` | Defaults to demo mode without its own Daraja settings. It does not use the root MongoDB customer system. |

The root frontend is a single static HTML page with inline CSS and JavaScript, not a separate React/Vite app. There is no admin dashboard UI; customer/admin operations are API-only.

## What has been built in the main app

### Customer portal

- Presents weekly (KES 300 / 7 days) and monthly (KES 999 / 30 days) plans.
- Provides a signup path and an existing-customer renewal path.
- Signup records are created as expired until payment succeeds.
- Requests an M-Pesa STK prompt and polls payment status while the customer approves it.
- Shows success/failure states and a timeout message.

### API and stored data

- Customer registration and customer create/list/read/suspend endpoints.
- Dashboard counts for total, active, expired, and suspended customers.
- Payment initiation and Daraja callback endpoints.
- Mongoose customer and payment models with unique phone/MAC and payment identifiers.
- Validation for phone numbers, MAC addresses, plans, and customer status.

### Payment, notifications, and expiry

- Daraja sandbox/production base URL selection, token retrieval, Nairobi timestamp generation, and STK request construction.
- Successful callbacks check the expected payment amount, mark payment paid, and extend the customer's entitlement.
- Repeated callbacks for a payment already processed do not extend the plan again.
- Optional Africa's Talking SMS for successful payment, upcoming expiry, and expired service.
- Hourly expiry processing and a reminder window around one day before expiry.

### Standalone prototype

- Editable brand, plan, pricing, and contact data in `isp-mvp/isp-mvp/public/site.json`.
- Demo payment simulation after a few seconds, or Daraja mode when that prototype's separate environment variables are supplied.
- This prototype describes itself as not having accounts, a database, or router activation. Its capabilities and API are separate from the root app.

## What was actually checked

- Root and nested JavaScript files passed `node --check` syntax checks.
- `npm.cmd ls --depth=0` found the root dependencies installed (Express, Mongoose, Axios, Africa's Talking, dotenv, and node-cron).
- Node.js 24.19.0 is installed; the root package requires Node 20 or newer.
- The root `package.json` defines `start` and `dev`, but no test, lint, or build command.
- The workspace root is not a Git repository, so this review could not establish commit history or uncommitted changes.
- I did not inspect or reproduce values from `.env`.

## What works versus what remains unverified

| Area | Code-level status | Runtime status |
| --- | --- | --- |
| Portal page | Implemented and wired to the root routes | Not opened in a browser during this review. |
| Customer APIs | Implemented with validation and MongoDB calls | Requires MongoDB; no DB request was run. |
| Daraja STK Push | Implemented; fails fast for a missing/invalid HTTPS callback URL | Not verified against Safaricom sandbox or production. Needs matching credentials and a publicly reachable callback URL. |
| Callback activation | Implemented, including amount matching and duplicate protection | Not exercised with a real or replayed callback. |
| SMS | Optional integration; missing key skips SMS | No Africa's Talking request was made. |
| Expiry scheduler | Hourly cron job is registered after database connection | Not observed running against data. It changes entitlement records but does not control network equipment. |
| Router/network access | No router/RADIUS/controller integration found | Customer status alone does not turn internet access on or off. |
| Nested demo | Demo and separate Daraja flows are implemented | Not started; not part of the root app. |

## Known gaps and break risks

### High priority before public use

1. **Admin/customer routes have no authentication or authorization.** `GET /api/customers`, `POST /api/customers`, `GET /api/dashboard`, and suspension are exposed without an admin login. The create endpoint also accepts an `active` status. A public deployment could expose customer personal data or allow unauthorized entitlement changes.
2. **The app does not connect entitlement state to the ISP network.** Payment changes the database status and expiry date only. A router, RADIUS service, or network access controller must be integrated before payment can actually restore service automatically.
3. **Callback processing can record payment without activating service.** The callback immediately returns success to Daraja, then processes asynchronously. It marks the payment paid before saving the customer activation. If the later customer lookup/save fails, the callback has already been acknowledged and the paid record prevents a duplicate callback from retrying activation. Add a recoverable transaction/outbox or reconciliation path.
4. **Payment polling identifies the newest payment by phone, not by checkout request.** If a customer starts another payment before the first callback arrives, `/api/payment-status?phone=...` can return the newer attempt's state. Poll by the specific checkout request ID instead.

### Operational gaps

- Root startup requires `MONGODB_URI`; it exits if unset or if MongoDB cannot be reached. Daraja is only contacted when a user requests payment, but then the sandbox/production credentials, shortcode, passkey, and public HTTPS callback must be configured correctly.
- The callback URL must be reachable from Safaricom. A local-only URL will not receive callbacks. A failed callback can leave the portal waiting until timeout even when the user paid.
- SMS is best-effort and can be skipped when `AT_API_KEY` is unset. SMS failure does not undo the payment or expiry update.
- The nested prototype is particularly unsuitable as the production system: it stores active payment state in memory, uses an append-only log for records, loses in-memory state after restart, and its README notes there is no customer account or automatic router activation. It also has a default callback secret that must be replaced if using Daraja mode.
- Neither app has an admin web interface, login flow, automated test suite, or deployment configuration in the reviewed files.

## Main endpoints in the root app

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/portal` | Customer plan and payment page |
| POST | `/api/register` | Public customer signup |
| POST | `/api/pay` | Start an STK Push for an existing phone/account |
| POST | `/api/mpesa/callback` | Receive Daraja payment result |
| GET | `/api/payment-status?phone=...` | Portal polling endpoint (currently latest payment per phone) |
| GET/POST | `/api/customers` | List/create customer records |
| GET | `/api/customers/:id` | Read one customer |
| PATCH | `/api/customers/:id/suspend` | Suspend a customer |
| GET | `/api/dashboard` | Customer status counts |

## Suggested next steps

1. Decide whether the nested Zuri Net demo should be archived or treated as a separate product; it currently has different plans, branding, API behavior, and payment storage.
2. Add admin authentication and access control before exposing customer-management endpoints publicly.
3. Change payment polling to use a checkout request ID and make callback-to-activation recoverable.
4. Connect activation and expiry/suspension to the actual network access system.
5. Add automated checks for registration, payment callback success/failure/duplicate/amount mismatch, expiry, and polling; then verify against Daraja sandbox and a publicly reachable HTTPS callback.

## Files to start with

- Main server and routes: `index.js`, `routes/customers.js`, `routes/payment.js`
- Portal UI: `public/portal.html`
- Database schemas: `models/Customer.js`, `models/Payment.js`
- Payment and background jobs: `services/mpesa.js`, `services/scheduler.js`, `services/sms.js`
- Separate prototype: `isp-mvp/isp-mvp/README.md`, `isp-mvp/isp-mvp/server.js`, `isp-mvp/isp-mvp/public/index.html`
