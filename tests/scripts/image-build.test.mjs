import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { build, requiredPackages } from '../../scripts/build-check.mjs';
import { FakeRegistry } from '../../scripts/dev/fakes.mjs';
import { Registry, splitImage } from '../../scripts/lib/registry.mjs';
import { main, resolveImage } from '../../scripts/resolve-image.mjs';
import { IMAGE, SHA_A, SHA_B, digestOf, tempFile } from './helpers.mjs';

let registry;
beforeEach(async () => {
  registry = new FakeRegistry({
    manifests: {
      [`owner/repo:sha-${SHA_A}`]: digestOf('1'),
      [`owner/repo:${digestOf('1')}`]: digestOf('1'),
      [`owner/repo:sha-${SHA_B}`]: digestOf('9'), // tag moved to a different image
      [`owner/repo:${digestOf('2')}`]: digestOf('2'),
    },
    requireAuth: true,
  });
  await registry.listen();
});
afterEach(() => registry.close());

const client = () => new Registry({ registryUrl: registry.url, user: 'ana', token: 'tok' });

test('splitImage separates host and repository', () => {
  assert.deepEqual(splitImage('ghcr.io/owner/repo'), { host: 'ghcr.io', name: 'owner/repo' });
  assert.throws(() => splitImage('noslash'), /host\/owner\/repo/);
});

test('resolves the digest from the sha tag', async () => {
  const resolved = await resolveImage({ image: IMAGE, sha: SHA_A, registry: client() });
  assert.equal(resolved.ref, `${IMAGE}@${digestOf('1')}`);
});

test('fails clearly when the sha tag does not exist', async () => {
  await assert.rejects(resolveImage({ image: IMAGE, sha: 'c'.repeat(40), registry: client() }), /does not exist in the registry/);
});

test('a known digest is verified against the registry', async () => {
  const resolved = await resolveImage({ image: IMAGE, sha: SHA_A, digest: digestOf('1'), registry: client() });
  assert.equal(resolved.digest, digestOf('1'));
  await assert.rejects(resolveImage({ image: IMAGE, sha: SHA_A, digest: digestOf('3'), registry: client() }), /does not exist/);
  await assert.rejects(resolveImage({ image: IMAGE, sha: SHA_A, digest: 'nope', registry: client() }), /not a sha256 digest/);
});

test('strict tag mode requires the sha tag to exist and to match the digest', async () => {
  const strict = (sha, digest) => resolveImage({ image: IMAGE, sha, digest, registry: client(), strictTag: true });
  assert.equal((await strict(SHA_A, digestOf('1'))).digest, digestOf('1'));
  await assert.rejects(strict(SHA_B, digestOf('2')), /rebuilt after it was verified/);
  await assert.rejects(strict('c'.repeat(40), digestOf('2')), /does not exist/);
});

test('a moved tag only warns: the digest built by the CI run wins', async () => {
  const resolved = await resolveImage({ image: IMAGE, sha: SHA_B, digest: digestOf('2'), registry: client() });
  assert.equal(resolved.digest, digestOf('2'));
});

test('registry errors name the repository, not the credentials', async () => {
  registry.requireAuth = true;
  const anonymous = new Registry({ registryUrl: registry.url });
  registry.server.removeAllListeners('request');
  registry.server.on('request', (_req, res) => res.writeHead(403).end());
  await assert.rejects(anonymous.manifest('owner/repo', 'x'), /token request failed|denied/);
});

test('CLI reads the digest from the artifact file and writes outputs', async () => {
  const file = tempFile('image-digest.json');
  writeFileSync(file.path, JSON.stringify({ sha: SHA_A, image: IMAGE, digest: digestOf('1') }));
  const out = tempFile();
  const env = { REGISTRY_URL: registry.url, GITHUB_ACTOR: 'ana', GITHUB_TOKEN: 'tok', GITHUB_OUTPUT: out.path };
  const resolved = await main(['--image', 'GHCR.io/Owner/Repo', '--sha', SHA_A, '--digest-file', file.path], env);
  assert.equal(resolved.digest, digestOf('1'));
  assert.match(out.read(), new RegExp(`ref=ghcr.io/owner/repo@${digestOf('1')}`));
});

test('CLI refuses a digest file that belongs to another commit', async () => {
  const file = tempFile('image-digest.json');
  writeFileSync(file.path, JSON.stringify({ sha: SHA_B, digest: digestOf('1') }));
  await assert.rejects(main(['--image', IMAGE, '--sha', SHA_A, '--digest-file', file.path], { REGISTRY_URL: registry.url }), /belongs to/);
  await assert.rejects(main(['--image', IMAGE], {}), /usage/);
});

test('requiredPackages ignores relative paths, node builtins and returns package roots', () => {
  const source = "require('./a'); require('node:fs'); require('path'); require('express'); require('@scope/pkg/sub'); require('lodash/get');";
  assert.deepEqual([...requiredPackages(source)].sort(), ['@scope/pkg', 'express', 'lodash']);
});

function fakeProject(files, deps) {
  const root = mkdtempSync(join(tmpdir(), 't18reto-build-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', dependencies: deps }));
  mkdirSync(join(root, 'src'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

test('build passes on the real project', () => {
  assert.ok(build().files >= 3);
});

test('build rejects a runtime package that is not a production dependency', () => {
  const root = fakeProject({ 'src/app.js': "require('left-pad'); module.exports = { createApp: () => () => {} };" }, {});
  assert.throws(() => build(root), /left-pad/);
});

test('build rejects syntax errors and factories that do not return a handler', () => {
  assert.throws(() => build(fakeProject({ 'src/app.js': 'const = ;' }, {})));
  assert.throws(() => build(fakeProject({ 'src/app.js': 'module.exports = { createApp: () => 1 };' }, {})), /request handler/);
});
