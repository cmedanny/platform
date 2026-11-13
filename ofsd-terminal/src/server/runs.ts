import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import type { LogLevel, RunDetail, RunEvent, RunEventInput, RunStatus, RunSummary } from '../shared/types.ts';
import { db, newId } from './db.ts';

const bus = new EventEmitter();
bus.setMaxListeners(200);

const insertEvent = db.prepare('INSERT INTO run_events (run_id, seq, t, type, data) VALUES (?, ?, ?, ?, ?)');

/**
 * A Run is one execution of a command. Every event is written to SQLite and
 * broadcast to live listeners, so the same timeline powers live view and replay.
 */
export class Run {
  readonly id: string;
  readonly startedAt = Date.now();
  private seq = 0;
  private preview = '';
  finished = false;

  constructor(readonly module: string, readonly command: string) {
    this.id = newId('run');
    db.prepare('INSERT INTO runs (id, module, command, status, created_at) VALUES (?, ?, ?, ?, ?)').run(
      this.id,
      module,
      command,
      'running',
      this.startedAt,
    );
  }

  emit(ev: RunEventInput) {
    if (this.finished) return;
    const event = { ...ev, seq: this.seq++, t: Date.now() - this.startedAt } as RunEvent;
    insertEvent.run(this.id, event.seq, event.t, event.type, JSON.stringify(event.data));
    bus.emit(this.id, event);
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
    db.prepare('UPDATE runs SET status = ?, finished_at = ?, error = ?, preview = ? WHERE id = ?').run(
      status,
      Date.now(),
      error ?? null,
      this.preview.slice(0, 200) || null,
      this.id,
    );
  }

  fail(error: string) {
    this.end('error', error);
  }
}

// Any run still marked "running" after a restart was interrupted.
db.prepare("UPDATE runs SET status = 'error', error = 'Interrupted (the app was restarted mid-run).' WHERE status = 'running'").run();

type RunRow = {
  id: string;
  module: string;
  command: string;
  status: RunStatus;
  created_at: number;
  finished_at: number | null;
  error: string | null;
  preview: string | null;
};

const toSummary = (r: RunRow): RunSummary => ({
  id: r.id,
  module: r.module,
  command: r.command,
  status: r.status,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
  error: r.error,
  preview: r.preview,
});

export function listRuns(limit = 200): RunSummary[] {
  const rows = db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as RunRow[];
  return rows.map(toSummary);
}

function readEvents(id: string): RunEvent[] {
  const rows = db.prepare('SELECT seq, t, type, data FROM run_events WHERE run_id = ? ORDER BY seq').all(id) as Array<{
    seq: number;
    t: number;
    type: string;
    data: string;
  }>;
  return rows.map((r) => ({ seq: r.seq, t: r.t, type: r.type, data: JSON.parse(r.data) }) as RunEvent);
}

export function getRun(id: string): RunDetail | null {
  const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!row) return null;
  return { ...toSummary(row), events: readEvents(id) };
}

export function deleteRun(id: string) {
  db.prepare('DELETE FROM runs WHERE id = ?').run(id);
}

/** Server-Sent Events: sends what's stored so far, then live events until the run ends. */
export function streamRun(req: Request, res: Response) {
  const id = String(req.params.id);
  const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as { status: RunStatus } | undefined;
  if (!row) {
    res.status(404).json({ error: 'Run not found.' });
    return;
  }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (e: RunEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  // Reading stored events and subscribing happen in the same tick, so nothing is missed.
  const past = readEvents(id);
  past.forEach(send);
  if (past.some((e) => e.type === 'end') || row.status !== 'running') {
    res.end();
    return;
  }
  const onEvent = (e: RunEvent) => {
    send(e);
    if (e.type === 'end') cleanup(true);
  };
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  const cleanup = (endRes: boolean) => {
    clearInterval(ping);
    bus.off(id, onEvent);
    if (endRes) res.end();
  };
  bus.on(id, onEvent);
  req.on('close', () => cleanup(false));
}
