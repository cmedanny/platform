// Types shared by the backend and the browser.

export type RunStatus = 'running' | 'done' | 'error';

export type LogLevel = 'info' | 'warn' | 'error';

/** One event in a run's timeline. Stored in SQLite so any run can be replayed. */
export type RunEvent =
  | { seq: number; t: number; type: 'log'; data: { level: LogLevel; text: string } }
  | { seq: number; t: number; type: 'text'; data: { delta: string } }
  | { seq: number; t: number; type: 'meta'; data: Record<string, unknown> }
  | { seq: number; t: number; type: 'end'; data: { status: RunStatus; error?: string } }
  // Modules can emit their own event types (crawler network lines, tokens, etc.)
  | { seq: number; t: number; type: `x:${string}`; data: Record<string, unknown> };

export type RunEventInput = Omit<RunEvent, 'seq' | 't'>;

export interface RunSummary {
  id: string;
  module: string;
  command: string;
  status: RunStatus;
  createdAt: number;
  finishedAt: number | null;
  error: string | null;
  /** First ~200 chars of Claude's output, for list views. */
  preview: string | null;
}

export interface RunDetail extends RunSummary {
  events: RunEvent[];
}

export interface ModuleStats {
  module: string;
  runs: number;
  records: number;
}

export interface Health {
  ok: true;
  model: string;
  keys: { anthropic: boolean; sec: boolean; twitter: boolean; discord: boolean };
  envPath: string;
}

export interface CommandResponse {
  runId?: string;
  error?: string;
}
