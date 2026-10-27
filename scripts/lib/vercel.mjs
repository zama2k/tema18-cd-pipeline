import { ApiError, httpJson } from './util.mjs';

// Vercel REST API (docs/plataformas.md): GET /v7/deployments and
// DELETE /v13/deployments/{id}. The list endpoint has no documented filter for
// custom metadata, so deployments are listed per project and filtered here.
export class VercelClient {
  constructor({ token, projectId, teamId, apiUrl = 'https://api.vercel.com', fetchImpl = fetch }) {
    if (!token) throw new Error('VERCEL_TOKEN is required');
    if (!projectId) throw new Error('VERCEL_PROJECT_ID is required');
    this.token = token;
    this.projectId = projectId;
    this.teamId = teamId;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, query = {}) {
    const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== ''));
    if (this.teamId) params.set('teamId', this.teamId);
    const qs = params.toString();
    const res = await httpJson(`${this.apiUrl}${path}${qs ? `?${qs}` : ''}`, {
      method,
      fetchImpl: this.fetchImpl,
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404 && method === 'DELETE') return { gone: true };
    if (!res.ok) throw new ApiError(`Vercel API ${method} ${path} failed with ${res.status}`, res);
    return res.data;
  }

  async listByPullRequest(pr, { maxPages = 10 } = {}) {
    const found = [];
    let until;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.request('GET', '/v7/deployments', { projectId: this.projectId, limit: 100, until });
      found.push(...data.deployments.filter((d) => String(d.meta?.githubPrId) === String(pr)));
      until = data.pagination?.next;
      if (!until) break;
    }
    return found;
  }

  async remove(uid) {
    return this.request('DELETE', `/v13/deployments/${encodeURIComponent(uid)}`);
  }
}

export async function removePreviews(client, pr, log = console.log) {
  const deployments = await client.listByPullRequest(pr);
  for (const d of deployments) {
    await client.remove(d.uid);
    log(`removed deployment ${d.uid} (${d.url})`);
  }
  return deployments.length;
}
