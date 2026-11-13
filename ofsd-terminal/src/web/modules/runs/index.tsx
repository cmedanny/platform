import { Fragment, useEffect, useMemo, useState } from 'react';
import type { RunSummary } from '../../../shared/types.ts';
import { api } from '../../lib/api.ts';
import { replayRun } from '../../lib/commands.ts';
import { dayKey, duration, stamp } from '../../lib/format.ts';
import { useStore, usePref } from '../../lib/store.ts';
import { Badge, EmptyState, Row, Section, Segmented, Select, StatusDot, Switch } from '../../ui/index.tsx';
import { LinesGlyph } from '../glyphs.tsx';
import { modules } from '../registry.ts';
import type { ModuleDef } from '../types.ts';

const ID = 'runs';
type StatusFilter = 'all' | 'running' | 'done' | 'error';

function useRuns() {
  const version = useStore((s) => s.runsVersion);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .runs()
        .then((r) => alive && (setRuns(r), setError(null)))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [version]);
  return { runs, error };
}

const moduleTitle = (id: string) => (id === 'terminal' ? 'Terminal' : (modules.find((m) => m.id === id)?.title ?? id));

function Canvas() {
  const { runs, error } = useRuns();
  const [status] = usePref<StatusFilter>(ID, 'status', 'all');
  const [mod] = usePref(ID, 'module', 'all');
  const [byDay] = usePref(ID, 'byDay', true);
  const [preview] = usePref(ID, 'preview', true);
  const [speed] = usePref(ID, 'speed', '1');
  const setDraft = useStore((s) => s.setDraft);
  const bump = useStore((s) => s.bumpRuns);
  const [sessionStart] = useState(() => Date.now());

  const rows = useMemo(
    () => (runs ?? []).filter((r) => (status === 'all' || r.status === status) && (mod === 'all' || r.module === mod)),
    [runs, status, mod],
  );

  if (error && !runs) return <EmptyState title="Couldn't load runs" text={error} />;
  if (!runs) return null;
  if (runs.length === 0)
    return (
      <EmptyState glyph={<LinesGlyph />} title="No runs yet" text="Every command you run is saved here with its full timeline, so you can replay it later.">
        <button className="chip" onClick={() => setDraft('/ask ')}>/ask &lt;question&gt;</button>
      </EmptyState>
    );
  if (rows.length === 0) return <EmptyState title="Nothing matches these filters" text="Change the filters in the inspector." />;

  let lastDay = '';
  return (
    <table className="table" style={{ tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{ width: 24 }} />
          <th>Command</th>
          <th style={{ width: 90 }}>Module</th>
          <th style={{ width: 130 }}>Started</th>
          <th style={{ width: 70 }} className="num">Took</th>
          <th style={{ width: 128 }} />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const day = dayKey(r.createdAt);
          const header = byDay && day !== lastDay;
          lastDay = day;
          return (
            <Fragment key={r.id}>
              {header && (
                <tr>
                  <td colSpan={6} style={{ paddingTop: 14 }}>
                    <span className="label">{day}</span>
                  </td>
                </tr>
              )}
              <tr>
                <td><StatusDot status={r.status} /></td>
                <td>
                  <div className="mono bright" style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.command}{' '}
                    {r.status === 'running' && <Badge kind="live">Live</Badge>}
                    {r.status !== 'running' && r.createdAt >= sessionStart && <Badge kind="new">New</Badge>}
                  </div>
                  {preview && (r.error || r.preview) && (
                    <div style={{ color: r.error ? 'var(--red)' : 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.error ?? r.preview?.replace(/\*\*|`/g, '').replace(/\s+/g, ' ')}
                    </div>
                  )}
                </td>
                <td className="dim">{moduleTitle(r.module)}</td>
                <td className="mono dim">{stamp(r.createdAt)}</td>
                <td className="num dim">{duration(r.finishedAt ? r.finishedAt - r.createdAt : null)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className="btn btn--ghost"
                    onClick={() => {
                      const m = modules.find((x) => x.id === r.module);
                      if (!m?.onReplay?.(r, Number(speed))) replayRun(r.id, Number(speed));
                    }}
                    title="Replay this run"
                  >
                    ▶ Replay
                  </button>
                  <button
                    className="iconbtn"
                    title="Delete run"
                    onClick={async () => {
                      if (window.confirm('Delete this run and its timeline?')) {
                        await api.deleteRun(r.id).catch(() => {});
                        bump();
                      }
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function Inspector() {
  const [status, setStatus] = usePref<StatusFilter>(ID, 'status', 'all');
  const [mod, setMod] = usePref(ID, 'module', 'all');
  const [byDay, setByDay] = usePref(ID, 'byDay', true);
  const [preview, setPreview] = usePref(ID, 'preview', true);
  const [speed, setSpeed] = usePref(ID, 'speed', '1');
  const moduleOpts = [
    { value: 'all', label: 'All modules' },
    { value: 'terminal', label: 'Terminal' },
    ...modules.filter((m) => m.placement !== 'footer' && m.id !== ID).map((m) => ({ value: m.id, label: m.title })),
  ];
  return (
    <>
      <Section title="Filter">
        <Segmented
          options={[
            { value: 'all', label: 'All' },
            { value: 'running', label: 'Live' },
            { value: 'done', label: 'Done' },
            { value: 'error', label: 'Failed' },
          ]}
          value={status}
          onChange={setStatus}
        />
        <Row label="Module"><Select options={moduleOpts} value={mod} onChange={setMod} /></Row>
      </Section>
      <Section title="Arrangement">
        <Row label="Group by day"><Switch on={byDay} onChange={setByDay} /></Row>
        <Row label="Show preview"><Switch on={preview} onChange={setPreview} /></Row>
      </Section>
      <Section title="Replay">
        <Segmented options={[{ value: '0.5', label: '0.5x' }, { value: '1', label: '1x' }, { value: '2', label: '2x' }, { value: '4', label: '4x' }]} value={speed} onChange={setSpeed} />
      </Section>
    </>
  );
}

export const runs: ModuleDef = {
  id: ID,
  title: 'Runs',
  blurb: 'Every command, saved with its timeline',
  Canvas,
  Inspector,
  stats: false,
};
