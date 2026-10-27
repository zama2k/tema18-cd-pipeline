#!/usr/bin/env node
// Smoke tests against a deployed URL.
//   node scripts/smoke.mjs --url https://app.example.com [--mode full|readonly] [--summary]
// Extra request headers (e.g. Vercel bypass) via SMOKE_HEADERS, one "Name: value" per line.
import { parseArgs } from 'node:util';
import { parseHeaders, runSmoke, smokeToMarkdown } from './lib/smoke.mjs';
import { appendSummary, fail, isMain } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      mode: { type: 'string', default: 'full' },
      summary: { type: 'boolean', default: false },
    },
  });
  if (!values.url || !['full', 'readonly'].includes(values.mode)) {
    throw new Error('usage: smoke.mjs --url <base url> [--mode full|readonly] [--summary]');
  }
  const outcome = await runSmoke({ baseUrl: values.url, mode: values.mode, headers: parseHeaders(env.SMOKE_HEADERS) });
  for (const r of outcome.results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
  if (values.summary) appendSummary(smokeToMarkdown(outcome), env);
  if (!outcome.ok) throw new Error(`${outcome.results.filter((r) => !r.ok).length} smoke check(s) failed`);
  return outcome;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
