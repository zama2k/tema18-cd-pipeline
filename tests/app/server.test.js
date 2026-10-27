'use strict';

const { start, shutdown, run, resolvePort } = require('../../src/server');

describe('server', () => {
  it('resolvePort uses PORT when valid and 3000 otherwise', () => {
    expect(resolvePort('10000')).toBe(10000);
    expect(resolvePort(undefined)).toBe(3000);
    expect(resolvePort('abc')).toBe(3000);
    expect(resolvePort('0')).toBe(3000);
  });

  it('start() without arguments reads PORT from the environment', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const probe = start({ port: 49321, host: '127.0.0.1' });
    await new Promise((resolve) => probe.once('listening', resolve));
    await new Promise((resolve) => probe.close(resolve));
    process.env.PORT = '49321';
    const server = start();
    await new Promise((resolve) => server.once('listening', resolve));
    expect(server.address().port).toBe(49321);
    await new Promise((resolve) => server.close(resolve));
    delete process.env.PORT;
    log.mockRestore();
  });

  it('listens on the requested port and serves /health', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const server = start({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    await new Promise((resolve) => server.close(resolve));
    log.mockRestore();
  });

  it('shutdown closes the server and exits with 0', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const server = start({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const code = await new Promise((resolve) => shutdown(server, 'SIGTERM', resolve));
    expect(code).toBe(0);
    log.mockRestore();
  });

  it('run wires SIGTERM and SIGINT to a graceful shutdown', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const handlers = {};
    const exited = new Promise((resolve) => {
      const proc = { on: (sig, fn) => (handlers[sig] = fn), exit: resolve };
      const server = run(proc, { port: 0, host: '127.0.0.1' });
      server.once('listening', () => handlers.SIGTERM());
    });
    expect(await exited).toBe(0);
    expect(Object.keys(handlers).sort()).toEqual(['SIGINT', 'SIGTERM']);
    log.mockRestore();
  });

  it('shutdown exits with 1 when closing fails', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const fake = {
      close: (cb) => cb(new Error('not running')),
      closeIdleConnections: () => {},
    };
    const code = await new Promise((resolve) => shutdown(fake, 'SIGINT', resolve));
    expect(code).toBe(1);
    log.mockRestore();
  });
});
