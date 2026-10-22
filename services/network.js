'use strict';

// Integration seam for a future router, RADIUS service, or access controller.
// These stubs only record intent; they do not change real network access.
async function activate(customer) {
  console.info('Network activation requested (stub):', { customerId: String(customer._id) });
}

async function deactivate(customer) {
  console.info('Network deactivation requested (stub):', { customerId: String(customer._id) });
}

module.exports = { activate, deactivate };
