'use strict';

// One shared MongoDB connection. On Vercel each warm function instance reuses it
// instead of opening a new connection per request (which would exhaust Atlas's limit).
const mongoose = require('mongoose');

const cache = global.__mongoCache || (global.__mongoCache = { promise: null });

function connectDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose.connection);
  if (!cache.promise) {
    if (!process.env.MONGODB_URI) {
      return Promise.reject(new Error('MONGODB_URI is not set. Add it to .env locally or to the Vercel project settings.'));
    }
    cache.promise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 5
    }).catch((error) => { cache.promise = null; throw error; }); // allow a retry on the next request
  }
  return cache.promise;
}

// Make the database's indexes match the models. Removes leftovers from older versions,
// e.g. a non-sparse unique macAddress index that lets only ONE customer exist without a MAC.
async function syncDatabaseIndexes() {
  const report = {};
  for (const model of [require('../models/Customer'), require('../models/Payment')]) {
    try {
      const dropped = await model.syncIndexes();
      report[model.modelName] = dropped.length ? `replaced ${dropped.join(', ')}` : 'ok';
      if (dropped.length) console.log(`Database: replaced outdated ${model.modelName} indexes: ${dropped.join(', ')}`);
    } catch (error) {
      report[model.modelName] = `failed: ${error.message}`;
      console.error(`Database: could not update ${model.modelName} indexes:`, { message: error.message, code: error.code });
    }
  }
  return report;
}

module.exports = { connectDb, syncDatabaseIndexes };
