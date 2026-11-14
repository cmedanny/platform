import './quiet.ts';
import express from 'express';
import type { CommandResponse, Health, ModuleStats } from '../shared/types.ts';
import { explainError } from './claude.ts';
import { db, registerMigration } from './db.ts';
import { ENV_PATH, getEnv, keyStatus } from './env.ts';
import { serverModules } from './modules/index.ts';
import type { ServerCommand } from './modules/types.ts';
import { deleteRun, getRun, listRuns, Run, streamRun } from './runs.ts';

const app = express();
app.use(express.json({ limit: '2mb' }));

// Module setup: migrations, routes, command table.
const commands = new Map<string, { module: string; cmd: ServerCommand }>();
for (const m of serverModules) {
  for (const [id, sql] of m.migrations ?? []) registerMigration(id, sql);
  if (m.routes) {
    const router = express.Router();
    m.routes(router);
    app.use(`/api/m/${m.id}`, router);
  }
  for (const [name, cmd] of Object.entries(m.commands ?? {})) commands.set(name, { module: m.id, cmd });
}

app.get('/api/health', (_req, res) => {
  const env = getEnv();
  const body: Health = { ok: true, model: env.model, keys: keyStatus(env), envPath: ENV_PATH };
  res.json(body);
});

app.get('/api/stats', (_req, res) => {
  const counts = new Map(
    (db.prepare('SELECT module, COUNT(*) AS n FROM runs GROUP BY module').all() as Array<{ module: string; n: number }>).map(
      (r) => [r.module, r.n],
    ),
  );
  const stats: ModuleStats[] = serverModules.map((m) => ({
    module: m.id,
    runs: counts.get(m.id) ?? 0,
    records: m.records?.() ?? 0,
  }));
  res.json(stats);
});

app.post('/api/command', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'Empty command.' } satisfies CommandResponse);
    return;
  }
  let name = 'ask';
  let args = text;
  const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (m) {
    name = m[1].toLowerCase();
    args = m[2];
  }
  const entry = commands.get(name);
  if (!entry) {
    res.status(404).json({ error: `Unknown command /${name}. Type /help to see what's available.` } satisfies CommandResponse);
    return;
  }
  // `display` lets the UI show a friendlier label than the raw command (e.g. ask-this-document).
  const display = String(req.body?.display ?? '').trim();
  const run = new Run(entry.module, display || text);
  res.json({ runId: run.id } satisfies CommandResponse);
  // Work continues after the response; the browser follows along via SSE.
  entry.cmd
    .run(args, run)
    .then(() => {
      if (!run.finished) run.end('done');
    })
    .catch((err) => run.fail(explainError(err)));
});

app.get('/api/commands', (_req, res) => {
  res.json([...commands.entries()].map(([name, { module, cmd }]) => ({ name, module, description: cmd.description })));
});

app.get('/api/runs', (req, res) => res.json(listRuns(Number(req.query.limit) || 200)));
app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) res.status(404).json({ error: 'Run not found.' });
  else res.json(run);
});
app.get('/api/runs/:id/stream', streamRun);
app.delete('/api/runs/:id', (req, res) => {
  deleteRun(req.params.id);
  res.json({ ok: true });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

const port = getEnv().port;
app.listen(port, () => {
  const k = keyStatus();
  console.log(`\n  OFSD backend on http://localhost:${port}`);
  console.log(`  Claude key: ${k.anthropic ? 'found' : 'MISSING (add to .env)'}  ·  model: ${getEnv().model}\n`);
  for (const m of serverModules) m.start?.();
});
