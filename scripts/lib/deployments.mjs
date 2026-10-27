import { ApiError } from './util.mjs';

// Our own deployment records carry the image digest in `payload`. They use a
// dedicated task name so they can be told apart from the records GitHub
// creates on its own for jobs that declare `environment:` (those have an
// empty payload and, for workflow_run, the wrong sha).
export const TASK = 'deploy-image';

const byNewest = (a, b) => b.id - a.id;

// `mode` is 'deploy' or 'rollback'. A rollback record says "this environment now
// runs an old version"; it must never be offered as a candidate for promotion.
export async function createDeployment(
  api,
  { environment, sha, image, digest, description, mode = 'deploy', defaultBranch = 'main' },
) {
  const payload = { sha, image, digest, mode };
  const base = {
    task: TASK,
    environment,
    auto_merge: false,
    required_contexts: [],
    description: (description || `Deploy ${sha.slice(0, 7)}`).slice(0, 140),
    payload,
    transient_environment: false,
    production_environment: environment === 'production',
  };
  try {
    return (await api.post('/deployments', { ...base, ref: sha })).id;
  } catch (err) {
    // Some environments only accept branch refs (deployment branch policy).
    // Fall back to the default branch; the real sha stays in the payload.
    if (!(err instanceof ApiError) || err.status !== 422) throw err;
    return (await api.post('/deployments', { ...base, ref: defaultBranch })).id;
  }
}

export function setStatus(api, deploymentId, { state, description, environmentUrl, logUrl }) {
  return api.post(`/deployments/${deploymentId}/statuses`, {
    state,
    description: (description || '').slice(0, 140),
    ...(environmentUrl ? { environment_url: environmentUrl } : {}),
    ...(logUrl ? { log_url: logUrl } : {}),
  });
}

// A deployment is "good" if it reached `success` at some point and was never
// marked failed afterwards. GitHub later appends `inactive` to superseded
// deployments, so looking at the newest status alone would discard them.
export function isGood(statuses) {
  const states = new Set(statuses.map((s) => s.state));
  return states.has('success') && !states.has('failure') && !states.has('error');
}

function toRecord(deployment) {
  const payload = typeof deployment.payload === 'string' ? safeParse(deployment.payload) : deployment.payload || {};
  return {
    id: deployment.id,
    sha: payload.sha || deployment.sha,
    image: payload.image || null,
    digest: payload.digest || null,
    mode: payload.mode || 'deploy',
    createdAt: deployment.created_at,
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function candidates(api, environment, { maxPages = 3 } = {}) {
  const query = `/deployments?environment=${encodeURIComponent(environment)}&task=${TASK}`;
  const all = await api.paginate(query, { maxPages });
  return all.sort(byNewest);
}

async function firstGood(api, list, accept) {
  for (const deployment of list) {
    const record = toRecord(deployment);
    if (!record.digest || !accept(record)) continue;
    const statuses = await api.get(`/deployments/${deployment.id}/statuses?per_page=100`);
    if (isGood(statuses)) return record;
  }
  return null;
}

// What the environment is running now (rollbacks included). This is the
// target of an automatic rollback.
export async function findLastGood(api, environment) {
  return firstGood(api, await candidates(api, environment), () => true);
}

// What may be promoted by default. If the newest good record is a rollback, the
// environment is running an old version on purpose: the previous record is the
// version that was rolled back FROM, and the rollback target was already
// released, so there is no safe default and the sha must be given explicitly.
export async function findPromotable(api, environment) {
  const current = await findLastGood(api, environment);
  if (current && current.mode === 'rollback') return { record: null, rolledBack: current };
  return { record: current, rolledBack: null };
}

export async function findGoodBySha(api, environment, sha) {
  // The `sha` filter only matches the deployment's own sha, which is the
  // default branch head when the branch fallback was used: filter locally.
  const list = await candidates(api, environment);
  // Only regular deployments prove that a commit went through the environment.
  return firstGood(api, list, (record) => record.sha === sha && record.mode !== 'rollback');
}
