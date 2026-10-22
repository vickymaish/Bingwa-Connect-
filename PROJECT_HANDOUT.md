# ISP App Review and Hardening Report

**Review date:** 22 October 2026  
**Workspace:** `C:\dev\internet`

This report uses the requested labels throughout: **VERIFIED** means a command or request was run and its output is shown; **CODE-READ ONLY** means the finding comes from reading code; **NOT TESTED** means no runtime verification was performed.

## Summary

**VERIFIED:** The main application is the project at the workspace root. Its portal is `public/portal.html`, served at `/portal`. The independent `isp-mvp/isp-mvp/` folder is a separate demo and was not modified.

**VERIFIED:** A baseline Git commit was created before code changes. The `.env` file was excluded from the baseline and no `.env` values were printed or committed.

**VERIFIED:** The test suite now passes **24/24** using `mongodb-memory-server`. Daraja HTTP calls are mocked with Nock and all other outbound HTTP is blocked during tests. JavaScript syntax checks pass.

**NOT TESTED:** This does not verify a real MongoDB deployment, real Safaricom STK Push/callback delivery, Africa's Talking SMS, or actual internet access through a router/controller.

## Project map

| Label | Path | Purpose and current state |
| --- | --- | --- |
| **CODE-READ ONLY** | `index.js`, `routes/`, `services/`, `models/`, `public/` | Main Express/MongoDB ISP customer and payment app. Portal is `http://localhost:3000/portal` after startup. |
| **CODE-READ ONLY** | `isp-mvp/isp-mvp/` | Separate Zuri Net landing page/payment prototype with its own server, plans, settings, and payment storage. It defaults to simulated checkout when its own Daraja credentials are absent. It has no customer accounts, database, or router activation. |

The main frontend is one static HTML file with inline CSS and JavaScript. There is no admin dashboard UI; admin functions are API-only.

## Environment variables read by the root app

**CODE-READ ONLY:** These names were found in the root app code. No `.env` values were inspected or reproduced.

| Variable name | Required? | Behavior when missing |
| --- | --- | --- |
| `MONGODB_URI` | Yes, for startup | `start()` throws; startup logs an error and exits with code 1. |
| `PORT` | No | Defaults to port `3000`. |
| `ADMIN_API_KEY` | Required to use admin/customer-management endpoints | App still starts, but those endpoints return 503 when the key is not configured. Requests without a matching `x-api-key` return 401. |
| `MPESA_ENV` | No | Defaults to sandbox. Only the exact value `production` selects production URLs and production credentials; other values select sandbox. |
| `MPESA_SANDBOX_CONSUMER_KEY` | Required for sandbox payment requests | Missing configuration causes a payment request to fail at runtime; the payment is marked failed and the API returns an error. |
| `MPESA_SANDBOX_CONSUMER_SECRET` | Required for sandbox payment requests | Same runtime behavior as the sandbox consumer key. |
| `MPESA_PRODUCTION_CONSUMER_KEY` | Required when `MPESA_ENV=production` | Missing configuration causes a payment request to fail at runtime. |
| `MPESA_PRODUCTION_CONSUMER_SECRET` | Required when `MPESA_ENV=production` | Missing configuration causes a payment request to fail at runtime. |
| `MPESA_SHORTCODE` | Required for payment requests | Missing configuration causes the request to fail at runtime. |
| `MPESA_PASSKEY` | Required for payment requests | Missing configuration causes the request to fail at runtime. |
| `MPESA_CALLBACK_URL` | Required for payment requests | Missing configuration causes the request to fail at runtime. A malformed or non-HTTPS URL is rejected with 503. The configured URL must be publicly reachable by Safaricom. |
| `AT_API_KEY` | No | SMS is skipped and a warning is logged. |
| `AT_USERNAME` | No | Defaults to `sandbox` when SMS is enabled. |
| `AT_SENDER_ID` | No | Africa's Talking request omits the sender ID. |
| `PORTAL_URL` | No | Reminder SMS uses the text “the customer portal” instead of a URL. |

## What changed

| Area | Change |
| --- | --- |
| Admin API | Added `ADMIN_API_KEY` authentication via the `x-api-key` header for customer list/create/read/suspend and dashboard endpoints. Comparison uses `timingSafeEqual`. Missing configuration fails closed with 503. Public signup still creates an expired account and ignores any client-supplied status. |
| Payment polling | `/api/pay` returns a `checkoutRequestId`; the portal now polls `/api/payment-status?checkoutRequestId=...`. The old phone-based lookup was removed so parallel attempts cannot report another checkout's state. |
| Payment callback recovery | A successful amount-matched callback first stores `paid_pending_activation`. Entitlement application uses a payment ID marker in the customer document, then marks the payment `paid`. The hourly scheduler retries pending activations. A duplicate callback or reconciliation pass will not extend a payment twice. |
| Network access seam | Added `services/network.js` with `activate(customer)` and `deactivate(customer)` stubs. Activation, expiry, and suspension call the relevant stub. The stubs only log the customer ID and requested action; they do not control a router, RADIUS server, or actual internet service. |
| Privacy | Network stub logs omit customer phone numbers. |
| Tests | Added `npm test` using Node's built-in test runner, `mongodb-memory-server`, Supertest, and Nock. |

## Baseline verification and regression results

### Initial HTTP run

**VERIFIED:** The app was served from an ephemeral local HTTP port with an isolated in-memory MongoDB. These are the actual pre-fix responses:

```text
GET /portal                                      -> 200 text/html
GET /api/dashboard                               -> 200 {"total":0,"active":0,"expired":0,"suspended":0}
GET /api/customers (no auth)                     -> 200 []
POST /api/customers status=active (no auth)       -> 201 {"status":"active", ...}
GET /api/customers/:id (no auth)                 -> 200
PATCH /api/customers/:id/suspend (no auth)        -> 200 {"status":"suspended", ...}
```

### Before and after tests

**VERIFIED:** The first regression run against the pre-fix code produced **20 tests, 12 passed, 8 failed**. The eight failures were the five unauthenticated admin routes, checkout-specific polling, and callback activation recovery. The registration, callback result handling, and scheduler checks passed at baseline.

| Issue | Before: failing test output | Fix | After: passing test output | Status |
| --- | --- | --- | --- | --- |
| Unauthenticated admin access | Five assertions got `200` (customer reads/dashboard/suspend) or `201` (customer create); active customer creation was possible. | Admin key middleware on all five management/dashboard routes; public registration always writes `expired`. | `✔` five anonymous route checks rejected; configured key accepted; missing key returned 503. | **VERIFIED** |
| Polling concurrent payment attempts | Checkout ID query expected 200 but got `400`; endpoint only accepted phone and selected the latest payment. | Poll by the returned checkout request ID; removed phone lookup. | `✔ payment polling identifies a specific checkout request`. | **VERIFIED** |
| Callback write failure | Injected customer write failure left payment `paid`; expected recoverable `paid_pending_activation`. | Persist intermediate state, per-payment idempotency marker, and hourly reconciliation. | `✔ callback activation failure remains recoverable and can be retried`. | **VERIFIED** |
| Callback result handling | Baseline tests passed. | Kept amount matching, failure handling, unknown callback acknowledgement, and duplicate protection while changing activation flow. | `✔` success/duplicate, amount mismatch, cancelled result, and unknown checkout tests. | **VERIFIED** |
| Registration validation | Baseline tests passed. | No behavior change required; continued checking phone, MAC, plan, and duplicate handling. | `✔` malformed phone/MAC/plan and duplicate phone/MAC checks. | **VERIFIED** |
| Expiry and reminder scheduler | Baseline tests passed. | Added network deactivation call on expiry; reminder remains guarded by `expiryReminderSentAt`. | `✔ scheduler expires customers and sends a reminder once in the one-day window`. | **VERIFIED** |
| Network activation/deactivation stubs | No stub existed at baseline. | Added calls on activation, expiry, and suspension. | `✔` activation, expiry, suspension, and phone-free log tests. | **VERIFIED** |

### Latest verification output

**VERIFIED:** The last complete test run returned:

```text
ℹ tests 24
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

**VERIFIED:** JavaScript syntax checks returned `SYNTAX_CHECKS=PASS` for `index.js`, customer/payment routes, reconciliation, network, and scheduler files.

## Remaining risks and untested work

### Not tested

- **NOT TESTED:** Real Safaricom sandbox STK Push. Tests use mocked HTTP; no Daraja credentials were used. The sandbox must only be exercised after confirming the configured credentials are sandbox credentials.
- **NOT TESTED:** Delivery to a publicly reachable HTTPS callback URL. A local mock callback does not prove Safaricom can reach the deployed callback.
- **NOT TESTED:** Real Africa's Talking SMS. Test configuration disables SMS and no SMS was sent.
- **NOT TESTED:** Router/RADIUS/network access. The new interface is a logging stub only; this app still does not enable or disable real internet access.
- **NOT TESTED:** Production deployment, real MongoDB topology, backup/restore, concurrency across multiple app instances, or browser-based visual behavior.
- **NOT TESTED:** `npm audit --omit=dev` details. Package installation reported 6 advisories (2 moderate, 4 high), but the audit endpoint could not be reached, so affected packages and production impact are unknown.

### Additional risks found by code reading

- **CODE-READ ONLY:** `MPESA_CALLBACK_URL` validation checks HTTPS and rejects localhost/example hosts, but it does not verify the URL path is `/api/mpesa/callback` or prove external reachability. A valid HTTPS URL with the wrong path can lose callbacks.
- **CODE-READ ONLY:** Reminder and expiry SMS failures are swallowed by `sendSms`. The reminder timestamp is set before sending, and expired status is saved before its SMS; a failed send is not automatically retried.
- **CODE-READ ONLY:** `activatedPaymentIds` grows by one ID per activated payment to preserve idempotency across retries. This should be monitored for unusually high-renewal accounts and revisited if customer documents approach MongoDB's document-size limit.
- **CODE-READ ONLY:** The admin API key is a shared secret. Use HTTPS, keep it out of source control, and rotate it through deployment configuration. There is no admin login UI or per-user audit trail.
- **CODE-READ ONLY:** The callback acknowledges Daraja before processing. The durable intermediate payment state and hourly retry now make activation recoverable, but retry can be delayed until the next scheduler run after a failure.
- **CODE-READ ONLY:** The nested prototype remains separate and unsuitable as the root system's production backend: it keeps active payment state in memory, writes an append-only payment log, and has no accounts or automated router activation. It was not changed.

## Commands

### Install

```powershell
npm.cmd install
```

The test dependencies are installed as development dependencies. If npm blocks the in-memory MongoDB package's setup script on a fresh machine, approve and rebuild that package with:

```powershell
npm.cmd approve-scripts mongodb-memory-server
npm.cmd rebuild mongodb-memory-server
```

### Configure

Keep `.env` local and out of Git. Set these **variable names** in the existing `.env` file:

```text
MONGODB_URI
ADMIN_API_KEY
MPESA_ENV
MPESA_SANDBOX_CONSUMER_KEY
MPESA_SANDBOX_CONSUMER_SECRET
MPESA_PRODUCTION_CONSUMER_KEY
MPESA_PRODUCTION_CONSUMER_SECRET
MPESA_SHORTCODE
MPESA_PASSKEY
MPESA_CALLBACK_URL
AT_API_KEY
AT_USERNAME
AT_SENDER_ID
PORT
PORTAL_URL
```

Only the credential pair for the selected `MPESA_ENV` is needed. SMS variables are optional. Never commit `.env`.

### Run tests and app

```powershell
npm.cmd test
npm.cmd start
```

Open `http://localhost:3000/portal`. Admin API calls must include `x-api-key` matching `ADMIN_API_KEY`; public signup, payment, callback, status polling, and portal routes remain public.

## Commit history

**VERIFIED:** These commits were created in order; the initial baseline excludes `.env`.

| Commit | Message |
| --- | --- |
| `d12b3bf` | `chore: baseline before ISP app hardening` |
| `bc3f49c` | `test: add failing ISP hardening regressions` |
| `4f1d51a` | `fix: protect customer management with admin key` |
| `1b232f9` | `fix: poll payment by checkout request ID` |
| `873bb13` | `fix: reconcile payment activation failures safely` |
| `738a6a8` | `feat: invoke network access stubs on entitlement changes` |
| `9b19376` | `fix: omit phone numbers from network stub logs` |
