'use strict';

// Server-side bundle price list. The page shows the same deals, but the SERVER decides
// what a deal costs: a customer can't edit the page and pay KSh 1 for a KSh 110 bundle.
// Every price is unique on purpose: the client's Bingwa auto app identifies the deal by amount.
// TBD: move to the database with an admin screen so the client can change prices.
const BUNDLES = Object.freeze({
  data: [
    { size: '1GB', valid: '1 hour', price: 19, limit: 'daily' },
    { size: '250MB', valid: '24 hours', price: 20, limit: 'daily' },
    { size: '1GB', valid: '1 hour', price: 23, limit: 'multi' },
    { size: '1GB', valid: '1 hour', price: 25, limit: 'multi' },
    { size: '250MB', valid: 'Buy many times', price: 26, limit: 'multi' },
    { size: '400MB', valid: '7 days', price: 49, limit: 'daily' },
    { size: '1.5GB', valid: '3 hours', price: 50, limit: 'daily' },
    { size: '750MB', valid: '24 hours', price: 52, limit: 'daily' },
    { size: '750MB', valid: '24 hours', price: 53, limit: 'multi' },
    { size: '750MB + 50 SMS', valid: '24 hours', price: 54, limit: 'daily' },
    { size: '1GB', valid: 'Till midnight', price: 55, limit: 'daily' },
    { size: '1.5GB', valid: '24 hours', price: 99, limit: 'daily' },
    { size: '1GB', valid: '24 hours', price: 100, limit: 'daily' },
    { size: '2GB', valid: '24 hours', price: 105, limit: 'multi' },
    { size: '1.5GB', valid: '24 hours', price: 106, limit: 'multi' },
    { size: '2GB', valid: '24 hours', price: 110, limit: 'multi' }
  ],
  minutes: [
    { size: '45 minutes', valid: '3 hours', price: 21, limit: 'multi' },
    { size: '45 minutes', valid: '3 hours', price: 22, limit: 'multi' },
    { size: '60 minutes', valid: 'Till midnight', price: 51, limit: 'multi' },
    { size: '50 minutes', valid: 'Till midnight', price: 56, limit: 'multi' },
    { size: '100 minutes', valid: 'Till midnight', price: 101, limit: 'multi' },
    { size: '250 minutes', valid: '7 days', price: 199, limit: 'multi' },
    { size: '313 minutes', valid: '7 days', price: 220, limit: 'multi' }
  ],
  sms: [
    { size: '20 SMS', valid: '1 day', price: 5, limit: 'multi' },
    { size: '200 SMS', valid: '1 day', price: 10, limit: 'multi' },
    { size: '1,000 SMS', valid: '7 days', price: 30, limit: 'multi' },
    { size: '1,500 SMS', valid: '30 days', price: 103, limit: 'multi' }
  ]
});

/** Returns the deal for this category and price, or null if no such deal exists. */
function findBundle(category, price) {
  const list = BUNDLES[category];
  const amount = Number(price);
  if (!Array.isArray(list) || !Number.isInteger(amount)) return null;
  const bundle = list.find((b) => b.price === amount);
  return bundle ? { category, ...bundle } : null;
}

module.exports = { BUNDLES, findBundle };
