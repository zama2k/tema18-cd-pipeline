import { shortSha } from './util.mjs';

// Hidden marker that identifies the single "sticky" preview comment of a PR.
export const MARKER = '<!-- cd-pipeline:preview -->';

export function previewBody({ url, sha, branch, runUrl, protectedByVercel = true }) {
  const lines = [
    MARKER,
    '### Preview deployment',
    '',
    '| | |',
    '| --- | --- |',
    `| **URL** | ${url} |`,
    `| **Commit** | \`${shortSha(sha)}\` |`,
    `| **Branch** | \`${branch}\` |`,
  ];
  if (runUrl) lines.push(`| **Run** | [workflow run](${runUrl}) |`);
  if (protectedByVercel) {
    lines.push('', '_The preview sits behind Vercel Deployment Protection; sign in to Vercel to open it._');
  }
  return lines.join('\n');
}

export function removedBody({ runUrl } = {}) {
  return [
    MARKER,
    '### Preview deployment',
    '',
    `Preview removed: the pull request is closed.${runUrl ? ` ([cleanup run](${runUrl}))` : ''}`,
  ].join('\n');
}

// Creates the comment, or edits the existing one that carries the marker, so a
// PR never accumulates one comment per push. With createIfMissing=false it only
// edits (used when closing a PR that never had a preview).
export async function upsertComment(api, { pr, body, createIfMissing = true }) {
  const comments = await api.paginate(`/issues/${pr}/comments`, { maxPages: 10 });
  const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(MARKER));
  if (existing) {
    await api.patch(`/issues/comments/${existing.id}`, { body });
    return { action: 'updated', id: existing.id };
  }
  if (!createIfMissing) return { action: 'none' };
  const created = await api.post(`/issues/${pr}/comments`, { body });
  return { action: 'created', id: created.id };
}
