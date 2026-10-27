#!/usr/bin/env node
// "npm run build": the app has no bundling step, so the build verifies what can
// actually break a production start:
//   1. every runtime file parses (node --check),
//   2. every third-party package required at runtime is a production dependency
//      (a devDependency would work locally and crash in the container),
//   3. the app factory loads and returns a request handler.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fail, isMain } from './lib/util.mjs';

const RUNTIME_DIRS = ['src', 'api'];

function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

export function requiredPackages(source) {
  const names = new Set();
  for (const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('node:') || builtinModules.includes(spec)) continue;
    names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  return names;
}

export function build(root = process.cwd()) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const files = RUNTIME_DIRS.filter((d) => statSync(join(root, d), { throwIfNoEntry: false })?.isDirectory()).flatMap(
    (d) => listJs(join(root, d)),
  );
  for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });

  const missing = new Set();
  for (const file of files) {
    for (const name of requiredPackages(readFileSync(file, 'utf8'))) {
      if (!pkg.dependencies?.[name]) missing.add(name);
    }
  }
  if (missing.size > 0) {
    throw new Error(`Runtime code requires packages that are not in "dependencies": ${[...missing].join(', ')}`);
  }

  const { createApp } = createRequire(join(resolve(root), 'package.json'))('./src/app.js');
  if (typeof createApp() !== 'function') throw new Error('createApp() did not return a request handler');
  return { files: files.length };
}

if (isMain(import.meta.url)) {
  try {
    const { files } = build();
    console.log(`build ok: ${files} runtime file(s) parsed, dependencies verified, app factory loads`);
  } catch (err) {
    fail(err.message);
  }
}
