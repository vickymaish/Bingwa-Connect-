# Router setup: MikroTik Hotspot (RouterOS v7.1+)

## How it works

1. A customer joins the WiFi. The MikroTik Hotspot catches them and shows `router/login.html`.
2. That page forwards them to your portal with their device address: `https://PORTAL/?mac=AA:BB:..`.
3. They enter their phone number, pick a plan and pay with M-Pesa. The portal sends `mac` along with the payment.
4. When Safaricom confirms, the device is saved on the customer and the router gets a **bypassed IP binding** for it: full internet, no login page.
5. When the plan expires, or an admin suspends the customer, the binding is removed and the session is kicked. They land back on the portal.
6. If the customer later pays from a new phone or laptop, the new device is switched on and the old one is cut off.

If the router is unreachable, nothing is lost. The customer shows `networkState: "pending"` with the reason in `networkError`, and the system retries every 2 minutes.

## 1. Settings: add to `.env`

```
NETWORK_DRIVER=mikrotik
MIKROTIK_URL=https://192.168.88.1
MIKROTIK_USER=billing
MIKROTIK_PASSWORD=the-password-from-setup.rsc
MIKROTIK_CA_FILE=C:\dev\internet\router\billing-api.crt
PORTAL_URL=https://your-portal-host
```

Add the same keys to `.env.example` with blank values. To run without a router, set `NETWORK_DRIVER=stub`; everything else keeps working.

Add this to the `"scripts"` section of `package.json`:

```
"router:check": "node scripts/router-check.js"
```

## 2. On the router (once)

1. **Hotspot:** in WinBox open New Terminal, run `/ip hotspot setup`, and choose the interface or bridge customers connect to.
2. **Billing access:** fill in the placeholders at the top of `router/setup.rsc`, then paste it into the terminal.
3. **Certificate:** in WinBox > Files, download `billing-api.crt` to the server and point `MIKROTIK_CA_FILE` at it.
4. **Login page:** in `router/login.html`, replace `YOUR_PORTAL_HOST` (it appears twice). Upload it to the router's `hotspot` folder, replacing the existing `login.html`.
5. On the server, run `npm run router:check`. It should print `OK: Router connected.` along with the Hotspot name.

The app also prints the router status every time it starts.

## 3. Portal change: send the MAC with the payment

`public/portal.html` must pass along the `mac` from its address bar. In the code that calls `/api/pay`:

```js
const mac = new URLSearchParams(location.search).get('mac') || undefined;
fetch('/api/pay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ phone, plan, mac })
});
```

## 4. End-to-end test

1. On a test phone, open the WiFi network's settings and set **Privacy / MAC address** to **Use device MAC**. This applies to that network only.
2. Join the WiFi. The portal should open with `?mac=` in the address. Pay with a sandbox or test number.
3. On the router, `/ip hotspot ip-binding print` should show `bypassed` with the comment `isp-billing:...`. The phone has internet.
4. In the database, set the customer's `expiresAt` to a past time. Within 5 minutes the binding is gone and the phone is back on the portal.

## Known limitation

Hotspot access is tied to a device's MAC address, and a determined user on the same WiFi can copy a paying customer's MAC. Every MAC-based hotspot shares this weakness. If it becomes a problem, the next step is PPPoE, where each customer gets their own username and password. Only `services/network.js` would need to change.
