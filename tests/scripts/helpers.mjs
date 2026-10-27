import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createApp } = require('../../src/app.js');

export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);
export const digestOf = (char) => `sha256:${char.repeat(64)}`;
export const IMAGE = 'ghcr.io/owner/repo';

export const noSleep = async () => {};
export const quiet = () => {};

// The real Express app behind a server whose "running commit" can be switched,
// which is how a Render redeploy looks from the outside.
export async function startAppServer(commit = 'unknown') {
  let handler = createApp({ env: { GIT_SHA: commit, APP_ENV: 'test' } });
  let broken = false;
  const server = createServer((req, res) => {
    if (broken) {
      res.writeHead(503).end('down');
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    serve(nextCommit) {
      handler = createApp({ env: { GIT_SHA: nextCommit, APP_ENV: 'test' } });
    },
    setBroken(value) {
      broken = value;
    },
    close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve))),
  };
}

// Temp file usable as GITHUB_OUTPUT / GITHUB_STEP_SUMMARY.
export function tempFile(name = 'file.txt') {
  const path = join(mkdtempSync(join(tmpdir(), 't18reto-')), name);
  writeFileSync(path, '');
  return { path, read: () => readFileSync(path, 'utf8') };
}

// Captures console.log while fn runs.
export async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.log = original;
  }
}
