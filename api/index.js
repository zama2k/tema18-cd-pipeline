'use strict';

// Vercel entry point (preview deployments only). Vercel invokes the exported
// Express app as a request handler; src/server.js is not used there.
const { createApp } = require('../src/app');

module.exports = createApp();
