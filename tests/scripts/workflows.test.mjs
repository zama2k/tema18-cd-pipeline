import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Static guards for mistakes actionlint cannot see. No YAML dependency: the
// workflows are split into jobs by indentation, which is enough for these checks.
const dir = new URL('../../.github/workflows/', import.meta.url);
const root = dir.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const workflows = Object.fromEntries(
  readdirSync(root)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f, readFileSync(join(root, f), 'utf8')]),
);

function jobsOf(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 6);
  const jobs = {};
  let current = null;
  for (const line of body.split('\n')) {
    const match = line.match(/^ {2}([\w-]+):\s*$/);
    if (match) {
      current = match[1];
      jobs[current] = '';
    } else if (current) {
      jobs[current] += `${line}\n`;
    }
  }
  return jobs;
}

test('every gh command that needs a repository has GH_REPO or --repo (jobs without checkout have no git remote)', () => {
  const needsRepo = /^\s*gh (release|pr|issue|run|workflow|variable|secret|repo|label)\b/m;
  let checked = 0;
  for (const [file, text] of Object.entries(workflows)) {
    for (const [job, body] of Object.entries(jobsOf(text))) {
      if (!needsRepo.test(body)) continue;
      checked += 1;
      assert.ok(/GH_REPO:|--repo\b/.test(body), `${file} job "${job}" calls gh without GH_REPO/--repo`);
    }
  }
  assert.ok(checked >= 1, 'expected at least the release job to be checked');
});

test('gh api calls always name the repository explicitly', () => {
  for (const [file, text] of Object.entries(workflows)) {
    for (const match of text.matchAll(/gh api "?([^\s"]+)/g)) {
      assert.match(match[1], /^repos\/\$GITHUB_REPOSITORY\//, `${file}: gh api ${match[1]}`);
    }
  }
});
