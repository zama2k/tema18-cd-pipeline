import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApiError,
  appendSummary,
  backoffDelay,
  httpJson,
  requireEnv,
  setOutputs,
  shortSha,
} from '../../scripts/lib/util.mjs';
import { captureLog, tempFile } from './helpers.mjs';

test('backoffDelay grows exponentially and is capped', () => {
  assert.equal(backoffDelay(1, { baseMs: 1000, factor: 2, maxMs: 5000 }), 1000);
  assert.equal(backoffDelay(2, { baseMs: 1000, factor: 2, maxMs: 5000 }), 2000);
  assert.equal(backoffDelay(10, { baseMs: 1000, factor: 2, maxMs: 5000 }), 5000);
});

test('shortSha trims to 7 characters and tolerates empty input', () => {
  assert.equal(shortSha('0123456789abcdef'), '0123456');
  assert.equal(shortSha(undefined), '');
});

test('setOutputs appends key=value lines to GITHUB_OUTPUT', () => {
  const out = tempFile();
  setOutputs({ a: 1, b: 'two', c: undefined }, { GITHUB_OUTPUT: out.path });
  assert.equal(out.read(), 'a=1\nb=two\nc=\n');
});

test('setOutputs prints the values when GITHUB_OUTPUT is not set', async () => {
  const { lines } = await captureLog(() => setOutputs({ a: 1 }, {}));
  assert.deepEqual(lines, ['output a=1']);
});

test('appendSummary writes to GITHUB_STEP_SUMMARY only when it exists', () => {
  const summary = tempFile();
  appendSummary('hello', { GITHUB_STEP_SUMMARY: summary.path });
  appendSummary('ignored', {});
  assert.equal(summary.read(), 'hello\n');
});

test('requireEnv lists every missing variable', () => {
  assert.throws(() => requireEnv({ A: '1' }, ['A', 'B', 'C']), /B, C/);
  assert.doesNotThrow(() => requireEnv({ A: '1' }, ['A']));
});

test('httpJson parses JSON, tolerates non-JSON bodies and never throws on HTTP errors', async () => {
  const responses = [
    new Response('{"x":1}', { status: 200 }),
    new Response('<html>oops</html>', { status: 502 }),
    new Response(null, { status: 204 }),
  ];
  const fetchImpl = async () => responses.shift();
  assert.deepEqual((await httpJson('http://x', { fetchImpl })).data, { x: 1 });
  const bad = await httpJson('http://x', { fetchImpl });
  assert.equal(bad.ok, false);
  assert.equal(bad.data.raw, '<html>oops</html>');
  assert.equal((await httpJson('http://x', { fetchImpl })).data, null);
});

test('httpJson sends a JSON body with a content-type header', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = init;
    return new Response('{}');
  };
  await httpJson('http://x', { method: 'POST', body: { a: 1 }, fetchImpl });
  assert.equal(seen.body, '{"a":1}');
  assert.equal(seen.headers['content-type'], 'application/json');
});

test('ApiError carries status and data', () => {
  const err = new ApiError('nope', { status: 418, data: { a: 1 } });
  assert.equal(err.status, 418);
  assert.equal(err.name, 'ApiError');
});
