'use strict';

const { createApp } = require('./app');

const SHUTDOWN_TIMEOUT_MS = 10_000;

const DEFAULT_PORT = 3000;

function resolvePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
}

function start({ port = resolvePort(process.env.PORT), host = '0.0.0.0' } = {}) {
  const server = createApp().listen(port, host);
  server.once('listening', () => {
    console.log(`listening on ${host}:${server.address().port}`);
  });
  return server;
}

// SIGTERM is what Render and Docker send before killing the container: stop
// accepting connections, let in-flight requests finish, then exit.
function shutdown(server, signal, exit = process.exit) {
  console.log(`${signal} received, shutting down`);
  const timer = setTimeout(() => exit(1), SHUTDOWN_TIMEOUT_MS);
  timer.unref();
  server.close((err) => exit(err ? 1 : 0));
  server.closeIdleConnections();
}

function run(proc, options) {
  const server = start(options);
  for (const signal of ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => shutdown(server, signal, proc.exit));
  }
  return server;
}

if (require.main === module) run(process);

module.exports = { start, shutdown, run, resolvePort };
