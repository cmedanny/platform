// One crawl being watched: live, replayed, or opened after the fact.
// Holds everything the panes draw. Plain object + subscribe, so canvases can
// read it every frame without React re-rendering.

import { useSyncExternalStore } from 'react';
import type { CrawlMeta, DocBlock, DocToken, KeyFigure, NetLine, Observation } from '../../../shared/crawl.ts';
import type { RunEvent } from '../../../shared/types.ts';
import { api, followRun, replayEvents } from '../../lib/api.ts';
import type { Reader } from './reader.ts';

export type Mode = 'live' | 'replay' | 'static';
export type Phase = 'resolve' | 'fetch' | 'analyze' | 'done' | 'error';

export interface ParsedStats {
  blocks: number;
  pages: number;
  tokens: number;
  values: number;
  callouts: number;
  figures: number;
  stmts: Record<string, number>;
}

export class CrawlSession {
  meta: CrawlMeta | null = null;
  phase: Phase = 'resolve';
  status: 'running' | 'done' | 'error' = 'running';
  error = '';
  net: NetLine[] = [];
  raw = '';
  rawDone = false;
  blocks: DocBlock[] = [];
  tokens: DocToken[] = [];
  parsed: ParsedStats | null = null;
  figures: KeyFigure[] = [];
  summary = '';
  key: string[] = [];
  obs: Observation[] = [];
  logs: string[] = [];
  version = 0;
  /** Bumped only when blocks change (the document pane re-renders on this). */
  docVersion = 0;
  startedAt = performance.now();
  stop: () => void = () => {};

  // Reading progress (filled by the reader).
  readAt: number[] = [];
  figuresRead = 0;
  readerDone = false;
  /** Created by the document pane; lives as long as the session so remounts keep their place. */
  reader: Reader | null = null;

  private listeners = new Set<() => void>();
  private scheduled = false;

  constructor(
    readonly runId: string,
    readonly mode: Mode,
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Coalesces notifications to one per frame. */
  notify() {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.listeners.forEach((l) => l());
    });
  }

  get live() {
    return this.status === 'running' || (!this.readerDone && this.mode !== 'static');
  }

  apply(e: RunEvent) {
    switch (e.type) {
      case 'x:crawl':
        this.meta = e.data as unknown as CrawlMeta;
        break;
      case 'x:phase':
        this.phase = e.data.phase as Phase;
        break;
      case 'x:net': {
        const line = e.data as unknown as NetLine;
        const i = this.net.findIndex((n) => n.id === line.id);
        if (i < 0) this.net = [...this.net, line];
        else this.net = this.net.map((n, k) => (k === i ? { ...n, ...line, url: line.note === 'redirected' ? line.url : n.url } : n));
        break;
      }
      case 'x:raw':
        this.raw += e.data.s as string;
        break;
      case 'x:doc': {
        const blocks = e.data.blocks as DocBlock[];
        this.blocks = this.blocks.concat(blocks);
        for (const b of blocks) for (const t of b.tokens) this.tokens[t.id] = t;
        this.docVersion++;
        break;
      }
      case 'x:parsed':
        this.parsed = e.data as unknown as ParsedStats;
        this.rawDone = true;
        break;
      case 'x:figures':
        this.figures = e.data.list as KeyFigure[];
        break;
      case 'x:summary':
        this.summary = e.data.text as string;
        break;
      case 'x:key':
        this.key = e.data.ids as string[];
        break;
      case 'x:obs':
        this.obs = [...this.obs, e.data as unknown as Observation];
        break;
      case 'log':
        this.logs = [...this.logs.slice(-30), e.data.text];
        if (e.data.level === 'error' && this.status === 'running') this.error = e.data.text;
        break;
      case 'end':
        this.status = e.data.status === 'error' ? 'error' : 'done';
        this.rawDone = true;
        if (e.data.error) this.error = e.data.error;
        if (this.status === 'error') this.phase = 'error';
        break;
    }
    this.notify();
  }

  figure(id: string) {
    return this.figures.find((f) => f.id === id);
  }
}

// ---- the one session on screen -------------------------------------------

let current: CrawlSession | null = null;
const sessionListeners = new Set<() => void>();
const emit = () => sessionListeners.forEach((l) => l());

export function getSession() {
  return current;
}

export async function openSession(runId: string, mode: Mode, speed: () => number = () => 1) {
  current?.stop();
  const s = new CrawlSession(runId, mode);
  current = s;
  emit();
  if (mode === 'live') {
    s.stop = followRun(
      runId,
      (e) => s.apply(e),
      () => {
        s.status = 'error';
        s.error = 'Lost connection to the backend mid-crawl.';
        s.notify();
      },
    );
    return s;
  }
  try {
    const run = await api.run(runId);
    if (current !== s) return s;
    if (mode === 'static') {
      for (const e of run.events) s.apply(e);
      if (!run.events.some((e) => e.type === 'end')) {
        s.status = run.status === 'running' ? 'running' : run.status;
        if (run.error) s.error = run.error;
      }
      s.notify();
    } else {
      s.stop = replayEvents(run.events, (e) => s.apply(e), speed, 1200);
    }
  } catch (err) {
    s.status = 'error';
    s.error = err instanceof Error ? err.message : String(err);
    s.notify();
  }
  return s;
}

export function closeSession() {
  current?.stop();
  current = null;
  emit();
}

export function useSession() {
  const s = useSyncExternalStore(
    (fn) => {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    () => current,
  );
  // re-render on session changes too
  useSyncExternalStore(
    s ? s.subscribe : noopSub,
    () => (s ? s.version : 0),
  );
  return s;
}

const noopSub = () => () => {};

// Dev-only handle for debugging in the browser console.
if (import.meta.env.DEV) (window as unknown as { __crawl: typeof getSession }).__crawl = getSession;
