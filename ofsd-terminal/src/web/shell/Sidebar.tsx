import { useEffect, useState } from 'react';
import type { ModuleStats } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { useStore } from '../lib/store.ts';
import { modules } from '../modules/registry.ts';
import { Kbd, Label, SearchIcon } from '../ui/index.tsx';
import { Constellation } from './Constellation.tsx';

function useStats() {
  const version = useStore((s) => s.runsVersion);
  const [stats, setStats] = useState<ModuleStats[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => api.stats().then((s) => alive && setStats(s)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [version]);
  return stats;
}

export function Sidebar() {
  const active = useStore((s) => s.active);
  const open = useStore((s) => s.open);
  const focusBar = useStore((s) => s.focusBar);
  const stats = useStats();
  const main = modules.filter((m) => m.placement !== 'footer');
  const footer = modules.filter((m) => m.placement === 'footer');

  const statRows = [
    ...main.filter((m) => m.stats !== false).map((m) => ({ id: m.id, title: m.title })),
    { id: 'terminal', title: 'Terminal' },
  ].map((r) => ({ ...r, s: stats.find((x) => x.module === r.id) }));
  const totalRuns = stats.reduce((a, b) => a + b.runs, 0);
  const totalRecords = stats.reduce((a, b) => a + b.records, 0);

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__name"><b>ofsd</b><span>terminal</span></span>
        <span className="sidebar__ver">v0.1</span>
      </div>

      <button className="askfield" onClick={focusBar}>
        <SearchIcon />
        <span className="askfield__text">Ask or search</span>
        <Kbd>⌘K</Kbd>
      </button>

      <nav className="nav" aria-label="Modules">
        {main.map((m) => (
          <button key={m.id} className={`nav__item ${active === m.id ? 'nav__item--on' : ''}`} onClick={() => open(m.id)}>
            {m.title}
            {m.id === 'runs' && totalRuns > 0 && <span className="nav__count">{totalRuns}</span>}
          </button>
        ))}
        <div className="nav__group" />
        {footer.map((m) => (
          <button key={m.id} className={`nav__item ${active === m.id ? 'nav__item--on' : ''}`} onClick={() => open(m.id)}>
            {m.title}
          </button>
        ))}
      </nav>

      <div className="sidebar__spacer">
        <Constellation />
      </div>

      <div className="stats">
        <div className="stats__head">
          <Label>Modules</Label>
          <Label>Runs · Record</Label>
        </div>
        {statRows.map((r) => (
          <button key={r.id} className="stats__row" onClick={() => open(r.id === 'terminal' ? 'runs' : r.id)}>
            <span className="dot" style={r.id === active ? { background: 'var(--lime)' } : undefined} />
            <span>{r.title}</span>
            <span className="stats__nums">
              {r.s?.runs ?? 0}<i>·</i>{r.s?.records ?? 0}
            </span>
          </button>
        ))}
        <div className="stats__foot">
          <Label>All</Label>
          <span className="stats__nums">{totalRuns}<i>·</i>{totalRecords}</span>
        </div>
      </div>
    </aside>
  );
}
