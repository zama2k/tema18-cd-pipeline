#!/usr/bin/env node
// Deploy an image to an image-backed Render service and wait until it is live.
//   node scripts/render-deploy.mjs --image ghcr.io/owner/repo@sha256:... [--timeout 600] [--interval 5]
// Env: RENDER_API_KEY, RENDER_SERVICE_ID, RENDER_API_URL (optional, for tests).
import { parseArgs } from 'node:util';
import { RenderClient, deployImage } from './lib/render.mjs';
import { fail, isMain, notice, setOutputs } from './lib/util.mjs';

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      image: { type: 'string' },
      timeout: { type: 'string', default: '600' },
      interval: { type: 'string', default: '5' },
    },
  });
  if (!values.image) throw new Error('usage: render-deploy.mjs --image <image reference>');

  if (!env.RENDER_API_KEY || !env.RENDER_SERVICE_ID) {
    notice('RENDER_API_KEY or RENDER_SERVICE_ID is not configured: skipping the Render deploy');
    setOutputs({ skipped: true }, env);
    return null;
  }
  const client = new RenderClient({
    apiKey: env.RENDER_API_KEY,
    serviceId: env.RENDER_SERVICE_ID,
    apiUrl: env.RENDER_API_URL,
  });
  const digest = values.image.includes('@') ? values.image.split('@')[1] : undefined;
  const result = await deployImage(client, values.image, {
    expectedDigest: digest,
    timeoutMs: Number(values.timeout) * 1000,
    intervalMs: Number(values.interval) * 1000,
  });
  setOutputs({ skipped: false, deploy_id: result.deployId, status: result.status }, env);
  return result;
}

if (isMain(import.meta.url)) {
  main().catch((err) => fail(err.message));
}
