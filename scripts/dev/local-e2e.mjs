#!/usr/bin/env node
// Local end-to-end rehearsal of the CD flow with REAL containers and FAKE
// Render/GitHub/Discord/registry APIs. The same scripts the workflows call run
// here as child processes, so the whole path is exercised without accounts:
//
//   deploy -> verify commit -> smoke -> automatic rollback -> promote -> manual rollback -> notify
//
// Ports: app 3201, fake Render 3202, fake GitHub 3203, fake Discord 3204, fake registry 3205.
// Docker resources are all prefixed `t18reto-` and removed at the end.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FakeDiscord, FakeGitHub, FakeRegistry, FakeRender } from './fakes.mjs';

const PORTS = { app: 3201, render: 3202, github: 3203, discord: 3204, registry: 3205 };
const CONTAINER = 't18reto-app';
const IMAGE = 'ghcr.io/owner/repo';
const VERSION_TAG = (sha) => `t18reto-app:${sha.slice(0, 7)}`;

const sha = (char) => char.repeat(40);
const digestOf = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const COMMITS = { one: sha('1'), two: sha('2'), three: sha('3'), bad: sha('4') };
const DIGESTS = Object.fromEntries(Object.entries(COMMITS).map(([k, v]) => [k, digestOf(v)]));
const dockerTagByDigest = {
  [DIGESTS.one]: VERSION_TAG(COMMITS.one),
  [DIGESTS.two]: VERSION_TAG(COMMITS.two),
  [DIGESTS.three]: VERSION_TAG(COMMITS.three),
  // Built with a different GIT_SHA than the commit it claims to be: a real
  // "deployed the wrong thing" failure for the health check to catch.
  [DIGESTS.bad]: 't18reto-app:wrong-commit',
};

const docker = (...args) => execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const banner = (text) => console.log(`\n=== ${text} ===`);

function build(tag, gitSha) {
  docker('build', '-q', '-t', tag, '--build-arg', `GIT_SHA=${gitSha}`, '--build-arg', 'APP_VERSION=1.0.0', '.');
}

function startContainer(tag) {
  try {
    docker('rm', '-f', CONTAINER);
  } catch {
    // nothing to remove
  }
  docker('run', '-d', '--name', CONTAINER, '-p', `${PORTS.app}:3000`, tag);
}

function runScript(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const pipe = (chunk) => {
      out += chunk;
      process.stdout.write(`    | ${String(chunk).replace(/\n(?=.)/g, '\n    | ')}`);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function servedCommit() {
  const res = await fetch(`http://127.0.0.1:${PORTS.app}/health`);
  return (await res.json()).commit;
}

function expect(cond, message) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${message}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  banner('Building images (real Docker)');
  for (const key of ['one', 'two', 'three']) build(VERSION_TAG(COMMITS[key]), COMMITS[key]);
  build(dockerTagByDigest[DIGESTS.bad], 'f'.repeat(40));
  console.log('built 4 images tagged t18reto-app:*');

  const render = new FakeRender({
    pollsUntilLive: 2,
    onLive: (ref) => startContainer(dockerTagByDigest[ref.split('@')[1]]),
  });
  const github = new FakeGitHub();
  const discord = new FakeDiscord();
  const registry = new FakeRegistry({
    manifests: Object.fromEntries(
      Object.entries(COMMITS).flatMap(([k, v]) => [
        [`owner/repo:sha-${v}`, DIGESTS[k]],
        [`owner/repo:${DIGESTS[k]}`, DIGESTS[k]],
      ]),
    ),
  });
  await Promise.all([
    render.listen(PORTS.render),
    github.listen(PORTS.github),
    discord.listen(PORTS.discord),
    registry.listen(PORTS.registry),
  ]);

  const summary = join(mkdtempSync(join(tmpdir(), 't18reto-e2e-')), 'summary.md');
  writeFileSync(summary, '');
  const baseEnv = {
    GITHUB_TOKEN: 'ghs_token',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_API_URL: github.url,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '1001',
    GITHUB_ACTOR: 'demo-user',
    RENDER_API_KEY: 'rnd_key',
    RENDER_SERVICE_ID: 'srv-1',
    RENDER_API_URL: `${render.url}/v1`,
    APP_URL: `http://127.0.0.1:${PORTS.app}`,
    REGISTRY_URL: registry.url,
    DISCORD_WEBHOOK_URL: `${discord.url}/api/webhooks/1/token`,
  };
  const deploy = (environment, commit, digest, extra = []) =>
    runScript(
      'scripts/cd-deploy.mjs',
      ['--environment', environment, '--sha', commit, '--image', IMAGE, '--digest', digest, '--health-delay', '1', '--render-interval', '1', '--health-attempts', '6', ...extra],
      baseEnv,
    );

  try {
    banner('1. Staging: first deployment (no previous good deployment)');
    let r = await deploy('staging', COMMITS.one, DIGESTS.one);
    expect(r.code === 0 && (await servedCommit()) === COMMITS.one, 'staging serves commit 1111111');

    banner('2. Staging: second deployment');
    r = await deploy('staging', COMMITS.two, DIGESTS.two);
    expect(r.code === 0 && (await servedCommit()) === COMMITS.two, 'staging serves commit 2222222');

    banner('3. Staging: simulate_failure -> automatic rollback to 2222222');
    r = await deploy('staging', COMMITS.three, DIGESTS.three, ['--simulate-failure']);
    expect(r.code === 1 && /rolled_back/.test(r.out), 'job fails with result rolled_back');
    expect((await servedCommit()) === COMMITS.two, 'staging is back on commit 2222222');

    banner('4. Staging: REAL failure (image reports another commit) -> automatic rollback');
    r = await deploy('staging', COMMITS.bad, DIGESTS.bad);
    expect(r.code === 1 && /commit mismatch/.test(r.out), 'health check detects the commit mismatch');
    expect((await servedCommit()) === COMMITS.two, 'staging is back on commit 2222222');

    banner('5. Notification on the failed deploy (embed captured by the fake Discord)');
    await runScript('scripts/notify-discord.mjs', ['--status', 'rolled_back', '--environment', 'staging', '--sha', COMMITS.bad, '--url', baseEnv.APP_URL, '--detail', 'Rolled back to 2222222'], baseEnv);
    const embed = discord.messages.at(-1)?.embeds?.[0];
    expect(Boolean(embed) && /rolled back/i.test(embed.title), `Discord embed received: "${embed?.title}"`);

    banner('6. Production: promote the commit that passed staging (read-only smoke)');
    r = await runScript('scripts/deployments.mjs', ['last-good', '--environment', 'staging', '--require'], baseEnv);
    expect(r.code === 0 && r.out.includes(COMMITS.two), 'last good staging deployment is 2222222');
    r = await runScript('scripts/resolve-image.mjs', ['--image', IMAGE, '--sha', COMMITS.two, '--digest', DIGESTS.two, '--strict-tag'], baseEnv);
    expect(r.code === 0, 'image sha-2222222 exists in the registry with the staged digest');
    const itemsBefore = (await (await fetch(`${baseEnv.APP_URL}/api/items`)).json()).count;
    r = await deploy('production', COMMITS.two, DIGESTS.two, ['--smoke-mode', 'readonly']);
    const itemsAfter = (await (await fetch(`${baseEnv.APP_URL}/api/items`)).json()).count;
    expect(r.code === 0 && itemsAfter === itemsBefore, `production smoke tests created no data (items ${itemsBefore} -> ${itemsAfter})`);
    r = await runScript('scripts/deployments.mjs', ['by-sha', '--environment', 'production', '--sha', COMMITS.one], baseEnv);
    expect(r.out.includes('No record'), 'a commit that never passed staging/production is not found');

    banner('7. New version: staging first, then production, then manual rollback to the previous release');
    r = await deploy('staging', COMMITS.three, DIGESTS.three);
    expect(r.code === 0, 'commit 3333333 passes staging this time');
    r = await runScript('scripts/deployments.mjs', ['by-sha', '--environment', 'staging', '--sha', COMMITS.three, '--require'], baseEnv);
    expect(r.code === 0, 'production validation finds 3333333 in the staging history');
    r = await deploy('production', COMMITS.three, DIGESTS.three, ['--smoke-mode', 'readonly']);
    expect(r.code === 0 && (await servedCommit()) === COMMITS.three, 'production serves commit 3333333');
    r = await deploy('production', COMMITS.two, DIGESTS.two, ['--mode', 'rollback', '--no-auto-rollback', '--smoke-mode', 'readonly']);
    expect(r.code === 0 && (await servedCommit()) === COMMITS.two, 'rollback restored commit 2222222');
    r = await runScript('scripts/deployments.mjs', ['last-good', '--environment', 'production'], baseEnv);
    expect(r.out.includes('rolled back to') && r.out.includes('found=false'), 'the rollback is not offered as a promotion candidate');

    banner('8. Deployment history recorded in the (fake) GitHub Deployments API');
    for (const d of github.deployments) {
      console.log(`  #${d.id} ${d.environment.padEnd(10)} ${d.payload.sha.slice(0, 7)} -> ${github.statuses.get(d.id).map((s) => s.state).reverse().join(' > ')}`);
    }

    banner('Step summary written by the last runs');
    console.log(readFileSync(summary, 'utf8').split('\n').slice(0, 24).join('\n'));
  } finally {
    banner('Cleanup (only t18reto-* resources)');
    for (const cmd of [['rm', '-f', CONTAINER], ['rmi', '-f', ...new Set(Object.values(dockerTagByDigest)), VERSION_TAG('f'.repeat(40))]]) {
      try {
        docker(...cmd);
      } catch {
        // already gone
      }
    }
    await Promise.all([render.close(), github.close(), discord.close(), registry.close()]);
  }
  console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
