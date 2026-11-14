import type { Router } from 'express';
import type { Run } from '../runs.ts';

export interface ServerCommand {
  /** One-line description, shown by /help. */
  description: string;
  run: (args: string, run: Run) => Promise<void>;
}

/**
 * A backend module. To add one: create a file in this folder exporting a
 * ServerModule, then add it to the list in modules/index.ts. Nothing else changes.
 */
export interface ServerModule {
  id: string;
  title: string;
  /** Slash commands this module owns, e.g. { crawl: {...} } handles "/crawl ...". */
  commands?: Record<string, ServerCommand>;
  /** SQL migrations, run once each, in order. Prefix ids with the module id. */
  migrations?: Array<[id: string, sql: string]>;
  /** Extra HTTP routes, mounted at /api/m/<id>/... */
  routes?: (router: Router) => void;
  /** Called once after the server starts (for schedulers and the like). */
  start?: () => void;
  /** Count shown in the sidebar stats table (filings, theses, nodes...). */
  records?: () => number;
}
