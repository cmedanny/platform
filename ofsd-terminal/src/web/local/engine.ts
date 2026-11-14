// The in-page backend for the Claude-app version. It answers the same /api
// requests as the local server, so every screen works unchanged.

import type { BrainNode, Note } from '../../shared/brain.ts';
import type { Theme, ThesisListItem, ThesisRecord, XHandle } from '../../shared/thesis.ts';
import type { CommandResponse, Health, ModuleStats } from '../../shared/types.ts';
import { askClaude, claudeAvailable } from './claude.ts';
import { UserError } from './claudeapp.ts';
import { askDoc, crawl, crawlList, type CrawlRecord } from './crawl.ts';
import { deleteRun, getRunDetail, listRuns, LocalRun, markInterrupted } from './runs.ts';
import { robinhoodConnected } from './sec.ts';
import { store } from './store.ts';
import * as th from './thesis.ts';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- commands

const ASK = `You are the assistant inside OFSD Terminal, a private research workspace for a markets-focused user.
Answer in plain text for a narrow terminal log: short paragraphs, simple dashes for lists, no markdown headers, no tables.
Be direct and specific. If you are not sure about a number or a recent fact, say so instead of guessing.`;

async function ask(args: string, run: LocalRun) {
  const q = args.trim();
  if (!q) throw new UserError('Type a question after /ask, for example: /ask what moves the 2s10s curve?');
  // short memory: the last few answered questions
  const recent = listRuns()
    .filter((r) => r.module === 'terminal' && r.status === 'done' && r.id !== run.id)
    .slice(0, 3)
    .reverse();
  const turns: string[] = [];
  for (const r of recent) {
    const d = await getRunDetail(r.id);
    const a = (d?.events ?? []).filter((e) => e.type === 'text').map((e) => (e.data as { delta: string }).delta).join('');
    if (a) turns.push(`Earlier question: ${r.command.replace(/^\/ask\s+/i, '')}\nYour answer: ${a.slice(0, 1500)}`);
  }
  const prompt = `${ASK}\n\n${turns.length ? `${turns.join('\n\n')}\n\n` : ''}Question: ${q}`;
  const { truncated } = await askClaude(prompt, (d) => run.text(d));
  if (truncated) run.log('Reply hit the length limit and was cut off.', 'warn');
  run.end('done');
}

function noteFromText(text: string) {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const first = nl < 0 ? t : t.slice(0, nl);
  return { title: first.length > 80 ? `${first.slice(0, 77)}…` : first, body: nl < 0 ? (first.length > 80 ? t : '') : t.slice(nl + 1).trim() };
}

function createNote(title: string, body: string, tags: string[]): Note {
  const n: Note = { id: newId('note'), title, body, tags, createdAt: Date.now(), updatedAt: Date.now() };
  store.put('notes', n.id, n);
  return n;
}

async function note(args: string, run: LocalRun) {
  const text = args.trim();
  if (!text) throw new UserError('Type the note after /note, for example: /note NVDA guide implies 60% DC growth #ai #semis');
  const tags = [...text.matchAll(/(?:^|\s)#([\w-]{1,24})/g)].map((m) => m[1]);
  const { title, body } = noteFromText(text.replace(/(?:^|\s)#[\w-]{1,24}/g, ' ').replace(/[ \t]+/g, ' '));
  const n = createNote(title, body, tags);
  run.emit({ type: 'x:note', data: { id: n.id } });
  run.log(`Saved note "${n.title}"${tags.length ? ` (${tags.map((t) => `#${t}`).join(' ')})` : ''}.`);
  run.end('done');
}

const COMMANDS: Record<string, { module: string; run: (args: string, run: LocalRun) => Promise<void> }> = {
  ask: { module: 'terminal', run: ask },
  crawl: { module: 'crawler', run: crawl },
  askdoc: { module: 'crawler', run: askDoc },
  thesis: { module: 'thesis', run: th.runThesis },
  note: { module: 'brain', run: note },
};

function command(text: string, display?: string): CommandResponse {
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  const name = m ? m[1].toLowerCase() : 'ask';
  const args = m ? m[2] : text;
  const entry = COMMANDS[name];
  if (!entry) throw new HttpError(404, `Unknown command /${name}. Type /help to see what's available.`);
  const run = new LocalRun(entry.module, display || text);
  entry
    .run(args, run)
    .then(() => !run.finished && run.end('done'))
    .catch((err) => run.fail(err instanceof UserError ? err.message : `Something went wrong: ${(err as Error).message}`));
  return { runId: run.id };
}

// ---------------------------------------------------------------- brain

const COMMON = new Set(['A', 'I', 'CEO', 'CFO', 'GDP', 'CPI', 'PCE', 'FOMC', 'FED', 'USD', 'EUR', 'JPY', 'IG', 'HY', 'US', 'UK', 'EU', 'FY', 'AI', 'ETF', 'OK', 'PM', 'AM']);
function tickersIn(text: string, known: Set<string>) {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g)) if (!COMMON.has(m[1])) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

function brainNodes(): BrainNode[] {
  const crawls = store.all<CrawlRecord>('crawls').filter((c) => c.status !== 'running');
  const theses = store.all<ThesisRecord>('theses');
  const notes = store.all<Note>('notes');
  const known = new Set(crawls.map((c) => c.ticker));
  const nodes: BrainNode[] = [];
  for (const c of crawls)
    nodes.push({
      id: `crawl:${c.id}`,
      kind: 'crawl',
      refId: c.id,
      runId: c.runId,
      title: `${c.ticker} ${c.form}`,
      subtitle: `${c.company}${c.period ? ` · period ${c.period}` : ''}`,
      createdAt: c.createdAt,
      tickers: [c.ticker],
      themes: ['filings'],
      status: c.status,
      weight: Math.max(1, Math.min(5, Math.round(Math.log10(((c.stats?.values as number) ?? 10) + 1) * 1.6))),
      links: [],
    });
  for (const t of theses) {
    const counts = new Map<Theme, number>();
    for (const p of t.posts) if (p.theme && p.theme !== 'other') counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
    const themes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k as string);
    nodes.push({
      id: `thesis:${t.id}`,
      kind: 'thesis',
      refId: t.id,
      runId: t.runId,
      title: t.view.split(/(?<=[.!?])\s/)[0]?.slice(0, 90) || 'Daily thesis',
      subtitle: `${t.posts.length} posts · ${t.status}`,
      createdAt: t.createdAt,
      tickers: tickersIn([t.view, ...t.points.map((p) => p.text), t.invalidation, ...t.watch].join(' '), known),
      themes: themes.length ? themes : ['macro'],
      status: t.status,
      weight: Math.max(1, Math.min(5, Math.round(Math.sqrt(t.posts.length) / 2.5))),
      links: t.crawlIds.map((id) => `crawl:${id}`),
    });
  }
  for (const n of notes)
    nodes.push({
      id: `note:${n.id}`,
      kind: 'note',
      refId: n.id,
      runId: null,
      title: n.title || 'Untitled note',
      subtitle: n.body.replace(/\s+/g, ' ').slice(0, 100),
      createdAt: n.createdAt,
      tickers: tickersIn(`${n.title} ${n.body}`, known),
      themes: n.tags.length ? n.tags : ['notes'],
      status: 'note',
      weight: Math.max(1, Math.min(4, Math.round((n.title.length + n.body.length) / 300) + 1)),
      links: [],
    });
  const latest = new Map<string, string>();
  for (const n of [...nodes].sort((a, b) => b.createdAt - a.createdAt)) if (n.kind === 'crawl') for (const t of n.tickers) if (!latest.has(t)) latest.set(t, n.id);
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const t of n.tickers) {
      const c = latest.get(t);
      if (c && c !== n.id && !n.links.includes(c)) n.links.push(c);
    }
    n.links = n.links.filter((l) => ids.has(l));
  }
  return nodes;
}

const parseTags = (raw: unknown) =>
  [...new Set((Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 12);

// ---------------------------------------------------------------- health

let healthCache: { at: number; value: Health } | null = null;
async function health(): Promise<Health> {
  if (healthCache && Date.now() - healthCache.at < 60_000) return healthCache.value;
  const [claude, rh] = await Promise.all([claudeAvailable(), robinhoodConnected()]);
  const value: Health = { ok: true, model: 'Your Claude plan', keys: { anthropic: claude, sec: rh, twitter: false, discord: false }, envPath: '' };
  healthCache = { at: Date.now(), value };
  return value;
}

export function storageStatus() {
  return { mode: store.mode, problem: store.problem };
}

// ---------------------------------------------------------------- router

let booted: Promise<void> | null = null;
const boot = () => (booted ??= store.ready.then(markInterrupted));

export async function localRequest(method: string, path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  await boot();
  const p = path.replace(/\?.*$/, '');
  const seg = p.split('/').filter(Boolean).slice(1); // drop "api"
  const is = (m: string, pattern: string) => {
    if (m !== method) return null;
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== seg.length) return null;
    const params: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '*') params.push(decodeURIComponent(seg[i]));
      else if (parts[i] !== seg[i]) return null;
    }
    return params;
  };
  let r: string[] | null;

  try {
    if ((r = is('GET', 'health'))) return await health();
    if ((r = is('GET', 'storage'))) return storageStatus();
    if ((r = is('GET', 'stats'))) {
      const runs = listRuns();
      const count = (m: string) => runs.filter((x) => x.module === m).length;
      const out: ModuleStats[] = [
        { module: 'terminal', runs: count('terminal'), records: 0 },
        { module: 'crawler', runs: count('crawler'), records: store.all<CrawlRecord>('crawls').filter((c) => c.status === 'done').length },
        { module: 'thesis', runs: count('thesis'), records: store.all('theses').length },
        { module: 'brain', runs: count('brain'), records: brainNodes().length },
      ];
      return out;
    }
    if ((r = is('POST', 'command'))) return command(String(body.text ?? '').trim(), body.display ? String(body.display) : undefined);
    if ((r = is('GET', 'runs'))) return listRuns();
    if ((r = is('GET', 'runs/*'))) {
      const d = await getRunDetail(r[0]);
      if (!d) throw new HttpError(404, 'Run not found.');
      return d;
    }
    if ((r = is('DELETE', 'runs/*'))) {
      await deleteRun(r[0]);
      return { ok: true };
    }

    // crawler
    if ((r = is('GET', 'm/crawler/list'))) return crawlList();
    if ((r = is('POST', 'm/crawler/*/attach'))) {
      const c = store.get<CrawlRecord>('crawls', r[0]);
      if (!c) throw new HttpError(404, 'Crawl not found.');
      store.put('crawls', c.id, { ...c, attached: !!body.on });
      return { ok: true, attached: !!body.on };
    }
    if ((r = is('GET', 'm/crawler/*'))) {
      const c = store.get<CrawlRecord>('crawls', r[0]);
      if (!c) throw new HttpError(404, 'Crawl not found.');
      return c;
    }

    // thesis
    if ((r = is('GET', 'm/thesis/handles'))) return th.handles();
    if ((r = is('POST', 'm/thesis/handles'))) return th.addHandles(String(body.handles ?? body.handle ?? ''), body.tags);
    if ((r = is('PATCH', 'm/thesis/handles/*'))) return th.setHandleTags(r[0], body.tags);
    if ((r = is('DELETE', 'm/thesis/handles/*'))) return th.removeHandle(r[0]);
    if ((r = is('GET', 'm/thesis/settings'))) return { ...th.getSettings(), defaultStyle: '' };
    if ((r = is('PUT', 'm/thesis/settings'))) return th.saveSettings(body as never);
    if ((r = is('GET', 'm/thesis/context')))
      return store
        .all<CrawlRecord>('crawls')
        .filter((c) => c.attached && c.status === 'done')
        .map((c) => ({ id: c.id, title: c.title, ticker: c.ticker, form: c.form, createdAt: c.createdAt }));
    if ((r = is('GET', 'm/thesis/list')))
      return store
        .all<ThesisRecord>('theses')
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((t): ThesisListItem => ({ id: t.id, runId: t.runId, createdAt: t.createdAt, status: t.status, view: t.view, posts: t.posts.length, sentAt: t.sentAt, auto: t.auto }));
    if ((r = is('GET', 'm/thesis/by-run/*'))) {
      const t = store.all<ThesisRecord>('theses').find((x) => x.runId === r![0]);
      if (!t) throw new HttpError(404, 'No thesis for that run.');
      return t;
    }
    if ((r = is('POST', 'm/thesis/*/approve'))) return th.setThesisStatus(r[0], 'approved');
    if ((r = is('POST', 'm/thesis/*/send'))) return th.setThesisStatus(r[0], 'sent');
    if ((r = is('GET', 'm/thesis/*'))) {
      const t = store.get<ThesisRecord>('theses', r[0]);
      if (!t) throw new HttpError(404, 'Thesis not found.');
      return t;
    }
    if ((r = is('PUT', 'm/thesis/*'))) return th.updateThesis(r[0], body as never);
    if ((r = is('DELETE', 'm/thesis/*'))) {
      store.remove('theses', r[0]);
      return { ok: true };
    }

    // brain
    if ((r = is('GET', 'm/brain/nodes'))) return brainNodes();
    if ((r = is('POST', 'm/brain/notes'))) return createNote(String(body.title ?? '').slice(0, 200), String(body.body ?? ''), parseTags(body.tags));
    if ((r = is('GET', 'm/brain/notes/*'))) {
      const n = store.get<Note>('notes', r[0]);
      if (!n) throw new HttpError(404, 'Note not found.');
      return n;
    }
    if ((r = is('PUT', 'm/brain/notes/*'))) {
      const n = store.get<Note>('notes', r[0]);
      if (!n) throw new HttpError(404, 'Note not found.');
      const next: Note = {
        ...n,
        title: typeof body.title === 'string' ? body.title.slice(0, 200) : n.title,
        body: typeof body.body === 'string' ? body.body : n.body,
        tags: body.tags !== undefined ? parseTags(body.tags) : n.tags,
        updatedAt: Date.now(),
      };
      store.put('notes', n.id, next);
      return next;
    }
    if ((r = is('DELETE', 'm/brain/notes/*'))) {
      store.remove('notes', r[0]);
      return { ok: true };
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof UserError) throw new HttpError(400, err.message);
    throw err;
  }
  throw new HttpError(404, 'Not found.');
}

export { setPendingPosts } from './thesis.ts';
export type { XHandle };
