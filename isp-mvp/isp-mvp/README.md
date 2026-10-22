# ISP MVP: landing page, plans, M-Pesa payments

A small website for an internet provider: plans, "Pay with M-Pesa" (Daraja STK push), contact options.
Needs only **Node 18+**. There is nothing to install.

## Run it (2 minutes)

```
node server.js
```
Open http://localhost:3000

With no `.env` it starts in **demo mode**: the whole flow works but payments are simulated
(a fake approval after 5 seconds). Use this to show the client.

## Change the business name, contacts and plans

Edit `public/site.json` (brand name, phone, WhatsApp number in 254 format, plans and prices).
Refresh the page. No code changes needed. The prices the server charges come from this same file,
so the browser cannot change the amount.

## Turn on real M-Pesa (Daraja sandbox)

1. Copy `.env.example` to `.env`.
2. Fill `DARAJA_KEY`, `DARAJA_SECRET`, `DARAJA_PASSKEY` from the **same** app on the Daraja portal
   (short code 174379 for the sandbox; the sandbox passkey is in the Daraja docs under M-Pesa Express).
3. Daraja cannot call `localhost`. Start a tunnel in a second terminal and copy its HTTPS address:
   ```
   ngrok http 3000
   ```
   Put that address in `.env` as `PUBLIC_URL=https://xxxx.ngrok-free.app`
4. Set `CALLBACK_SECRET` to a long random string.
5. Restart `node server.js`. The terminal prints the callback URL it registered.
6. Test with the sandbox phone number **254708374149** (the simulator number from the Daraja portal).

Successful and failed payments are appended to `payments.log` (one JSON line each).

## Going live later

- Create a Go Live request on Daraja and switch to your real paybill or till (`DARAJA_ENV=production`,
  and `DARAJA_TXN_TYPE=CustomerBuyGoodsOnline` for tills).
- Host this on a server with HTTPS and set `PUBLIC_URL` to your real domain.

## What this MVP does not do yet (be upfront with the client)

- No database: payments live in memory and in `payments.log`. A restart loses the in-memory list.
- No customer accounts, login, or admin dashboard.
- No automatic activation on the router or billing system (someone must act on the payment).
- No STK status query fallback: if the callback URL is unreachable, the page will time out even
  if the customer paid. Check `payments.log` and the M-Pesa statement.
- Replace the placeholder brand, plans and prices before showing it as final.

## Files

- `server.js`: web server and Daraja integration
- `public/index.html`: the website
- `public/site.json`: brand, contacts and plans
- `.env.example`: settings template
