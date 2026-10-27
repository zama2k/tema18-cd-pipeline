import { shortSha, sleep as realSleep } from './util.mjs';

const COLORS = { success: 0x2ecc71, failure: 0xe74c3c, rolled_back: 0xe67e22, rollback: 0x3498db, skipped: 0x95a5a6 };
const TITLES = {
  success: 'Deploy succeeded',
  failure: 'Deploy failed',
  rolled_back: 'Deploy failed, automatically rolled back',
  rollback: 'Rollback completed',
  skipped: 'Deploy skipped',
};

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// Discord embed limits: title 256, field value 1024, 25 fields, 6000 total.
export function buildPayload({ status, environment, sha, version, url, runUrl, actor, repo, detail }) {
  const known = status in COLORS ? status : 'failure';
  const fields = [
    { name: 'Environment', value: environment || 'n/a', inline: true },
    { name: 'Status', value: known.replace('_', ' '), inline: true },
    { name: 'Commit', value: sha ? `\`${shortSha(sha)}\`` : 'n/a', inline: true },
  ];
  if (version) fields.push({ name: 'Version', value: version, inline: true });
  if (actor) fields.push({ name: 'Triggered by', value: actor, inline: true });
  if (url) fields.push({ name: 'URL', value: url, inline: false });
  return {
    username: 'CD pipeline',
    // Never let a commit message or branch name ping anybody.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: clip(`${TITLES[known]}${repo ? ` - ${repo}` : ''}`, 256),
        description: detail ? clip(detail, 1000) : undefined,
        url: runUrl || undefined,
        color: COLORS[known],
        fields: fields.map((f) => ({ ...f, value: clip(String(f.value), 1024) })),
        timestamp: new Date().toISOString(),
        footer: { text: 'Run details: click the title' },
      },
    ],
  };
}

// One retry on HTTP 429, honouring retry_after. Errors never include the URL
// because it embeds the webhook token.
export async function sendWebhook(webhookUrl, payload, { fetchImpl = fetch, sleep = realSleep } = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && attempt === 1) {
      const body = await res.json().catch(() => ({}));
      await sleep(Math.min(Number(body.retry_after) || 1, 10) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Discord webhook answered HTTP ${res.status}`);
    return;
  }
}
