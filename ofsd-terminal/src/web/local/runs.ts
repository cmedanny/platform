// Runs for the Claude-app version: same event timeline as the server version,
// kept in memory while live and saved (summary + timeline) when they end.

import type { LogLevel, RunDetail, RunEvent, RunEventInput, RunStatus, RunSummary } from '../../shared/types.ts';
import { store } from './store.ts';

const live = new Map<string, LocalRun>();
const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class LocalRun {
  readonly id = newId('run');
  readonly createdAt = Date.now();
  events: RunEvent[] = [];
  status: RunStatus = 'running';
  error: string | null = null;
  finishedAt: number | null = null;
  private preview = '';
  private seq = 0;
  private listeners = new Set<(e: RunEvent) => void>();
  finished = false;

  constructor(
    readonly module: string,
    readonly command: string,
  ) {
    live.set(this.id, this);
    store.put('runs', this.id, this.summary());
  }

  summary(): RunSummary {
    return {
      id: this.id,
      module: this.module,
      command: this.command,
      status: this.status,
      createdAt: this.createdAt,
      finishedAt: this.finishedAt,
      error: this.error,
      preview: this.preview.slice(0, 200) || null,
    };
  }

  emit(ev: RunEventInput) {
    if (this.finished) return;
    const event = { ...ev, seq: this.seq++, t: Date.now() - this.createdAt } as RunEvent;
    this.events.push(event);
    for (const l of this.listeners) l(event);
  }

  log(text: string, level: LogLevel = 'info') {
    this.emit({ type: 'log', data: { level, text } });
  }

  text(delta: string) {
    if (this.preview.length < 200) this.preview += delta;
    this.emit({ type: 'text', data: { delta } });
  }

  end(status: Exclude<RunStatus, 'running'>, error?: string) {
    if (this.finished) return;
    if (error) this.log(error, 'error');
    this.emit({ type: 'end', data: { status, error } });
    this.finished = true;
    this.status = status;
    this.error = error ?? null;
    this.finishedAt = Date.now();
    store.put('runs', this.id, this.summary());
    store.saveLog(this.id, this.events);
  }

  fail(error: string) {
    this.end('error', error);
  }

  subscribe(fn: (e: RunEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function listRuns(): RunSummary[] {
  return store.all<RunSummary>('runs').sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const run = live.get(id);
  if (run) return { ...run.summary(), events: [...run.events] };
  const sum = store.get<RunSummary>('runs', id);
  if (!sum) return null;
  const events = ((await store.loadLog(id)) ?? []) as RunEvent[];
  return { ...sum, events };
}

export async function deleteRun(id: string) {
  live.delete(id);
  store.remove('runs', id);
  await store.deleteLog(id);
}

/** Live follow: past events first, then new ones until the run ends. */
export function followLocal(id: string, onEvent: (e: RunEvent) => void, onLost: () => void) {
  let stopped = false;
  let unsub = () => {};
  queueMicrotask(async () => {
    const run = live.get(id);
    if (run) {
      for (const e of [...run.events]) if (!stopped) onEvent(e);
      if (!run.finished && !stopped) {
        const off = run.subscribe((e) => !stopped && onEvent(e));
        unsub = () => off();
      }
      return;
    }
    const detail = await getRunDetail(id);
    if (!detail) return onLost();
    for (const e of detail.events) if (!stopped) onEvent(e);
  });
  return () => {
    stopped = true;
    unsub();
  };
}

/** Interrupted runs from an earlier visit (page closed mid-run). */
export function markInterrupted() {
  for (const r of store.all<RunSummary>('runs')) {
    if (r.status === 'running' && !live.has(r.id)) store.put('runs', r.id, { ...r, status: 'error', error: 'Interrupted (the page was closed mid-run).' });
  }
}
