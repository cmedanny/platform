import { useEffect, useState } from 'react';
import { clock } from '../lib/format.ts';
import { useStore } from '../lib/store.ts';
import type { ModuleDef } from '../modules/types.ts';

const CONN = [
  { key: 'anthropic', label: 'Claude' },
  { key: 'sec', label: 'EDGAR' },
  { key: 'twitter', label: 'X' },
  { key: 'discord', label: 'Discord' },
] as const;

export function TopBar({ mod }: { mod: ModuleDef }) {
  const health = useStore((s) => s.health);
  const offline = useStore((s) => s.offline);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggle = useStore((s) => s.toggleInspector);
  const open = useStore((s) => s.open);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar__title">
        <b>{mod.title}</b>
        <span>{mod.blurb}</span>
      </div>
      <div className="topbar__right">
        {offline ? (
          <span className="offline"><span className="dot dot--error" /> Backend offline</span>
        ) : (
          <button className="conn" onClick={() => open('settings')} title="Connections (Settings)">
            {CONN.map((c) => {
              const ok = health?.keys[c.key];
              return (
                <span key={c.key} className={`conn__item ${ok ? '' : 'conn__item--off'}`}>
                  <span className={`dot ${ok ? 'dot--ok' : 'dot--off'}`} />
                  {c.label}
                </span>
              );
            })}
          </button>
        )}
        <span className="topbar__clock">{clock(now)}</span>
        {mod.Inspector && (
          <button className="iconbtn" onClick={toggle} title={inspectorOpen ? 'Hide inspector' : 'Show inspector'} aria-pressed={inspectorOpen}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
              <path d="M10 2.5v11" />
              {inspectorOpen && <path d="M10 2.5h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-3z" fill="currentColor" opacity="0.35" />}
            </svg>
          </button>
        )}
      </div>
    </header>
  );
}
