'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');

const env = { GIT_SHA: 'abc1234def', APP_VERSION: '9.9.9', APP_ENV: 'staging' };

describe('GET /', () => {
  it('returns name, version and environment', async () => {
    const res = await request(createApp({ env })).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'tema18-cd-pipeline', version: '9.9.9', environment: 'staging' });
  });
});

describe('GET /health', () => {
  it('exposes the commit baked into the image', async () => {
    const res = await request(createApp({ env })).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ status: 'ok', version: '9.9.9', commit: 'abc1234def', environment: 'staging' });
    expect(typeof res.body.uptime).toBe('number');
    expect(new Date(res.body.startedAt).toISOString()).toBe(res.body.startedAt);
  });

  it('falls back to safe defaults without env vars', async () => {
    const res = await request(createApp({ env: {} })).get('/health');
    expect(res.body.commit).toBe('unknown');
    expect(res.body.environment).toBe('development');
    expect(res.body.version).toBe(require('../../package.json').version);
  });

  it('uses NODE_ENV when APP_ENV is not set', async () => {
    const res = await request(createApp({ env: { NODE_ENV: 'production' } })).get('/health');
    expect(res.body.environment).toBe('production');
  });
});

describe('GET /api/info', () => {
  it('returns runtime information', async () => {
    const res = await request(createApp({ env })).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.commit).toBe('abc1234def');
    expect(res.body.node).toBe(process.version);
  });
});

describe('/api/items', () => {
  it('starts empty', async () => {
    const res = await request(createApp({ env })).get('/api/items');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], count: 0 });
  });

  it('creates and lists items', async () => {
    const app = createApp({ env });
    const created = await request(app).post('/api/items').send({ name: '  first  ' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 1, name: 'first' });
    const list = await request(app).get('/api/items');
    expect(list.body.count).toBe(1);
    expect(list.body.items[0].name).toBe('first');
  });

  it.each([
    ['missing body', undefined],
    ['missing name', {}],
    ['empty name', { name: '   ' }],
    ['non-string name', { name: 42 }],
    ['name too long', { name: 'x'.repeat(101) }],
  ])('rejects %s with 400', async (_label, body) => {
    const req = request(createApp({ env })).post('/api/items');
    const res = await (body === undefined ? req : req.send(body));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(createApp({ env }))
      .post('/api/items')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid JSON body');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(createApp({ env })).post('/api/items').send({ name: 'x'.repeat(20000) });
    expect(res.status).toBe(413);
  });

  it('keeps at most 100 items in memory', async () => {
    const app = createApp({ env });
    for (let i = 0; i < 102; i++) {
      await request(app).post('/api/items').send({ name: `item-${i}` });
    }
    const res = await request(app).get('/api/items');
    expect(res.body.count).toBe(100);
    expect(res.body.items[0].name).toBe('item-2');
  });
});

describe('unknown routes and errors', () => {
  it('returns a JSON 404', async () => {
    const res = await request(createApp({ env })).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('does not leak the framework in headers', async () => {
    const res = await request(createApp({ env })).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns a generic 500 for unexpected errors', async () => {
    const app = createApp({ env });
    // Force a failure inside a handler by breaking JSON serialisation.
    const original = app.response.json;
    app.response.json = function broken() {
      app.response.json = original;
      throw new Error('boom');
    };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/api/info');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
  });
});
