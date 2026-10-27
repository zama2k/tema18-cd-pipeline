#!/usr/bin/env node
// Resolve deployments recorded in the GitHub Deployments API.
//   last-good --environment staging
//   by-sha    --environment staging --sha <full sha>
// Writes found/sha/image/digest/deployment_id to $GITHUB_OUTPUT.
import { parseArgs } from 'node:util';
import { GitHubApi } from './lib/github.mjs';
import { findGoodBySha, findLastGood } from './lib/deployments.mjs';
import { fail, isMain, notice, requireEnv, setOutputs } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      environment: { type: 'string' },
      sha: { type: 'string' },
      require: { type: 'boolean', default: false },
    },
  });
  const [command] = positionals;
  if (!values.environment || !['last-good', 'by-sha'].includes(command)) {
    throw new Error('usage: deployments.mjs <last-good|by-sha> --environment <name> [--sha <sha>] [--require]');
  }
  if (command === 'by-sha' && !/^[0-9a-f]{40}$/.test(values.sha || '')) {
    throw new Error('--sha must be a full 40-character commit sha');
  }
  requireEnv(env, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']);
  const api = new GitHubApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });

  const record =
    command === 'last-good'
      ? await findLastGood(api, values.environment)
      : await findGoodBySha(api, values.environment, values.sha);

  if (!record) {
    const what = command === 'last-good' ? 'a successful deployment' : `a successful deployment of ${values.sha}`;
    if (values.require) throw new Error(`No record of ${what} in environment "${values.environment}"`);
    notice(`No record of ${what} in environment "${values.environment}"`);
    setOutputs({ found: false, sha: '', image: '', digest: '', deployment_id: '' }, env);
    return null;
  }
  console.log(`${values.environment}: ${record.sha} -> ${record.image}@${record.digest} (deployment ${record.id})`);
  setOutputs({ found: true, sha: record.sha, image: record.image, digest: record.digest, deployment_id: record.id }, env);
  return record;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
