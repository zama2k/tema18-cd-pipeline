import { createDeployment, findLastGood, setStatus } from './deployments.mjs';
import { checkHealth } from './health.mjs';
import { deployImage } from './render.mjs';
import { runSmoke, smokeToMarkdown } from './smoke.mjs';
import { endGroup, group, shortSha } from './util.mjs';

// Log groups must be closed exactly once, also when a step throws half way.
function groups() {
  let isOpen = false;
  return {
    open(title) {
      this.close();
      group(title);
      isOpen = true;
    },
    close() {
      if (isOpen) endGroup();
      isOpen = false;
    },
  };
}

// A commit that can never be served: used by `simulate_failure` to exercise
// the failure and rollback path on demand.
export const IMPOSSIBLE_COMMIT = '0'.repeat(40);

/**
 * Deploys one image to one environment and verifies it:
 *   deploy (Render) -> health check (commit must match) -> smoke tests.
 * When any step fails and autoRollback is on, the last known good image of the
 * environment (from the GitHub Deployments API) is deployed again and verified.
 *
 * Returns { result, ... } where result is one of
 *   success | rolled_back | rollback_failed | failed
 */
export async function runDeploy(opts, deps) {
  const {
    environment,
    sha,
    image,
    digest,
    appUrl,
    autoRollback = true,
    simulateFailure = false,
    smokeMode = 'full',
    mode = 'deploy',
    headers = {},
    health = {},
    renderOptions = {},
    logUrl,
    defaultBranch,
  } = opts;
  const { api, render, fetchImpl = fetch, sleep, log = console.log } = deps;
  const ref = `${image}@${digest}`;
  const logGroup = groups();
  const healthOptions = { baseUrl: appUrl, headers, fetchImpl, sleep, log, ...health };

  logGroup.open('Look up the last good deployment');
  const previous = autoRollback ? await findLastGood(api, environment) : null;
  log(previous ? `previous good: ${previous.sha} (${previous.image}@${previous.digest})` : 'no previous good deployment');
  logGroup.close();

  const deploymentId = await createDeployment(api, {
    environment,
    sha,
    image,
    digest,
    mode,
    defaultBranch,
    description: `${mode === 'rollback' ? 'Rollback to' : 'Deploy'} ${shortSha(sha)}`,
  });
  await setStatus(api, deploymentId, { state: 'in_progress', description: `Deploying ${shortSha(sha)}`, logUrl });

  const smokeReports = [];
  let failure;
  try {
    logGroup.open(`Deploy ${ref} to ${environment}`);
    await deployImage(render, ref, { expectedDigest: digest, ...renderOptions });

    logGroup.open('Health check');
    const expectedCommit = simulateFailure ? IMPOSSIBLE_COMMIT : sha;
    if (simulateFailure) log('simulate_failure is on: the health check expects a commit that cannot exist');
    const healthResult = await checkHealth({ ...healthOptions, expectedCommit });
    if (!healthResult.ok) throw new Error(`health check failed: ${healthResult.error}`);

    logGroup.open('Smoke tests');
    const smoke = await runSmoke({ baseUrl: appUrl, mode: smokeMode, headers, fetchImpl });
    for (const r of smoke.results) log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
    logGroup.close();
    smokeReports.push(smokeToMarkdown(smoke));
    if (!smoke.ok) throw new Error(`${smoke.results.filter((r) => !r.ok).length} smoke check(s) failed`);

    await setStatus(api, deploymentId, {
      state: 'success',
      description: `${shortSha(sha)} is live and verified`,
      environmentUrl: appUrl,
      logUrl,
    });
    return { result: 'success', deploymentId, previous, smokeReports };
  } catch (err) {
    logGroup.close();
    failure = err.message;
    log(`deployment of ${shortSha(sha)} failed: ${failure}`);
  }

  if (!autoRollback) {
    await setStatus(api, deploymentId, { state: 'failure', description: `Failed: ${failure}`, logUrl });
    return { result: 'failed', deploymentId, previous, failure, smokeReports };
  }
  if (!previous) {
    await setStatus(api, deploymentId, {
      state: 'failure',
      description: 'Failed; no previous good deployment to roll back to',
      logUrl,
    });
    return { result: 'failed', deploymentId, previous, failure, smokeReports, note: 'no previous deployment to roll back to' };
  }

  const previousRef = `${previous.image}@${previous.digest}`;
  try {
    logGroup.open(`Automatic rollback to ${shortSha(previous.sha)}`);
    await deployImage(render, previousRef, { expectedDigest: previous.digest, ...renderOptions });
    const restored = await checkHealth({ ...healthOptions, expectedCommit: previous.sha });
    logGroup.close();
    if (!restored.ok) throw new Error(`health check after rollback failed: ${restored.error}`);
    await setStatus(api, deploymentId, {
      state: 'failure',
      description: `Failed; rolled back to ${shortSha(previous.sha)}`,
      logUrl,
    });
    return { result: 'rolled_back', deploymentId, previous, failure, smokeReports };
  } catch (err) {
    logGroup.close();
    await setStatus(api, deploymentId, {
      state: 'failure',
      description: `Failed and the rollback failed too: ${err.message}`,
      logUrl,
    });
    return { result: 'rollback_failed', deploymentId, previous, failure, rollbackFailure: err.message, smokeReports };
  }
}

export function summaryMarkdown({ environment, sha, image, digest, appUrl, mode }, outcome) {
  const headline = {
    success: 'succeeded',
    rolled_back: 'FAILED and was rolled back automatically',
    rollback_failed: 'FAILED and the automatic rollback FAILED too: manual intervention needed',
    failed: 'FAILED',
  }[outcome.result];
  const lines = [
    `### ${mode === 'rollback' ? 'Rollback' : 'Deploy'} to ${environment} ${headline}`,
    '',
    '| | |',
    '| --- | --- |',
    `| Environment | ${environment} |`,
    `| Commit | \`${sha}\` |`,
    `| Image | \`${image}@${digest}\` |`,
    `| URL | ${appUrl} |`,
  ];
  if (outcome.previous) {
    lines.push(`| Last good before this run | \`${shortSha(outcome.previous.sha)}\` |`);
  }
  if (outcome.failure) lines.push(`| Failure | ${outcome.failure.replace(/\|/g, '/')} |`);
  if (outcome.rollbackFailure) lines.push(`| Rollback failure | ${outcome.rollbackFailure.replace(/\|/g, '/')} |`);
  if (outcome.note) lines.push(`| Note | ${outcome.note} |`);
  return [lines.join('\n'), ...outcome.smokeReports].join('\n\n');
}
