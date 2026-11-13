import type { CommandResponse, Health, ModuleStats, RunDetail, RunEvent, RunSummary } from '../../shared/types.ts';

export class BackendError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  } catch {
    throw new BackendError("Can't reach the OFSD backend. Is the terminal window running `npm start` still open?");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackendError(body?.error || `Request failed (${res.status}).`);
  return body as T;
}

export const api = {
  health: () => req<Health>('/api/health'),
  stats: () => req<ModuleStats[]>('/api/stats'),
  runs: () => req<RunSummary[]>('/api/runs'),
  run: (id: string) => req<RunDetail>(`/api/runs/${id}`),
  deleteRun: (id: string) => req<{ ok: true }>(`/api/runs/${id}`, { method: 'DELETE' }),
  command: (text: string, display?: string) => req<CommandResponse>('/api/command', { method: 'POST', body: JSON.stringify({ text, display }) }),
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body: unknown) => req<T>(path, { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * Follows a run live over SSE. De-duplicates by seq so an automatic reconnect
 * (which re-sends stored events) never double-prints.
 */
export function followRun(id: string, onEvent: (e: RunEvent) => void, onLost: () => void) {
  const es = new EventSource(`/api/runs/${id}/stream`);
  let last = -1;
  let ended = false;
  es.onmessage = (msg) => {
    const e = JSON.parse(msg.data) as RunEvent;
    if (e.seq <= last) return;
    last = e.seq;
    onEvent(e);
    if (e.type === 'end') {
      ended = true;
      es.close();
    }
  };
  es.onerror = () => {
    if (ended) return;
    if (es.readyState === EventSource.CLOSED) onLost();
  };
  return () => es.close();
}

/**
 * Replays a stored run with its original timing (scaled by speed).
 * Long pauses are capped so replays stay snappy.
 */
export function replayEvents(events: RunEvent[], onEvent: (e: RunEvent) => void, speed: number | (() => number) = 1, maxGap = 900) {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const step = () => {
    if (stopped || i >= events.length) return;
    const e = events[i++];
    onEvent(e);
    const next = events[i];
    if (!next) return;
    const sp = typeof speed === 'function' ? speed() : speed;
    const gap = Math.min(maxGap, Math.max(0, next.t - e.t)) / sp;
    timer = setTimeout(step, gap);
  };
  step();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
