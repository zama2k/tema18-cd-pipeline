import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { FakeDiscord } from '../../scripts/dev/fakes.mjs';
import { buildPayload, sendWebhook } from '../../scripts/lib/discord.mjs';
import { main } from '../../scripts/notify-discord.mjs';
import { SHA_A, captureLog, noSleep } from './helpers.mjs';

let discord;
beforeEach(async () => {
  discord = new FakeDiscord();
  await discord.listen();
});
afterEach(() => discord.close());

const hook = () => `${discord.url}/api/webhooks/123/secret-token`;

test('payload has the expected embed for each status and never allows mentions', () => {
  for (const status of ['success', 'failure', 'rolled_back', 'rollback', 'skipped']) {
    const payload = buildPayload({ status, environment: 'production', sha: SHA_A, version: 'v1.0.0', url: 'https://app', actor: 'ana' });
    const [embed] = payload.embeds;
    assert.equal(typeof embed.color, 'number');
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
    const names = embed.fields.map((f) => f.name);
    assert.deepEqual(names, ['Environment', 'Status', 'Commit', 'Version', 'Triggered by', 'URL']);
    assert.equal(embed.fields[2].value, '`aaaaaaa`');
  }
  assert.match(buildPayload({ status: 'rolled_back' }).embeds[0].title, /rolled back/);
});

test('unknown statuses are reported as failures and long text is clipped to Discord limits', () => {
  const payload = buildPayload({ status: 'weird', detail: 'x'.repeat(5000), url: 'u'.repeat(3000), repo: 'r'.repeat(400) });
  const [embed] = payload.embeds;
  assert.match(embed.title, /^Deploy failed/);
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 1000);
  assert.ok(embed.fields.every((f) => f.value.length <= 1024));
});

test('sendWebhook retries once after a 429', async () => {
  discord.rateLimitOnce = true;
  await sendWebhook(hook(), { content: 'x' }, { sleep: noSleep });
  assert.equal(discord.messages.length, 1);
  assert.equal(discord.requests.length, 2);
});

test('sendWebhook errors do not include the webhook URL', async () => {
  discord.status = 400;
  await assert.rejects(sendWebhook(hook(), { content: 'x' }), (err) => {
    assert.match(err.message, /HTTP 400/);
    assert.ok(!err.message.includes('secret-token'));
    return true;
  });
});

test('sendWebhook gives up when rate limited twice', async () => {
  const fetchImpl = async () => new Response('{"retry_after":0}', { status: 429 });
  await assert.rejects(sendWebhook('http://x', {}, { fetchImpl, sleep: noSleep }), /HTTP 429/);
});

test('CLI posts an embed with the run link', async () => {
  const env = {
    DISCORD_WEBHOOK_URL: hook(),
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '42',
    GITHUB_ACTOR: 'ana',
  };
  const sent = await main(['--status', 'success', '--environment', 'staging', '--sha', SHA_A], env);
  assert.equal(sent, true);
  const [embed] = discord.messages[0].embeds;
  assert.equal(embed.url, 'https://github.com/owner/repo/actions/runs/42');
  assert.match(embed.title, /owner\/repo/);
});

test('CLI skips with a notice when the webhook is not configured', async () => {
  const { value, lines } = await captureLog(() => main(['--status', 'success'], {}));
  assert.equal(value, false);
  assert.ok(lines.some((l) => l.startsWith('::notice::')));
  assert.equal(discord.requests.length, 0);
});

test('CLI never throws when Discord is down; it only warns', async () => {
  discord.status = 500;
  const { value, lines } = await captureLog(() => main(['--status', 'failure'], { DISCORD_WEBHOOK_URL: hook() }));
  assert.equal(value, false);
  assert.ok(lines.some((l) => l.startsWith('::warning::') && !l.includes('secret-token')));
});

test('CLI requires --status', async () => {
  await assert.rejects(main([], {}), /usage/);
});
