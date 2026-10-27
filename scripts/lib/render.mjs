import { ApiError, backoffDelay, httpJson, sleep as realSleep } from './util.mjs';

// API reference consulted: https://api-docs.render.com/reference/create-deploy
// and /retrieve-deploy (see docs/plataformas.md).
const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);

export class RenderClient {
  constructor({
    apiKey,
    serviceId,
    apiUrl = 'https://api.render.com/v1',
    fetchImpl = fetch,
    sleep = realSleep,
    log = console.log,
  }) {
    if (!apiKey) throw new Error('RENDER_API_KEY is required');
    if (!serviceId) throw new Error('RENDER_SERVICE_ID is required');
    this.apiKey = apiKey;
    this.serviceId = serviceId;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.log = log;
  }

  async request(method, path, body, { retries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const res = await httpJson(`${this.apiUrl}/services/${encodeURIComponent(this.serviceId)}${path}`, {
        method,
        body,
        fetchImpl: this.fetchImpl,
        headers: { authorization: `Bearer ${this.apiKey}` },
      });
      const transient = res.status === 429 || res.status >= 500;
      if (transient && attempt <= retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt, { baseMs: 1000 }));
        continue;
      }
      if (!res.ok) {
        const reason = res.data?.message || 'no message';
        throw new ApiError(`Render API ${method} ${path || '/'} failed with ${res.status}: ${reason}`, res);
      }
      return res;
    }
  }

  // Returns the new deploy object. A 202 means the deploy was queued without a
  // body, so the newest deploy is looked up instead.
  async triggerDeploy(imageRef) {
    const res = await this.request('POST', '/deploys', { imageUrl: imageRef, clearCache: 'do_not_clear' });
    if (res.data?.id) return res.data;
    this.log(`Render queued the deploy (HTTP ${res.status}); looking up the newest deploy`);
    const list = await this.request('GET', '/deploys?limit=1');
    const first = (list.data || [])[0];
    const newest = first?.deploy ?? first;
    if (!newest?.id) throw new Error('Render accepted the deploy but no deploy could be found');
    return newest;
  }

  async getDeploy(deployId) {
    return (await this.request('GET', `/deploys/${encodeURIComponent(deployId)}`)).data;
  }

  async waitForLive(deployId, { timeoutMs = 600000, intervalMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    for (;;) {
      const deploy = await this.getDeploy(deployId);
      if (deploy.status !== last) {
        this.log(`deploy ${deployId}: ${deploy.status}`);
        last = deploy.status;
      }
      if (deploy.status === 'live') return deploy;
      if (FAILED.has(deploy.status)) {
        throw new Error(`Render deploy ${deployId} ended with status "${deploy.status}"`);
      }
      if (Date.now() + intervalMs > deadline) {
        throw new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for deploy ${deployId} (last status "${deploy.status}")`,
        );
      }
      await this.sleep(intervalMs);
    }
  }
}

// Deploys `imageRef` and waits until it is live. If Render reports the image
// digest, it must match the one we asked for.
export async function deployImage(client, imageRef, { expectedDigest, timeoutMs, intervalMs } = {}) {
  const created = await client.triggerDeploy(imageRef);
  client.log(`triggered deploy ${created.id} for ${imageRef}`);
  const live = await client.waitForLive(created.id, { timeoutMs, intervalMs });
  const reported = live.image?.sha;
  if (expectedDigest && reported && reported !== expectedDigest) {
    throw new Error(`Render is running digest ${reported}, expected ${expectedDigest}`);
  }
  return { deployId: created.id, status: live.status, digest: reported || null };
}
