import { useEffect, useRef, useState } from 'react';
import type { CrawlListItem } from '../../../shared/crawl.ts';
import { api } from '../../lib/api.ts';
import { execute } from '../../lib/commands.ts';
import { stamp } from '../../lib/format.ts';
import { useStore, usePref } from '../../lib/store.ts';
import { EmptyState, Row, Section, Segmented, Select, Switch } from '../../ui/index.tsx';
import { SpiderGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';
import { DocPane, speedNow } from './DocPane.tsx';
import { Hud } from './Hud.tsx';
import { NetStrip } from './NetStrip.tsx';
import { RawPane } from './RawPane.tsx';
import { Report } from './Report.tsx';
import { getSession, openSession, useSession } from './session.ts';
import './crawler.css';

const ID = 'crawler';
const setPref = (k: string, v: unknown) => useStore.getState().setPref(ID, k, v);

function useCrawls() {
  const version = useStore((s) => s.runsVersion);
  const [list, setList] = useState<CrawlListItem[] | null>(null);
  useEffect(() => {
    api.get<CrawlListItem[]>('/api/m/crawler/list').then(setList).catch(() => setList([]));
  }, [version]);
  return list;
}

function open(c: CrawlListItem) {
  setPref('lastRun', c.runId);
  setPref('view', c.status === 'done' ? 'report' : 'live');
  openSession(c.runId, 'static');
}

function RecentList({ list, limit = 8 }: { list: CrawlListItem[]; limit?: number }) {
  const s = useSession();
  return (
    <div className="recent">
      {list.slice(0, limit).map((c) => (
        <button key={c.id} className={`recent__item ${s?.runId === c.runId ? 'recent__item--on' : ''}`} onClick={() => open(c)}>
          <span className={`dot ${c.status === 'running' ? 'dot--live' : c.status === 'error' ? 'dot--error' : 'dot--done'}`} />
          <span className="recent__title">{c.ticker ? `${c.ticker} ${c.form}` : c.title}</span>
          <span className="recent__time mono">{stamp(c.createdAt)}</span>
        </button>
      ))}
    </div>
  );
}

function Canvas() {
  const s = useSession();
  const setDraft = useStore((st) => st.setDraft);
  const [view, setView] = usePref<'live' | 'report'>(ID, 'view', 'live');
  const [lastRun] = usePref<string | null>(ID, 'lastRun', null);
  const list = useCrawls();
  const autoShown = useRef<string | null>(null);

  // Reopen the last crawl after a reload.
  useEffect(() => {
    if (!getSession() && lastRun) openSession(lastRun, 'static');
  }, [lastRun]);

  // When a live crawl finishes (spider done reading + Claude done), flip to the report once.
  useEffect(() => {
    if (!s || s.mode === 'static' || autoShown.current === s.runId) return;
    if (s.readerDone && s.status === 'done') {
      autoShown.current = s.runId;
      setView('report');
    }
  });

  if (!s)
    return (
      <EmptyState
        glyph={<SpiderGlyph />}
        title="No crawl open"
        text="Point the spider at an SEC filing or any URL. It reads the real document live and pulls out every figure."
      >
        <button className="chip" onClick={() => setDraft('/crawl NVDA 10-Q')}>/crawl NVDA 10-Q</button>
        <button className="chip" onClick={() => setDraft('/crawl https://')}>/crawl &lt;url&gt;</button>
        {list && list.length > 0 && (
          <div style={{ width: 320, marginTop: 14, textAlign: 'left' }}>
            <span className="label">Recent crawls</span>
            <RecentList list={list} />
          </div>
        )}
      </EmptyState>
    );

  return (
    <div className="crawl">
      <Hud s={s} />
      <NetStrip s={s} />
      <div className="crawl__panes">
        <RawPane s={s} />
        <DocPane s={s} />
        {view === 'report' && (
          <div className="crawl__report">
            <Report s={s} />
          </div>
        )}
      </div>
      {s.status === 'error' && s.error && view === 'live' && <div className="crawl__error">{s.error}</div>}
    </div>
  );
}

function Inspector() {
  const [source, setSource] = usePref<'EDGAR' | 'URL'>(ID, 'source', 'EDGAR');
  const [form, setForm] = usePref(ID, 'form', '10-Q');
  const [ticker, setTicker] = usePref(ID, 'ticker', '');
  const [url, setUrl] = usePref(ID, 'url', '');
  const [speed, setSpeed] = usePref(ID, 'speed', '2x');
  const [callouts, setCallouts] = usePref(ID, 'callouts', true);
  const [silk, setSilk] = usePref(ID, 'silk', true);
  const [trail, setTrail] = usePref(ID, 'trail', true);
  const list = useCrawls();
  const go = () => {
    if (source === 'EDGAR' && ticker.trim()) execute(`/crawl ${ticker.trim().toUpperCase()} ${form}`);
    if (source === 'URL' && url.trim()) execute(`/crawl ${url.trim()}`);
  };
  return (
    <>
      <Section title="New crawl">
        <Segmented options={['EDGAR', 'URL'] as const} value={source} onChange={setSource} />
        {source === 'EDGAR' ? (
          <>
            <Row label="Ticker">
              <input className="input mono" style={{ width: 92 }} value={ticker} placeholder="NVDA" onChange={(e) => setTicker(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
            </Row>
            <Row label="Form">
              <Select options={['10-Q', '10-K', '8-K'] as const} value={form as '10-Q'} onChange={setForm} />
            </Row>
          </>
        ) : (
          <input className="input mono" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        )}
        <button className="btn btn--primary" style={{ alignSelf: 'flex-start' }} onClick={go}>
          Crawl
        </button>
      </Section>
      <Section title="Playback">
        <Segmented options={['0.5x', '1x', '2x', '4x'] as const} value={speed as '1x'} onChange={setSpeed} />
      </Section>
      <Section title="Layers">
        <Row label="Value callouts"><Switch on={callouts} onChange={setCallouts} /></Row>
        <Row label="Silk line"><Switch on={silk} onChange={setSilk} /></Row>
        <Row label="Highlight trail"><Switch on={trail} onChange={setTrail} /></Row>
        <div className="legend">
          <span><i style={{ background: 'var(--lime)' }} />current</span>
          <span><i style={{ background: 'var(--magenta)' }} />prior</span>
          <span><i style={{ background: 'var(--cyan)' }} />label</span>
          <span><i style={{ background: 'var(--orange)' }} />section</span>
        </div>
      </Section>
      <Section title="Recent" hint={list ? `${list.length} crawls` : ''}>
        {list && list.length ? <RecentList list={list} limit={12} /> : <div className="dim" style={{ fontSize: 11 }}>No crawls yet.</div>}
      </Section>
    </>
  );
}

export const crawler: ModuleDef = {
  id: ID,
  title: 'Crawler',
  blurb: 'Live document reading · SEC EDGAR or any URL',
  Canvas,
  Inspector,
  commands: [
    {
      name: 'crawl',
      usage: '/crawl NVDA 10-Q | <url>',
      description: 'Crawl a filing or web page live.',
      // "/crawl NVDA" uses the default form from the inspector
      transform: (args) => {
        const a = args.trim();
        if (/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(a) && !a.includes('.')) return `${a.toUpperCase()} ${(useStore.getState().prefs[ID]?.form as string) ?? '10-Q'}`;
        return a;
      },
      onStarted: (runId) => {
        setPref('lastRun', runId);
        setPref('view', 'live');
        useStore.getState().open(ID);
        openSession(runId, 'live');
      },
    },
    { name: 'askdoc', usage: '/askdoc <crawl> <question>', description: 'Ask a question about a crawled document.', hidden: true },
  ],
  onReplay: (run) => {
    if (!/^\/crawl\b/i.test(run.command)) return false;
    setPref('lastRun', run.id);
    setPref('view', 'live');
    useStore.getState().open(ID);
    openSession(run.id, 'replay', speedNow);
    return true;
  },
};
