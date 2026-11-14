// Sends a finished thesis to the user's private Discord channel via webhook.
// Only ever called from an explicit button press. Mentions are disabled.

import { UserFacingError } from '../claude.ts';
import { getEnv, keyStatus } from '../env.ts';

const LIMIT = 1900; // Discord allows 2000 characters per message

export function splitForDiscord(text: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const para of text.split(/\n(?=\n)|\n(?=\*\*)/)) {
    const add = cur ? `${cur}\n${para}` : para;
    if (add.length <= LIMIT) {
      cur = add;
      continue;
    }
    if (cur) parts.push(cur);
    if (para.length <= LIMIT) cur = para;
    else {
      // a single huge paragraph: hard-split on sentence or space
      let rest = para;
      while (rest.length > LIMIT) {
        const cut = Math.max(rest.lastIndexOf('. ', LIMIT), rest.lastIndexOf(' ', LIMIT));
        const at = cut > LIMIT * 0.5 ? cut + 1 : LIMIT;
        parts.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
      }
      cur = rest;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

export async function sendToDiscord(text: string): Promise<string[]> {
  const env = getEnv();
  if (!keyStatus(env).discord) {
    throw new UserFacingError(
      'No Discord webhook yet. In your private channel: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL. Paste it after DISCORD_WEBHOOK_URL= in .env and save.',
    );
  }
  let url = env.discordWebhook;
  if (env.discordBase) url = url.replace(/^https:\/\/(discord|discordapp)\.com/, env.discordBase);
  const ids: string[] = [];
  for (const content of splitForDiscord(text)) {
    let res: Response;
    try {
      res = await fetch(`${url}${url.includes('?') ? '&' : '?'}wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, username: 'OFSD Terminal', allowed_mentions: { parse: [] } }),
      });
    } catch {
      throw new UserFacingError("Couldn't reach Discord. Check your internet connection.");
    }
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      throw new UserFacingError(`Discord rate limit. Try again in ${Math.ceil(body.retry_after ?? 5)}s.${ids.length ? ` (${ids.length} part(s) already sent.)` : ''}`);
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new UserFacingError('Discord rejected the webhook. It may have been deleted. Create a new one and update DISCORD_WEBHOOK_URL in .env.');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new UserFacingError(`Discord refused the message (${res.status}${body.message ? `: ${body.message}` : ''}).`);
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    if (body.id) ids.push(body.id);
  }
  return ids;
}
