import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DB } from 'node:sqlite';
import { ROOT } from './env.ts';

mkdirSync(join(ROOT, 'data'), { recursive: true });
export const DB_PATH = join(ROOT, 'data', 'ofsd.sqlite');
// Loaded lazily so quiet.ts can hide Node's "experimental" notice first.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DB };
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/**
 * Migrations run in order, once each. Modules can append their own with
 * registerMigration() so adding a module never means editing this file.
 */
const core: Array<[string, string]> = [
  [
    'core:001-runs',
    `CREATE TABLE runs (
       id TEXT PRIMARY KEY,
       module TEXT NOT NULL,
       command TEXT NOT NULL,
       status TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       finished_at INTEGER,
       error TEXT,
       preview TEXT
     );
     CREATE INDEX runs_created ON runs(created_at DESC);
     CREATE TABLE run_events (
       run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
       seq INTEGER NOT NULL,
       t INTEGER NOT NULL,
       type TEXT NOT NULL,
       data TEXT NOT NULL,
       PRIMARY KEY (run_id, seq)
     );`,
  ],
  [
    'core:002-notes',
    `CREATE TABLE notes (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL,
       body TEXT NOT NULL DEFAULT '',
       tags TEXT NOT NULL DEFAULT '[]',
       status TEXT NOT NULL DEFAULT 'draft',
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     );
     CREATE TABLE settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     );`,
  ],
];

db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

export function registerMigration(id: string, sql: string) {
  const done = db.prepare('SELECT 1 FROM _migrations WHERE id = ?').get(id);
  if (done) return;
  db.exec('BEGIN');
  try {
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

for (const [id, sql] of core) registerMigration(id, sql);

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
