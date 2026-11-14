// The daily thesis: shared types and the streaming format Claude writes in.
//
// Claude replies in plain lines so the draft can be shown while it's typed:
//   TAG p12 rates
//   VIEW: main view (continuation lines allowed)
//   POINT: supporting point ... [p3, p7]
//   INVALIDATION: what would make this wrong
//   WATCH: a data release or level to watch today

export const THEMES = ['rates', 'Fed', 'credit', 'FX', 'data', 'other'] as const;
export type Theme = (typeof THEMES)[number];
export const HANDLE_TAGS = ['rates', 'Fed', 'credit', 'FX', 'data'] as const;

export const DEFAULT_STYLE = `Short paragraphs.
Casual, first person ("I think", "I'm watching").
No em dashes.
No hype, no emojis, no "buckle up".
Be specific: name the levels, the data, the accounts.`;

export interface ThesisPoint {
  text: string;
  refs: string[];
}

export interface ThesisDraft {
  view: string;
  points: ThesisPoint[];
  invalidation: string;
  watch: string[];
}

export type ThesisStatus = 'draft' | 'edited' | 'approved' | 'sent';

export interface XPost {
  /** short ref used in prompts and citations, e.g. p12 */
  ref: string;
  id: string;
  handle: string;
  name: string;
  text: string;
  url: string;
  createdAt: number;
  likes: number;
  reposts: number;
  views: number;
  tags: string[];
  theme?: Theme;
}

export interface XHandle {
  handle: string;
  tags: string[];
  addedAt: number;
  lastCount: number | null;
}

export interface ThesisRecord extends ThesisDraft {
  id: string;
  runId: string;
  createdAt: number;
  status: ThesisStatus;
  approvedAt: number | null;
  sentAt: number | null;
  auto: boolean;
  posts: XPost[];
  crawlIds: string[];
}

export interface ThesisListItem {
  id: string;
  runId: string;
  createdAt: number;
  status: ThesisStatus;
  view: string;
  posts: number;
  sentAt: number | null;
  auto: boolean;
}

export interface ThesisSettings {
  style: string;
  schedule: { enabled: boolean; time: string; lastRunDate: string | null };
}

const KEY = /^(TAG|VIEW|POINT|INVALIDATION|WATCH)\b:?\s*/i;

const clean = (s: string) => s.replace(/\s*—\s*/g, ', ').replace(/\s+–\s+/g, ' - ');

export interface ParsedStream {
  tags: Map<string, Theme>;
  draft: ThesisDraft;
  /** which section the stream is currently writing (for the typing caret) */
  writing: 'view' | 'point' | 'invalidation' | 'watch' | 'tags' | null;
}

function refsOf(text: string): { text: string; refs: string[] } {
  const m = text.match(/\[([^\]]*)\]\s*\.?\s*$/);
  if (!m) return { text: text.trim(), refs: [] };
  const refs = m[1].split(/[\s,]+/).filter((x) => /^p\d+$/i.test(x)).map((x) => x.toLowerCase());
  return { text: text.slice(0, m.index).trim(), refs };
}

const themeOf = (raw: string): Theme => {
  const t = raw.trim().toLowerCase();
  return (THEMES.find((x) => x.toLowerCase() === t) ?? 'other') as Theme;
};

/** Parses everything received so far (including a partial last line). Cheap enough to rerun on every delta. */
export function parseThesisStream(text: string): ParsedStream {
  const tags = new Map<string, Theme>();
  const draft: ThesisDraft = { view: '', points: [], invalidation: '', watch: [] };
  let cur: ParsedStream['writing'] = null;
  const raw: { point: string[] } = { point: [] };
  const lines = text.split('\n');
  for (const line0 of lines) {
    const line = line0.replace(/\r$/, '');
    const m = line.match(KEY);
    if (m) {
      const key = m[1].toUpperCase();
      const rest = line.slice(m[0].length);
      if (key === 'TAG') {
        const t = rest.match(/^(p\d+)\s*[:,-]?\s*([A-Za-z]+)/i);
        if (t) tags.set(t[1].toLowerCase(), themeOf(t[2]));
        cur = 'tags';
      } else if (key === 'VIEW') {
        draft.view = draft.view ? `${draft.view}\n\n${rest}` : rest;
        cur = 'view';
      } else if (key === 'POINT') {
        raw.point.push(rest);
        cur = 'point';
      } else if (key === 'INVALIDATION') {
        draft.invalidation = draft.invalidation ? `${draft.invalidation}\n\n${rest}` : rest;
        cur = 'invalidation';
      } else if (key === 'WATCH') {
        draft.watch.push(rest.replace(/^[-•]\s*/, ''));
        cur = 'watch';
      }
      continue;
    }
    if (!line.trim()) continue;
    // continuation of the previous section
    if (cur === 'view') draft.view += `\n\n${line.trim()}`;
    else if (cur === 'invalidation') draft.invalidation += `\n\n${line.trim()}`;
    else if (cur === 'point' && raw.point.length) raw.point[raw.point.length - 1] += ` ${line.trim()}`;
    else if (cur === 'watch' && /^[-•]\s+/.test(line)) draft.watch.push(line.replace(/^[-•]\s*/, '').trim());
  }
  draft.points = raw.point.map((p) => {
    const r = refsOf(p);
    return { text: clean(r.text), refs: r.refs };
  });
  draft.view = clean(draft.view.trim());
  draft.invalidation = clean(draft.invalidation.trim());
  draft.watch = draft.watch.map((w) => clean(w.trim())).filter(Boolean);
  return { tags, draft, writing: cur };
}

/** Plain-text version for Discord or the clipboard. Source links use <> so Discord doesn't unfurl them. */
export function thesisToText(d: ThesisDraft, posts: XPost[], date: Date): string {
  const byRef = new Map(posts.map((p) => [p.ref, p]));
  const day = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const out: string[] = [`**Daily thesis · ${day}**`, '', d.view.trim()];
  if (d.points.length) {
    out.push('', '**Why**');
    d.points.forEach((p, i) => {
      const src = p.refs
        .map((r) => byRef.get(r))
        .filter((x): x is XPost => !!x)
        .map((x) => `@${x.handle} <${x.url}>`);
      out.push(`${i + 1}. ${p.text.trim()}${src.length ? `\n   ↳ ${src.join(' · ')}` : ''}`);
    });
  }
  if (d.invalidation.trim()) out.push('', '**What would change my mind**', d.invalidation.trim());
  if (d.watch.length) out.push('', '**Watch today**', ...d.watch.map((w) => `- ${w.trim()}`));
  return out.join('\n');
}
