// Real network requests, reported line by line to the run as they happen.

import type { NetLine } from '../../shared/crawl.ts';
import { UserFacingError } from '../claude.ts';
import type { Run } from '../runs.ts';

const MAX_BYTES = 30 * 1024 * 1024;
const TIMEOUT_MS = 45_000;

let netSeq = 0;

export interface FetchResult {
  status: number;
  text: string;
  bytes: number;
  contentType: string;
  finalUrl: string;
}

export interface FetchOpts {
  userAgent: string;
  accept?: string;
  /** Called with each decoded chunk as it streams in. */
  onChunk?: (text: string) => void;
  /** Explain non-2xx statuses in plain English. */
  explain?: (status: number) => string | undefined;
}

function net(run: Run, line: NetLine) {
  run.emit({ type: 'x:net', data: line as unknown as Record<string, unknown> });
}

export async function fetchStream(run: Run, url: string, opts: FetchOpts): Promise<FetchResult> {
  const id = ++netSeq;
  const t0 = Date.now();
  net(run, { id, method: 'GET', url, phase: 'start' });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': opts.userAgent,
        Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = (err as Error).name === 'AbortError';
    const causeObj = (err as { cause?: { code?: string; message?: string } }).cause;
    const cause = causeObj?.code;
    const msg = aborted
      ? `Timed out after ${TIMEOUT_MS / 1000}s fetching ${url}.`
      : cause === 'ENOTFOUND'
        ? `Couldn't find the site ${new URL(url).hostname}. Check the address.`
        : `Couldn't connect to ${new URL(url).hostname} (${cause || causeObj?.message || (err as Error).message}). Check your internet connection or the URL.`;
    net(run, { id, method: 'GET', url, phase: 'error', ms: Date.now() - t0, note: msg });
    throw new UserFacingError(msg);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (res.url && res.url !== url) net(run, { id, method: 'GET', url: res.url, phase: 'progress', status: res.status, bytes: 0, note: 'redirected' });
  if (!res.ok) {
    clearTimeout(timer);
    net(run, { id, method: 'GET', url, phase: 'error', status: res.status, ms: Date.now() - t0 });
    const custom = opts.explain?.(res.status);
    const generic =
      res.status === 404
        ? `Not found (404): ${url}`
        : res.status === 403 || res.status === 401
          ? `The site refused the request (${res.status}). Some sites block automated readers.`
          : res.status === 429
            ? 'Rate limited (429). Wait a minute and try again.'
            : `The server answered ${res.status} ${res.statusText} for ${url}.`;
    throw new UserFacingError(custom ?? generic);
  }

  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset && charset !== 'ascii' && charset !== 'us-ascii' ? charset : 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }

  let bytes = 0;
  let text = '';
  let lastReport = 0;
  const reader = res.body!.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) {
        ctrl.abort();
        throw new UserFacingError(`That document is over ${MAX_BYTES / 1024 / 1024} MB. Too big to read here.`);
      }
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      if (chunk) opts.onChunk?.(chunk);
      const now = Date.now();
      if (now - lastReport > 50) {
        lastReport = now;
        net(run, { id, method: 'GET', url, phase: 'progress', status: res.status, bytes, ms: now - t0 });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      text += tail;
      opts.onChunk?.(tail);
    }
  } catch (err) {
    net(run, { id, method: 'GET', url, phase: 'error', status: res.status, bytes, ms: Date.now() - t0 });
    if (err instanceof UserFacingError) throw err;
    throw new UserFacingError(`The download from ${new URL(url).hostname} broke off partway (${(err as Error).message}). Try again.`);
  } finally {
    clearTimeout(timer);
  }
  net(run, { id, method: 'GET', url: res.url || url, phase: 'done', status: res.status, bytes, ms: Date.now() - t0 });
  return { status: res.status, text, bytes, contentType, finalUrl: res.url || url };
}
