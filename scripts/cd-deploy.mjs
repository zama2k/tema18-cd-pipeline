#!/usr/bin/env node
// Deploy an image to Render, verify it and roll back automatically if it fails.
//   node scripts/cd-deploy.mjs --environment staging --sha <sha> --image ghcr.io/o/r --digest sha256:...
//        [--smoke-mode full|readonly] [--no-auto-rollback] [--simulate-failure] [--mode deploy|rollback]
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, RENDER_API_KEY, RENDER_SERVICE_ID, APP_URL, SMOKE_HEADERS (optional).
// Writes outputs: result, deployment_id, rolled_back_to and appends a step summary.
import { parseArgs } from 'node:util';
import { runDeploy, summaryMarkdown } from './lib/cd-deploy.mjs';
import { GitHubApi } from './lib/github.mjs';
import { RenderClient } from './lib/render.mjs';
import { parseHeaders } from './lib/smoke.mjs';
import { DIGEST_RE } from './lib/registry.mjs';
import { appendSummary, errorAnnotation, fail, isMain, notice, requireEnv, setOutputs } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      environment: { type: 'string' },
      sha: { type: 'string' },
      image: { type: 'string' },
      digest: { type: 'string' },
      'smoke-mode': { type: 'string', default: 'full' },
      mode: { type: 'string', default: 'deploy' },
      'no-auto-rollback': { type: 'boolean', default: false },
      'simulate-failure': { type: 'boolean', default: false },
      'health-attempts': { type: 'string', default: '12' },
      'health-delay': { type: 'string', default: '5' },
      'render-timeout': { type: 'string', default: '600' },
      'render-interval': { type: 'string', default: '5' },
    },
  });
  if (!values.environment || !values.image || !/^[0-9a-f]{40}$/.test(values.sha || '') || !DIGEST_RE.test(values.digest || '')) {
    throw new Error('usage: cd-deploy.mjs --environment <env> --sha <40 hex> --image <host/owner/repo> --digest sha256:<64 hex>');
  }
  if (!['full', 'readonly'].includes(values['smoke-mode']) || !['deploy', 'rollback'].includes(values.mode)) {
    throw new Error('--smoke-mode must be full|readonly and --mode deploy|rollback');
  }
  requireEnv(env, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY']);

  if (!env.RENDER_API_KEY || !env.RENDER_SERVICE_ID || !env.APP_URL) {
    notice('RENDER_API_KEY, RENDER_SERVICE_ID or APP_URL is not configured for this environment: skipping the deploy');
    appendSummary(`### Deploy to ${values.environment} skipped\n\nThe Render secrets/variables are not configured yet (see docs/setup.md).`, env);
    setOutputs({ result: 'skipped', deployment_id: '', rolled_back_to: '' }, env);
    return { result: 'skipped' };
  }

  const api = new GitHubApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
  const render = new RenderClient({ apiKey: env.RENDER_API_KEY, serviceId: env.RENDER_SERVICE_ID, apiUrl: env.RENDER_API_URL });
  const simulate = values['simulate-failure'];
  const opts = {
    environment: values.environment,
    sha: values.sha,
    image: values.image.toLowerCase(),
    digest: values.digest,
    appUrl: env.APP_URL.replace(/\/$/, ''),
    autoRollback: !values['no-auto-rollback'],
    simulateFailure: simulate,
    smokeMode: values['smoke-mode'],
    mode: values.mode,
    headers: parseHeaders(env.SMOKE_HEADERS),
    // A simulated failure should fail fast instead of burning the whole retry budget.
    health: { attempts: simulate ? 2 : Number(values['health-attempts']), baseDelayMs: (simulate ? 1 : Number(values['health-delay'])) * 1000 },
    renderOptions: { timeoutMs: Number(values['render-timeout']) * 1000, intervalMs: Number(values['render-interval']) * 1000 },
    logUrl:
      env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
        ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : undefined,
    defaultBranch: env.GITHUB_DEFAULT_BRANCH || 'main',
  };

  const outcome = await runDeploy(opts, { api, render });
  appendSummary(summaryMarkdown(opts, outcome), env);
  setOutputs(
    {
      result: outcome.result,
      deployment_id: outcome.deploymentId,
      rolled_back_to: outcome.result === 'rolled_back' ? outcome.previous.sha : '',
    },
    env,
  );
  if (outcome.result !== 'success') {
    errorAnnotation(`${values.mode} to ${values.environment} ended as "${outcome.result}": ${outcome.failure}`);
    process.exitCode = 1;
  }
  return outcome;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
