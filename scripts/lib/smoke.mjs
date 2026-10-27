// Parses "Name: value" lines (env SMOKE_HEADERS) into a headers object.
export function parseHeaders(text) {
  const headers = {};
  for (const line of String(text || '').split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

// Smoke tests against a live URL. `readonly` mode never creates data, which is
// what production needs; `full` also exercises the write path.
export async function runSmoke({ baseUrl, mode = 'full', headers = {}, fetchImpl = fetch, timeoutMs = 15000 }) {
  const root = baseUrl.replace(/\/$/, '');
  const call = async (method, path, body) => {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const res = await fetchImpl(`${root}${path}`, init);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  const expect = (cond, status) => (cond ? null : `unexpected response (HTTP ${status})`);

  const checks = [
    [
      'GET / returns 200 with the app name',
      async () => {
        const { status, data } = await call('GET', '/');
        return expect(status === 200 && typeof data?.name === 'string', status);
      },
    ],
    [
      'GET /health returns status ok',
      async () => {
        const { status, data } = await call('GET', '/health');
        return expect(status === 200 && data?.status === 'ok', status);
      },
    ],
    [
      'GET /api/info returns the commit',
      async () => {
        const { status, data } = await call('GET', '/api/info');
        return expect(status === 200 && typeof data?.commit === 'string', status);
      },
    ],
    [
      'GET /api/items returns a list',
      async () => {
        const { status, data } = await call('GET', '/api/items');
        return expect(status === 200 && Array.isArray(data?.items), status);
      },
    ],
    [
      'GET /unknown returns 404',
      async () => {
        const { status } = await call('GET', '/__smoke_unknown__');
        return expect(status === 404, status);
      },
    ],
  ];

  if (mode === 'full') {
    checks.push(
      [
        'POST /api/items with a valid body returns 201',
        async () => {
          const { status, data } = await call('POST', '/api/items', { name: `smoke-${Date.now()}` });
          return expect(status === 201 && Boolean(data?.id), status);
        },
      ],
      [
        'POST /api/items with an invalid body returns 400',
        async () => {
          const { status } = await call('POST', '/api/items', { name: '' });
          return expect(status === 400, status);
        },
      ],
    );
  }

  const results = [];
  for (const [name, run] of checks) {
    try {
      const problem = await run();
      results.push({ name, ok: problem === null, detail: problem || 'ok' });
    } catch (err) {
      const detail = err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message;
      results.push({ name, ok: false, detail });
    }
  }
  return { ok: results.every((r) => r.ok), mode, results };
}

export function smokeToMarkdown({ mode, results }) {
  const rows = results.map((r) => `| ${r.ok ? 'pass' : 'FAIL'} | ${r.name} | ${r.detail} |`);
  return [`#### Smoke tests (${mode} mode)`, '', '| Result | Check | Detail |', '| --- | --- | --- |', ...rows].join('\n');
}
