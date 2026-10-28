'use strict';

// Server-side bundle price list. The page shows the same deals, but the SERVER decides
// what a deal costs: a customer can't edit the page and pay KSh 1 for a KSh 110 bundle.
// Every price is unique on purpose: the client's AutoBundles system identifies the deal by amount.
// Must match the store at https://bingwa.co.ke/buy/emmanuel and public/index.html.
// TBD: move to the database with an admin screen so the client can change prices.
const BUNDLES = Object.freeze({
  data: [
    { size: '1GB', valid: '1 hour', price: 19 },
    { size: '250MB', valid: '24 hours', price: 20 },
    { size: '1GB Tunukiwa', valid: '1 hour', price: 23 },
    { size: '250MB Patamore', valid: '24 hours', price: 25 },
    { size: '1GB Blaze', valid: '1 hour', price: 27 },
    { size: '400MB', valid: '1 hour', price: 29 },
    { size: '400MB', valid: '7 days', price: 49 },
    { size: '1.5GB', valid: '3 hours', price: 50 },
    { size: '750MB Patamore', valid: '24 hours', price: 52 },
    { size: '750MB', valid: '24 hours', price: 54 },
    { size: '1GB', valid: 'Till midnight', price: 55 },
    { size: '900MB', valid: 'Till midnight', price: 58 },
    { size: '1.5GB', valid: '24 hours', price: 99 },
    { size: '1.5GB', valid: '24 hours', price: 100 },
    { size: '1.5GB Patamore', valid: '24 hours', price: 106 }
  ],
  minutes: [
    { size: '45 minutes', valid: '3 hours', price: 21 },
    { size: '45 minutes', valid: '3 hours', price: 22 },
    { size: '60 minutes', valid: 'Till midnight', price: 51 },
    { size: '50 minutes', valid: 'Till midnight', price: 56 },
    { size: '100 minutes', valid: '2 days', price: 101 },
    { size: '1,000 minutes', valid: '30 days', price: 1010 }
  ],
  sms: [
    { size: '20 SMS', valid: '1 day', price: 5 },
    { size: '200 SMS', valid: '1 day', price: 10 },
    { size: '1,000 SMS', valid: '7 days', price: 30 }
  ]
});

/** Returns the deal for this category and price, or null if no such deal exists. */
function findBundle(category, price) {
  const list = BUNDLES[category];
  const amount = Number(price);
  if (!Array.isArray(list) || !Number.isInteger(amount)) return null;
  const bundle = list.find((b) => b.price === amount);
  return bundle ? { category, limit: 'multi', ...bundle } : null;
}

module.exports = { BUNDLES, findBundle };
