// Storage for the Claude-app version. Everything lives in memory and is saved
// to the app's database under the viewer's private folder
// (data/users/<id>/c/<table>/<doc>), which nobody else can read.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { capability } from './claudeapp.ts';

export type Table = 'runs' | 'logs' | 'crawls' | 'theses' | 'notes' | 'handles' | 'settings';
const LOADED: Table[] = ['runs', 'crawls', 'theses', 'notes', 'handles', 'settings'];
const CHUNK = 110_000; // characters per saved log piece (documents are capped at 256 KB)

class Store {
  tables: Record<Table, Map<string, any>> = {
    runs: new Map(),
    logs: new Map(),
    crawls: new Map(),
    theses: new Map(),
    notes: new Map(),
    handles: new Map(),
    settings: new Map(),
  };
  /** 'saved' = persisted in the Claude app; 'memory' = this session only. */
  mode: 'loading' | 'saved' | 'memory' = 'loading';
  problem = '';
  private db: any = null;
  private uid: string | null = null;
  private writes = new Map<string, Promise<void>>();
  private logCache = new Map<string, unknown[]>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init() {
    try {
      const [db, user] = await Promise.all([capability('db'), capability('user')]);
      const uid = user ? await user.id() : null;
      if (!db || !uid) {
        this.mode = 'memory';
        this.problem = 'Saving is unavailable here (open OFSD inside the Claude app while signed in). Work is kept until you close the page.';
        return;
      }
      this.db = db;
      this.uid = uid;
      await Promise.all(
        LOADED.map(async (t) => {
          const snap = await this.coll(t).limit(1000).get();
          for (const d of snap.docs) this.tables[t].set(d.id, d.data());
        }),
      );
      this.mode = 'saved';
    } catch (err) {
      this.mode = 'memory';
      this.problem = `Couldn't load your saved data (${(err as { code?: string }).code ?? 'error'}). Work is kept until you close the page.`;
    }
  }

  private coll(t: Table) {
    return this.db.collection(`data/users/${this.uid}/c/${t}`);
  }

  all<T = any>(t: Table): T[] {
    return [...this.tables[t].values()];
  }

  get<T = any>(t: Table, id: string): T | undefined {
    return this.tables[t].get(id);
  }

  /** Save a record (one write at a time per document). */
  put(t: Table, id: string, data: object) {
    this.tables[t].set(id, data);
    this.persist(t, id, () => this.coll(t).doc(id).set(JSON.parse(JSON.stringify(data))));
  }

  remove(t: Table, id: string) {
    this.tables[t].delete(id);
    this.persist(t, id, () => this.coll(t).doc(id).delete());
  }

  private persist(t: Table, id: string, op: () => Promise<void>) {
    if (!this.db) return;
    const key = `${t}/${id}`;
    const prev = this.writes.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(op)
      .catch((err: { code?: string; message?: string }) => {
        this.problem =
          err?.code === 'quota_exceeded'
            ? 'Storage is full. Delete old runs or crawls to save new ones.'
            : `A save failed (${err?.code ?? 'error'}). Your latest change may not be kept.`;
      });
    this.writes.set(key, next);
  }

  /** A run's full event timeline, split into pieces small enough to save. */
  saveLog(runId: string, events: unknown[]) {
    this.logCache.set(runId, events);
    if (!this.db) return;
    const text = JSON.stringify(events);
    const total = Math.max(1, Math.ceil(text.length / CHUNK));
    for (let n = 0; n < total; n++) {
      const id = `${runId}__${n}`;
      const piece = { runId, n, total, chunk: text.slice(n * CHUNK, (n + 1) * CHUNK) };
      this.persist('logs', id, () => this.coll('logs').doc(id).set(piece));
    }
  }

  async loadLog(runId: string): Promise<unknown[] | null> {
    const hit = this.logCache.get(runId);
    if (hit) return hit;
    if (!this.db) return null;
    try {
      const snap = await this.coll('logs').where('runId', '==', runId).get();
      const parts = snap.docs.map((d: any) => d.data()).sort((a: any, b: any) => a.n - b.n);
      if (!parts.length || parts.length !== parts[0].total) return null;
      const events = JSON.parse(parts.map((p: any) => p.chunk).join(''));
      this.logCache.set(runId, events);
      return events;
    } catch {
      return null;
    }
  }

  async deleteLog(runId: string) {
    this.logCache.delete(runId);
    if (!this.db) return;
    try {
      const snap = await this.coll('logs').where('runId', '==', runId).get();
      for (const d of snap.docs) this.persist('logs', d.id, () => this.coll('logs').doc(d.id).delete());
    } catch {
      /* best effort */
    }
  }
}

export const store = new Store();
