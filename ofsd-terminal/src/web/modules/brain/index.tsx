import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BrainNode, Note, NodeKind } from '../../../shared/brain.ts';
import { api } from '../../lib/api.ts';
import { stamp } from '../../lib/format.ts';
import { useStore, usePref } from '../../lib/store.ts';
import { Badge, Draft, EmptyState, Row, Section, Segmented, Select, Switch } from '../../ui/index.tsx';
import { NetworkGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';
import { Clusters } from './Clusters.tsx';
import { groupNodes, isToday, KIND_LABEL, openNode, type Group, type GroupBy, type Order } from './model.ts';
import { Timeline } from './Timeline.tsx';
import './brain.css';

const ID = 'brain';
const FORMS = ['Clusters', 'Grid', 'Timeline', 'Table'] as const;
type Form = (typeof FORMS)[number];
const KINDS: NodeKind[] = ['crawl', 'thesis', 'note'];

function useNodes() {
  const version = useStore((s) => s.runsVersion);
  const [nodes, setNodes] = useState<BrainNode[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .get<BrainNode[]>('/api/m/brain/nodes')
        .then((n) => alive && (setNodes(n), setError('')))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [version, tick]);
  return { nodes, error, reload: () => setTick((x) => x + 1) };
}

const statusBadge = (n: BrainNode) =>
  n.kind === 'thesis' ? (
    n.status === 'draft' ? (
      <Draft />
    ) : (
      <Badge kind={n.status === 'sent' || n.status === 'approved' ? 'new' : undefined}>{n.status}</Badge>
    )
  ) : n.status === 'error' ? (
    <Badge kind="error">failed</Badge>
  ) : null;

const glyph = (k: NodeKind) => <span className={`br-glyph br-glyph--${k}`} aria-label={KIND_LABEL[k]} />;

function Grid({ groups, onOpen }: { groups: Group[]; onOpen: (n: BrainNode) => void }) {
  return (
    <div className="br-grid">
      {groups.map((g) => (
        <section key={g.key} className="br-grid__group">
          <div className="br-grid__head">
            <span className="label">{g.label}</span>
            <span className="mono faint">{g.nodes.length}</span>
          </div>
          <div className="br-grid__cards">
            {g.nodes.map((n) => (
              <button key={n.id} className={`br-card ${isToday(n.createdAt) ? 'br-card--new' : ''}`} onClick={() => onOpen(n)}>
                <div className="br-card__top">
                  {glyph(n.kind)}
                  <span className="br-card__kind">{KIND_LABEL[n.kind]}</span>
                  {statusBadge(n)}
                  <span className="br-card__time mono">{stamp(n.createdAt)}</span>
                </div>
                <div className="br-card__title">{n.title}</div>
                {n.subtitle && <div className="br-card__sub">{n.subtitle}</div>}
                <div className="br-card__tags mono">{[...n.tickers.map((t) => `$${t}`), ...n.themes.map((t) => `#${t}`)].join('  ')}</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

type SortKey = 'kind' | 'title' | 'group' | 'createdAt';
function Table({ groups, onOpen }: { groups: Group[]; onOpen: (n: BrainNode) => void }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });
  const rows = useMemo(() => {
    const flat = groups.flatMap((g) => g.nodes.map((n) => ({ n, group: g.label })));
    const v = (r: (typeof flat)[number]) => (sort.key === 'group' ? r.group : sort.key === 'createdAt' ? r.n.createdAt : sort.key === 'kind' ? r.n.kind : r.n.title.toLowerCase());
    return flat.sort((a, b) => (v(a) > v(b) ? 1 : v(a) < v(b) ? -1 : 0) * sort.dir);
  }, [groups, sort]);
  const th = (key: SortKey, label: string, style?: React.CSSProperties) => (
    <th style={{ cursor: 'pointer', ...style }} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === 'createdAt' ? -1 : 1 }))}>
      {label} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
    </th>
  );
  return (
    <div className="br-table">
      <table className="table">
        <thead>
          <tr>
            {th('kind', 'Kind', { width: 90 })}
            {th('title', 'Title')}
            {th('group', 'Group', { width: 120 })}
            <th style={{ width: 170 }}>Tags</th>
            {th('createdAt', 'Date', { width: 130 })}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ n, group }) => (
            <tr key={n.id} className="br-row" onClick={() => onOpen(n)}>
              <td>
                {glyph(n.kind)} <span className="dim">{KIND_LABEL[n.kind]}</span>
              </td>
              <td>
                <span className="bright">{n.title}</span> {statusBadge(n)}
                {n.subtitle && <div className="dim br-row__sub">{n.subtitle}</div>}
              </td>
              <td className="dim">{group}</td>
              <td className="mono dim br-row__tags">{[...n.tickers.map((t) => `$${t}`), ...n.themes.map((t) => `#${t}`)].join(' ')}</td>
              <td className={`mono ${isToday(n.createdAt) ? '' : 'dim'}`} style={isToday(n.createdAt) ? { color: 'var(--lime)' } : undefined}>
                {stamp(n.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NoteDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState<Note | null>(null);
  const [saving, setSaving] = useState('');
  const dirty = useRef(false);
  const body = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.get<Note>(`/api/m/brain/notes/${id}`).then(setNote).catch(() => onClose());
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Save a moment after typing stops. Status changes happen in the handler, not here.
  useEffect(() => {
    if (!note || !dirty.current) return;
    const t = setTimeout(async () => {
      try {
        await api.put(`/api/m/brain/notes/${id}`, { title: note.title, body: note.body, tags: note.tags });
        dirty.current = false;
        setSaving('saved');
        onChanged();
      } catch {
        setSaving('not saved');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [note]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.max(200, el.scrollHeight + 2)}px`;
  }, [note?.body]);

  if (!note) return null;
  const edit = (patch: Partial<Note>) => {
    dirty.current = true;
    if (saving !== 'saving…') setSaving('saving…');
    setNote({ ...note, ...patch });
  };
  return (
    <aside className="br-drawer" aria-label="Note">
      <div className="br-drawer__head">
        {glyph('note')}
        <span className="label">Note</span>
        <span className="mono faint" style={{ fontSize: 10 }}>{stamp(note.createdAt)}</span>
        <span className="br-drawer__save mono">{saving}</span>
        <button className="iconbtn" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <input className="br-drawer__title" value={note.title} placeholder="Title" onChange={(e) => edit({ title: e.target.value })} autoFocus={!note.body} />
      <input
        className="input mono br-drawer__tags"
        value={note.tags.join(', ')}
        placeholder="tags, comma separated"
        onChange={(e) => edit({ tags: e.target.value.split(',').map((t) => t.trim()) })}
      />
      <textarea ref={body} className="br-drawer__body" value={note.body} placeholder="Write… mention $TICKERS to link this note to crawls." onChange={(e) => edit({ body: e.target.value })} />
      <div className="br-drawer__foot">
        <button
          className="btn btn--ghost"
          onClick={async () => {
            if (!window.confirm('Delete this note?')) return;
            await api.del(`/api/m/brain/notes/${id}`);
            onChanged();
            onClose();
          }}
        >
          Delete
        </button>
      </div>
    </aside>
  );
}

function Canvas() {
  const { nodes, error, reload } = useNodes();
  const [form] = usePref<Form>(ID, 'form', 'Clusters');
  const [group] = usePref<GroupBy>(ID, 'group', 'ticker');
  const [order] = usePref<Order>(ID, 'order', 'newest');
  const [links] = usePref(ID, 'links', true);
  const [kinds] = usePref<NodeKind[]>(ID, 'kinds', KINDS);
  const [q, setQ] = usePref(ID, 'q', '');
  const [noteId, setNoteId] = useState<string | null>(null);
  const setDraft = useStore((s) => s.setDraft);


  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (nodes ?? []).filter(
      (n) =>
        kinds.includes(n.kind) &&
        (!needle || [n.title, n.subtitle, ...n.tickers, ...n.themes].some((s) => s.toLowerCase().includes(needle.replace(/^[$#]/, '')))),
    );
  }, [nodes, kinds, q]);
  const groups = useMemo(() => groupNodes(filtered, group, order, form === 'Clusters' ? 9 : 14), [filtered, group, order, form]);
  const open = (n: BrainNode) => (n.kind === 'note' ? setNoteId(n.refId) : openNode(n));
  const newNote = async () => {
    const n = await api.post<Note>('/api/m/brain/notes', { title: '', body: '' });
    reload();
    setNoteId(n.id);
  };

  const counts = { crawl: 0, thesis: 0, note: 0 } as Record<NodeKind, number>;
  for (const n of nodes ?? []) counts[n.kind]++;

  return (
    <div className="br">
      <div className="br-bar">
        <input className="input mono br-search" value={q} placeholder="Filter: ticker, theme, title…" onChange={(e) => setQ(e.target.value)} />
        <span className="br-legend">
          {glyph('crawl')} {counts.crawl} crawls {glyph('thesis')} {counts.thesis} theses {glyph('note')} {counts.note} notes
          <span className="br-legend__new">
            <i /> today
          </span>
        </span>
        <span className="br-bar__spacer" />
        <button className="btn btn--primary" onClick={newNote}>
          New note
        </button>
      </div>
      <div className="br-body">
        {error && !nodes ? (
          <EmptyState title="Couldn't load the Brain" text={error} />
        ) : nodes && nodes.length === 0 ? (
          <EmptyState glyph={<NetworkGlyph />} title="Your brain is empty" text="Every crawl, thesis and note becomes a node here. Run a crawl, draft a thesis, or write a note.">
            <button className="chip" onClick={() => setDraft('/note ')}>
              /note &lt;text&gt;
            </button>
            <button className="chip" onClick={() => setDraft('/crawl NVDA 10-Q')}>
              /crawl NVDA 10-Q
            </button>
          </EmptyState>
        ) : nodes && filtered.length === 0 ? (
          <EmptyState title="Nothing matches" text="Clear the filter or turn kinds back on in the inspector." />
        ) : nodes ? (
          form === 'Clusters' ? (
            <Clusters groups={groups} links={links} onOpen={open} />
          ) : form === 'Timeline' ? (
            <Timeline groups={groups} links={links} onOpen={open} />
          ) : form === 'Grid' ? (
            <Grid groups={groups} onOpen={open} />
          ) : (
            <Table groups={groups} onOpen={open} />
          )
        ) : null}
        {noteId && <NoteDrawer key={noteId} id={noteId} onClose={() => setNoteId(null)} onChanged={reload} />}
      </div>
    </div>
  );
}

function Inspector() {
  const [form, setForm] = usePref<Form>(ID, 'form', 'Clusters');
  const [group, setGroup] = usePref<GroupBy>(ID, 'group', 'ticker');
  const [order, setOrder] = usePref<Order>(ID, 'order', 'newest');
  const [links, setLinks] = usePref(ID, 'links', true);
  const [kinds, setKinds] = usePref<NodeKind[]>(ID, 'kinds', KINDS);
  return (
    <>
      <Section title="Form">
        <Segmented options={FORMS} value={form} onChange={setForm} wrap />
        <Row label="Links">
          <Switch on={links} onChange={setLinks} />
        </Row>
      </Section>
      <Section title="Axes">
        <Row label="Group by">
          <Select options={[{ value: 'ticker', label: 'Ticker' }, { value: 'theme', label: 'Theme' }, { value: 'date', label: 'Date' }]} value={group} onChange={setGroup} />
        </Row>
        <Row label="Order">
          <Select options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }]} value={order} onChange={setOrder} />
        </Row>
      </Section>
      <Section title="Show">
        {KINDS.map((k) => (
          <Row key={k} label={k === 'thesis' ? 'Theses' : `${KIND_LABEL[k]}s`}>
            <Switch on={kinds.includes(k)} onChange={(on) => setKinds(on ? [...kinds, k] : kinds.filter((x) => x !== k))} />
          </Row>
        ))}
      </Section>
      <Section title="Tips" defaultOpen={false} hint="Drag, hover, click">
        <div className="dim" style={{ fontSize: 10.5, lineHeight: 1.6 }}>
          Drag the clusters to turn them. Click a node to open it. Lime nodes are from today. Write $TICKER in a note to link it to that ticker's crawls, and
          #tag in /note to give it a theme.
        </div>
      </Section>
    </>
  );
}

export const brain: ModuleDef = {
  id: ID,
  title: 'Brain',
  blurb: 'Every crawl, thesis and note as a node',
  Canvas,
  Inspector,
  commands: [
    {
      name: 'note',
      usage: '/note <text> #tag',
      description: 'Save a note to the Brain. First line is the title.',
      onStarted: () => {
        // the run's x:note event carries the id; open the Brain once it's saved
        setTimeout(() => useStore.getState().bumpRuns(), 400);
      },
    },
  ],
};
