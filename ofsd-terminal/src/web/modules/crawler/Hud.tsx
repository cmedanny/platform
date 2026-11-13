import { useEffect, useRef, useState } from 'react';
import { execute } from '../../lib/commands.ts';
import { usePref } from '../../lib/store.ts';
import { Kbd, Segmented } from '../../ui/index.tsx';
import { speedNow } from './DocPane.tsx';
import { fmtBytes } from './NetStrip.tsx';
import { openSession, type CrawlSession } from './session.ts';

function phaseText(s: CrawlSession) {
  if (s.status === 'error') return 'failed';
  const reader = s.reader;
  const pages = s.parsed?.pages;
  if (s.phase === 'resolve') return 'resolving filing';
  if (!s.rawDone) return `downloading · ${fmtBytes(s.raw.length)}`;
  if (reader && !s.readerDone) {
    const tok = reader.cur >= 0 ? s.tokens[reader.cur] : undefined;
    const page = tok ? s.blocks[tok.b]?.page : undefined;
    return page && pages ? `reading p. ${page} / ${pages}` : 'reading';
  }
  if (s.status === 'running') return 'Claude analyzing';
  return 'done';
}

export function Hud({ s }: { s: CrawlSession }) {
  const [speed, setSpeed] = usePref('crawler', 'speed', '1x');
  const [view, setView] = usePref<'live' | 'report'>('crawler', 'view', 'live');
  const [q, setQ] = useState('');
  const ask = useRef<HTMLInputElement>(null);
  const title = s.meta ? (s.meta.ticker ? `${s.meta.ticker} ${s.meta.form}` : s.meta.title) : '…';
  const live = s.live && s.status !== 'error';
  const canAsk = s.status === 'done' && !!s.meta?.crawlId;
  const stmt = s.parsed?.stmts?.income ?? s.parsed?.stmts?.balance;

  // "/" focuses "Ask this document" when you're not typing somewhere else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey) return;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      ask.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submitAsk = () => {
    const question = q.trim();
    if (!question || !s.meta) return;
    setQ('');
    ask.current?.blur();
    execute(`/askdoc ${s.meta.crawlId} ${question}`, `ask ${title}: ${question}`);
  };

  const jump = () => {
    if (stmt === undefined || !s.reader) return;
    const first = s.blocks[stmt]?.tokens.find((t) => t.kind !== 'label' && t.kind !== 'header') ?? s.blocks[stmt]?.tokens[0];
    if (first) {
      setView('live');
      s.reader.jump(first.id);
    }
  };

  return (
    <div className="hud">
      <div className="hud__title">
        {live ? <span className="dot dot--live" /> : s.status === 'error' ? <span className="dot dot--error" /> : <span className="dot dot--done" />}
        {live && <span className="hud__live">Live</span>}
        <b>{title}</b>
        <span className="hud__sep">·</span>
        <span className="mono hud__count">{s.figuresRead.toLocaleString()}</span> figures
        <span className="hud__sep">·</span>
        <span className="mono hud__count">{s.obs.length}</span> observations
        <span className="hud__phase mono">{phaseText(s)}</span>
      </div>
      <div className="hud__controls">
        <Segmented options={[{ value: 'live', label: 'Live' }, { value: 'report', label: 'Report' }]} value={view} onChange={setView} label="View" />
        <Segmented options={['0.5x', '1x', '2x', '4x'] as const} value={speed as '1x'} onChange={setSpeed} label="Speed" />
        <button className="btn" onClick={() => (setView('live'), openSession(s.runId, 'replay', speedNow))} title="Replay this crawl from the saved timeline">
          ↻ Replay
        </button>
        <button className="btn" onClick={jump} disabled={stmt === undefined} title="Send the spider to the financial statements">
          Jump to statements
        </button>
        <div className={`hud__ask ${canAsk ? '' : 'hud__ask--off'}`}>
          <input
            ref={ask}
            className="input"
            value={q}
            disabled={!canAsk}
            placeholder={canAsk ? 'Ask this document' : 'Ask (after the crawl)'}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitAsk();
              if (e.key === 'Escape') ask.current?.blur();
            }}
          />
          <Kbd>/</Kbd>
        </div>
      </div>
    </div>
  );
}
