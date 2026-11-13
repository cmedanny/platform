import { brain } from './brain.ts';
import { crawler } from './crawler.ts';
import { terminal } from './terminal.ts';
import { thesis } from './thesis.ts';
import type { ServerModule } from './types.ts';

/** Add new backend modules here. Order doesn't matter. */
export const serverModules: ServerModule[] = [terminal, crawler, thesis, brain];
