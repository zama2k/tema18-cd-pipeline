import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { FakeRender } from '../../scripts/dev/fakes.mjs';
import { RenderClient, deployImage } from '../../scripts/lib/render.mjs';
import { main } from '../../scripts/render-deploy.mjs';
import { IMAGE, digestOf, noSleep, quiet, tempFile } from './helpers.mjs';

const ref = `${IMAGE}@${digestOf('1')}`;
let fake;

beforeEach(async () => {
  await fake?.close();
  fake = new FakeRender({ pollsUntilLive: 2 });
  await fake.listen();
});
after(() => fake.close());

const client = (overrides = {}) =>
  new RenderClient({ apiKey: 'rnd_key', serviceId: 'srv-1', apiUrl: `${fake.url}/v1`, sleep: noSleep, log: quiet, ...overrides });

test('deploys an image reference and waits until the deploy is live', async () => {
  const result = await deployImage(client(), ref, { expectedDigest: digestOf('1'), intervalMs: 0 });
  assert.equal(result.status, 'live');
  assert.equal(result.digest, digestOf('1'));
  const post = fake.requests.find((r) => r.method === 'POST');
  assert.deepEqual(post.body, { imageUrl: ref, clearCache: 'do_not_clear' });
  assert.equal(post.headers.authorization, 'Bearer rnd_key');
});

test('fails when Render ends the deploy in a failed status', async () => {
  fake.failRefs.add(ref);
  await assert.rejects(deployImage(client(), ref, { intervalMs: 0 }), /update_failed/);
});

test('fails with a timeout when the deploy never becomes live', async () => {
  fake.pollsUntilLive = 1000;
  await assert.rejects(deployImage(client(), ref, { timeoutMs: 30, intervalMs: 10 }), /Timed out/);
});

test('fails when Render reports a different digest than requested', async () => {
  await assert.rejects(deployImage(client(), ref, { expectedDigest: digestOf('2'), intervalMs: 0 }), /expected sha256:2/);
});

test('retries on 429 honouring Retry-After', async () => {
  fake.throttle = 2;
  const result = await deployImage(client(), ref, { intervalMs: 0 });
  assert.equal(result.status, 'live');
});

test('looks up the newest deploy when Render answers 202 without a body', async () => {
  fake.answer202 = true;
  const result = await deployImage(client(), ref, { intervalMs: 0 });
  assert.equal(result.deployId, 'dep-1');
});

test('reports API errors without leaking the API key', async () => {
  const bad = client({ apiKey: 'wrong_key_value' });
  await assert.rejects(bad.triggerDeploy(ref), (err) => {
    assert.match(err.message, /401/);
    assert.ok(!err.message.includes('wrong_key_value'));
    return true;
  });
});

test('gives up after repeated server errors', async () => {
  const failing = client({ fetchImpl: async () => new Response('{"message":"boom"}', { status: 503 }) });
  await assert.rejects(failing.triggerDeploy(ref), /503/);
});

test('constructor validates its inputs', () => {
  assert.throws(() => new RenderClient({ serviceId: 's' }), /RENDER_API_KEY/);
  assert.throws(() => new RenderClient({ apiKey: 'k' }), /RENDER_SERVICE_ID/);
});

test('CLI skips with a notice when the Render secrets are missing', async () => {
  const out = tempFile();
  const result = await main(['--image', ref], { GITHUB_OUTPUT: out.path });
  assert.equal(result, null);
  assert.match(out.read(), /skipped=true/);
  assert.equal(fake.requests.length, 0);
});

test('CLI deploys and writes outputs', async () => {
  const out = tempFile();
  const env = { RENDER_API_KEY: 'rnd_key', RENDER_SERVICE_ID: 'srv-1', RENDER_API_URL: `${fake.url}/v1`, GITHUB_OUTPUT: out.path };
  const result = await main(['--image', ref, '--interval', '0', '--timeout', '5'], env);
  assert.equal(result.status, 'live');
  assert.match(out.read(), /status=live/);
});

test('CLI requires --image', async () => {
  await assert.rejects(main([], {}), /usage/);
});
