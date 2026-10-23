'use strict';
// Usage: npm run router:check
// Checks the router connection using the settings in .env, without starting the app.
require('dotenv').config();
const { checkConnection } = require('../services/network');

checkConnection().then((result) => {
  console.log(`Driver:   ${result.driver}`);
  if (result.version) console.log(`RouterOS: ${result.version}${result.board ? ` (${result.board})` : ''}`);
  if (result.hotspots) console.log(`Hotspot:  ${result.hotspots.join(', ')}`);
  console.log(`${result.ok ? 'OK' : 'PROBLEM'}:      ${result.message}`);
  process.exitCode = result.ok ? 0 : 1;
});
