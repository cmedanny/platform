import { brain } from './brain/index.tsx';
import { crawler } from './crawler/index.tsx';
import { runs } from './runs/index.tsx';
import { settings } from './settings/index.tsx';
import { thesis } from './thesis/index.tsx';
import type { ModuleDef } from './types.ts';

/**
 * The module list. Add a new module by importing it and placing it here.
 * Order here = order in the sidebar.
 */
export const modules: ModuleDef[] = [crawler, thesis, brain, runs, settings];
