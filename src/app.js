'use strict';

const express = require('express');
const pkg = require('../package.json');

const MAX_ITEMS = 100;
const MAX_NAME_LENGTH = 100;

function createApp({ env = process.env } = {}) {
  const app = express();
  const startedAt = new Date();
  const items = [];
  let nextId = 1;

  const meta = () => ({
    name: pkg.name,
    version: env.APP_VERSION || pkg.version,
    commit: env.GIT_SHA || 'unknown',
    environment: env.APP_ENV || env.NODE_ENV || 'development',
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.json({ limit: '10kb' }));

  app.get('/', (req, res) => {
    const { name, version, environment } = meta();
    res.json({ name, version, environment, message: 'CD pipeline demo API' });
  });

  app.get('/health', (req, res) => {
    const { version, commit, environment } = meta();
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      version,
      commit,
      environment,
      uptime: Math.round(process.uptime()),
      startedAt: startedAt.toISOString(),
    });
  });

  app.get('/api/info', (req, res) => {
    res.json({ ...meta(), node: process.version });
  });

  app.get('/api/items', (req, res) => {
    res.json({ items, count: items.length });
  });

  app.get('/api/items/:id', (req, res) => {
    // Strict positive integer: Number('1e3') or parseInt('1.5') would accept malformed ids.
    if (!/^[1-9]\d*$/.test(req.params.id)) {
      return res.status(400).json({ error: '"id" must be a positive integer' });
    }
    const item = items.find((i) => i.id === Number(req.params.id));
    if (!item) return res.status(404).json({ error: 'Item not found' });
    return res.json(item);
  });

  app.post('/api/items', (req, res) => {
    const name = req.body && req.body.name;
    if (typeof name !== 'string' || name.trim() === '' || name.length > MAX_NAME_LENGTH) {
      return res
        .status(400)
        .json({ error: `"name" must be a non-empty string of at most ${MAX_NAME_LENGTH} characters` });
    }
    const item = { id: nextId++, name: name.trim(), createdAt: new Date().toISOString() };
    items.push(item);
    // Bounded on purpose: the service is public and the store lives in memory.
    if (items.length > MAX_ITEMS) items.shift();
    return res.status(201).json(item);
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.status === 400) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err.status === 413) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = { createApp };
