import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Health, LogLevel, RunEvent, RunStatus } from '../../shared/types.ts';

export type LogItem = { kind: 'line'; level: LogLevel; text: string } | { kind: 'text'; text: string };

export interface LogEntry {
  id: string;
  ts: number;
  /** What the user typed. */
  command: string;
  /** 'local' = handled in the browser, 'run' = backend run, 'replay' = stored run played back. */
  source: 'local' | 'run' | 'replay';
  runId?: string;
  module?: string;
  status: RunStatus;
  items: LogItem[];
}

export type MotionPref = 'system' | 'reduced' | 'full';

interface State {
  active: string;
  inspectorOpen: boolean;
  logOpen: boolean;
  motion: MotionPref;
  /** Per-module inspector settings, persisted in the browser. */
  prefs: Record<string, Record<string, unknown>>;

  entries: LogEntry[];
  health: Health | null;
  offline: boolean;
  /** Bumped whenever a run finishes so lists and stats refresh. */
  runsVersion: number;
  /** Command bar listens to these. */
  focusTick: number;
  draft: { text: string; tick: number };

  open: (id: string) => void;
  toggleInspector: () => void;
  setLogOpen: (v: boolean) => void;
  setMotion: (m: MotionPref) => void;
  setPref: (module: string, key: string, value: unknown) => void;

  addEntry: (e: Omit<LogEntry, 'id' | 'ts' | 'items' | 'status'> & Partial<Pick<LogEntry, 'items' | 'status'>>) => string;
  pushItem: (id: string, item: LogItem) => void;
  applyEvent: (id: string, e: RunEvent) => void;
  setStatus: (id: string, status: RunStatus) => void;
  clearLog: () => void;

  setHealth: (h: Health | null) => void;
  bumpRuns: () => void;
  focusBar: () => void;
  setDraft: (text: string) => void;
}

let n = 0;
const uid = () => `e${Date.now().toString(36)}${(n++).toString(36)}`;

function appendItem(items: LogItem[], item: LogItem): LogItem[] {
  const last = items[items.length - 1];
  if (item.kind === 'text' && last?.kind === 'text') {
    return [...items.slice(0, -1), { kind: 'text', text: last.text + item.text }];
  }
  return [...items, item];
}

export const useStore = create<State>()(
  persist(
    (set) => ({
      active: 'crawler',
      inspectorOpen: true,
      logOpen: true,
      motion: 'system',
      prefs: {},

      entries: [],
      health: null,
      offline: false,
      runsVersion: 0,
      focusTick: 0,
      draft: { text: '', tick: 0 },

      open: (id) => set({ active: id }),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      setLogOpen: (v) => set({ logOpen: v }),
      setMotion: (m) => set({ motion: m }),
      setPref: (module, key, value) =>
        set((s) => ({ prefs: { ...s.prefs, [module]: { ...s.prefs[module], [key]: value } } })),

      addEntry: (e) => {
        const id = uid();
        set((s) => ({
          logOpen: true,
          entries: [...s.entries.slice(-199), { items: [], status: 'running', ...e, id, ts: Date.now() }],
        }));
        return id;
      },
      pushItem: (id, item) =>
        set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, items: appendItem(x.items, item) } : x)) })),
      applyEvent: (id, e) =>
        set((s) => ({
          entries: s.entries.map((x) => {
            if (x.id !== id) return x;
            if (e.type === 'text') return { ...x, items: appendItem(x.items, { kind: 'text', text: e.data.delta }) };
            if (e.type === 'log') return { ...x, items: appendItem(x.items, { kind: 'line', level: e.data.level, text: e.data.text }) };
            if (e.type === 'end') return { ...x, status: e.data.status };
            return x;
          }),
        })),
      setStatus: (id, status) => set((s) => ({ entries: s.entries.map((x) => (x.id === id ? { ...x, status } : x)) })),
      clearLog: () => set({ entries: [] }),

      setHealth: (h) => set({ health: h, offline: h === null }),
      bumpRuns: () => set((s) => ({ runsVersion: s.runsVersion + 1 })),
      focusBar: () => set((s) => ({ focusTick: s.focusTick + 1 })),
      setDraft: (text) => set((s) => ({ draft: { text, tick: s.draft.tick + 1 } })),
    }),
    {
      name: 'ofsd-ui',
      partialize: (s) => ({ active: s.active, inspectorOpen: s.inspectorOpen, logOpen: s.logOpen, motion: s.motion, prefs: s.prefs }),
    },
  ),
);

/** Read/write one inspector setting for a module, with a default. */
export function usePref<T>(module: string, key: string, fallback: T): [T, (v: T) => void] {
  const value = useStore((s) => s.prefs[module]?.[key]) as T | undefined;
  const setPref = useStore((s) => s.setPref);
  return [value ?? fallback, (v: T) => setPref(module, key, v)];
}
