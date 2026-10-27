// Local fakes of the third-party APIs the pipeline talks to (Render, GitHub,
// Vercel, Discord, an OCI registry). They implement only the documented subset
// the scripts use, so the clients can be tested without accounts or network.
import { createServer } from 'node:http';

class FakeServer {
  constructor() {
    this.requests = [];
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  async #handle(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const url = new URL(req.url, 'http://fake');
    const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: req.headers };
    this.requests.push(record);
    try {
      const out = (await this.route(record)) || { status: 404, body: { message: 'not found' } };
      const payload = out.body === undefined ? '' : JSON.stringify(out.body);
      res.writeHead(out.status, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(req.method === 'HEAD' ? undefined : payload);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: err.message }));
    }
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.url = `http://${host}:${this.server.address().port}`;
        resolve(this.url);
      });
    });
  }

  close() {
    this.server.closeAllConnections?.();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

export class FakeRender extends FakeServer {
  constructor({ apiKey = 'rnd_key', serviceId = 'srv-1', pollsUntilLive = 1, failRefs = [], onLive, answer202 = false } = {}) {
    super();
    Object.assign(this, { apiKey, serviceId, pollsUntilLive, failRefs: new Set(failRefs), onLive, answer202 });
    this.deploys = [];
    this.throttle = 0; // answer 429 this many times before behaving
    this.reportedSha = null; // override image.sha (formats are not fixed by Render's docs)
    this.listLag = 0; // list calls that do not show the newest deploy yet (after a 202)
  }

  async route(req) {
    if (bearer(req) !== this.apiKey) return { status: 401, body: { message: 'unauthorized' } };
    const base = `/v1/services/${this.serviceId}/deploys`;
    if (this.throttle > 0 && req.path.startsWith(base)) {
      this.throttle -= 1;
      return { status: 429, headers: { 'retry-after': '0' }, body: { message: 'slow down' } };
    }
    if (req.method === 'POST' && req.path === base) {
      if (typeof req.body?.imageUrl !== 'string') return { status: 400, body: { message: 'imageUrl required' } };
      const deploy = {
        id: `dep-${this.deploys.length + 1}`,
        status: 'created',
        createdAt: new Date().toISOString(),
        image: { ref: req.body.imageUrl, sha: this.reportedSha ?? req.body.imageUrl.split('@')[1] },
        polls: 0,
      };
      this.deploys.push(deploy);
      return this.answer202 ? { status: 202 } : { status: 201, body: this.#view(deploy) };
    }
    if (req.method === 'GET' && req.path === base) {
      let visible = this.deploys;
      if (this.listLag > 0) {
        this.listLag -= 1;
        visible = this.deploys.slice(0, -1);
      }
      const limit = Number(req.query.limit || 20);
      const newest = [...visible].reverse().slice(0, limit);
      return { status: 200, body: newest.map((d) => ({ deploy: this.#view(d), cursor: 'c' })) };
    }
    const match = req.path.match(new RegExp(`^${base}/([\\w-]+)$`));
    if (req.method === 'GET' && match) {
      const deploy = this.deploys.find((d) => d.id === match[1]);
      if (!deploy) return { status: 404, body: { message: 'deploy not found' } };
      await this.#advance(deploy);
      return { status: 200, body: this.#view(deploy) };
    }
    return null;
  }

  // A deploy that already exists, e.g. the one currently live.
  seedDeploy({ ref, status = 'live', createdAt = new Date(Date.now() - 3600000).toISOString() }) {
    this.deploys.push({ id: `dep-${this.deploys.length + 1}`, status, createdAt, image: { ref, sha: ref.split('@')[1] }, polls: 0 });
  }

  async #advance(deploy) {
    if (['live', 'update_failed'].includes(deploy.status)) return;
    deploy.polls += 1;
    if (deploy.polls < this.pollsUntilLive) {
      deploy.status = 'update_in_progress';
    } else if (this.failRefs.has(deploy.image.ref)) {
      deploy.status = 'update_failed';
    } else {
      deploy.status = 'live';
      for (const other of this.deploys) if (other !== deploy && other.status === 'live') other.status = 'deactivated';
      await this.onLive?.(deploy.image.ref, deploy);
    }
  }

  #view(deploy) {
    const copy = { ...deploy };
    delete copy.polls;
    return copy;
  }
}

export class FakeGitHub extends FakeServer {
  constructor({ token = 'ghs_token', repo = 'owner/repo', rejectShaRef = false } = {}) {
    super();
    Object.assign(this, { token, repo, rejectShaRef });
    this.deployments = [];
    this.statuses = new Map();
    this.comments = [];
    this.clock = 0;
  }

  tick() {
    this.clock += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
  }

  seedDeployment({ environment, sha, image = 'ghcr.io/owner/repo', digest, states = ['success'] }) {
    const id = this.deployments.length + 1;
    this.deployments.push({ id, sha, task: 'deploy-image', environment, payload: { sha, image, digest }, created_at: this.tick() });
    this.statuses.set(id, states.map((state) => ({ id: this.clock + 1, state, created_at: this.tick() })).reverse());
    return id;
  }

  latestState(id) {
    return this.statuses.get(id)?.[0]?.state;
  }

  async route(req) {
    if (bearer(req) !== this.token) return { status: 401, body: { message: 'Bad credentials' } };
    const root = `/repos/${this.repo}`;
    if (!req.path.startsWith(root)) return null;
    const path = req.path.slice(root.length);

    if (req.method === 'POST' && path === '/deployments') {
      if (this.rejectShaRef && /^[0-9a-f]{40}$/.test(req.body.ref)) {
        return { status: 422, body: { message: 'Conflict: branch not allowed' } };
      }
      const id = this.deployments.length + 1;
      this.deployments.push({ id, sha: req.body.ref, task: req.body.task, environment: req.body.environment, payload: req.body.payload, created_at: this.tick() });
      this.statuses.set(id, []);
      return { status: 201, body: this.deployments[id - 1] };
    }
    if (req.method === 'GET' && path === '/deployments') {
      const { environment, task, sha, per_page = 30, page = 1 } = req.query;
      const list = this.deployments
        .filter((d) => (!environment || d.environment === environment) && (!task || d.task === task) && (!sha || d.sha === sha))
        .sort((a, b) => b.id - a.id);
      return { status: 200, body: list.slice((page - 1) * per_page, page * per_page) };
    }
    const status = path.match(/^\/deployments\/(\d+)\/statuses$/);
    if (status) {
      const id = Number(status[1]);
      if (req.method === 'POST') {
        const entry = { id: this.clock + 1, state: req.body.state, description: req.body.description, environment_url: req.body.environment_url, created_at: this.tick() };
        this.statuses.get(id).unshift(entry);
        if (req.body.state === 'success' && req.body.auto_inactive !== false) {
          const env = this.deployments[id - 1].environment;
          for (const d of this.deployments) {
            const had = this.statuses.get(d.id).some((s) => s.state === 'success');
            if (d.id !== id && d.environment === env && had) this.statuses.get(d.id).unshift({ id: this.clock + 1, state: 'inactive', created_at: this.tick() });
          }
        }
        return { status: 201, body: entry };
      }
      return { status: 200, body: this.statuses.get(id) || [] };
    }

    const comments = path.match(/^\/issues\/(\d+)\/comments$/);
    if (comments && req.method === 'GET') {
      const { per_page = 30, page = 1 } = req.query;
      return { status: 200, body: this.comments.filter((c) => c.pr === comments[1]).slice((page - 1) * per_page, page * per_page) };
    }
    if (comments && req.method === 'POST') {
      const comment = { id: this.comments.length + 100, pr: comments[1], body: req.body.body };
      this.comments.push(comment);
      return { status: 201, body: comment };
    }
    const edit = path.match(/^\/issues\/comments\/(\d+)$/);
    if (edit && req.method === 'PATCH') {
      const comment = this.comments.find((c) => c.id === Number(edit[1]));
      if (!comment) return { status: 404, body: { message: 'Not Found' } };
      comment.body = req.body.body;
      return { status: 200, body: comment };
    }
    return null;
  }
}

export class FakeVercel extends FakeServer {
  constructor({ token = 'vc_token', projectId = 'prj_1', pageSize = 100 } = {}) {
    super();
    Object.assign(this, { token, projectId, pageSize });
    this.deployments = [];
  }

  seed(uid, prId, created) {
    this.deployments.push({ uid, url: `${uid}.vercel.app`, created, meta: prId === undefined ? {} : { githubPrId: String(prId) } });
  }

  async route(req) {
    if (bearer(req) !== this.token) return { status: 401, body: { error: { code: 'forbidden' } } };
    if (req.method === 'GET' && req.path === '/v7/deployments') {
      if (req.query.projectId !== this.projectId) return { status: 400, body: { error: { code: 'bad_request' } } };
      const until = req.query.until ? Number(req.query.until) : Infinity;
      const sorted = this.deployments.filter((d) => d.created < until).sort((a, b) => b.created - a.created);
      const page = sorted.slice(0, this.pageSize);
      const next = sorted.length > this.pageSize ? page.at(-1).created : null;
      return { status: 200, body: { deployments: page, pagination: { count: page.length, next } } };
    }
    const del = req.path.match(/^\/v13\/deployments\/([\w-]+)$/);
    if (req.method === 'DELETE' && del) {
      const idx = this.deployments.findIndex((d) => d.uid === del[1]);
      if (idx < 0) return { status: 404, body: { error: { code: 'not_found' } } };
      this.deployments.splice(idx, 1);
      return { status: 200, body: { state: 'DELETED', uid: del[1] } };
    }
    return null;
  }
}

export class FakeDiscord extends FakeServer {
  constructor({ status = 204, rateLimitOnce = false } = {}) {
    super();
    Object.assign(this, { status, rateLimitOnce });
    this.messages = [];
  }

  async route(req) {
    if (req.method !== 'POST' || !req.path.startsWith('/api/webhooks/')) return null;
    if (this.rateLimitOnce) {
      this.rateLimitOnce = false;
      return { status: 429, body: { message: 'You are being rate limited.', retry_after: 0 } };
    }
    if (this.status >= 400) return { status: this.status, body: { message: 'error' } };
    this.messages.push(req.body);
    return { status: this.status };
  }
}

// Registry that knows { "owner/repo:ref": "sha256:..." }.
export class FakeRegistry extends FakeServer {
  constructor({ manifests = {}, requireAuth = false } = {}) {
    super();
    Object.assign(this, { manifests, requireAuth });
  }

  async route(req) {
    if (req.path === '/token') {
      return { status: 200, body: { token: 'registry-token' } };
    }
    const match = req.path.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (match && (req.method === 'HEAD' || req.method === 'GET')) {
      if (this.requireAuth && bearer(req) !== 'registry-token') return { status: 401, body: {} };
      const digest = this.manifests[`${match[1]}:${match[2]}`];
      if (!digest) return { status: 404, body: {} };
      return { status: 200, headers: { 'docker-content-digest': digest }, body: {} };
    }
    return null;
  }
}
