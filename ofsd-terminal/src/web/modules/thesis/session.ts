// A thesis run being watched live or replayed. Same pattern as the crawler session.

import { useSyncExternalStore } from 'react';
import { parseThesisStream, type ParsedStream, type XHandle, type XPost } from '../../../shared/thesis.ts';
import type { RunEvent } from '../../../shared/types.ts';
import { api, followRun, replayEvents } from '../../lib/api.ts';

export class ThesisSession {
  phase: 'fetch' | 'analyze' | 'done' | 'error' = 'fetch';
  status: 'running' | 'done' | 'error' = 'running';
  error = '';
  handles: XHandle[] = [];
  posts: XPost[] = [];
  /** when each post arrived (performance.now), for the card animation */
  arrived = new Map<string, number>();
  draftText = '';
  thesisId: string | null = null;
  logs: string[] = [];
  replayDone = false;
  version = 0;
  stop: () => void = () => {};
  private parsedAt = -1;
  private parsedCache: ParsedStream | null = null;
  private listeners = new Set<() => void>();
  private scheduled = false;

  constructor(
    readonly runId: string,
    readonly mode: 'live' | 'replay',
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  notify() {
    this.version++;
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      this.listeners.forEach((l) => l());
    });
  }

  get parsed(): ParsedStream {
    if (!this.parsedCache || this.parsedAt !== this.draftText.length) {
      this.parsedCache = parseThesisStream(this.draftText);
      this.parsedAt = this.draftText.length;
    }
    return this.parsedCache;
  }

  get active() {
    return this.status === 'running' || (this.mode === 'replay' && !this.replayDone);
  }

  apply(e: RunEvent) {
    switch (e.type) {
      case 'x:phase':
        this.phase = e.data.phase as ThesisSession['phase'];
        break;
      case 'x:handles':
        this.handles = e.data.list as XHandle[];
        break;
      case 'x:post': {
        const p = e.data as unknown as XPost;
        this.posts = [...this.posts, p];
        this.arrived.set(p.ref, performance.now());
        break;
      }
      case 'x:draft':
        this.draftText += e.data.d as string;
        break;
      case 'x:saved':
        this.thesisId = e.data.thesisId as string;
        break;
      case 'log':
        this.logs = [...this.logs.slice(-20), e.data.text];
        break;
      case 'end':
        this.status = e.data.status === 'error' ? 'error' : 'done';
        if (e.data.error) this.error = e.data.error;
        if (this.status === 'error') this.phase = 'error';
        if (this.mode === 'replay') this.replayDone = true;
        break;
    }
    this.notify();
  }
}

let current: ThesisSession | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export const getThesisSession = () => current;

export async function openThesisSession(runId: string, mode: 'live' | 'replay', speed: () => number = () => 1) {
  current?.stop();
  const s = new ThesisSession(runId, mode);
  current = s;
  emit();
  if (mode === 'live') {
    s.stop = followRun(
      runId,
      (e) => s.apply(e),
      () => {
        s.status = 'error';
        s.error = 'Lost connection to the backend mid-run.';
        s.notify();
      },
    );
    return s;
  }
  try {
    const run = await api.run(runId);
    if (current !== s) return s;
    s.stop = replayEvents(run.events, (e) => s.apply(e), speed, 900);
  } catch (err) {
    s.status = 'error';
    s.error = err instanceof Error ? err.message : String(err);
    s.notify();
  }
  return s;
}

export function closeThesisSession() {
  current?.stop();
  current = null;
  emit();
}

const noop = () => () => {};
export function useThesisSession() {
  const s = useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => current,
  );
  useSyncExternalStore(s ? s.subscribe : noop, () => (s ? s.version : 0));
  return s;
}
