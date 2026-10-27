import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FakeGitHub, FakeVercel } from '../../scripts/dev/fakes.mjs';
import { GitHubApi } from '../../scripts/lib/github.mjs';
import { MARKER, previewBody, removedBody, upsertComment } from '../../scripts/lib/pr-comment.mjs';
import { VercelClient, removePreviews } from '../../scripts/lib/vercel.mjs';
import { main as commentMain } from '../../scripts/pr-comment.mjs';
import { main as cleanupMain } from '../../scripts/vercel-cleanup.mjs';
import { SHA_A, quiet, tempFile } from './helpers.mjs';

let gh;
let vercel;
beforeEach(async () => {
  gh = new FakeGitHub();
  vercel = new FakeVercel();
  await Promise.all([gh.listen(), vercel.listen()]);
});
afterEach(() => Promise.all([gh.close(), vercel.close()]));

const api = () => new GitHubApi({ token: 'ghs_token', repo: 'owner/repo', apiUrl: gh.url });
const vc = (extra = {}) => new VercelClient({ token: 'vc_token', projectId: 'prj_1', apiUrl: vercel.url, ...extra });

test('previewBody contains the marker, URL, short sha, branch and run link', () => {
  const body = previewBody({ url: 'https://p.vercel.app', sha: SHA_A, branch: 'feat/x', runUrl: 'https://run' });
  assert.ok(body.startsWith(MARKER));
  for (const part of ['https://p.vercel.app', '`aaaaaaa`', '`feat/x`', '[workflow run](https://run)']) {
    assert.ok(body.includes(part), part);
  }
  assert.ok(!previewBody({ url: 'u', sha: SHA_A, branch: 'b', protectedByVercel: false }).includes('Deployment Protection'));
});

test('upsertComment creates once and then edits the same comment', async () => {
  const first = await upsertComment(api(), { pr: 7, body: previewBody({ url: 'u1', sha: SHA_A, branch: 'b' }) });
  const second = await upsertComment(api(), { pr: 7, body: previewBody({ url: 'u2', sha: SHA_A, branch: 'b' }) });
  assert.equal(first.action, 'created');
  assert.equal(second.action, 'updated');
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, /u2/);
});

test('upsertComment leaves other comments alone and does not confuse PRs', async () => {
  gh.comments.push({ id: 1, pr: '7', body: 'a human comment' });
  await upsertComment(api(), { pr: 7, body: previewBody({ url: 'u', sha: SHA_A, branch: 'b' }) });
  await upsertComment(api(), { pr: 8, body: previewBody({ url: 'other', sha: SHA_A, branch: 'b' }) });
  assert.equal(gh.comments.length, 3);
  assert.equal(gh.comments[0].body, 'a human comment');
});

test('removed mode edits the sticky comment but never creates one', async () => {
  assert.equal((await upsertComment(api(), { pr: 7, body: removedBody(), createIfMissing: false })).action, 'none');
  assert.equal(gh.comments.length, 0);
  await upsertComment(api(), { pr: 7, body: previewBody({ url: 'u', sha: SHA_A, branch: 'b' }) });
  await upsertComment(api(), { pr: 7, body: removedBody({ runUrl: 'https://run' }), createIfMissing: false });
  assert.match(gh.comments[0].body, /Preview removed/);
  assert.match(gh.comments[0].body, /cleanup run/);
});

test('comment CLI posts the preview, then edits it, then marks it removed', async () => {
  const env = { GITHUB_TOKEN: 'ghs_token', GITHUB_REPOSITORY: 'owner/repo', GITHUB_API_URL: gh.url, GITHUB_SERVER_URL: 'https://github.com', GITHUB_RUN_ID: '9' };
  const args = ['preview', '--pr', '5', '--url', 'https://p', '--sha', SHA_A, '--branch', 'feat/y'];
  assert.equal((await commentMain(args, env)).action, 'created');
  assert.equal((await commentMain(args, env)).action, 'updated');
  assert.equal((await commentMain(['removed', '--pr', '5'], env)).action, 'updated');
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0].body, /Preview removed/);
});

test('comment CLI validates arguments', async () => {
  await assert.rejects(commentMain(['preview', '--pr', 'x'], {}), /usage/);
  await assert.rejects(commentMain(['preview', '--pr', '1'], { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'a/b' }), /--url, --sha and --branch/);
});

test('removePreviews deletes only the deployments of that PR, across pages', async () => {
  vercel.pageSize = 2;
  vercel.seed('dpl_a', 12, 5);
  vercel.seed('dpl_b', 99, 4);
  vercel.seed('dpl_c', 12, 3);
  vercel.seed('dpl_d', undefined, 2);
  vercel.seed('dpl_e', 12, 1);
  const removed = await removePreviews(vc(), 12, quiet);
  assert.equal(removed, 3);
  assert.deepEqual(vercel.deployments.map((d) => d.uid).sort(), ['dpl_b', 'dpl_d']);
});

test('removePreviews is a no-op when the PR has no deployments and sends the team id', async () => {
  vercel.seed('dpl_b', 99, 4);
  assert.equal(await removePreviews(vc({ teamId: 'team_1' }), 12, quiet), 0);
  assert.ok(vercel.requests.every((r) => r.query.teamId === 'team_1'));
});

test('a deployment that is already gone does not fail the cleanup', async () => {
  const client = vc();
  assert.deepEqual(await client.remove('dpl_missing'), { gone: true });
});

test('Vercel API errors are surfaced without the token', async () => {
  await assert.rejects(vc({ token: 'wrong' }).listByPullRequest(1), (err) => {
    assert.match(err.message, /401/);
    assert.ok(!err.message.includes('wrong'));
    return true;
  });
  assert.throws(() => new VercelClient({ projectId: 'p' }), /VERCEL_TOKEN/);
  assert.throws(() => new VercelClient({ token: 't' }), /VERCEL_PROJECT_ID/);
});

test('cleanup CLI removes previews, and skips when Vercel is not configured', async () => {
  vercel.seed('dpl_a', 3, 1);
  const out = tempFile();
  const env = { VERCEL_TOKEN: 'vc_token', VERCEL_PROJECT_ID: 'prj_1', VERCEL_API_URL: vercel.url, GITHUB_OUTPUT: out.path };
  assert.equal(await cleanupMain(['--pr', '3'], env), 1);
  assert.match(out.read(), /removed=1/);
  const skipOut = tempFile();
  assert.equal(await cleanupMain(['--pr', '3'], { GITHUB_OUTPUT: skipOut.path }), null);
  assert.match(skipOut.read(), /skipped=true/);
  await assert.rejects(cleanupMain(['--pr', 'abc'], {}), /usage/);
});
