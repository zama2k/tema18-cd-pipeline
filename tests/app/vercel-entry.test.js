'use strict';

const request = require('supertest');
const handler = require('../../api/index');

it('api/index.js exports a request handler that serves the app', async () => {
  expect(typeof handler).toBe('function');
  const res = await request(handler).get('/health');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
});
