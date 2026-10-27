import { ApiError, httpJson } from './util.mjs';

// Minimal GitHub REST client (Deployments, issue comments). Only what the
// pipeline needs; the base URL is injectable so tests can use a local fake.
export class GitHubApi {
  constructor({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
    if (!token) throw new Error('GITHUB_TOKEN is required');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('GITHUB_REPOSITORY must look like owner/repo');
    this.token = token;
    this.repo = repo;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, body) {
    const res = await httpJson(`${this.apiUrl}/repos/${this.repo}${path}`, {
      method,
      body,
      fetchImpl: this.fetchImpl,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tema18-cd-pipeline',
      },
    });
    if (!res.ok) {
      const detail = res.data?.message ? `: ${res.data.message}` : '';
      throw new ApiError(`GitHub API ${method} ${path} failed with ${res.status}${detail}`, res);
    }
    return res.data;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  patch(path, body) {
    return this.request('PATCH', path, body);
  }

  async paginate(path, { maxPages = 5, perPage = 100 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const batch = await this.get(`${path}${sep}per_page=${perPage}&page=${page}`);
      items.push(...batch);
      if (batch.length < perPage) break;
    }
    return items;
  }
}
