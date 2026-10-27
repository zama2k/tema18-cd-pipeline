#!/usr/bin/env node
// Runs every local verification and stores the REAL output in evidencias/local/
// (plain text, no ANSI codes, repository path replaced by <repo>).
//   node scripts/dev/collect-evidence.mjs
// Docker resources use the `t18reto-` prefix and port 3201 and are removed at the end.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const outDir = join(root, 'evidencias', 'local');
mkdirSync(outDir, { recursive: true });

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const clean = (text) =>
  text
    .replace(ANSI, '')
    .replaceAll(root.replaceAll('\\', '\\\\'), '<repo>') // JSON-escaped form
    .replaceAll(root, '<repo>')
    .replaceAll(root.replaceAll('\\', '/'), '<repo>')
    .replaceAll(process.env.USERPROFILE || '\u0000', '<home>')
    .replace(/\r\n/g, '\n');

function run(command, { cwd = root, env = {}, shell = true } = {}) {
  const result = spawnSync(command, {
    cwd,
    shell,
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', FORCE_COLOR: '0', NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: result.status ?? 1, out: `${result.stdout || ''}${result.stderr || ''}` };
}

function record(file, steps) {
  const chunks = [];
  let worst = 0;
  for (const step of steps) {
    const { code, out } = typeof step === 'string' ? run(step) : step.fn();
    const label = typeof step === 'string' ? step : step.label;
    chunks.push(`$ ${label}\n${out.trimEnd()}\n[exit code: ${code}]\n`);
    worst = Math.max(worst, step.expectFailure ? (code === 0 ? 1 : 0) : code);
  }
  writeFileSync(join(outDir, file), clean(chunks.join('\n')));
  console.log(`${worst === 0 ? 'ok  ' : 'FAIL'} ${file}`);
  return worst;
}

let failures = 0;
const add = (n) => {
  failures += n ? 1 : 0;
};

const SHA = run('git rev-parse HEAD').out.trim();
const winRoot = root.replaceAll('\\', '/');

add(record('00-entorno.txt', ['node -v', 'npm -v', 'docker --version', 'git --version']));
add(record('01-npm-ci.txt', ['npm ci']));
add(record('02-lint.txt', ['npm run lint']));
add(record('03-jest-cobertura.txt', ['npm test']));
add(
  record('04-jest-umbral-incumplido.txt', [
    {
      label: 'npx jest --coverageThreshold={"global":{"branches":99}}   (the gate must FAIL)',
      expectFailure: true,
      fn: () => run('npx jest --coverageThreshold={\\"global\\":{\\"branches\\":99}}'),
    },
  ]),
);
add(record('05-tests-scripts-pipeline.txt', ['npm run test:scripts']));
add(record('06-build.txt', ['npm run build']));

add(
  record('07-docker-contenedor.txt', [
    `docker build -t t18reto-evidence:local --build-arg GIT_SHA=${SHA} --build-arg APP_VERSION=1.0.0 .`,
    'docker image inspect t18reto-evidence:local --format "size={{.Size}} user={{.Config.User}} cmd={{.Config.Cmd}}"',
    'docker rm -f t18reto-evidence',
    'docker run -d --name t18reto-evidence -p 3201:3000 t18reto-evidence:local',
    {
      label: 'curl http://127.0.0.1:3201/health   (after waiting for startup)',
      fn: () => {
        run('node -e "setTimeout(()=>{},3000)"');
        return run('curl -s http://127.0.0.1:3201/health');
      },
    },
    { label: `expected commit: ${SHA}`, fn: () => ({ code: 0, out: '' }) },
    'node scripts/health-check.mjs --url http://127.0.0.1:3201 --expected-commit ' + SHA + ' --attempts 5 --delay 1',
    'node scripts/smoke.mjs --url http://127.0.0.1:3201 --mode full',
    {
      label: 'node scripts/health-check.mjs ... --expected-commit <wrong sha>   (must FAIL)',
      expectFailure: true,
      fn: () => run(`node scripts/health-check.mjs --url http://127.0.0.1:3201 --expected-commit ${'0'.repeat(40)} --attempts 2 --delay 1`),
    },
    {
      label: 'docker inspect --format health status (after the HEALTHCHECK start period)',
      fn: () => {
        run('node -e "setTimeout(()=>{},12000)"');
        return run('docker inspect t18reto-evidence --format "health={{.State.Health.Status}}"');
      },
    },
    {
      label: 'docker stop t18reto-evidence   (SIGTERM, graceful shutdown)',
      fn: () => {
        const started = Date.now();
        const stop = run('docker stop t18reto-evidence');
        const logs = run('docker logs t18reto-evidence');
        const exit = run('docker inspect t18reto-evidence --format "exit code={{.State.ExitCode}}"');
        return { code: stop.code, out: `${stop.out}stopped in ${Date.now() - started} ms\n${logs.out}${exit.out}` };
      },
    },
    'docker rm -f t18reto-evidence',
    'docker rmi -f t18reto-evidence:local',
  ]),
);

add(
  record('08-actionlint-shellcheck.txt', [
    `docker run --rm -v "${winRoot}:/repo" -w /repo rhysd/actionlint:1.7.12 -color`,
    `docker run --rm -v "${winRoot}:/mnt" koalaman/shellcheck:v0.11.0 scripts/setup-github.sh`,
  ]),
);

add(
  record('09-vercel-build-local.txt', [
    {
      label: 'prepare .vercel/project.json with placeholder ids (no Vercel account needed)',
      fn: () => {
        mkdirSync(join(root, '.vercel'), { recursive: true });
        writeFileSync(
          join(root, '.vercel', 'project.json'),
          JSON.stringify({ projectId: 'prj_localcheck000000000000000000', orgId: 'team_localcheck00000000000000', settings: { framework: null } }),
        );
        return { code: 0, out: 'written (the directory is git-ignored)' };
      },
    },
    'npx --yes vercel@65.4.0 build',
    'node -e "const c=require(\'./.vercel/output/config.json\');console.log(JSON.stringify(c.framework));console.log(require(\'fs\').readdirSync(\'.vercel/output/functions/api\'))"',
    {
      label: 'git checkout package-lock.json   (a local vercel build runs npm install and rewrites the lockfile on Windows)',
      fn: () => run('git checkout package-lock.json'),
    },
  ]),
);

add(record('10-flujo-cd-local-e2e.txt', ['node scripts/dev/local-e2e.mjs']));

console.log(failures === 0 ? 'all evidence collected' : `${failures} evidence file(s) with unexpected results`);
process.exitCode = failures === 0 ? 0 : 1;
