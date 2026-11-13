import { memo, useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { DocBlock, DocToken, Tone } from '../../../shared/crawl.ts';
import { useReducedMotion } from '../../lib/motion.ts';
import { useStore } from '../../lib/store.ts';
import { DocLayout } from './layout.ts';
import { Reader } from './reader.ts';
import type { CrawlSession } from './session.ts';

export const SPEEDS: Record<string, number> = { '0.5x': 0.5, '1x': 1, '2x': 2, '4x': 4 };
export const speedNow = () => SPEEDS[(useStore.getState().prefs.crawler?.speed as string) ?? '1x'] ?? 1;
const pref = (k: string, d: boolean) => (useStore.getState().prefs.crawler?.[k] as boolean | undefined) ?? d;

function withTokens(text: string, toks: DocToken[]): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  for (const t of [...toks].sort((a, b) => a.s - b.s)) {
    if (t.s < pos) continue;
    if (t.s > pos) out.push(text.slice(pos, t.s));
    out.push(
      <span key={t.id} data-t={t.id}>
        {text.slice(t.s, t.e)}
      </span>,
    );
    pos = t.e;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

const NUMERIC = /^[\d,.()$%\s—–-]+$/;

const BlockView = memo(function BlockView({ b }: { b: DocBlock }) {
  if (b.t === 'pb')
    return (
      <div className="d-pb" data-b={b.id}>
        <span>p. {b.page}</span>
      </div>
    );
  if (b.t === 'table') {
    const byCell = new Map<string, DocToken[]>();
    for (const t of b.tokens) {
      const k = `${t.r}:${t.c}`;
      byCell.set(k, [...(byCell.get(k) ?? []), t]);
    }
    return (
      <table className={`d-table ${b.stmt ? 'd-table--stmt' : ''}`} data-b={b.id}>
        <tbody>
          {b.rows.map((row, r) => (
            <tr key={r}>
              {row.map((c, ci) => (
                <td key={ci} colSpan={c.cs} className={c.x === '$' || c.x === ')' || c.x === '%' ? 'sym' : NUMERIC.test(c.x) && c.x ? 'num' : ''}>
                  {withTokens(c.x, byCell.get(`${r}:${ci}`) ?? [])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  const Tag = b.t === 'h' ? 'div' : 'p';
  return (
    <Tag className={`d-${b.t} ${b.center ? 'd-center' : ''}`} data-b={b.id}>
      {withTokens(b.text, b.tokens)}
    </Tag>
  );
});

const DocBody = memo(function DocBody({ blocks }: { blocks: DocBlock[]; v: number }) {
  return (
    <>
      {blocks.map((b) => (
        <BlockView key={b.id} b={b} />
      ))}
    </>
  );
});

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    current: v('--lime'),
    prior: v('--magenta'),
    label: v('--cyan'),
    header: v('--orange'),
    red: v('--red'),
    bg: v('--bg-deep'),
    ink: '#0d1320',
  };
}

const toneColor = (c: ReturnType<typeof readColors>, t: Tone) => c[t];

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function DocPane({ s, onLayout }: { s: CrawlSession; onLayout?: (l: DocLayout) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<DocLayout | null>(null);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const docVersion = useSyncExternalStore(s.subscribe, () => s.docVersion);

  useLayoutEffect(() => {
    layoutRef.current?.appended();
  }, [docVersion]);

  useEffect(() => {
    const sc = scroller.current!;
    const ct = content.current!;
    const cv = canvas.current!;
    const layout = new DocLayout(sc, ct);
    layoutRef.current = layout;
    onLayout?.(layout);
    const reader = (s.reader ??= new Reader(s));
    const colors = readColors();
    let raf = 0;
    let last = performance.now();
    let userScrollAt = -1e9;
    let settled = false;
    const onUser = () => (userScrollAt = performance.now());
    sc.addEventListener('wheel', onUser, { passive: true });
    sc.addEventListener('touchmove', onUser, { passive: true });
    sc.addEventListener('keydown', onUser);
    const ro = new ResizeObserver(() => layout.invalidate());
    ro.observe(ct);
    document.fonts?.ready.then(() => layout.invalidate());

    const ctx = cv.getContext('2d')!;
    let W = 0;
    let H = 0;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = sc.clientWidth;
      H = sc.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro2 = new ResizeObserver(resize);
    ro2.observe(sc);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const speed = speedNow();
      const red = reducedRef.current;

      if (s.mode === 'static' && !settled && s.status !== 'running' && s.blocks.length && (s.tokens.length === 0 || layout.rect(s.tokens[s.tokens.length - 1].id))) {
        reader.settleAll(layout);
        settled = true;
        const p = reader.spider;
        sc.scrollTop = Math.max(0, p.y - H * 0.4);
      }
      reader.step(now, dt, speed, layout, red);

      // camera: keep the spider ~40% down the viewport unless the user is scrolling
      const sp = reader.spider;
      if (now - userScrollAt > 2500 && reader.mode !== 'done') {
        const want = Math.max(0, sp.y - H * 0.45);
        const delta = want - sc.scrollTop;
        if (Math.abs(delta) > 2) sc.scrollTop += red || Math.abs(delta) > H * 2 ? delta : delta * Math.min(1, dt * 2.2);
      }

      // ---- draw overlay ----
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(-sc.scrollLeft, -sc.scrollTop);
      const top = sc.scrollTop - 40;
      const bottom = sc.scrollTop + H + 40;
      const trail = pref('trail', true);
      for (let id = 0; id < s.readAt.length; id++) {
        const at = s.readAt[id];
        if (at === undefined) continue;
        const age = now - at;
        if (!trail && age > 900) continue;
        const r = layout.rect(id);
        if (!r || r.y > bottom || r.y + r.h < top) continue;
        const t = s.tokens[id];
        const fresh = red ? 0 : Math.exp(-age / 450);
        const a = 0.4 + 0.6 * fresh;
        const col = toneColor(colors, t.tone);
        ctx.globalAlpha = a;
        if (t.kind === 'header') {
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.16 + 0.3 * fresh;
          ctx.fillRect(r.x - 4, r.y - 1, r.w + 8, r.h + 2);
          ctx.globalAlpha = a;
          ctx.fillRect(r.x - 6, r.y - 1, 2, r.h + 2);
        } else if (t.kind === 'label') {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(r.x, r.y + r.h + 0.5);
          ctx.lineTo(r.x + r.w, r.y + r.h + 0.5);
          ctx.stroke();
        } else {
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.1 + 0.22 * fresh;
          ctx.fillRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2);
          ctx.globalAlpha = a;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1;
          ctx.strokeRect(r.x - 2.5, r.y - 1.5, r.w + 5, r.h + 3);
        }
      }
      ctx.globalAlpha = 1;

      // silk thread from the head to the token just read; it fades between reads
      const cur = reader.cur >= 0 ? layout.rect(reader.cur) : null;
      const readAge = reader.cur >= 0 ? now - (s.readAt[reader.cur] ?? -1e9) : 1e9;
      const silkA = reader.mode === 'done' ? 0 : Math.max(0, 1 - readAge / (900 / Math.sqrt(speed)));
      if (cur && pref('silk', true) && silkA > 0.02) {
        const hd = sp.head();
        const tx = cur.x + Math.min(cur.w, 120) / 2;
        const ty = cur.y + cur.h / 2;
        const sag = Math.min(40, Math.hypot(tx - hd.x, ty - hd.y) * 0.12);
        ctx.strokeStyle = colors.red;
        ctx.globalAlpha = 0.75 * silkA;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(hd.x, hd.y);
        ctx.quadraticCurveTo((hd.x + tx) / 2, (hd.y + ty) / 2 + sag, tx, ty);
        ctx.stroke();
        ctx.fillStyle = colors.red;
        ctx.beginPath();
        ctx.arc(tx, ty, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      sp.draw(ctx, now, { body: colors.label, joint: colors.label, foot: colors.prior, head: '#e9fbff', bg: colors.bg }, red);

      // callouts: pop big next to the token, hold, fade
      if (pref('callouts', true)) {
        ctx.font = "700 20px 'JetBrains Mono', ui-monospace, monospace";
        ctx.textBaseline = 'middle';
        for (const c of reader.callouts) {
          const r = layout.rect(c.tok.id);
          if (!r) continue;
          const age = (now - c.t0) * Math.max(1, speed * 0.6);
          const inT = Math.min(1, age / 160);
          const scale = red ? 1 : 0.6 + 0.4 * (1 + 2.2 * Math.pow(inT - 1, 3) + 1.2 * Math.pow(inT - 1, 2));
          const alpha = red ? (age < 900 ? 1 : 0) : age < 760 ? 1 : Math.max(0, 1 - (age - 760) / 300);
          if (alpha <= 0) continue;
          const label = c.text.length > 34 ? `${c.text.slice(0, 33)}…` : c.text;
          const tw = ctx.measureText(label).width;
          const bw = tw + 18;
          const bh = 30;
          let bx = r.x + r.w + 10;
          let by = r.y + r.h / 2 - bh / 2 - 18;
          const viewRight = sc.scrollLeft + W - 8;
          if (bx + bw > viewRight) bx = Math.max(sc.scrollLeft + 8, r.x - bw - 10);
          by = Math.max(sc.scrollTop + 6, Math.min(by, sc.scrollTop + H - bh - 6));
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(bx + bw / 2, by + bh / 2);
          ctx.scale(scale, scale);
          const fill = toneColor(colors, c.tone);
          ctx.shadowColor = fill;
          ctx.shadowBlur = 14;
          ctx.fillStyle = fill;
          roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 3);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.fillStyle = c.tone === 'prior' ? '#ffffff' : colors.ink;
          ctx.fillText(label, -tw / 2, 1);
          ctx.restore();
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ro2.disconnect();
      sc.removeEventListener('wheel', onUser);
      sc.removeEventListener('touchmove', onUser);
      sc.removeEventListener('keydown', onUser);
    };
  }, [s, onLayout]);

  const m = s.meta;
  return (
    <div className="docpane">
      <div className="docpane__scroll" ref={scroller} tabIndex={0}>
        <div className="doc" ref={content}>
          {m && (
            <div className="doc__meta">
              <span className="label">{m.kind === 'edgar' ? 'SEC EDGAR' : 'Web page'}</span>
              <div className="doc__title">{m.company ? `${m.company} · ${m.form}` : m.title}</div>
              <div className="doc__sub mono">
                {m.filed && <>filed {m.filed} · </>}
                {m.period && <>period {m.period} · </>}
                {m.url && (
                  <a href={m.url} target="_blank" rel="noreferrer">
                    source ↗
                  </a>
                )}
              </div>
            </div>
          )}
          <DocBody blocks={s.blocks} v={docVersion} />
          {!s.blocks.length && s.status === 'running' && <div className="doc__wait mono">waiting for the first bytes…</div>}
        </div>
      </div>
      <canvas ref={canvas} className="docpane__overlay" aria-hidden />
    </div>
  );
}
