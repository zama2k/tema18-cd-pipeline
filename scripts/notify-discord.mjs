#!/usr/bin/env node
// Post a deployment embed to Discord.
//   node scripts/notify-discord.mjs --status success|failure|rolled_back|rollback|skipped --environment staging --sha <sha>
//        [--version v1.2.3] [--url https://...] [--detail "text"]
// Env: DISCORD_WEBHOOK_URL (skipped with a notice when missing), GITHUB_REPOSITORY, GITHUB_SERVER_URL,
// GITHUB_RUN_ID, GITHUB_ACTOR. A failed notification never fails the pipeline.
import { parseArgs } from 'node:util';
import { buildPayload, sendWebhook } from './lib/discord.mjs';
import { isMain, notice, warning } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      status: { type: 'string' },
      environment: { type: 'string' },
      sha: { type: 'string' },
      version: { type: 'string' },
      url: { type: 'string' },
      detail: { type: 'string' },
    },
  });
  if (!values.status) throw new Error('usage: notify-discord.mjs --status <status> --environment <env> --sha <sha>');
  if (!env.DISCORD_WEBHOOK_URL) {
    notice('DISCORD_WEBHOOK_URL is not configured: skipping the Discord notification');
    return false;
  }
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const payload = buildPayload({
    ...values,
    runUrl,
    actor: env.GITHUB_ACTOR,
    repo: env.GITHUB_REPOSITORY,
  });
  try {
    await sendWebhook(env.DISCORD_WEBHOOK_URL, payload);
    console.log('Discord notification sent');
    return true;
  } catch (err) {
    warning(`Discord notification failed: ${err.message}`);
    return false;
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    warning(`Discord notification failed: ${err.message}`);
  });
}
