import { useEffect, useState } from 'react';
import type { CrawlListItem, KeyFigure } from '../../../shared/crawl.ts';
import { api } from '../../lib/api.ts';
import { exportCrawl } from '../../lib/exports.ts';
import { PAGE_LABEL } from '../../lib/platform.ts';
import { usePref } from '../../lib/store.ts';
import { Draft, Label, Switch } from '../../ui/index.tsx';
import type { CrawlSession } from './session.ts';

const num = (v: number | null) =>
  v === null ? '—' : v < 0 ? `(${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })})` : v.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (c: number | null) => (c === null ? '—' : `${c >= 0 ? '+' : '−'}${Math.abs(c * 100).toFixed(1)}%`);
const STMT: Record<string, string> = { income: 'Income', comprehensive: 'Comp. income', balance: 'Balance sheet', cashflow: 'Cash flow', equity: 'Equity' };

export function Report({ s }: { s: CrawlSession }) {
  const [, setView] = usePref<'live' | 'report'>('crawler', 'view', 'live');
  const [showAll, setShowAll] = useState(false);
  const [attached, setAttached] = useState<boolean | null>(null);
  const [exportErr, setExportErr] = useState('');
  const crawlId = s.meta?.crawlId;

  useEffect(() => {
    if (!crawlId) return;
    api
      .get<CrawlListItem[]>('/api/m/crawler/list')
      .then((l) => setAttached(l.find((c) => c.id === crawlId)?.attached ?? false))
      .catch(() => setAttached(false));
  }, [crawlId]);

  const goTo = (f: KeyFigure) => {
    setView('live');
    s.reader?.visit(f.token);
  };

  const keyFigs = s.key.map((id) => s.figure(id)).filter((f): f is KeyFigure => !!f);
  const rest = s.figures.filter((f) => !s.key.includes(f.id));
  const rows = showAll || !keyFigs.length ? [...keyFigs, ...rest] : keyFigs;
  const unit = s.figures[0]?.unit;
  const analyzing = s.status === 'running';
  const done = s.status === 'done';

  return (
    <div className="report">
      <div className="report__head">
        <div>
          <Label>Report</Label>
          <div className="report__title">{s.meta?.company ? `${s.meta.company} · ${s.meta.form}` : s.meta?.title}</div>
          <div className="report__sub mono">
            {s.meta?.period && <>period {s.meta.period} · </>}
            {s.meta?.filed && <>filed {s.meta.filed} · </>}
            {s.parsed && (
              <>
                {s.parsed.pages} {PAGE_LABEL === '§' ? 'sections' : 'pages'} · {s.parsed.values.toLocaleString()} values
              </>
            )}
          </div>
        </div>
        <div className="report__actions">
          <label className="report__attach">
            <Switch
              on={!!attached}
              onChange={async (on) => {
                if (!crawlId) return;
                setAttached(on);
                await api.post(`/api/m/crawler/${crawlId}/attach`, { on }).catch(() => setAttached(!on));
              }}
              label="Attach to thesis"
            />
            Attach to thesis
          </label>
          {(['csv', 'xlsx'] as const).map((fmt) => (
            <button
              key={fmt}
              className="btn"
              disabled={!done || !crawlId}
              onClick={async () => {
                if (!crawlId) return;
                const base = (s.meta?.ticker ? `${s.meta.ticker}-${s.meta.form}` : 'crawl').replace(/[^\w-]+/g, '_');
                setExportErr((await exportCrawl({ crawlId, base, figures: s.figures, key: s.key, summary: s.summary, obs: s.obs }, fmt)) ?? '');
              }}
            >
              {fmt === 'csv' ? 'Export CSV' : 'Export Excel'}
            </button>
          ))}
        </div>
      </div>

      {s.status === 'error' && <div className="report__error">{s.error || 'This crawl failed.'}</div>}
      {exportErr && <div className="report__error">{exportErr}</div>}

      <section className="report__block">
        <div className="report__label">
          <Label>Summary</Label>
          {s.summary && <Draft />}
        </div>
        {s.summary ? <p className="report__summary">{s.summary}</p> : <p className="dim">{analyzing ? 'Claude is reading the document…' : 'No summary (Claude was not available for this crawl).'}</p>}
      </section>

      <section className="report__block">
        <div className="report__label">
          <Label>Key figures</Label>
          <span className="dim">{unit ? `$ in ${unit} unless noted` : ''}</span>
          {keyFigs.length > 0 && rest.length > 0 && (
            <button className="btn btn--ghost" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Key only' : `All ${s.figures.length} statement lines`}
            </button>
          )}
        </div>
        {rows.length === 0 ? (
          <p className="dim">{s.rawDone ? 'No financial statement tables found in this document.' : 'Waiting for the document…'}</p>
        ) : (
          <table className="table report__table">
            <thead>
              <tr>
                <th>Line item</th>
                <th className="num">Current</th>
                <th className="num">Prior</th>
                <th className="num">Change</th>
                <th>Statement</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className={s.key.includes(f.id) ? 'is-key' : ''}>
                  <td className="bright">{f.label}</td>
                  <td className="num tone-current">{num(f.current)}</td>
                  <td className="num tone-prior">{num(f.prior)}</td>
                  <td className="num">{pct(f.change)}</td>
                  <td className="dim">{STMT[f.statement] ?? f.statement}</td>
                  <td>
                    <button className="linkbtn mono" onClick={() => goTo(f)} title="Send the spider to this figure">
                      {PAGE_LABEL} {f.page} ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="report__block">
        <div className="report__label">
          <Label>Observations</Label>
          {s.obs.length > 0 && <Draft />}
        </div>
        {s.obs.length === 0 ? (
          <p className="dim">{analyzing ? 'Coming in as Claude writes them…' : 'None.'}</p>
        ) : (
          <ol className="obs">
            {s.obs.map((o) => (
              <li key={o.i}>
                <span>{o.text}</span>
                {o.refs.map((id) => {
                  const f = s.figure(id);
                  return f ? (
                    <button key={id} className="chip obs__ref" onClick={() => goTo(f)} title={`${f.label}: ${num(f.current)}`}>
                      {f.label.length > 22 ? `${f.label.slice(0, 21)}…` : f.label}
                    </button>
                  ) : null;
                })}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
