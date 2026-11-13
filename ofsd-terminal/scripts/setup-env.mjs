// Runs after `npm install`: creates .env from the template and the data folder if missing.
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = join(root, '.env');
mkdirSync(join(root, 'data'), { recursive: true });
if (!existsSync(env)) {
  copyFileSync(join(root, '.env.example'), env);
  console.log('\n  Created ofsd-terminal/.env. Open it and paste your keys (see README step 2).\n');
} else {
  console.log('\n  .env already exists, leaving it alone.\n');
}
