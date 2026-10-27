import { backoffDelay, sleep as realSleep } from './util.mjs';

// Polls GET <baseUrl>/health until it answers 200 with status "ok" and, when
// expectedCommit is given, with exactly that commit. A wrong commit is retried
// because the previous version can still be serving while the new one starts.
export async function checkHealth({
  baseUrl,
  expectedCommit,
  attempts = 12,
  baseDelayMs = 5000,
  maxDelayMs = 30000,
  timeoutMs = 10000,
  headers = {},
  fetchImpl = fetch,
  sleep = realSleep,
  log = console.log,
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/health`;
  let lastError = 'no attempt made';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      const body = await res.json().catch(() => null);
      if (res.status !== 200) {
        lastError = `HTTP ${res.status}`;
      } else if (body?.status !== 'ok') {
        lastError = `unexpected body status "${body?.status}"`;
      } else if (expectedCommit && body.commit !== expectedCommit) {
        lastError = `commit mismatch: serving ${body.commit}, expected ${expectedCommit}`;
      } else {
        log(`health check passed on attempt ${attempt}: commit ${body.commit}, version ${body.version}`);
        return { ok: true, attempts: attempt, body };
      }
    } catch (err) {
      lastError = err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.cause?.code || err.message;
    }
    log(`health check attempt ${attempt}/${attempts} failed: ${lastError}`);
    if (attempt < attempts) await sleep(backoffDelay(attempt, { baseMs: baseDelayMs, maxMs: maxDelayMs }));
  }
  return { ok: false, attempts, error: lastError };
}
