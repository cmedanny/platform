// Timeline view: one lane per group, time left to right, a lime "now" line.

import { useEffect, useRef, useState } from 'react';
import type { BrainNode } from '../../../shared/brain.ts';
import { stamp } from '../../lib/format.ts';
import { useReducedMotion } from '../../lib/motion.ts';
import { drawGlyph, isToday, KIND_LABEL, type Group } from './model.ts';

const LABEL_W = 130;
const STEPS = [3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 2 * 86400e3, 7 * 86400e3, 30 * 86400e3, 90 * 86400e3];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function Timeline({ groups, links, onOpen }: { groups: Group[]; links: boolean; onOpen: (n: BrainNode) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<BrainNode | null>(null);
  const reduced = useReducedMotion();
  const live = useRef({ groups, links, onOpen, reduced, hover: null as BrainNode | null });
  live.current = { groups, links, onOpen, reduced, hover: live.current.hover };

  useEffect(() => {
    const el = wrap.current!;
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const C = {
      node: css.getPropertyValue('--text-bright').trim(),
      lime: css.getPropertyValue('--lime').trim(),
      cyan: css.getPropertyValue('--cyan').trim(),
      dim: css.getPropertyValue('--text-dim').trim(),
      faint: css.getPropertyValue('--text-faint').trim(),
      border: css.getPropertyValue('--border').trim(),
    };
    let W = 0;
    let H = 0;
    let raf = 0;
    let mouse: { x: number; y: number } | null = null;
    const born = performance.now();
    let screen: Array<{ n: BrainNode; x: number; y: number }> = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      W = el.clientWidth;
      H = el.clientHeight;
      cv.width = W * dpr;
      cv.height = H * dpr;
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const frame = (now: number) => {
      const { groups: gs, links: showLinks, reduced: red } = live.current;
      ctx.clearRect(0, 0, W, H);
      const all = gs.flatMap((g) => g.nodes);
      if (!all.length) {
        raf = requestAnimationFrame(frame);
        return;
      }
      let t0 = Math.min(...all.map((n) => n.createdAt));
      let t1 = Math.max(Date.now(), ...all.map((n) => n.createdAt));
      t1 = Math.max(...all.map((n) => n.createdAt), Math.min(Date.now(), t1));
      // fit the window to the data (at least 2 hours) so a busy afternoon isn't squeezed into one edge
      if (t1 - t0 < 2 * 3600e3) {
        const mid = (t0 + t1) / 2;
        t0 = mid - 3600e3;
        t1 = mid + 3600e3;
      }
      const pad = (t1 - t0) * 0.06;
      t0 -= pad;
      t1 += pad;
      const x0 = LABEL_W + 10;
      const x1 = W - 24;
      const X = (t: number) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
      const top = 34;
      const laneH = Math.max(36, Math.min(90, (H - top - 20) / Math.max(1, gs.length)));
      const intro = red ? 1 : Math.min(1, (now - born) / 900);

      // ticks
      const step = STEPS.find((s) => (t1 - t0) / s <= 9) ?? STEPS[STEPS.length - 1];
      ctx.font = "10px 'JetBrains Mono', monospace";
      for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
        const x = X(t);
        const d = new Date(t);
        const label = step < 86400e3 ? `${String(d.getHours()).padStart(2, '0')}:00` : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
        ctx.strokeStyle = C.border;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, top - 6);
        ctx.lineTo(x, top + laneH * gs.length);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.faint;
        ctx.fillText(label, x - ctx.measureText(label).width / 2, top - 12);
      }
      // now line
      const xn = X(Date.now());
      if (xn <= x1 + 1) {
      ctx.strokeStyle = C.lime;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(xn, top - 6);
      ctx.lineTo(xn, top + laneH * gs.length);
      ctx.stroke();
      ctx.globalAlpha = 1;
      }

      const next: typeof screen = [];
      const where = new Map<string, { x: number; y: number }>();
      gs.forEach((g, gi) => {
        const y = top + gi * laneH + laneH / 2;
        ctx.strokeStyle = C.border;
        ctx.beginPath();
        ctx.moveTo(x0, top + (gi + 1) * laneH);
        ctx.lineTo(x1, top + (gi + 1) * laneH);
        ctx.stroke();
        ctx.font = "500 9.5px 'Inter', sans-serif";
        ctx.fillStyle = C.cyan;
        const lab = g.label.toUpperCase();
        ctx.fillText(lab.length > 18 ? `${lab.slice(0, 17)}…` : lab, 14, y + 3);
        ctx.fillStyle = C.faint;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText(String(g.nodes.length), LABEL_W - 14, y + 3);
        // stack nodes that would overlap, squeezing the stack to fit inside the lane
        const placed: Array<{ x: number; row: number; n: BrainNode }> = [];
        const sorted = [...g.nodes].sort((a, b) => a.createdAt - b.createdAt);
        for (const n of sorted) {
          const xt = X(n.createdAt);
          let row = 0;
          while (placed.some((p) => p.row === row && Math.abs(p.x - xt) < 12)) row++;
          placed.push({ x: xt, row, n });
        }
        const maxRow = Math.max(0, ...placed.map((p) => p.row));
        const gap = Math.min(11, (laneH - 14) / Math.max(1, maxRow));
        for (const { x: xt, row, n } of placed) {
          const yy = y + (row % 2 ? 1 : -1) * Math.ceil(row / 2) * gap;
          const x = x0 + (xt - x0) * (0.6 + 0.4 * intro);
          const r = 2.6 + n.weight * 0.6;
          const hot = live.current.hover?.id === n.id;
          ctx.globalAlpha = intro * (hot ? 1 : 0.9);
          ctx.fillStyle = isToday(n.createdAt) ? C.lime : C.node;
          if (hot) {
            ctx.shadowColor = C.cyan;
            ctx.shadowBlur = 12;
          }
          drawGlyph(ctx, n.kind, x, yy, r);
          ctx.fill();
          ctx.shadowBlur = 0;
          if (hot) {
            ctx.strokeStyle = C.cyan;
            ctx.beginPath();
            ctx.arc(x, yy, r + 5, 0, Math.PI * 2);
            ctx.stroke();
          }
          next.push({ n, x, y: yy });
          where.set(n.id, { x, y: yy });
        }
      });
      ctx.globalAlpha = 1;
      if (showLinks) {
        const hov = live.current.hover;
        for (const s of next)
          for (const l of s.n.links) {
            const t = where.get(l);
            if (!t) continue;
            const lit = hov && (hov.id === s.n.id || hov.id === l);
            ctx.strokeStyle = C.cyan;
            ctx.globalAlpha = (lit ? 0.75 : 0.16) * intro;
            ctx.beginPath();
            ctx.moveTo(s.x, s.y);
            ctx.bezierCurveTo(s.x, (s.y + t.y) / 2, t.x, (s.y + t.y) / 2, t.x, t.y);
            ctx.stroke();
          }
        ctx.globalAlpha = 1;
      }
      screen = next;

      let hit: BrainNode | null = null;
      if (mouse) {
        let best = 10;
        for (const s of screen) {
          const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
          if (d < best) {
            best = d;
            hit = s.n;
          }
        }
      }
      if (hit?.id !== live.current.hover?.id) {
        live.current.hover = hit;
        setHover(hit);
      }
      if (hit && tip.current) {
        const s = screen.find((x) => x.n.id === hit!.id)!;
        tip.current.style.transform = `translate(${Math.min(W - 260, s.x + 12)}px, ${Math.max(6, s.y - 16)}px)`;
      }
      el.style.cursor = hit ? 'pointer' : 'default';
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onLeave = () => (mouse = null);
    const onClick = () => live.current.hover && live.current.onOpen(live.current.hover);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('click', onClick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('click', onClick);
    };
  }, []);

  return (
    <div className="br-clusters" ref={wrap}>
      <canvas ref={canvas} aria-label="Brain timeline" />
      {hover && (
        <div className="br-tip" ref={tip}>
          <div className="br-tip__kind">
            {KIND_LABEL[hover.kind]} · <span className="mono">{stamp(hover.createdAt)}</span>
          </div>
          <div className="br-tip__title">{hover.title}</div>
          {hover.subtitle && <div className="br-tip__sub">{hover.subtitle}</div>}
        </div>
      )}
    </div>
  );
}
