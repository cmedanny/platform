import { modules } from '../modules/registry.ts';
import type { ClientCommand } from '../modules/types.ts';
import { api, BackendError, followRun, replayEvents } from './api.ts';
import { useStore } from './store.ts';

/** Commands that belong to the terminal itself rather than a module. */
const core: ClientCommand[] = [
  { name: 'ask', usage: '/ask <question>', description: 'Ask Claude. Plain text without a slash does the same.' },
  {
    name: 'runs',
    usage: '/runs',
    description: 'Open the list of every run, with replay.',
    local: (_a, ctx) => {
      ctx.open('runs');
      ctx.line('Opened Runs.');
    },
  },
  {
    name: 'help',
    usage: '/help',
    description: 'List every command.',
    local: (_a, ctx) => {
      for (const c of allCommands()) ctx.line(`${c.usage.padEnd(26)} ${c.description}${c.soon ? `  (${c.soon})` : ''}`);
      ctx.line('Shortcuts: ⌘K / Ctrl+K focus the bar · ↑/↓ history · Tab completes · Esc closes.');
    },
  },
  { name: 'clear', usage: '/clear', description: 'Clear the command log (runs stay saved).' },
];

export function allCommands(): ClientCommand[] {
  return [...core, ...modules.flatMap((m) => m.commands ?? [])];
}

function parse(text: string) {
  const m = text.match(/^\/(\S*)\s*([\s\S]*)$/);
  return m ? { name: m[1].toLowerCase(), args: m[2] } : { name: 'ask', args: text };
}

export async function execute(raw: string) {
  const text = raw.trim();
  if (!text) return;
  const s = useStore.getState();
  const { name, args } = parse(text);

  if (name === 'clear') {
    s.clearLog();
    return;
  }

  const cmd = allCommands().find((c) => c.name === name);
  if (!cmd) {
    const id = s.addEntry({ command: text, source: 'local' });
    s.pushItem(id, { kind: 'line', level: 'error', text: `Unknown command /${name}. Type /help to see what's available.` });
    s.setStatus(id, 'error');
    return;
  }

  if (cmd.local || cmd.soon) {
    const id = s.addEntry({ command: text, source: 'local' });
    let failed = false;
    const ctx = {
      line: (t: string, level: 'info' | 'warn' | 'error' = 'info') => {
        if (level === 'error') failed = true;
        useStore.getState().pushItem(id, { kind: 'line', level, text: t });
      },
      open: (m: string) => useStore.getState().open(m),
    };
    if (cmd.local) cmd.local(args, ctx);
    else ctx.line(`/${cmd.name} isn't built yet. It arrives in ${cmd.soon}.`, 'warn');
    useStore.getState().setStatus(id, failed ? 'error' : 'done');
    return;
  }

  const id = s.addEntry({ command: text, source: 'run' });
  try {
    const res = await api.command(text);
    if (!res.runId) throw new BackendError(res.error || 'The backend did not start a run.');
    useStore.setState((st) => ({ entries: st.entries.map((e) => (e.id === id ? { ...e, runId: res.runId } : e)) }));
    useStore.getState().bumpRuns();
    followRun(
      res.runId,
      (ev) => {
        useStore.getState().applyEvent(id, ev);
        if (ev.type === 'end') useStore.getState().bumpRuns();
      },
      () => {
        const st = useStore.getState();
        st.pushItem(id, { kind: 'line', level: 'error', text: 'Lost connection to the backend mid-run. Check the terminal running npm start.' });
        st.setStatus(id, 'error');
      },
    );
  } catch (err) {
    const st = useStore.getState();
    st.pushItem(id, { kind: 'line', level: 'error', text: err instanceof Error ? err.message : String(err) });
    st.setStatus(id, 'error');
  }
}

/** Plays a stored run back into the log with its original timing. */
export async function replayRun(runId: string, speed = 1) {
  const s = useStore.getState();
  try {
    const run = await api.run(runId);
    const id = s.addEntry({ command: run.command, source: 'replay', runId, module: run.module });
    replayEvents(run.events, (ev) => useStore.getState().applyEvent(id, ev), speed);
    if (!run.events.some((e) => e.type === 'end')) useStore.getState().setStatus(id, run.status);
  } catch (err) {
    const id = s.addEntry({ command: `replay ${runId}`, source: 'local' });
    s.pushItem(id, { kind: 'line', level: 'error', text: err instanceof Error ? err.message : String(err) });
    s.setStatus(id, 'error');
  }
}
