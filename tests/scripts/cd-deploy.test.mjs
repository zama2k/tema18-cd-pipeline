import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { main } from '../../scripts/cd-deploy.mjs';
import { FakeGitHub, FakeRender } from '../../scripts/dev/fakes.mjs';
import { IMPOSSIBLE_COMMIT, runDeploy, summaryMarkdown } from '../../scripts/lib/cd-deploy.mjs';
import { GitHubApi } from '../../scripts/lib/github.mjs';
import { RenderClient } from '../../scripts/lib/render.mjs';
import { IMAGE, SHA_A, SHA_B, SHA_C, digestOf, noSleep, quiet, startAppServer, tempFile } from './helpers.mjs';

// Digests double as identities of the "images" in these scenarios.
const DIGEST = { [SHA_A]: digestOf('a'), [SHA_B]: digestOf('b'), [SHA_C]: digestOf('c') };
const SHA_BY_DIGEST = Object.fromEntries(Object.entries(DIGEST).map(([sha, digest]) => [digest, sha]));

let gh;
let render;
let app;
let api;
let client;

beforeEach(async () => {
  app = await startAppServer('unknown');
  gh = new FakeGitHub();
  await gh.listen();
  // "Going live" switches the commit the app serves, like a real redeploy.
  render = new FakeRender({ onLive: (ref) => app.serve(SHA_BY_DIGEST[ref.split('@')[1]]) });
  await render.listen();
  api = new GitHubApi({ token: 'ghs_token', repo: 'owner/repo', apiUrl: gh.url });
  client = new RenderClient({ apiKey: 'rnd_key', serviceId: 'srv-1', apiUrl: `${render.url}/v1`, sleep: noSleep, log: quiet });
});
afterEach(async () => {
  await Promise.all([app.close(), gh.close(), render.close()]);
});

const options = (sha, extra = {}) => ({
  environment: 'staging',
  sha,
  image: IMAGE,
  digest: DIGEST[sha],
  appUrl: app.url,
  health: { attempts: 2, baseDelayMs: 0 },
  renderOptions: { intervalMs: 0 },
  ...extra,
});
const deps = () => ({ api, render: client, sleep: noSleep, log: quiet });
const seedGood = (sha) => gh.seedDeployment({ environment: 'staging', sha, digest: DIGEST[sha] });

test('first deployment: deploys, verifies commit and smoke tests, records success', async () => {
  const outcome = await runDeploy(options(SHA_A), deps());
  assert.equal(outcome.result, 'success');
  assert.equal(gh.latestState(outcome.deploymentId), 'success');
  assert.equal(outcome.previous, null);
  assert.equal(render.requests.find((r) => r.method === 'POST').body.imageUrl, `${IMAGE}@${DIGEST[SHA_A]}`);
});

test('a later deployment replaces the previous one and becomes the new last good', async () => {
  seedGood(SHA_A);
  const outcome = await runDeploy(options(SHA_B), deps());
  assert.equal(outcome.result, 'success');
  assert.equal(outcome.previous.sha, SHA_A);
});

test('health check failure rolls back to the previous good digest and verifies it', async () => {
  seedGood(SHA_A);
  app.serve(SHA_A);
  render.onLive = (ref) => app.serve(ref.includes(DIGEST[SHA_B]) ? 'wrong-commit' : SHA_A);
  const outcome = await runDeploy(options(SHA_B), deps());
  assert.equal(outcome.result, 'rolled_back');
  assert.match(outcome.failure, /commit mismatch/);
  assert.equal(gh.latestState(outcome.deploymentId), 'failure');
  assert.match(gh.statuses.get(outcome.deploymentId)[0].description, /rolled back to aaaaaaa/);
  const deployed = render.requests.filter((r) => r.method === 'POST').map((r) => r.body.imageUrl);
  assert.deepEqual(deployed, [`${IMAGE}@${DIGEST[SHA_B]}`, `${IMAGE}@${DIGEST[SHA_A]}`]);
  assert.equal((await (await fetch(`${app.url}/health`)).json()).commit, SHA_A);
});

test('smoke test failure also triggers the rollback', async () => {
  seedGood(SHA_A);
  // The new version serves the right commit but breaks the items endpoint.
  const original = app.serve;
  render.onLive = (ref) => {
    original(ref.includes(DIGEST[SHA_B]) ? SHA_B : SHA_A);
    app.breakItems = ref.includes(DIGEST[SHA_B]);
  };
  const breaking = { ...deps(), fetchImpl: async (url, init) => (new URL(url).pathname === '/api/items' && app.breakItems ? new Response('{}', { status: 500 }) : fetch(url, init)) };
  const outcome = await runDeploy(options(SHA_B), breaking);
  assert.equal(outcome.result, 'rolled_back');
  assert.match(outcome.failure, /smoke check/);
});

test('a Render deploy failure rolls back too', async () => {
  seedGood(SHA_A);
  render.failRefs.add(`${IMAGE}@${DIGEST[SHA_B]}`);
  const outcome = await runDeploy(options(SHA_B), deps());
  assert.equal(outcome.result, 'rolled_back');
  assert.match(outcome.failure, /update_failed/);
});

test('simulate_failure forces the failure path and the automatic rollback', async () => {
  seedGood(SHA_A);
  const outcome = await runDeploy(options(SHA_B, { simulateFailure: true }), deps());
  assert.equal(outcome.result, 'rolled_back');
  assert.ok(outcome.failure.includes(IMPOSSIBLE_COMMIT));
  assert.equal((await (await fetch(`${app.url}/health`)).json()).commit, SHA_A);
});

test('without a previous good deployment a failure is reported and nothing is rolled back', async () => {
  const outcome = await runDeploy(options(SHA_B, { simulateFailure: true }), deps());
  assert.equal(outcome.result, 'failed');
  assert.match(outcome.note, /no previous deployment/);
  assert.equal(render.requests.filter((r) => r.method === 'POST').length, 1);
  assert.match(gh.statuses.get(outcome.deploymentId)[0].description, /no previous good deployment/);
});

test('if the rollback itself fails the outcome says so', async () => {
  seedGood(SHA_A);
  render.failRefs.add(`${IMAGE}@${DIGEST[SHA_A]}`);
  const outcome = await runDeploy(options(SHA_B, { simulateFailure: true }), deps());
  assert.equal(outcome.result, 'rollback_failed');
  assert.match(outcome.rollbackFailure, /update_failed/);
  assert.match(gh.statuses.get(outcome.deploymentId)[0].description, /rollback failed too/);
});

test('rollback target that does not come back healthy is reported as rollback_failed', async () => {
  seedGood(SHA_A);
  render.onLive = () => app.serve('still-broken');
  const outcome = await runDeploy(options(SHA_B), deps());
  assert.equal(outcome.result, 'rollback_failed');
  assert.match(outcome.rollbackFailure, /health check after rollback failed/);
});

test('with autoRollback off (manual rollback workflow) a failure is just a failure', async () => {
  seedGood(SHA_A);
  const outcome = await runDeploy(options(SHA_B, { autoRollback: false, simulateFailure: true, mode: 'rollback' }), deps());
  assert.equal(outcome.result, 'failed');
  assert.equal(outcome.previous, null);
  assert.equal(render.requests.filter((r) => r.method === 'POST').length, 1);
});

test('a manual rollback is recorded with mode "rollback" and a regular deploy with mode "deploy"', async () => {
  seedGood(SHA_A);
  const rolled = await runDeploy(options(SHA_A, { autoRollback: false, mode: 'rollback' }), deps());
  assert.equal(gh.deployments[rolled.deploymentId - 1].payload.mode, 'rollback');
  const regular = await runDeploy(options(SHA_B), deps());
  assert.equal(gh.deployments[regular.deploymentId - 1].payload.mode, 'deploy');
});

test('after a rollback the next failing deploy rolls back to the rolled-back version, not to the one before', async () => {
  seedGood(SHA_A);
  seedGood(SHA_B);
  await runDeploy(options(SHA_A, { autoRollback: false, mode: 'rollback' }), deps());
  render.onLive = (ref) => app.serve(ref.includes(DIGEST[SHA_A]) ? SHA_A : 'wrong-commit');
  const outcome = await runDeploy(options(SHA_C), deps());
  assert.equal(outcome.result, 'rolled_back');
  assert.equal(outcome.previous.sha, SHA_A);
});

test('summary lists the outcome, the failure and the smoke tests', async () => {
  seedGood(SHA_A);
  const opts = options(SHA_B, { simulateFailure: true });
  const outcome = await runDeploy(opts, deps());
  const md = summaryMarkdown(opts, outcome);
  assert.match(md, /FAILED and was rolled back automatically/);
  assert.match(md, /Last good before this run \| `aaaaaaa`/);
  const ok = await runDeploy(options(SHA_A), deps());
  assert.match(summaryMarkdown(options(SHA_A, { mode: 'rollback' }), ok), /### Rollback to staging succeeded[\s\S]*Smoke tests \(full mode\)/);
});

const envFor = (extra = {}) => ({
  GITHUB_TOKEN: 'ghs_token',
  GITHUB_REPOSITORY: 'owner/repo',
  GITHUB_API_URL: gh.url,
  RENDER_API_KEY: 'rnd_key',
  RENDER_SERVICE_ID: 'srv-1',
  RENDER_API_URL: `${render.url}/v1`,
  APP_URL: app.url,
  ...extra,
});
const argsFor = (sha, extra = []) => [
  '--environment', 'staging', '--sha', sha, '--image', IMAGE, '--digest', DIGEST[sha],
  '--health-delay', '0', '--render-interval', '0', '--health-attempts', '2', ...extra,
];

test('CLI: success writes outputs and the step summary', async () => {
  const out = tempFile();
  const summary = tempFile();
  const outcome = await main(argsFor(SHA_A), envFor({ GITHUB_OUTPUT: out.path, GITHUB_STEP_SUMMARY: summary.path }));
  assert.equal(outcome.result, 'success');
  assert.match(out.read(), /result=success/);
  assert.match(summary.read(), /Deploy to staging succeeded/);
});

test('CLI: --simulate-failure rolls back and exits non-zero', async () => {
  seedGood(SHA_A);
  const out = tempFile();
  process.exitCode = 0;
  const outcome = await main(argsFor(SHA_B, ['--simulate-failure']), envFor({ GITHUB_OUTPUT: out.path }));
  assert.equal(outcome.result, 'rolled_back');
  assert.equal(process.exitCode, 1);
  assert.match(out.read(), new RegExp(`rolled_back_to=${SHA_A}`));
  process.exitCode = 0;
});

test('CLI: skips with a notice when Render is not configured', async () => {
  const out = tempFile();
  const outcome = await main(argsFor(SHA_A), envFor({ RENDER_API_KEY: '', GITHUB_OUTPUT: out.path }));
  assert.equal(outcome.result, 'skipped');
  assert.match(out.read(), /result=skipped/);
  assert.equal(render.requests.length, 0);
});

test('CLI: validates its arguments', async () => {
  await assert.rejects(main([], envFor()), /usage/);
  await assert.rejects(main(argsFor(SHA_A, ['--smoke-mode', 'weird']), envFor()), /smoke-mode/);
  await assert.rejects(main(argsFor(SHA_A), { RENDER_API_KEY: 'x' }), /GITHUB_TOKEN/);
});
