'use strict';

const request = require('supertest');
const handler = require('../../api/index');

it('api/index.js exports a request handler that serves the app', async () => {
  expect(typeof handler).toBe('function');
  const res = await request(handler).get('/health');
  expect(res.status).toBe(200);
  expect(res.body.status).toBe('ok');
});

it('vercel.json rewrites every path to the api/ function that exists', () => {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(require.resolve('../../vercel.json'), 'utf8'));
  expect(config.rewrites).toEqual([{ source: '/(.*)', destination: '/api' }]);
  expect(fs.existsSync(require.resolve('../../api/index.js'))).toBe(true);
  // Vercel's static build step needs an output directory.
  expect(fs.existsSync(`${__dirname}/../../public`)).toBe(true);
});
