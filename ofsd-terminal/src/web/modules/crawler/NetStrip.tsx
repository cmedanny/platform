import { useEffect, useRef } from 'react';
import type { NetLine } from '../../../shared/crawl.ts';
import type { CrawlSession } from './session.ts';

export const fmtBytes = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

function shortUrl(u: string) {
  try {
    const url = new URL(u);
    const path = url.pathname.length > 58 ? `${url.pathname.slice(0, 24)}…${url.pathname.slice(-30)}` : url.pathname;
    return { host: url.host, path: path + (url.search ? '?…' : '') };
  } catch {
    return { host: '', path: u };
  }
}

function Line({ n }: { n: NetLine }) {
  const { host, path } = shortUrl(n.url);
  const err = n.phase === 'error' || (n.status ?? 0) >= 400;
  const live = n.phase === 'start' || n.phase === 'progress';
  return (
    <div className={`net__line ${err ? 'net__line--err' : ''}`}>
      <span className={`dot ${live ? 'dot--live' : err ? 'dot--error' : 'dot--done'}`} />
      <span className="net__method">{n.method}</span>
      <span className="net__status">{n.status ?? (live ? '···' : '—')}</span>
      <span className="net__url">
        <span className="net__host">{host}</span>
        {path}
      </span>
      <span className="net__bytes">{n.bytes ? fmtBytes(n.bytes) : ''}</span>
      <span className="net__ms">{n.ms !== undefined ? `${n.ms}ms` : ''}</span>
      {n.note && n.phase === 'error' && <span className="net__note">{n.note}</span>}
    </div>
  );
}

export function NetStrip({ s }: { s: CrawlSession }) {
  const total = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLDivElement>(null);

  // Byte counter ticks up smoothly toward the real total.
  useEffect(() => {
    let shown = 0;
    let raf = 0;
    const tick = () => {
      const real = s.net.reduce((a, n) => a + (n.bytes ?? 0), 0);
      shown += (real - shown) * 0.18;
      if (Math.abs(real - shown) < 1) shown = real;
      if (total.current) total.current.textContent = fmtBytes(Math.round(shown));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [s]);

  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  return (
    <div className="net">
      <div className="pane__head">
        <span className="label">Network</span>
        <span className="pane__file mono">{s.net.length} request{s.net.length === 1 ? '' : 's'}</span>
        <span className="pane__stat mono">
          ↓ <span ref={total}>0 B</span>
        </span>
      </div>
      <div className="net__body" ref={body}>
        {s.net.length === 0 ? <div className="net__line net__line--idle">waiting…</div> : s.net.map((n) => <Line key={n.id} n={n} />)}
      </div>
    </div>
  );
}
