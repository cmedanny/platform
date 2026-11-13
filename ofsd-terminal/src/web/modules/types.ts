import type { ComponentType } from 'react';
import type { LogLevel, RunSummary } from '../../shared/types.ts';

export interface CommandCtx {
  line: (text: string, level?: LogLevel) => void;
  open: (moduleId: string) => void;
}

export interface ClientCommand {
  name: string;
  usage: string;
  description: string;
  /** Runs in the browser. Without it, the command is sent to the backend. */
  local?: (args: string, ctx: CommandCtx) => void;
  /** Not listed in autocomplete or /help (used by buttons and inputs in the UI). */
  hidden?: boolean;
  /** Shown greyed in autocomplete while the feature isn't built yet. */
  soon?: string;
  /** Rewrites the arguments before sending (e.g. adds a default form type). */
  transform?: (args: string) => string;
  /** Called once the backend has started the run. */
  onStarted?: (runId: string) => void;
}

/**
 * A front-end module. To add one: make a folder in src/web/modules/, export a
 * ModuleDef from its index.tsx, and add it to registry.ts. Pair it with a
 * backend module of the same id in src/server/modules/ if it needs one.
 */
export interface ModuleDef {
  id: string;
  title: string;
  /** Short description shown in the top bar. */
  blurb: string;
  Canvas: ComponentType;
  Inspector?: ComponentType;
  commands?: ClientCommand[];
  /** 'main' modules appear in the module list; 'footer' sits below it (Settings). */
  placement?: 'main' | 'footer';
  /** Show in the sidebar stats table (defaults to true for main modules). */
  stats?: boolean;
  /** Custom replay for this module's runs. Return false to fall back to the log replay. */
  onReplay?: (run: RunSummary, speed: number) => boolean;
}
