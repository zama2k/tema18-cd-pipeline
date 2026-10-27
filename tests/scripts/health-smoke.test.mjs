import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { main as healthMain } from '../../scripts/health-check.mjs';
import { checkHealth } from '../../scripts/lib/health.mjs';
import { parseHeaders, runSmoke, smokeToMarkdown } from '../../scripts/lib/smoke.mjs';
import { main as smokeMain } from '../../scripts/smoke.mjs';
import { SHA_A, SHA_B, noSleep, quiet, startAppServer, tempFile } from './helpers.mjs';

let app;
before(async () => {
  app = await startAppServer(SHA_A);
});
after(() => app.close());

const opts = (extra = {}) => ({ baseUrl: app.url, attempts: 3, sleep: noSleep, log: quiet, ...extra });

test('health check passes when the expected commit is served', async () => {
  const result = await checkHealth(opts({ expectedCommit: SHA_A }));
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.body.commit, SHA_A);
});

test('health check fails when a different commit keeps being served', async () => {
  const result = await checkHealth(opts({ expectedCommit: SHA_B }));
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.match(result.error, /commit mismatch/);
});

test('health check retries until the new commit shows up (rollout in progress)', async () => {
  let calls = 0;
  const sleep = async () => {
    calls += 1;
    if (calls === 2) app.serve(SHA_B);
  };
  const result = await checkHealth(opts({ expectedCommit: SHA_B, attempts: 5, sleep }));
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  app.serve(SHA_A);
});

test('health check reports HTTP errors and connection failures', async () => {
  app.setBroken(true);
  const down = await checkHealth(opts());
  app.setBroken(false);
  assert.equal(down.ok, false);
  assert.match(down.error, /HTTP 503/);

  const refused = await checkHealth(opts({ baseUrl: 'http://127.0.0.1:1', attempts: 1 }));
  assert.equal(refused.ok, false);
});

test('health check reports a timeout', async () => {
  const slow = async (_url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const result = await checkHealth(opts({ fetchImpl: slow, timeoutMs: 20, attempts: 1 }));
  assert.match(result.error, /timeout/);
});

test('health check rejects a body whose status is not ok', async () => {
  const fetchImpl = async () => new Response('{"status":"degraded"}', { status: 200 });
  const result = await checkHealth(opts({ fetchImpl, attempts: 1 }));
  assert.match(result.error, /degraded/);
});

test('health-check CLI throws on failure and returns the result on success', async () => {
  const ok = await healthMain(['--url', app.url, '--expected-commit', SHA_A, '--attempts', '1'], {});
  assert.equal(ok.ok, true);
  await assert.rejects(
    healthMain(['--url', app.url, '--expected-commit', SHA_B, '--attempts', '1', '--delay', '0'], {}),
    /Health check failed after 1 attempts/,
  );
  await assert.rejects(healthMain([], {}), /usage/);
});

test('smoke full mode exercises reads and writes', async () => {
  const outcome = await runSmoke({ baseUrl: app.url, mode: 'full' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 7);
});

test('smoke readonly mode never writes', async () => {
  const before = await (await fetch(`${app.url}/api/items`)).json();
  const outcome = await runSmoke({ baseUrl: app.url, mode: 'readonly' });
  const after = await (await fetch(`${app.url}/api/items`)).json();
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, 5);
  assert.equal(after.count, before.count);
});

test('smoke tests fail when the service is down and name the failing checks', async () => {
  app.setBroken(true);
  const outcome = await runSmoke({ baseUrl: app.url, mode: 'readonly' });
  app.setBroken(false);
  assert.equal(outcome.ok, false);
  assert.match(smokeToMarkdown(outcome), /FAIL/);
});

test('smoke tests report connection errors per check', async () => {
  const outcome = await runSmoke({ baseUrl: 'http://127.0.0.1:1', mode: 'readonly' });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.results.every((r) => !r.ok));
});

test('smoke tests send the extra headers', async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(init.headers['x-vercel-protection-bypass']);
    return new Response('{}', { status: 200 });
  };
  await runSmoke({ baseUrl: 'http://x', mode: 'readonly', headers: { 'x-vercel-protection-bypass': 's3cret' }, fetchImpl });
  assert.ok(seen.length > 0 && seen.every((v) => v === 's3cret'));
});

test('parseHeaders reads Name: value lines and ignores junk', () => {
  assert.deepEqual(parseHeaders('X-Test: a:b\n\nnot a header\nOther:  v '), { 'x-test': 'a:b', other: 'v' });
  assert.deepEqual(parseHeaders(undefined), {});
});

test('smoke CLI writes the step summary and fails on errors', async () => {
  const summary = tempFile();
  await smokeMain(['--url', app.url, '--mode', 'readonly', '--summary'], { GITHUB_STEP_SUMMARY: summary.path });
  assert.match(summary.read(), /Smoke tests \(readonly mode\)/);
  app.setBroken(true);
  await assert.rejects(smokeMain(['--url', app.url, '--mode', 'readonly'], {}), /smoke check\(s\) failed/);
  app.setBroken(false);
  await assert.rejects(smokeMain(['--url', app.url, '--mode', 'bogus'], {}), /usage/);
});
