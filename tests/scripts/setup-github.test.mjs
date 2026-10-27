import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../../scripts/setup-github.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// A fake `gh` that records every call (and the JSON bodies sent on stdin).
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 't18reto-gh-'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const shim = join(dir, 'gh');
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
args="$*"
if [[ "$args" == "api user --jq .login" ]]; then echo ana; exit 0; fi
if [[ "$args" == "api user --jq .id" ]]; then echo 4242; exit 0; fi
if [[ "$args" == "repo view"* ]]; then echo owner/repo; exit 0; fi
if [[ "$args" == *"deployment-branch-policies --jq"* ]]; then printf '%s' "$GH_EXISTING_POLICIES"; exit 0; fi
echo "CALL: $args" >> "${log.replace(/\\/g, '/')}"
if [[ "$args" == *"--input -"* ]]; then cat >> "${log.replace(/\\/g, '/')}"; fi
`,
  );
  chmodSync(shim, 0o755);
  return { dir, calls: () => readFileSync(log, 'utf8') };
}

function run(args, extraEnv = {}) {
  const gh = fakeGh();
  const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${gh.dir}${delimiter}${process.env.PATH}`, ...extraEnv },
  });
  return { ...result, calls: gh.calls() };
}

test('configures environments, variables, token defaults and branch protection', () => {
  const r = run(['owner/repo'], { STAGING_APP_URL: 'https://stg.example', STAGING_RENDER_SERVICE_ID: 'srv-stg' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /CALL: api -X PUT repos\/owner\/repo\/environments\/preview/);
  assert.match(r.calls, /CALL: api -X PUT repos\/owner\/repo\/environments\/staging/);
  assert.match(r.calls, /CALL: api -X PUT repos\/owner\/repo\/environments\/production/);
  assert.match(r.calls, /CALL: variable set APP_URL --env staging --repo owner\/repo --body https:\/\/stg\.example/);
  assert.match(r.calls, /CALL: variable set RENDER_SERVICE_ID --env staging --repo owner\/repo --body srv-stg/);
  assert.match(r.calls, /CALL: api -X PUT repos\/owner\/repo\/branches\/main\/protection/);
  assert.match(r.calls, /"required_approving_review_count": 1/);
  assert.match(r.calls, /"context": "CI OK"/);
  assert.match(r.calls, /"enforce_admins": false/);
  assert.match(r.calls, /default_workflow_permissions=read/);
});

test('production gets the authenticated user as required reviewer and a 1 minute wait timer', () => {
  const r = run(['owner/repo']);
  assert.match(r.calls, /"wait_timer": 1,/);
  assert.match(r.calls, /"reviewers": \[\{ "type": "User", "id": 4242 \}\]/);
  assert.match(r.calls, /"prevent_self_review": false/);
});

test('the wait timer is configurable and validated', () => {
  assert.match(run(['owner/repo'], { WAIT_TIMER_MINUTES: '5' }).calls, /"wait_timer": 5,/);
  const bad = run(['owner/repo'], { WAIT_TIMER_MINUTES: 'soon' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /WAIT_TIMER_MINUTES/);
});

test('restricts staging and production deployments to main, once (idempotent)', () => {
  const first = run(['owner/repo']);
  assert.equal((first.calls.match(/deployment-branch-policies -f name=main -f type=branch/g) || []).length, 2);
  const again = run(['owner/repo'], { GH_EXISTING_POLICIES: 'main\n' });
  assert.equal((again.calls.match(/deployment-branch-policies/g) || []).length, 0);
  assert.match(again.stdout, /already present/);
});

test('variables without a value are reported, not set to empty strings', () => {
  const r = run(['owner/repo']);
  assert.doesNotMatch(r.calls, /variable set APP_URL/);
  assert.match(r.stdout, /staging: APP_URL not set/);
  assert.match(r.calls, /variable set NODE_ENV --env production/);
});

test('discovers the repository when none is given and rejects malformed names', () => {
  assert.match(run([]).stdout, /Configuring owner\/repo/);
  const bad = run(['not a repo']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /owner\/repo/);
});

test('prints the secrets to create but never creates them', () => {
  const r = run(['owner/repo']);
  assert.doesNotMatch(r.calls, /secret set/);
  for (const name of ['DISCORD_WEBHOOK_URL', 'VERCEL_TOKEN', 'VERCEL_AUTOMATION_BYPASS_SECRET', 'RENDER_API_KEY']) {
    assert.ok(r.stdout.includes(name), name);
  }
});

test('DRY_RUN prints the calls without executing them', () => {
  const r = run(['owner/repo'], { DRY_RUN: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls, '');
  assert.match(r.stdout, /\[dry-run\] gh api -X PUT repos\/owner\/repo\/branches\/main\/protection/);
});
