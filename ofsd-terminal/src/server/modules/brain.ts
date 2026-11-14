import type { BrainNode, Note } from '../../shared/brain.ts';
import type { Theme, ThesisPoint, XPost } from '../../shared/thesis.ts';
import { UserFacingError } from '../claude.ts';
import { db, newId } from '../db.ts';
import type { ServerModule } from './types.ts';

type NoteRow = { id: string; title: string; body: string; tags: string; created_at: number; updated_at: number };
const toNote = (r: NoteRow): Note => ({ id: r.id, title: r.title, body: r.body, tags: JSON.parse(r.tags), createdAt: r.created_at, updatedAt: r.updated_at });

const COMMON = new Set(['A', 'I', 'CEO', 'CFO', 'GDP', 'CPI', 'PCE', 'FOMC', 'FED', 'USD', 'EUR', 'JPY', 'IG', 'HY', 'US', 'UK', 'EU', 'Q1', 'Q2', 'Q3', 'Q4', 'FY', 'AI', 'ETF', 'OK', 'PM', 'AM']);

/** Tickers mentioned in free text: $CASHTAGS, plus bare symbols we've crawled before. */
function tickersIn(text: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g)) if (!COMMON.has(m[1])) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

function parseTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  return [...new Set(list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 12);
}

/** First line becomes the title (trimmed), the rest the body. */
function splitNote(text: string) {
  const t = text.trim();
  const nl = t.indexOf('\n');
  const first = nl < 0 ? t : t.slice(0, nl);
  const title = first.length > 80 ? `${first.slice(0, 77)}…` : first;
  return { title, body: nl < 0 ? (first.length > 80 ? t : '') : t.slice(nl + 1).trim() };
}

function buildNodes(): BrainNode[] {
  const crawls = db
    .prepare("SELECT id, run_id, kind, ticker, form, title, company, period, filed, status, created_at, stats, attached FROM crawls WHERE status != 'running' ORDER BY created_at DESC")
    .all() as Array<{ id: string; run_id: string; kind: string; ticker: string | null; form: string | null; title: string; company: string | null; period: string | null; filed: string | null; status: string; created_at: number; stats: string | null; attached: number }>;
  const theses = db
    .prepare('SELECT id, run_id, created_at, status, view, points, invalidation, watch, posts, crawl_ids, auto FROM theses ORDER BY created_at DESC')
    .all() as Array<{ id: string; run_id: string; created_at: number; status: string; view: string; points: string; invalidation: string; watch: string; posts: string; crawl_ids: string; auto: number }>;
  const notes = (db.prepare('SELECT * FROM notes ORDER BY created_at DESC').all() as NoteRow[]).map(toNote);

  const known = new Set(crawls.map((c) => c.ticker).filter((t): t is string => !!t));
  const nodes: BrainNode[] = [];

  for (const c of crawls) {
    const stats = c.stats ? (JSON.parse(c.stats) as { values?: number; pages?: number }) : {};
    nodes.push({
      id: `crawl:${c.id}`,
      kind: 'crawl',
      refId: c.id,
      runId: c.run_id,
      title: c.ticker ? `${c.ticker} ${c.form}` : c.title || 'Web page',
      subtitle: c.kind === 'edgar' ? `${c.company ?? ''}${c.period ? ` · period ${c.period}` : ''}` : c.title,
      createdAt: c.created_at,
      tickers: c.ticker ? [c.ticker] : [],
      themes: [c.kind === 'edgar' ? 'filings' : 'web'],
      status: c.status,
      weight: Math.max(1, Math.min(5, Math.round(Math.log10((stats.values ?? 10) + 1) * 1.6))),
      links: [],
    });
  }

  for (const t of theses) {
    const posts = JSON.parse(t.posts) as XPost[];
    const points = JSON.parse(t.points) as ThesisPoint[];
    const counts = new Map<Theme, number>();
    for (const p of posts) if (p.theme && p.theme !== 'other') counts.set(p.theme, (counts.get(p.theme) ?? 0) + 1);
    const themes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k as string);
    const text = [t.view, ...points.map((p) => p.text), t.invalidation, ...(JSON.parse(t.watch) as string[])].join(' ');
    nodes.push({
      id: `thesis:${t.id}`,
      kind: 'thesis',
      refId: t.id,
      runId: t.run_id,
      title: t.view.split(/(?<=[.!?])\s/)[0]?.slice(0, 90) || 'Daily thesis',
      subtitle: `${posts.length} posts · ${t.status}${t.auto ? ' · scheduled' : ''}`,
      createdAt: t.created_at,
      tickers: tickersIn(text, known),
      themes: themes.length ? themes : ['macro'],
      status: t.status,
      weight: Math.max(1, Math.min(5, Math.round(Math.sqrt(posts.length) / 2.5))),
      links: (JSON.parse(t.crawl_ids) as string[]).map((id) => `crawl:${id}`),
    });
  }

  for (const n of notes) {
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
  }

  // Shared tickers link each node to the most recent crawl of that ticker.
  const latestCrawl = new Map<string, string>();
  for (const n of nodes) if (n.kind === 'crawl') for (const t of n.tickers) if (!latestCrawl.has(t)) latestCrawl.set(t, n.id);
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const t of n.tickers) {
      const c = latestCrawl.get(t);
      if (c && c !== n.id && !n.links.includes(c)) n.links.push(c);
    }
    n.links = n.links.filter((l) => ids.has(l));
  }
  return nodes;
}

function createNote(title: string, body: string, tags: string[]): Note {
  const id = newId('note');
  const now = Date.now();
  db.prepare("INSERT INTO notes (id, title, body, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'note', ?, ?)").run(id, title, body, JSON.stringify(tags), now, now);
  return toNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow);
}

export const brain: ServerModule = {
  id: 'brain',
  title: 'Brain',
  commands: {
    note: {
      description: 'Save a note to the Brain. First line is the title. Use #tags.',
      run: async (args, run) => {
        const text = args.trim();
        if (!text) throw new UserFacingError('Type the note after /note, for example: /note NVDA guide implies 60% DC growth #ai #semis');
        const tags = [...text.matchAll(/(?:^|\s)#([\w-]{1,24})/g)].map((m) => m[1]);
        const { title, body } = splitNote(text.replace(/(?:^|\s)#[\w-]{1,24}/g, ' ').replace(/[ \t]+/g, ' '));
        const note = createNote(title, body, tags);
        run.emit({ type: 'x:note', data: { id: note.id } });
        run.log(`Saved note "${note.title}"${tags.length ? ` (${tags.map((t) => `#${t}`).join(' ')})` : ''}.`);
        run.end('done');
      },
    },
  },
  records: () =>
    (db.prepare("SELECT (SELECT COUNT(*) FROM crawls WHERE status != 'running') + (SELECT COUNT(*) FROM theses) + (SELECT COUNT(*) FROM notes) AS n").get() as { n: number }).n,
  routes: (r) => {
    r.get('/nodes', (_req, res) => res.json(buildNodes()));
    r.get('/notes/:id', (req, res) => {
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id) as NoteRow | undefined;
      if (!row) res.status(404).json({ error: 'Note not found.' });
      else res.json(toNote(row));
    });
    r.post('/notes', (req, res) => {
      const title = String(req.body?.title ?? '').trim().slice(0, 200);
      const body = String(req.body?.body ?? '');
      res.json(createNote(title, body, parseTags(req.body?.tags)));
    });
    r.put('/notes/:id', (req, res) => {
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id) as NoteRow | undefined;
      if (!row) {
        res.status(404).json({ error: 'Note not found.' });
        return;
      }
      db.prepare('UPDATE notes SET title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?').run(
        typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : row.title,
        typeof req.body?.body === 'string' ? req.body.body : row.body,
        req.body?.tags !== undefined ? JSON.stringify(parseTags(req.body.tags)) : row.tags,
        Date.now(),
        row.id,
      );
      res.json(toNote(db.prepare('SELECT * FROM notes WHERE id = ?').get(row.id) as NoteRow));
    });
    r.delete('/notes/:id', (req, res) => {
      db.prepare('DELETE FROM notes WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    });
  },
};
