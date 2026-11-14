import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { clock } from '../lib/format.ts';
import { IS_ARTIFACT } from '../lib/platform.ts';
import { useStore } from '../lib/store.ts';
import type { ModuleDef } from '../modules/types.ts';

const CONN = IS_ARTIFACT
  ? ([
      { key: 'anthropic', label: 'Claude plan' },
      { key: 'sec', label: 'Robinhood' },
    ] as const)
  : ([
      { key: 'anthropic', label: 'Claude' },
      { key: 'sec', label: 'EDGAR' },
      { key: 'twitter', label: 'X' },
      { key: 'discord', label: 'Discord' },
    ] as const);

export function TopBar({ mod }: { mod: ModuleDef }) {
  const health = useStore((s) => s.health);
  const offline = useStore((s) => s.offline);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  const toggle = useStore((s) => s.toggleInspector);
  const open = useStore((s) => s.open);
  const [now, setNow] = useState(() => new Date());
  const [storage, setStorage] = useState<{ mode: string; problem: string } | null>(null);
  useEffect(() => {
    if (!IS_ARTIFACT) return;
    const load = () => api.get<{ mode: string; problem: string }>('/api/storage').then(setStorage).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
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
        {storage && storage.mode !== 'loading' && (
          <span className={`conn__item ${storage.mode === 'saved' && !storage.problem ? '' : 'conn__item--warn'}`} title={storage.problem || 'Saved privately in your Claude account'}>
            <span className={`dot ${storage.mode === 'saved' && !storage.problem ? 'dot--ok' : 'dot--error'}`} />
            {storage.mode === 'saved' && !storage.problem ? 'Saved' : 'Not saving'}
          </span>
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
