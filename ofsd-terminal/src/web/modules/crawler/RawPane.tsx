import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../../lib/motion.ts';
import { speedNow } from './DocPane.tsx';
import type { CrawlSession } from './session.ts';

const LINE_H = 13;
const FONT = "10.5px 'JetBrains Mono', ui-monospace, monospace";

/**
 * Wrapped-line index over the raw source, built incrementally as bytes arrive.
 * Also remembers whether each line starts inside a tag, for coloring.
 */
class LineIndex {
  starts: number[] = [0];
  inTag: boolean[] = [false];
  private pos = 0;
  private col = 0;
  private tag = false;
  constructor(public cols: number) {}

  extend(raw: string) {
    const { cols } = this;
    for (let i = this.pos; i < raw.length; i++) {
      const ch = raw.charCodeAt(i);
      if (ch === 60) this.tag = true; // <
      else if (ch === 62) this.tag = false; // >
      if (ch === 10) {
        this.starts.push(i + 1);
        this.inTag.push(this.tag);
        this.col = 0;
        continue;
      }
      if (++this.col >= cols) {
        this.starts.push(i + 1);
        this.inTag.push(this.tag);
        this.col = 0;
      }
    }
    this.pos = raw.length;
  }

  lineOf(offset: number) {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export function RawPane({ s }: { s: CrawlSession }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const bytesEl = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    const cv = canvas.current!;
    const el = wrap.current!;
    const ctx = cv.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const col = {
      tag: css.getPropertyValue('--text-faint').trim(),
      text: css.getPropertyValue('--text-bright').trim(),
      ent: css.getPropertyValue('--text-dim').trim(),
      band: 'rgba(255,255,255,0.05)',
      current: css.getPropertyValue('--lime').trim(),
      prior: css.getPropertyValue('--magenta').trim(),
      label: css.getPropertyValue('--cyan').trim(),
      header: css.getPropertyValue('--orange').trim(),
      cursor: css.getPropertyValue('--lime').trim(),
    };
    let W = 0;
    let H = 0;
    let charW = 6.3;
    let index = new LineIndex(80);
    let shown = s.mode === 'static' ? s.raw.length : 0;
    let viewLine = 0;
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = el.clientWidth;
      H = el.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = FONT;
      charW = ctx.measureText('M').width || 6.3;
      const cols = Math.max(20, Math.floor((W - 20) / charW));
      if (cols !== index.cols) index = new LineIndex(cols);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const raw = s.raw;
      index.extend(raw);
      const speed = speedNow();
      const red = reducedRef.current;

      // Terminal flood: the display catches up with bytes actually received.
      if (shown < raw.length) {
        const backlog = raw.length - shown;
        const rate = red ? Infinity : Math.max(90_000 * speed, backlog / 1.1);
        shown = Math.min(raw.length, shown + rate * dt);
      }
      const flooding = shown < raw.length || (!s.rawDone && s.status === 'running');
      const head = s.reader?.cur ?? -1;
      const headTok = head >= 0 ? s.tokens[head] : undefined;
      const rows = Math.floor(H / LINE_H);

      let targetLine: number;
      let headLine = -1;
      if (flooding || !headTok) {
        targetLine = Math.max(0, index.lineOf(Math.floor(shown)) - rows + 2);
      } else {
        headLine = index.lineOf(headTok.src);
        targetLine = Math.max(0, headLine - Math.floor(rows * 0.45));
      }
      const d = targetLine - viewLine;
      viewLine = red || Math.abs(d) > rows * 4 || flooding ? targetLine : viewLine + d * Math.min(1, dt * 8);

      ctx.clearRect(0, 0, W, H);
      ctx.font = FONT;
      ctx.textBaseline = 'top';
      const first = Math.floor(viewLine);
      const offY = -(viewLine - first) * LINE_H + 4;
      const limit = Math.floor(shown);
      for (let k = 0; k <= rows + 1; k++) {
        const li = first + k;
        if (li >= index.starts.length) break;
        const a = index.starts[li];
        if (a >= limit) break;
        const b = Math.min(li + 1 < index.starts.length ? index.starts[li + 1] : raw.length, limit);
        const y = offY + k * LINE_H;
        if (li === headLine) {
          ctx.fillStyle = col.band;
          ctx.fillRect(0, y - 1, W, LINE_H);
        }
        // color runs: tags faint, text bright, entities dim
        let inTag = index.inTag[li];
        let x = 10;
        let runStart = a;
        const flush = (end: number, color: string) => {
          if (end <= runStart) return;
          const str = raw.slice(runStart, end).replace(/\n/g, '');
          ctx.fillStyle = color;
          ctx.fillText(str, x, y);
          x += str.length * charW;
          runStart = end;
        };
        for (let i = a; i < b; i++) {
          const ch = raw.charCodeAt(i);
          if (!inTag && ch === 60) {
            flush(i, col.text);
            inTag = true;
          } else if (inTag && ch === 62) {
            flush(i + 1, col.tag);
            inTag = false;
          } else if (!inTag && ch === 38) {
            flush(i, col.text);
            const semi = raw.indexOf(';', i);
            if (semi > 0 && semi - i < 10 && semi < b) {
              flush(semi + 1, col.ent);
              i = semi;
            }
          }
        }
        flush(b, inTag ? col.tag : col.text);
        // underline the token being read
        if (li === headLine && headTok) {
          const s0 = Math.max(a, headTok.src);
          const len = Math.min(headTok.text.length, b - s0);
          if (len > 0) {
            ctx.fillStyle = col[headTok.tone];
            ctx.fillRect(10 + (s0 - a) * charW, y + LINE_H - 2, len * charW, 1.5);
          }
        }
        if (flooding && li === index.lineOf(limit) && !red && Math.floor(now / 400) % 2 === 0) {
          ctx.fillStyle = col.cursor;
          ctx.fillRect(x + 1, y, charW * 0.8, LINE_H - 2);
        }
      }
      if (bytesEl.current) bytesEl.current.textContent = `${(Math.floor(shown) / 1024).toFixed(0)} KB${flooding ? '' : headTok ? ` · read head ${(headTok.src / 1024).toFixed(0)} KB` : ''}`;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [s]);

  const file = s.meta?.url ? s.meta.url.split('/').pop() : '';
  return (
    <div className="rawpane">
      <div className="pane__head">
        <span className="label">Raw source</span>
        <span className="pane__file mono">{file}</span>
        <span className="pane__stat mono" ref={bytesEl} />
      </div>
      <div className="rawpane__body" ref={wrap}>
        <canvas ref={canvas} aria-label="Raw HTML source streaming in" />
      </div>
    </div>
  );
}
