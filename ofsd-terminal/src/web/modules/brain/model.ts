import type { BrainNode, NodeKind } from '../../../shared/brain.ts';
import { useStore } from '../../lib/store.ts';
import { openSession } from '../crawler/session.ts';
import { closeThesisSession } from '../thesis/session.ts';

export type GroupBy = 'ticker' | 'theme' | 'date';
export type Order = 'newest' | 'oldest';

export interface Group {
  key: string;
  label: string;
  nodes: BrainNode[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== today.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}

export const isToday = (ms: number) => new Date(ms).toDateString() === new Date().toDateString();

export function groupNodes(nodes: BrainNode[], by: GroupBy, order: Order, max = 10): Group[] {
  const map = new Map<string, Group>();
  const sorted = [...nodes].sort((a, b) => (order === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt));
  for (const n of sorted) {
    let key: string;
    let label: string;
    if (by === 'ticker') {
      key = n.tickers[0] ?? '—';
      label = n.tickers[0] ?? 'No ticker';
    } else if (by === 'theme') {
      key = (n.themes[0] ?? 'other').toLowerCase();
      label = n.themes[0] ?? 'other';
    } else {
      const d = new Date(n.createdAt);
      key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      label = dayLabel(n.createdAt);
    }
    if (!map.has(key)) map.set(key, { key, label, nodes: [] });
    map.get(key)!.nodes.push(n);
  }
  let groups = [...map.values()];
  // dates keep time order; tickers and themes go biggest first
  if (by !== 'date') groups.sort((a, b) => b.nodes.length - a.nodes.length || a.label.localeCompare(b.label));
  if (groups.length > max) {
    const rest = groups.slice(max - 1);
    groups = [...groups.slice(0, max - 1), { key: '__other', label: `${rest.length} more`, nodes: rest.flatMap((g) => g.nodes) }];
  }
  return groups;
}

export const KIND_LABEL: Record<NodeKind, string> = { crawl: 'Crawl', thesis: 'Thesis', note: 'Note' };

/** Small shape per kind: square = crawl, diamond = thesis, circle = note. */
export function drawGlyph(ctx: CanvasRenderingContext2D, kind: NodeKind, x: number, y: number, r: number) {
  ctx.beginPath();
  if (kind === 'crawl') ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (kind === 'thesis') {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.3, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.lineTo(x - r * 1.3, y);
    ctx.closePath();
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
}

/** Open a node in its own module (notes open in the Brain's drawer, handled by the caller). */
export function openNode(n: BrainNode) {
  const st = useStore.getState();
  if (n.kind === 'crawl' && n.runId) {
    st.setPref('crawler', 'lastRun', n.runId);
    st.setPref('crawler', 'view', 'report');
    openSession(n.runId, 'static');
    st.open('crawler');
  } else if (n.kind === 'thesis') {
    closeThesisSession();
    st.setPref('thesis', 'thesisId', n.refId);
    st.setPref('thesis', 'tab', 'today');
    st.open('thesis');
  }
}
