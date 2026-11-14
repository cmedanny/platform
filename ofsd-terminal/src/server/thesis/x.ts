// Last-24h posts from the curated X accounts, through TwitterAPI.io's advanced search.
// Accounts are batched into OR queries so a long list takes a handful of requests.

import type { XHandle } from '../../shared/thesis.ts';
import { UserFacingError } from '../claude.ts';
import { fetchStream } from '../crawler/fetch.ts';
import { getEnv } from '../env.ts';
import type { Run } from '../runs.ts';

export interface RawPost {
  id: string;
  handle: string;
  name: string;
  text: string;
  url: string;
  createdAt: number;
  likes: number;
  reposts: number;
  views: number;
}

interface ApiTweet {
  id: string;
  url: string;
  text: string;
  createdAt: string;
  likeCount?: number;
  retweetCount?: number;
  viewCount?: number;
  isReply?: boolean;
  author?: { userName: string; name?: string };
  quoted_tweet?: ApiTweet | null;
  retweeted_tweet?: ApiTweet | null;
}

interface SearchResponse {
  tweets?: ApiTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
  status?: string;
  msg?: string;
  message?: string;
}

const BATCH = 8;
const MAX_PAGES = 12;
const PER_HANDLE = 40;

const explain = (status: number) =>
  status === 401 || status === 403
    ? 'TwitterAPI.io rejected the API key. Check TWITTERAPI_IO_KEY in .env.'
    : status === 402
      ? 'TwitterAPI.io says the account is out of credits. Top up at twitterapi.io.'
      : status === 429
        ? 'TwitterAPI.io rate limit hit. Wait a minute and run it again.'
        : status >= 500
          ? `TwitterAPI.io is having trouble right now (${status}). Try again shortly.`
          : undefined;

function toPost(t: ApiTweet): RawPost | null {
  const handle = t.author?.userName;
  if (!handle || !t.id) return null;
  let text = t.text ?? '';
  if (t.retweeted_tweet?.author) text = `RT @${t.retweeted_tweet.author.userName}: ${t.retweeted_tweet.text}`;
  if (t.quoted_tweet?.author) text += `\n> @${t.quoted_tweet.author.userName}: ${t.quoted_tweet.text}`;
  const createdAt = Date.parse(t.createdAt);
  return {
    id: String(t.id),
    handle,
    name: t.author?.name ?? handle,
    text: text.trim(),
    url: t.url || `https://x.com/${handle}/status/${t.id}`,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    likes: t.likeCount ?? 0,
    reposts: t.retweetCount ?? 0,
    views: t.viewCount ?? 0,
  };
}

/** Streams posts back through onPosts as each page arrives. */
export async function fetchRecentPosts(run: Run, handles: XHandle[], sinceMs: number, onPosts: (p: RawPost[]) => void, limit: number) {
  const env = getEnv();
  if (!env.twitterKey) {
    throw new UserFacingError(
      'No TwitterAPI.io key yet. Sign up at twitterapi.io, copy your API key, paste it after TWITTERAPI_IO_KEY= in ofsd-terminal/.env, save, and run /thesis again.',
    );
  }
  const since = Math.floor(sinceMs / 1000);
  const perHandle = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < handles.length && total < limit; i += BATCH) {
    const group = handles.slice(i, i + BATCH);
    const from = group.map((h) => `from:${h.handle}`).join(' OR ');
    const query = `(${from}) since_time:${since} -filter:replies`;
    let cursor = '';
    for (let page = 0; page < MAX_PAGES && total < limit; page++) {
      const url = `${env.twitterBase}/twitter/tweet/advanced_search?${new URLSearchParams({ query, queryType: 'Latest', cursor })}`;
      const res = await fetchStream(run, url, { userAgent: 'OFSD-Terminal/0.3', accept: 'application/json', headers: { 'X-API-Key': env.twitterKey }, explain });
      let body: SearchResponse;
      try {
        body = JSON.parse(res.text) as SearchResponse;
      } catch {
        throw new UserFacingError('TwitterAPI.io sent something unexpected. Try again in a minute.');
      }
      if (body.status === 'error') throw new UserFacingError(`TwitterAPI.io: ${body.msg || body.message || 'request failed'}`);
      const fresh: RawPost[] = [];
      for (const t of body.tweets ?? []) {
        if (t.isReply) continue;
        const p = toPost(t);
        if (!p || p.createdAt < sinceMs) continue;
        const key = p.handle.toLowerCase();
        const n = perHandle.get(key) ?? 0;
        if (n >= PER_HANDLE) continue;
        perHandle.set(key, n + 1);
        fresh.push(p);
        if (++total >= limit) break;
      }
      if (fresh.length) onPosts(fresh);
      if (!body.has_next_page || !body.next_cursor) break;
      cursor = body.next_cursor;
    }
  }
  return { perHandle, capped: total >= limit };
}
