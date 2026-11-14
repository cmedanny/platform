// Daily thesis for the Claude-app version. The page can't reach X, so posts are
// pasted in; Claude (on the viewer's plan) tags them and drafts the thesis.

import type { KeyFigure } from '../../shared/crawl.ts';
import { DEFAULT_STYLE, HANDLE_TAGS, parseThesisStream, type ThesisDraft, type ThesisRecord, type ThesisSettings, type XHandle, type XPost } from '../../shared/thesis.ts';
import { askClaude, fitBytes, promptBudget } from './claude.ts';
import { UserError } from './claudeapp.ts';
import type { CrawlRecord } from './crawl.ts';
import type { LocalRun } from './runs.ts';
import { store } from './store.ts';

const SYSTEM = `You are the macro and rates research assistant inside OFSD Terminal. You draft a private daily market thesis for one trader, built from posts by X accounts they curate and any documents they attached.
Rules:
- Only use what is in the posts and documents. Never invent quotes, numbers or levels. If a level is your own inference, say so.
- Disagreement between accounts is information. Say where people disagree.
- Plain text. No markdown, no bullet characters, no emojis.`;

let pending = '';
/** The thesis screen hands pasted posts over before running /thesis. */
export function setPendingPosts(text: string) {
  pending = text;
}

const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---------------------------------------------------------------- settings + accounts

export function getSettings(): ThesisSettings {
  const s = store.get<{ style?: string }>('settings', 'thesis') ?? {};
  return { style: s.style || DEFAULT_STYLE, schedule: { enabled: false, time: '07:30', lastRunDate: null } };
}

export function saveSettings(patch: Partial<ThesisSettings>) {
  const cur = store.get<{ style?: string }>('settings', 'thesis') ?? {};
  if (typeof patch.style === 'string') store.put('settings', 'thesis', { ...cur, style: patch.style.slice(0, 4000) || DEFAULT_STYLE });
  return getSettings();
}

export const handles = () => store.all<XHandle>('handles').sort((a, b) => a.addedAt - b.addedAt);

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const norm = (h: string) => h.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').split(/[/?]/)[0];
const validTags = (t: unknown) => (Array.isArray(t) ? t.filter((x): x is string => (HANDLE_TAGS as readonly string[]).includes(x)) : []);

export function addHandles(raw: string, tags: unknown) {
  const list = raw.split(/[\s,]+/).map(norm).filter(Boolean);
  const bad = list.filter((h) => !HANDLE_RE.test(h));
  if (!list.length || bad.length) throw new UserError(bad.length ? `"${bad[0]}" isn't a valid X handle (letters, numbers and _ only, up to 15).` : 'Type a handle, like @NickTimiraos.');
  let added = 0;
  list.forEach((h, i) => {
    if ([...store.tables.handles.keys()].some((k) => k.toLowerCase() === h.toLowerCase())) return;
    store.put('handles', h, { handle: h, tags: validTags(tags), addedAt: Date.now() + i, lastCount: null } satisfies XHandle);
    added++;
  });
  return { added, handles: handles() };
}

export function setHandleTags(h: string, tags: unknown) {
  const cur = store.get<XHandle>('handles', h);
  if (cur) store.put('handles', h, { ...cur, tags: validTags(tags) });
  return handles();
}

export function removeHandle(h: string) {
  store.remove('handles', h);
  return handles();
}

// ---------------------------------------------------------------- pasted posts

const METRIC = /^[\d.,]+[KkMm]?$|^(Reply|Repost|Like|View|Views|Show more|Quote|Bookmark|Pinned|Promoted|·|Translate post)$/;
const TIME = /^(\d+[smhd]|[A-Z][a-z]{2} \d{1,2}(, \d{4})?)$/;

/** Turns text copied from X (or written by hand as "@handle: text") into posts. */
export function parsePosts(text: string): XPost[] {
  const tags = new Map(handles().map((h) => [h.handle.toLowerCase(), h.tags]));
  const blocks = text
    .replace(/\r/g, '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  const posts: XPost[] = [];
  let carryHandle = '';
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    let handle = '';
    const body: string[] = [];
    for (const l of lines) {
      const only = l.match(/^@([A-Za-z0-9_]{1,15})$/);
      const inline = l.match(/^@([A-Za-z0-9_]{1,15})\s*[:\-–]\s*(.+)$/);
      if (only && !handle) handle = only[1];
      else if (inline && !handle) {
        handle = inline[1];
        body.push(inline[2]);
      } else if (METRIC.test(l) || TIME.test(l)) continue;
      else body.push(l);
    }
    // X copies "Name" on the line before "@handle": drop it when it's alone
    if (handle && body.length > 1 && lines[0] !== `@${handle}` && body[0] === lines[0] && body[0].length < 50 && !/[.!?]$/.test(body[0])) body.shift();
    const t = body.join(' ').replace(/\s+/g, ' ').trim();
    if (!t) {
      if (handle) carryHandle = handle;
      continue;
    }
    if (!handle && carryHandle) handle = carryHandle;
    carryHandle = '';
    const h = handle || 'pasted';
    posts.push({
      ref: `p${posts.length + 1}`,
      id: newId('post'),
      handle: h,
      name: h,
      text: t.slice(0, 1200),
      url: handle ? `https://x.com/${handle}` : '',
      createdAt: Date.now(),
      likes: 0,
      reposts: 0,
      views: 0,
      tags: tags.get(h.toLowerCase()) ?? [],
    });
  }
  return posts.slice(0, 400);
}

// ---------------------------------------------------------------- run

function attachedContext() {
  const crawls = store.all<CrawlRecord>('crawls').filter((c) => c.attached && c.status === 'done').sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  const text = crawls
    .map((c) => {
      const figs = (c.report.key.length ? c.report.key.map((k) => c.figures.find((f) => f.id === k)).filter(Boolean) : c.figures.slice(0, 12)) as KeyFigure[];
      return [
        `<document title="${c.title}"${c.period ? ` period="${c.period}"` : ''}>`,
        c.report.summary ? `Summary: ${c.report.summary}` : '',
        ...figs.map((f) => `${f.label}: ${f.current} vs ${f.prior ?? 'n/a'}${f.change !== null ? ` (${(f.change * 100).toFixed(1)}%)` : ''} ${f.unit}`),
        ...c.report.obs.map((o) => `Observation: ${o.text}`),
        '</document>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
  return { ids: crawls.map((c) => c.id), text };
}

export async function runThesis(_args: string, run: LocalRun) {
  const text = pending;
  pending = '';
  if (!text.trim()) throw new UserError("Paste today's posts first: open Thesis and press Draft today's thesis.");
  const posts = parsePosts(text);
  if (!posts.length) throw new UserError("Couldn't find any posts in what you pasted.");
  const phase = (p: string) => run.emit({ type: 'x:phase', data: { phase: p } });

  phase('fetch');
  run.emit({ type: 'x:handles', data: { list: handles() } });
  run.log(`${posts.length} pasted posts from ${new Set(posts.map((p) => p.handle)).size} accounts.`);
  for (const p of posts) {
    run.emit({ type: 'x:post', data: p as unknown as Record<string, unknown> });
    await new Promise((r) => setTimeout(r, 35)); // let the cards land one by one
  }

  phase('analyze');
  const settings = getSettings();
  const ctx = attachedContext();
  if (ctx.ids.length) run.log(`Using ${ctx.ids.length} attached crawl${ctx.ids.length === 1 ? '' : 's'} as extra context.`);
  run.log('Claude is clustering the posts and drafting (on your Claude plan)…');
  const now = new Date();
  const lines = posts.map((p) => `${p.ref} | @${p.handle} | ${p.tags.join(',') || 'untagged'} | ${p.text.replace(/\s*\n\s*/g, ' / ')}`);
  const budget = (await promptBudget()) - 6_000;
  const body = fitBytes(lines.join('\n'), Math.max(20_000, budget - 3_000));
  if (body.cut) run.log('Too many posts for one request; Claude used the first ones.', 'warn');
  const prompt = `${SYSTEM}

Today is ${now.toDateString()}, ${now.toTimeString().slice(0, 5)} local time.

<posts count="${posts.length}">
${body.text}
</posts>
${ctx.text ? `\n<attached_documents>\n${ctx.text}\n</attached_documents>\n` : ''}
<style_rules>
${settings.style.trim()}
</style_rules>

First, tag every post with exactly one theme, one line per post:
TAG <ref> <theme>
where theme is one of: rates, Fed, credit, FX, data, other.

Then write today's thesis in exactly this format:
VIEW: my main view in 2 to 4 short sentences. A second short paragraph may follow on the next line.
POINT: one supporting point, ending with the refs it comes from in brackets, like [p3, p12]. Write 3 to 5 POINT lines.
INVALIDATION: what would prove this view wrong, concretely.
WATCH: one data release, event or level to watch today. Write 2 to 6 WATCH lines.

Write every sentence in the voice the style rules describe. Output nothing else before, between or after these lines.`;
  let out = '';
  await askClaude(prompt, (d) => {
    out += d;
    run.emit({ type: 'x:draft', data: { d } });
  });
  const parsed = parseThesisStream(out);
  for (const p of posts) p.theme = parsed.tags.get(p.ref) ?? 'other';
  const d = parsed.draft;
  if (!d.view && !d.points.length) throw new UserError("Claude's reply didn't contain a thesis. Try again.");
  const id = newId('thesis');
  const rec: ThesisRecord = { id, runId: run.id, createdAt: Date.now(), status: 'draft', ...d, posts, crawlIds: ctx.ids, approvedAt: null, sentAt: null, auto: false };
  store.put('theses', id, rec);
  run.emit({ type: 'x:saved', data: { thesisId: id } });
  run.log(`Draft ready: ${d.points.length} points, ${d.watch.length} things to watch. It stays a DRAFT until you edit or approve it.`);
  phase('done');
  run.end('done');
}

export function updateThesis(id: string, b: Partial<ThesisDraft>) {
  const cur = store.get<ThesisRecord>('theses', id);
  if (!cur) throw new UserError('Thesis not found.');
  const next: ThesisRecord = {
    ...cur,
    view: typeof b.view === 'string' ? b.view : cur.view,
    points: Array.isArray(b.points) ? b.points.map((p) => ({ text: String(p?.text ?? ''), refs: Array.isArray(p?.refs) ? p.refs.map(String) : [] })) : cur.points,
    invalidation: typeof b.invalidation === 'string' ? b.invalidation : cur.invalidation,
    watch: Array.isArray(b.watch) ? b.watch.map(String) : cur.watch,
    status: cur.status === 'draft' ? 'edited' : cur.status,
  };
  store.put('theses', id, next);
  return next;
}

export function setThesisStatus(id: string, status: 'approved' | 'sent') {
  const cur = store.get<ThesisRecord>('theses', id);
  if (!cur) throw new UserError('Thesis not found.');
  const next: ThesisRecord =
    status === 'approved'
      ? { ...cur, status: cur.status === 'sent' ? 'sent' : 'approved', approvedAt: Date.now() }
      : { ...cur, status: 'sent', sentAt: Date.now() };
  store.put('theses', id, next);
  return next;
}

export const hasPendingPosts = () => pending.trim().length > 0;
