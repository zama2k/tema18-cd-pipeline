#!/usr/bin/env node
// Resolve (and verify) the immutable image for a commit.
//   node scripts/resolve-image.mjs --image ghcr.io/owner/repo --sha <40 hex> [--digest sha256:... | --digest-file path.json]
// Without a digest, the digest is read from the `sha-<sha>` tag. With one, it must exist in the registry;
// --strict-tag additionally requires the `sha-<sha>` tag to exist and point to that same digest.
// Outputs: image, digest, ref (image@digest). Env: GITHUB_TOKEN + GITHUB_ACTOR (optional, public packages work
// anonymously), REGISTRY_URL (tests).
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DIGEST_RE, Registry, shaTag, splitImage } from './lib/registry.mjs';
import { fail, isMain, setOutputs, warning } from './lib/util.mjs';

export async function resolveImage({ image, sha, digest, registry, strictTag = false }) {
  const { name } = splitImage(image);
  if (digest) {
    if (!DIGEST_RE.test(digest)) throw new Error(`"${digest}" is not a sha256 digest`);
    const byDigest = await registry.manifest(name, digest);
    if (!byDigest.exists) throw new Error(`Image ${image}@${digest} does not exist in the registry`);
    const byTag = await registry.manifest(name, shaTag(sha));
    if (strictTag && !byTag.exists) {
      throw new Error(`Image ${image}:${shaTag(sha)} does not exist in the registry`);
    }
    if (strictTag && byTag.digest !== digest) {
      throw new Error(`Tag ${shaTag(sha)} points to ${byTag.digest}, not to ${digest}: the image was rebuilt after it was verified`);
    }
    if (byTag.exists && byTag.digest !== digest) {
      warning(`Tag ${shaTag(sha)} now points to ${byTag.digest}; using ${digest} from the CI run that built it`);
    }
    return { image, digest, ref: `${image}@${digest}` };
  }
  const byTag = await registry.manifest(name, shaTag(sha));
  if (!byTag.exists) throw new Error(`Image ${image}:${shaTag(sha)} does not exist in the registry (did CI push it?)`);
  return { image, digest: byTag.digest, ref: `${image}@${byTag.digest}` };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      image: { type: 'string' },
      sha: { type: 'string' },
      digest: { type: 'string' },
      'digest-file': { type: 'string' },
      'strict-tag': { type: 'boolean', default: false },
    },
  });
  if (!values.image || !/^[0-9a-f]{40}$/.test(values.sha || '')) {
    throw new Error('usage: resolve-image.mjs --image <host/owner/repo> --sha <40 hex> [--digest d | --digest-file f] [--strict-tag]');
  }
  let digest = values.digest;
  if (values['digest-file']) {
    const recorded = JSON.parse(readFileSync(values['digest-file'], 'utf8'));
    if (recorded.sha !== values.sha) {
      throw new Error(`The digest file belongs to ${recorded.sha}, not ${values.sha}`);
    }
    digest = recorded.digest;
  }
  const registry = new Registry({
    registryUrl: env.REGISTRY_URL,
    user: env.GITHUB_ACTOR,
    token: env.GITHUB_TOKEN,
  });
  const resolved = await resolveImage({ image: values.image.toLowerCase(), sha: values.sha, digest, registry, strictTag: values['strict-tag'] });
  console.log(`resolved ${resolved.ref}`);
  setOutputs(resolved, env);
  return resolved;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
