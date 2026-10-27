#!/usr/bin/env node
// Create or update the sticky preview comment on a pull request.
//   node scripts/pr-comment.mjs preview --pr 42 --url https://x.vercel.app --sha <sha> --branch feature/x
//   node scripts/pr-comment.mjs removed --pr 42
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID.
import { parseArgs } from 'node:util';
import { GitHubApi } from './lib/github.mjs';
import { previewBody, removedBody, upsertComment } from './lib/pr-comment.mjs';
import { fail, isMain, requireEnv } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pr: { type: 'string' },
      url: { type: 'string' },
      sha: { type: 'string' },
      branch: { type: 'string' },
    },
  });
  const [mode] = positionals;
  if (!['preview', 'removed'].includes(mode) || !/^\d+$/.test(values.pr || '')) {
    throw new Error('usage: pr-comment.mjs <preview|removed> --pr <number> [--url --sha --branch]');
  }
  requireEnv(env, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']);
  const api = new GitHubApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;

  let result;
  if (mode === 'preview') {
    if (!values.url || !values.sha || !values.branch) throw new Error('preview mode needs --url, --sha and --branch');
    result = await upsertComment(api, {
      pr: values.pr,
      body: previewBody({ url: values.url, sha: values.sha, branch: values.branch, runUrl }),
    });
  } else {
    result = await upsertComment(api, { pr: values.pr, body: removedBody({ runUrl }), createIfMissing: false });
  }
  console.log(`PR #${values.pr} comment: ${result.action}`);
  return result;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
