import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { main } from '../../scripts/deployments.mjs';
import { FakeGitHub } from '../../scripts/dev/fakes.mjs';
import {
  TASK,
  createDeployment,
  findGoodBySha,
  findLastGood,
  isGood,
  setStatus,
} from '../../scripts/lib/deployments.mjs';
import { GitHubApi } from '../../scripts/lib/github.mjs';
import { IMAGE, SHA_A, SHA_B, SHA_C, digestOf, tempFile } from './helpers.mjs';

let gh;
let api;
beforeEach(async () => {
  gh = new FakeGitHub();
  await gh.listen();
  api = new GitHubApi({ token: 'ghs_token', repo: 'owner/repo', apiUrl: gh.url });
});
afterEach(() => gh.close());

test('isGood: success without a later failure, even if superseded by inactive', () => {
  assert.equal(isGood([{ state: 'inactive' }, { state: 'success' }, { state: 'in_progress' }]), true);
  assert.equal(isGood([{ state: 'in_progress' }]), false);
  assert.equal(isGood([{ state: 'failure' }, { state: 'success' }]), false);
  assert.equal(isGood([{ state: 'error' }, { state: 'success' }]), false);
  assert.equal(isGood([]), false);
});

test('createDeployment records sha, image and digest in the payload', async () => {
  const id = await createDeployment(api, { environment: 'staging', sha: SHA_A, image: IMAGE, digest: digestOf('1') });
  const record = gh.deployments[id - 1];
  assert.equal(record.task, TASK);
  assert.equal(record.environment, 'staging');
  assert.deepEqual(record.payload, { sha: SHA_A, image: IMAGE, digest: digestOf('1') });
  const post = gh.requests.find((r) => r.path.endsWith('/deployments'));
  assert.equal(post.body.auto_merge, false);
  assert.deepEqual(post.body.required_contexts, []);
  assert.equal(post.body.production_environment, false);
});

test('createDeployment marks production deployments as production', async () => {
  await createDeployment(api, { environment: 'production', sha: SHA_A, image: IMAGE, digest: digestOf('1') });
  assert.equal(gh.requests.find((r) => r.method === 'POST').body.production_environment, true);
});

test('createDeployment falls back to the default branch when a sha ref is rejected', async () => {
  gh.rejectShaRef = true;
  const id = await createDeployment(api, { environment: 'staging', sha: SHA_A, image: IMAGE, digest: digestOf('1') });
  assert.equal(gh.deployments[id - 1].sha, 'main');
  assert.equal(gh.deployments[id - 1].payload.sha, SHA_A);
});

test('createDeployment propagates other errors', async () => {
  const bad = new GitHubApi({ token: 'wrong', repo: 'owner/repo', apiUrl: gh.url });
  await assert.rejects(createDeployment(bad, { environment: 'staging', sha: SHA_A, image: IMAGE, digest: digestOf('1') }), /401/);
});

test('setStatus posts state, description and URLs', async () => {
  const id = await createDeployment(api, { environment: 'staging', sha: SHA_A, image: IMAGE, digest: digestOf('1') });
  await setStatus(api, id, { state: 'success', description: 'ok', environmentUrl: 'https://app', logUrl: 'https://run' });
  assert.equal(gh.latestState(id), 'success');
  assert.equal(gh.statuses.get(id)[0].environment_url, 'https://app');
});

test('findLastGood returns the newest good deployment and skips failed ones', async () => {
  gh.seedDeployment({ environment: 'staging', sha: SHA_A, digest: digestOf('1') });
  gh.seedDeployment({ environment: 'staging', sha: SHA_B, digest: digestOf('2') });
  gh.seedDeployment({ environment: 'staging', sha: SHA_C, digest: digestOf('3'), states: ['in_progress', 'failure'] });
  const last = await findLastGood(api, 'staging');
  assert.equal(last.sha, SHA_B);
  assert.equal(last.digest, digestOf('2'));
  assert.equal(last.image, IMAGE);
});

test('findLastGood sees through the inactive status GitHub appends to superseded deployments', async () => {
  gh.seedDeployment({ environment: 'staging', sha: SHA_A, digest: digestOf('1'), states: ['success', 'inactive'] });
  assert.equal((await findLastGood(api, 'staging')).sha, SHA_A);
});

test('findLastGood ignores other environments, foreign tasks and the excluded deployment', async () => {
  gh.seedDeployment({ environment: 'production', sha: SHA_A, digest: digestOf('1') });
  const own = gh.seedDeployment({ environment: 'staging', sha: SHA_B, digest: digestOf('2') });
  gh.deployments.push({ id: 99, sha: SHA_C, task: 'deploy', environment: 'staging', payload: {}, created_at: gh.tick() });
  gh.statuses.set(99, [{ state: 'success' }]);
  assert.equal((await findLastGood(api, 'staging')).sha, SHA_B);
  assert.equal(await findLastGood(api, 'staging', { excludeId: own }), null);
});

test('findLastGood returns null when there is no history', async () => {
  assert.equal(await findLastGood(api, 'staging'), null);
});

test('findGoodBySha finds a record by the sha in its payload, not by the git ref', async () => {
  const id = gh.seedDeployment({ environment: 'staging', sha: SHA_A, digest: digestOf('1') });
  gh.deployments[id - 1].sha = 'main'; // branch fallback case
  assert.equal((await findGoodBySha(api, 'staging', SHA_A)).digest, digestOf('1'));
  assert.equal(await findGoodBySha(api, 'staging', SHA_B), null);
});

test('findGoodBySha refuses a sha that only ever failed in that environment', async () => {
  gh.seedDeployment({ environment: 'staging', sha: SHA_A, digest: digestOf('1'), states: ['in_progress', 'failure'] });
  assert.equal(await findGoodBySha(api, 'staging', SHA_A), null);
});

test('paginates through more than one page of deployments', async () => {
  for (let i = 0; i < 120; i++) {
    gh.seedDeployment({ environment: 'staging', sha: SHA_C, digest: digestOf('3'), states: ['failure'] });
  }
  gh.deployments[0].sha = SHA_A;
  gh.deployments[0].payload.sha = SHA_A;
  gh.statuses.set(1, [{ state: 'success' }]);
  assert.equal((await findGoodBySha(api, 'staging', SHA_A)).sha, SHA_A);
});

test('deployments CLI: last-good writes outputs', async () => {
  gh.seedDeployment({ environment: 'staging', sha: SHA_A, digest: digestOf('1') });
  const out = tempFile();
  const env = { GITHUB_TOKEN: 'ghs_token', GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: gh.url, GITHUB_OUTPUT: out.path };
  const record = await main(['last-good', '--environment', 'staging'], env);
  assert.equal(record.sha, SHA_A);
  assert.match(out.read(), new RegExp(`found=true\\nsha=${SHA_A}\\nimage=${IMAGE}\\ndigest=${digestOf('1')}`));
});

test('deployments CLI: missing record is reported, or fails with --require', async () => {
  const out = tempFile();
  const env = { GITHUB_TOKEN: 'ghs_token', GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: gh.url, GITHUB_OUTPUT: out.path };
  assert.equal(await main(['by-sha', '--environment', 'staging', '--sha', SHA_A], env), null);
  assert.match(out.read(), /found=false/);
  await assert.rejects(main(['by-sha', '--environment', 'staging', '--sha', SHA_A, '--require'], env), /No record of/);
  await assert.rejects(main(['last-good', '--environment', 'staging', '--require'], env), /successful deployment/);
});

test('deployments CLI validates its arguments', async () => {
  await assert.rejects(main(['nope'], {}), /usage/);
  await assert.rejects(main(['by-sha', '--environment', 'staging', '--sha', 'abc'], {}), /40-character/);
  await assert.rejects(main(['last-good', '--environment', 'staging'], {}), /GITHUB_TOKEN/);
});

test('GitHubApi validates token and repository', () => {
  assert.throws(() => new GitHubApi({ repo: 'a/b' }), /GITHUB_TOKEN/);
  assert.throws(() => new GitHubApi({ token: 't', repo: 'bad' }), /owner\/repo/);
});
