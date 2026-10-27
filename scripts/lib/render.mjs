import { ApiError, backoffDelay, httpJson, sleep as realSleep, warning } from './util.mjs';

// API reference consulted: https://api-docs.render.com/reference/create-deploy
// and /retrieve-deploy (see docs/plataformas.md).
const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);

// Allowance for the difference between the runner's clock and Render's.
const CLOCK_SKEW_MS = 10000;

const sameImage = (a, b) => {
  const clean = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  return clean(a) !== '' && clean(a) === clean(b);
};

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
  // body. The newest deploy of the service may then still be the PREVIOUS one
  // (already live), so the new deploy is identified by the image we asked for
  // and by being created after our request, retrying until it shows up.
  async triggerDeploy(imageRef, { lookupAttempts = 10, lookupIntervalMs = 2000 } = {}) {
    const requestedAt = Date.now();
    const res = await this.request('POST', '/deploys', { imageUrl: imageRef, clearCache: 'do_not_clear' });
    if (res.data?.id) return res.data;
    this.log(`Render queued the deploy (HTTP ${res.status}); looking for it in the deploy list`);
    for (let attempt = 1; attempt <= lookupAttempts; attempt++) {
      const list = await this.request('GET', '/deploys?limit=10');
      const deploys = (list.data || []).map((entry) => entry.deploy ?? entry);
      const created = deploys.find(
        (d) => d?.id && sameImage(d.image?.ref, imageRef) && Date.parse(d.createdAt) >= requestedAt - CLOCK_SKEW_MS,
      );
      if (created) return created;
      if (attempt < lookupAttempts) await this.sleep(lookupIntervalMs);
    }
    throw new Error(`Render accepted the deploy of ${imageRef} but it did not show up in the deploy list`);
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

// Render's documentation does not fix the format of image.sha, so compare
// loosely: case-insensitive, without the "sha256:" prefix or an image@ part.
export const normalizeDigest = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .split('@')
    .pop()
    .replace(/^sha256:/, '');

// Deploys imageRef and waits until it is live. A digest reported by Render
// that still differs after normalisation is only a warning: the strong check
// is /health.commit, which the caller verifies next.
export async function deployImage(client, imageRef, { expectedDigest, timeoutMs, intervalMs } = {}) {
  const created = await client.triggerDeploy(imageRef);
  client.log(`triggered deploy ${created.id} for ${imageRef}`);
  const live = await client.waitForLive(created.id, { timeoutMs, intervalMs });
  const reported = live.image?.sha;
  let digestMismatch = false;
  if (expectedDigest && reported && normalizeDigest(reported) !== normalizeDigest(expectedDigest)) {
    digestMismatch = true;
    warning(`Render reports image digest ${reported}, expected ${expectedDigest}; relying on /health.commit`);
  }
  return { deployId: created.id, status: live.status, digest: reported || null, digestMismatch };
}
