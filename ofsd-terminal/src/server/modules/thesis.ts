import type Anthropic from '@anthropic-ai/sdk';
import type { KeyFigure, Observation } from '../../shared/crawl.ts';
import {
  DEFAULT_STYLE,
  HANDLE_TAGS,
  parseThesisStream,
  thesisToText,
  type ThesisDraft,
  type ThesisListItem,
  type ThesisRecord,
  type ThesisSettings,
  type ThesisStatus,
  type XHandle,
  type XPost,
} from '../../shared/thesis.ts';
import { explainError, streamClaude, UserFacingError } from '../claude.ts';
import { db, getSetting, newId, setSetting } from '../db.ts';
import { keyStatus } from '../env.ts';
import { Run } from '../runs.ts';
import { sendToDiscord } from '../thesis/discord.ts';
import { fetchRecentPosts } from '../thesis/x.ts';
import type { ServerModule } from './types.ts';

const LOOKBACK_MS = 24 * 3600_000;
const MAX_POSTS = 400;

const SYSTEM = `You are the macro and rates research assistant inside OFSD Terminal. You draft a private daily market thesis for one trader, built from posts by X accounts they curate and any documents they attached.
Rules:
- Only use what is in the posts and documents. Never invent quotes, numbers or levels. If a level is your own inference, say so.
- Disagreement between accounts is information. Say where people disagree.
- Plain text. No markdown, no bullet characters, no emojis.`;

// ---------------------------------------------------------------- storage

type ThesisRow = {
  id: string;
  run_id: string;
  created_at: number;
  status: ThesisStatus;
  view: string;
  points: string;
  invalidation: string;
  watch: string;
  posts: string;
  crawl_ids: string;
  approved_at: number | null;
  sent_at: number | null;
  auto: number;
};

const handleRows = () =>
  (db.prepare('SELECT handle, tags, added_at, last_count FROM x_handles ORDER BY added_at').all() as Array<{ handle: string; tags: string; added_at: number; last_count: number | null }>).map(
    (r): XHandle => ({ handle: r.handle, tags: JSON.parse(r.tags), addedAt: r.added_at, lastCount: r.last_count }),
  );

function toRecord(r: ThesisRow): ThesisRecord {
  return {
    id: r.id,
    runId: r.run_id,
    createdAt: r.created_at,
    status: r.status,
    view: r.view,
    points: JSON.parse(r.points),
    invalidation: r.invalidation,
    watch: JSON.parse(r.watch),
    posts: JSON.parse(r.posts),
    crawlIds: JSON.parse(r.crawl_ids),
    approvedAt: r.approved_at,
    sentAt: r.sent_at,
    auto: !!r.auto,
  };
}

export function getSettings(): ThesisSettings {
  return {
    style: getSetting('thesis.style', DEFAULT_STYLE),
    schedule: getSetting('thesis.schedule', { enabled: false, time: '07:30', lastRunDate: null as string | null }),
  };
}

const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------------------------------------------------------- prompt

function ago(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

function attachedContext() {
  const rows = db
    .prepare("SELECT id, title, period, report, figures FROM crawls WHERE attached = 1 AND status = 'done' ORDER BY created_at DESC LIMIT 5")
    .all() as Array<{ id: string; title: string; period: string | null; report: string | null; figures: string | null }>;
  const docs = rows.map((r) => {
    const rep = r.report ? (JSON.parse(r.report) as { summary: string; key: string[]; obs: Observation[] }) : null;
    const figs = r.figures ? (JSON.parse(r.figures) as KeyFigure[]) : [];
    const keyFigs = (rep?.key.length ? rep.key.map((k) => figs.find((f) => f.id === k)).filter(Boolean) : figs.slice(0, 12)) as KeyFigure[];
    const lines = [
      `<document title="${r.title.replace(/"/g, "'")}"${r.period ? ` period="${r.period}"` : ''}>`,
      rep?.summary ? `Summary: ${rep.summary}` : '',
      ...keyFigs.map((f) => `${f.label}: ${f.current} vs ${f.prior ?? 'n/a'}${f.change !== null ? ` (${(f.change * 100).toFixed(1)}%)` : ''} ${f.unit}`),
      ...(rep?.obs ?? []).map((o) => `Observation: ${o.text}`),
      '</document>',
    ].filter(Boolean);
    return lines.join('\n');
  });
  return { ids: rows.map((r) => r.id), text: docs.join('\n\n') };
}

function buildMessages(posts: XPost[], style: string, docs: string): Anthropic.Beta.BetaMessageParam[] {
  const now = new Date();
  const postLines = posts.map(
    (p) => `${p.ref} | @${p.handle} | ${p.tags.join(',') || 'untagged'} | ${ago(p.createdAt)} | ${p.likes} likes | ${p.text.replace(/\s*\n\s*/g, ' / ')}`,
  );
  return [
    {
      role: 'user',
      content: `Today is ${now.toDateString()}, ${now.toTimeString().slice(0, 5)} local time.

<posts window="last 24 hours" count="${posts.length}">
${postLines.join('\n')}
</posts>
${docs ? `\n<attached_documents>\n${docs}\n</attached_documents>\n` : ''}
<style_rules>
${style.trim()}
</style_rules>

First, tag every post with exactly one theme, one line per post:
TAG <ref> <theme>
where theme is one of: rates, Fed, credit, FX, data, other.

Then write today's thesis in exactly this format:
VIEW: my main view in 2 to 4 short sentences. A second short paragraph may follow on the next line.
POINT: one supporting point, ending with the refs it comes from in brackets, like [p3, p12]. Write 3 to 5 POINT lines.
INVALIDATION: what would prove this view wrong, concretely.
WATCH: one data release, event or level to watch today. Write 2 to 6 WATCH lines.

Write every sentence in the voice the style rules describe. Output nothing else before, between or after these lines.`,
    },
  ];
}

// ---------------------------------------------------------------- pipeline

async function runThesis(run: Run, auto = false) {
  const handles = handleRows();
  if (!handles.length) throw new UserFacingError('No accounts yet. Open Thesis → Accounts and add the X accounts you follow for macro and rates.');
  const phase = (p: string) => run.emit({ type: 'x:phase', data: { phase: p } });

  phase('fetch');
  run.emit({ type: 'x:handles', data: { list: handles } });
  run.log(`Fetching the last 24h from ${handles.length} account${handles.length === 1 ? '' : 's'}…`);
  const posts: XPost[] = [];
  const tagsByHandle = new Map(handles.map((h) => [h.handle.toLowerCase(), h.tags]));
  const insert = db.prepare(
    `INSERT INTO x_posts (id, handle, name, text, url, created_at, likes, reposts, views, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET likes = excluded.likes, reposts = excluded.reposts, views = excluded.views, fetched_at = excluded.fetched_at`,
  );
  const { perHandle, capped } = await fetchRecentPosts(
    run,
    handles,
    Date.now() - LOOKBACK_MS,
    (batch) => {
      for (const p of batch) {
        const post: XPost = { ...p, ref: `p${posts.length + 1}`, tags: tagsByHandle.get(p.handle.toLowerCase()) ?? [] };
        posts.push(post);
        insert.run(p.id, p.handle, p.name, p.text, p.url, p.createdAt, p.likes, p.reposts, p.views, Date.now());
        run.emit({ type: 'x:post', data: post as unknown as Record<string, unknown> });
      }
    },
    MAX_POSTS,
  );
  for (const h of handles) db.prepare('UPDATE x_handles SET last_count = ? WHERE handle = ?').run(perHandle.get(h.handle.toLowerCase()) ?? 0, h.handle);
  const quiet = handles.filter((h) => !perHandle.get(h.handle.toLowerCase())).map((h) => `@${h.handle}`);
  run.log(`${posts.length} posts${capped ? ` (capped at ${MAX_POSTS})` : ''}.${quiet.length ? ` Nothing new from ${quiet.slice(0, 6).join(', ')}${quiet.length > 6 ? '…' : ''}.` : ''}`);
  if (!posts.length) {
    run.log('No posts in the last 24 hours from your accounts, so there is nothing to build a thesis from.', 'warn');
    phase('done');
    run.end('done');
    return;
  }
  if (!keyStatus().anthropic) throw new UserFacingError('Posts fetched, but there is no Claude key to write the draft. Add ANTHROPIC_API_KEY to .env and run /thesis again.');

  phase('analyze');
  const settings = getSettings();
  const ctx = attachedContext();
  if (ctx.ids.length) run.log(`Using ${ctx.ids.length} attached crawl${ctx.ids.length === 1 ? '' : 's'} as extra context.`);
  run.log('Claude is clustering the posts and drafting…');
  let text = '';
  await streamClaude({
    system: SYSTEM,
    messages: buildMessages(posts, settings.style, ctx.text),
    maxTokens: 16000,
    onText: (d) => {
      text += d;
      run.emit({ type: 'x:draft', data: { d } });
    },
    onTruncated: () => run.log('The draft hit the length limit and was cut off.', 'warn'),
  });
  const parsed = parseThesisStream(text);
  for (const p of posts) p.theme = parsed.tags.get(p.ref) ?? 'other';
  const d = parsed.draft;
  if (!d.view && !d.points.length) throw new UserFacingError("Claude's reply didn't contain a thesis. Try running /thesis again.");

  const id = newId('thesis');
  db.prepare(
    `INSERT INTO theses (id, run_id, created_at, status, view, points, invalidation, watch, posts, crawl_ids, auto)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, run.id, Date.now(), d.view, JSON.stringify(d.points), d.invalidation, JSON.stringify(d.watch), JSON.stringify(posts), JSON.stringify(ctx.ids), auto ? 1 : 0);
  run.emit({ type: 'x:saved', data: { thesisId: id } });
  run.log(`Draft ready: ${d.points.length} points, ${d.watch.length} things to watch. It stays a DRAFT until you edit or approve it.`);
  phase('done');
  run.end('done');
}

// ---------------------------------------------------------------- scheduler

let ticking = false;
function scheduleTick() {
  if (ticking) return;
  const { schedule } = getSettings();
  if (!schedule.enabled) return;
  const now = new Date();
  const today = localDate(now);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (schedule.lastRunDate === today || hhmm < schedule.time) return;
  setSetting('thesis.schedule', { ...schedule, lastRunDate: today });
  ticking = true;
  const run = new Run('thesis', '/thesis (scheduled)');
  runThesis(run, true)
    .catch((err) => run.fail(explainError(err)))
    .finally(() => (ticking = false));
}

// ---------------------------------------------------------------- module

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const normHandle = (h: string) => h.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?]/)[0];
const validTags = (t: unknown) => (Array.isArray(t) ? t.filter((x): x is string => (HANDLE_TAGS as readonly string[]).includes(x)) : []);

export const thesis: ServerModule = {
  id: 'thesis',
  title: 'Thesis',
  migrations: [
    [
      'thesis:001-tables',
      `CREATE TABLE x_handles (
         handle TEXT PRIMARY KEY COLLATE NOCASE,
         tags TEXT NOT NULL DEFAULT '[]',
         added_at INTEGER NOT NULL,
         last_count INTEGER
       );
       CREATE TABLE x_posts (
         id TEXT PRIMARY KEY, handle TEXT NOT NULL, name TEXT, text TEXT NOT NULL, url TEXT NOT NULL,
         created_at INTEGER NOT NULL, likes INTEGER, reposts INTEGER, views INTEGER, fetched_at INTEGER NOT NULL
       );
       CREATE INDEX x_posts_created ON x_posts(created_at DESC);
       CREATE TABLE theses (
         id TEXT PRIMARY KEY,
         run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
         created_at INTEGER NOT NULL,
         status TEXT NOT NULL,
         view TEXT NOT NULL DEFAULT '', points TEXT NOT NULL DEFAULT '[]', invalidation TEXT NOT NULL DEFAULT '', watch TEXT NOT NULL DEFAULT '[]',
         posts TEXT NOT NULL DEFAULT '[]', crawl_ids TEXT NOT NULL DEFAULT '[]',
         approved_at INTEGER, sent_at INTEGER, discord TEXT, auto INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX theses_created ON theses(created_at DESC);`,
    ],
  ],
  commands: {
    thesis: {
      description: "Draft today's macro thesis from your X accounts.",
      run: async (_args, run) => runThesis(run),
    },
  },
  records: () => (db.prepare('SELECT COUNT(*) AS n FROM theses').get() as { n: number }).n,
  start: () => {
    setInterval(scheduleTick, 30_000);
    setTimeout(scheduleTick, 5_000);
  },
  routes: (r) => {
    // accounts
    r.get('/handles', (_req, res) => res.json(handleRows()));
    r.post('/handles', (req, res) => {
      const raw = String(req.body?.handles ?? req.body?.handle ?? '');
      const tags = validTags(req.body?.tags);
      const list = raw.split(/[\s,]+/).map(normHandle).filter(Boolean);
      const bad = list.filter((h) => !HANDLE_RE.test(h));
      if (!list.length || bad.length) {
        res.status(400).json({ error: bad.length ? `"${bad[0]}" isn't a valid X handle (letters, numbers and _ only, up to 15).` : 'Type a handle, like @NickTimiraos.' });
        return;
      }
      const ins = db.prepare('INSERT INTO x_handles (handle, tags, added_at) VALUES (?, ?, ?) ON CONFLICT(handle) DO NOTHING');
      let added = 0;
      list.forEach((h, i) => (added += Number(ins.run(h, JSON.stringify(tags), Date.now() + i).changes)));
      res.json({ added, handles: handleRows() });
    });
    r.patch('/handles/:h', (req, res) => {
      db.prepare('UPDATE x_handles SET tags = ? WHERE handle = ?').run(JSON.stringify(validTags(req.body?.tags)), req.params.h);
      res.json(handleRows());
    });
    r.delete('/handles/:h', (req, res) => {
      db.prepare('DELETE FROM x_handles WHERE handle = ?').run(req.params.h);
      res.json(handleRows());
    });

    // settings
    r.get('/settings', (_req, res) => res.json({ ...getSettings(), defaultStyle: DEFAULT_STYLE }));
    r.put('/settings', (req, res) => {
      const cur = getSettings();
      if (typeof req.body?.style === 'string') setSetting('thesis.style', req.body.style.slice(0, 4000) || DEFAULT_STYLE);
      if (req.body?.schedule) {
        const s = req.body.schedule;
        const time = typeof s.time === 'string' && /^\d{2}:\d{2}$/.test(s.time) ? s.time : cur.schedule.time;
        // changing the time re-arms today's run
        const lastRunDate = time !== cur.schedule.time ? null : cur.schedule.lastRunDate;
        setSetting('thesis.schedule', { enabled: !!s.enabled, time, lastRunDate });
      }
      res.json({ ...getSettings(), defaultStyle: DEFAULT_STYLE });
    });

    // attached crawls (context)
    r.get('/context', (_req, res) => {
      res.json(db.prepare("SELECT id, title, ticker, form, created_at AS createdAt FROM crawls WHERE attached = 1 AND status = 'done' ORDER BY created_at DESC LIMIT 5").all());
    });

    // theses
    r.get('/list', (_req, res) => {
      const rows = db.prepare('SELECT id, run_id, created_at, status, view, posts, sent_at, auto FROM theses ORDER BY created_at DESC LIMIT 100').all() as ThesisRow[];
      const list: ThesisListItem[] = rows.map((x) => ({
        id: x.id,
        runId: x.run_id,
        createdAt: x.created_at,
        status: x.status,
        view: x.view,
        posts: (JSON.parse(x.posts) as unknown[]).length,
        sentAt: x.sent_at,
        auto: !!x.auto,
      }));
      res.json(list);
    });
    r.get('/by-run/:runId', (req, res) => {
      const row = db.prepare('SELECT * FROM theses WHERE run_id = ?').get(req.params.runId) as ThesisRow | undefined;
      if (!row) res.status(404).json({ error: 'No thesis for that run.' });
      else res.json(toRecord(row));
    });
    r.get('/:id', (req, res) => {
      const row = db.prepare('SELECT * FROM theses WHERE id = ?').get(req.params.id) as ThesisRow | undefined;
      if (!row) res.status(404).json({ error: 'Thesis not found.' });
      else res.json(toRecord(row));
    });
    r.put('/:id', (req, res) => {
      const row = db.prepare('SELECT * FROM theses WHERE id = ?').get(req.params.id) as ThesisRow | undefined;
      if (!row) {
        res.status(404).json({ error: 'Thesis not found.' });
        return;
      }
      const b = req.body as Partial<ThesisDraft>;
      const points = Array.isArray(b.points)
        ? b.points.map((p) => ({ text: String(p?.text ?? ''), refs: Array.isArray(p?.refs) ? p.refs.map(String) : [] }))
        : JSON.parse(row.points);
      // editing a sent or approved draft keeps that status; editing a draft marks it edited
      const status: ThesisStatus = row.status === 'draft' ? 'edited' : row.status;
      db.prepare('UPDATE theses SET view = ?, points = ?, invalidation = ?, watch = ?, status = ? WHERE id = ?').run(
        typeof b.view === 'string' ? b.view : row.view,
        JSON.stringify(points),
        typeof b.invalidation === 'string' ? b.invalidation : row.invalidation,
        JSON.stringify(Array.isArray(b.watch) ? b.watch.map(String) : JSON.parse(row.watch)),
        status,
        row.id,
      );
      res.json(toRecord(db.prepare('SELECT * FROM theses WHERE id = ?').get(row.id) as ThesisRow));
    });
    r.post('/:id/approve', (req, res) => {
      const out = db.prepare("UPDATE theses SET status = CASE WHEN status = 'sent' THEN 'sent' ELSE 'approved' END, approved_at = ? WHERE id = ?").run(Date.now(), req.params.id);
      if (!out.changes) res.status(404).json({ error: 'Thesis not found.' });
      else res.json(toRecord(db.prepare('SELECT * FROM theses WHERE id = ?').get(req.params.id) as ThesisRow));
    });
    r.delete('/:id', (req, res) => {
      db.prepare('DELETE FROM theses WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    });
    // The only path that posts anywhere: an explicit click on "Send to Discord".
    r.post('/:id/send', async (req, res) => {
      const row = db.prepare('SELECT * FROM theses WHERE id = ?').get(req.params.id) as ThesisRow | undefined;
      if (!row) {
        res.status(404).json({ error: 'Thesis not found.' });
        return;
      }
      const rec = toRecord(row);
      try {
        const ids = await sendToDiscord(thesisToText(rec, rec.posts, new Date(rec.createdAt)));
        db.prepare("UPDATE theses SET status = 'sent', sent_at = ?, discord = ? WHERE id = ?").run(Date.now(), JSON.stringify(ids), row.id);
        res.json(toRecord(db.prepare('SELECT * FROM theses WHERE id = ?').get(row.id) as ThesisRow));
      } catch (err) {
        res.status(400).json({ error: explainError(err) });
      }
    });
  },
};
