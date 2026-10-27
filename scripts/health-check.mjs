#!/usr/bin/env node
// Health check with retries/backoff.
//   node scripts/health-check.mjs --url https://app.example.com --expected-commit <sha> [--attempts 12] [--delay 5]
// Extra request headers can be passed with SMOKE_HEADERS (one "Name: value" per line).
import { parseArgs } from 'node:util';
import { checkHealth } from './lib/health.mjs';
import { parseHeaders } from './lib/smoke.mjs';
import { fail, isMain } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      'expected-commit': { type: 'string' },
      attempts: { type: 'string', default: '12' },
      delay: { type: 'string', default: '5' },
      'max-delay': { type: 'string', default: '30' },
    },
  });
  if (!values.url) throw new Error('usage: health-check.mjs --url <base url> [--expected-commit <sha>]');
  const result = await checkHealth({
    baseUrl: values.url,
    expectedCommit: values['expected-commit'],
    attempts: Number(values.attempts),
    baseDelayMs: Number(values.delay) * 1000,
    maxDelayMs: Number(values['max-delay']) * 1000,
    headers: parseHeaders(env.SMOKE_HEADERS),
  });
  if (!result.ok) throw new Error(`Health check failed after ${result.attempts} attempts: ${result.error}`);
  return result;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
