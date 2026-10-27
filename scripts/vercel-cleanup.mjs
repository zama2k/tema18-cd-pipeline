#!/usr/bin/env node
// Remove the Vercel preview deployments created for a pull request.
//   node scripts/vercel-cleanup.mjs --pr 42
// Env: VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID (team id), VERCEL_API_URL (tests).
import { parseArgs } from 'node:util';
import { VercelClient, removePreviews } from './lib/vercel.mjs';
import { fail, isMain, notice, setOutputs } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args: argv, options: { pr: { type: 'string' } } });
  if (!/^\d+$/.test(values.pr || '')) throw new Error('usage: vercel-cleanup.mjs --pr <number>');
  if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) {
    notice('VERCEL_TOKEN or VERCEL_PROJECT_ID is not configured: skipping the Vercel cleanup');
    setOutputs({ skipped: true, removed: 0 }, env);
    return null;
  }
  const client = new VercelClient({
    token: env.VERCEL_TOKEN,
    projectId: env.VERCEL_PROJECT_ID,
    teamId: env.VERCEL_ORG_ID,
    apiUrl: env.VERCEL_API_URL,
  });
  const removed = await removePreviews(client, values.pr);
  console.log(`removed ${removed} preview deployment(s) for PR #${values.pr}`);
  setOutputs({ skipped: false, removed }, env);
  return removed;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
