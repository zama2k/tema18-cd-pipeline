import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(process.argv[1]).href;
}

export const shortSha = (sha) => String(sha || '').slice(0, 7);

// GitHub Actions workflow commands. Messages are single-line by construction.
const oneLine = (msg) => String(msg).replace(/\r?\n/g, ' ');
export const notice = (msg) => console.log(`::notice::${oneLine(msg)}`);
export const warning = (msg) => console.log(`::warning::${oneLine(msg)}`);
export const errorAnnotation = (msg) => console.log(`::error::${oneLine(msg)}`);
export const group = (title) => console.log(`::group::${oneLine(title)}`);
export const endGroup = () => console.log('::endgroup::');

export function setOutputs(outputs, env = process.env) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value ?? '')}`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  } else {
    for (const line of lines) console.log(`output ${line}`);
  }
}

export function appendSummary(markdown, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

// Exponential backoff with a cap; the delay function is injectable for tests.
export function backoffDelay(attempt, { baseMs = 2000, factor = 1.5, maxMs = 30000 } = {}) {
  return Math.min(maxMs, Math.round(baseMs * factor ** (attempt - 1)));
}

// Thin fetch wrapper: JSON in/out, hard timeout, never echoes request headers.
export async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 20000, fetchImpl = fetch } = {}) {
  const init = {
    method,
    headers: { accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
  }
  return { status: res.status, ok: res.ok, headers: res.headers, data };
}

export class ApiError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function requireEnv(env, names) {
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }
}

export function fail(message, code = 1) {
  errorAnnotation(message);
  process.exitCode = code;
}
