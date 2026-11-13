// SEC EDGAR lookups: ticker -> CIK -> latest filing of a form type.

import { UserFacingError } from '../claude.ts';
import { getEnv, keyStatus } from '../env.ts';
import type { Run } from '../runs.ts';
import { fetchStream } from './fetch.ts';

export const FORMS = ['10-Q', '10-K', '8-K'] as const;
export type Form = (typeof FORMS)[number];

let tickerCache: { at: number; map: Map<string, { cik: number; title: string }> } | null = null;

export function secUserAgent() {
  const env = getEnv();
  if (!keyStatus(env).sec) {
    throw new UserFacingError(
      'SEC needs your name and email before it will serve filings. Open ofsd-terminal/.env and set SEC_USER_AGENT="OFSD Terminal Your Name you@email.com", save, then try again.',
    );
  }
  return env.secUserAgent;
}

const explainSec = (status: number) =>
  status === 403
    ? 'SEC refused the request (403). This usually means SEC_USER_AGENT in .env needs a real name and email.'
    : status === 429
      ? 'SEC rate limit hit (they allow about 10 requests a second). Wait a minute and try again.'
      : undefined;

async function json<T>(run: Run, url: string): Promise<T> {
  const res = await fetchStream(run, url, { userAgent: secUserAgent(), accept: 'application/json', explain: explainSec });
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new UserFacingError(`SEC sent something unexpected from ${url}. Try again in a minute.`);
  }
}

export async function lookupTicker(run: Run, tickerRaw: string) {
  const ticker = tickerRaw.toUpperCase().replace(/\./g, '-');
  if (!tickerCache || Date.now() - tickerCache.at > 24 * 3600_000) {
    const data = await json<Record<string, { cik_str: number; ticker: string; title: string }>>(run, 'https://www.sec.gov/files/company_tickers.json');
    const map = new Map<string, { cik: number; title: string }>();
    for (const v of Object.values(data)) map.set(v.ticker.toUpperCase(), { cik: v.cik_str, title: v.title });
    tickerCache = { at: Date.now(), map };
  } else {
    run.log('Ticker list already loaded (cached for 24h).');
  }
  const hit = tickerCache.map.get(ticker);
  if (!hit) throw new UserFacingError(`Couldn't find ticker "${tickerRaw}" on SEC EDGAR. Check the spelling. Only US-listed companies file there.`);
  return { ticker, cik: hit.cik, company: hit.title };
}

interface Submissions {
  name: string;
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      reportDate: string[];
      primaryDocument: string[];
    };
  };
}

export async function latestFiling(run: Run, cik: number, form: Form) {
  const padded = String(cik).padStart(10, '0');
  const sub = await json<Submissions>(run, `https://data.sec.gov/submissions/CIK${padded}.json`);
  const r = sub.filings.recent;
  const i = r.form.findIndex((f) => f === form);
  if (i < 0) throw new UserFacingError(`${sub.name} has no ${form} in its recent SEC filings.`);
  const acc = r.accessionNumber[i];
  const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}`;
  return {
    company: sub.name,
    accession: acc,
    filed: r.filingDate[i],
    period: r.reportDate[i],
    folder,
    url: `${folder}/${r.primaryDocument[i]}`,
  };
}

/** For 8-Ks the real content is usually the press release in exhibit 99.x. */
export async function findExhibit99(run: Run, folder: string) {
  try {
    const idx = await json<{ directory: { item: Array<{ name: string }> } }>(run, `${folder}/index.json`);
    const hit = idx.directory.item.map((x) => x.name).find((n) => /ex-?99/i.test(n) && /\.html?$/i.test(n));
    return hit ? `${folder}/${hit}` : null;
  } catch {
    return null;
  }
}

export function fetchFilingDoc(run: Run, url: string, onChunk: (s: string) => void) {
  return fetchStream(run, url, { userAgent: secUserAgent(), onChunk, explain: explainSec });
}
