// Clusters view: each group is a slowly turning sphere of dust with its nodes
// set into it. Drag to turn, hover for details, click to open.

import { useEffect, useRef, useState } from 'react';
import type { BrainNode } from '../../../shared/brain.ts';
import { stamp } from '../../lib/format.ts';
import { useReducedMotion } from '../../lib/motion.ts';
import { drawGlyph, isToday, KIND_LABEL, type Group } from './model.ts';

interface Props {
  groups: Group[];
  links: boolean;
  onOpen: (n: BrainNode) => void;
}

interface Sphere {
  key: string;
  dust: Array<[number, number, number]>;
  spots: Map<string, [number, number, number]>;
  spin: number;
}

function sphereDust(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    // mostly near the surface, some inside: a fluffy shell
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = 0.55 + Math.pow(Math.random(), 0.35) * 0.45;
    const s = Math.sqrt(1 - u * u);
    out.push([Math.cos(a) * s * r, u * r, Math.sin(a) * s * r]);
  }
  return out;
}

function fib(i: number, n: number): [number, number, number] {
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.39996;
  const k = 0.72;
  return [Math.cos(a) * r * k, y * k, Math.sin(a) * r * k];
}

export function Clusters({ groups, links, onOpen }: Props) {
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
      dust: css.getPropertyValue('--text-dim').trim(),
      node: css.getPropertyValue('--text-bright').trim(),
      lime: css.getPropertyValue('--lime').trim(),
      cyan: css.getPropertyValue('--cyan').trim(),
      faint: css.getPropertyValue('--text-faint').trim(),
      bg: css.getPropertyValue('--bg').trim(),
    };
    const spheres = new Map<string, Sphere>();
    let W = 0;
    let H = 0;
    let drag = 0;
    let dragging: { x: number; moved: boolean } | null = null;
    let mouse: { x: number; y: number } | null = null;
    let screen: Array<{ n: BrainNode; x: number; y: number; r: number }> = [];
    let raf = 0;

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

    const layout = (gs: Group[]) => {
      const n = gs.length;
      const radii = gs.map((g) => 30 + 12 * Math.sqrt(g.nodes.length));
      if (n === 1) return [{ x: W / 2, y: H / 2, R: Math.min(radii[0] * 1.6, Math.min(W, H) * 0.32) }];
      // biggest in the middle when there are many, the rest on a ring
      const center = n > 4;
      const ringN = center ? n - 1 : n;
      const rx = W * (center ? 0.36 : 0.3);
      const ry = H * (center ? 0.33 : 0.27);
      const out = gs.map((_, i) => {
        if (center && i === 0) return { x: W / 2, y: H / 2, R: radii[0] };
        const k = center ? i - 1 : i;
        const a = -Math.PI / 2 + (k * Math.PI * 2) / ringN;
        return { x: W / 2 + Math.cos(a) * rx, y: H / 2 + Math.sin(a) * ry, R: radii[i] };
      });
      // keep spheres from overlapping on small screens
      const maxR = Math.min(W, H) / (n > 4 ? 6.5 : 5);
      return out.map((o) => ({ ...o, R: Math.min(o.R, maxR) }));
    };

    const frame = (now: number) => {
      const { groups: gs, links: showLinks, reduced: red } = live.current;
      ctx.clearRect(0, 0, W, H);
      const pos = layout(gs);
      const nextScreen: typeof screen = [];
      const where = new Map<string, { x: number; y: number }>();

      gs.forEach((g, gi) => {
        let sp = spheres.get(g.key);
        if (!sp) {
          sp = { key: g.key, dust: sphereDust(Math.min(900, 140 + g.nodes.length * 40)), spots: new Map(), spin: Math.random() * 6 };
          spheres.set(g.key, sp);
        }
        g.nodes.forEach((n, i) => {
          if (!sp!.spots.has(n.id)) sp!.spots.set(n.id, fib(i, Math.max(g.nodes.length, 2)));
        });
        const { x: cx, y: cy, R } = pos[gi];
        const a = sp.spin + drag + (red ? 0 : now * 0.00008);
        const cos = Math.cos(a);
        const sin = Math.sin(a);
        const tilt = 0.32;
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const proj = (p: [number, number, number]) => {
          const x = p[0] * cos - p[2] * sin;
          const z0 = p[0] * sin + p[2] * cos;
          const y = p[1] * ct - z0 * st;
          const z = p[1] * st + z0 * ct;
          return { x: cx + x * R, y: cy + y * R, z };
        };
        // dust
        ctx.fillStyle = C.dust;
        for (const d of sp.dust) {
          const p = proj(d);
          ctx.globalAlpha = 0.12 + (p.z + 1) * 0.22;
          const s = 0.8 + (p.z + 1) * 0.45;
          ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        }
        ctx.globalAlpha = 1;
        // nodes, back to front
        const placed = g.nodes.map((n) => ({ n, p: proj(sp!.spots.get(n.id)!) })).sort((x, y) => x.p.z - y.p.z);
        for (const { n, p } of placed) {
          const r = 2.2 + n.weight * 0.7 + (p.z + 1) * 0.6;
          const hot = live.current.hover?.id === n.id;
          ctx.globalAlpha = 0.45 + (p.z + 1) * 0.27;
          ctx.fillStyle = isToday(n.createdAt) ? C.lime : C.node;
          if (hot) {
            ctx.globalAlpha = 1;
            ctx.shadowColor = C.cyan;
            ctx.shadowBlur = 12;
          }
          drawGlyph(ctx, n.kind, p.x, p.y, r);
          ctx.fill();
          ctx.shadowBlur = 0;
          if (hot) {
            ctx.strokeStyle = C.cyan;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
            ctx.stroke();
          }
          nextScreen.push({ n, x: p.x, y: p.y, r: r + 4 });
          where.set(n.id, { x: p.x, y: p.y });
        }
        ctx.globalAlpha = 1;
        // label
        ctx.font = "500 9.5px 'Inter', sans-serif";
        ctx.fillStyle = C.cyan;
        const label = `${g.label.toUpperCase()} · ${g.nodes.length}`;
        ctx.fillText(label, cx - ctx.measureText(label).width / 2, cy + R + 22);
      });

      // links
      if (showLinks) {
        const hov = live.current.hover;
        for (const s of nextScreen) {
          for (const l of s.n.links) {
            const t = where.get(l);
            if (!t) continue;
            const lit = hov && (hov.id === s.n.id || hov.id === l);
            ctx.strokeStyle = C.cyan;
            ctx.globalAlpha = lit ? 0.75 : 0.14;
            ctx.lineWidth = lit ? 1.2 : 0.8;
            ctx.beginPath();
            const mx = (s.x + t.x) / 2;
            const my = (s.y + t.y) / 2 - Math.min(60, Math.hypot(t.x - s.x, t.y - s.y) * 0.15);
            ctx.moveTo(s.x, s.y);
            ctx.quadraticCurveTo(mx, my, t.x, t.y);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      screen = nextScreen;

      // hover hit test (front-most first)
      let hit: BrainNode | null = null;
      if (mouse && !dragging) {
        let best = 14;
        for (let i = screen.length - 1; i >= 0; i--) {
          const s = screen[i];
          const d = Math.hypot(s.x - mouse.x, s.y - mouse.y);
          if (d < Math.max(best, s.r) && d < best + 4) {
            best = d;
            hit = s.n;
          }
        }
      }
      if (hit?.id !== live.current.hover?.id) {
        live.current.hover = hit;
        setHover(hit);
      }
      if (hit && tip.current && mouse) {
        const s = screen.find((x) => x.n.id === hit!.id)!;
        tip.current.style.transform = `translate(${Math.min(W - 260, s.x + 14)}px, ${Math.max(6, s.y - 18)}px)`;
      }
      el.style.cursor = dragging?.moved ? 'grabbing' : hit ? 'pointer' : 'grab';
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      mouse = local(e);
      if (dragging) {
        const dx = e.clientX - dragging.x;
        if (Math.abs(dx) > 2) dragging.moved = true;
        drag += dx * 0.008;
        dragging.x = e.clientX;
      }
    };
    const onDown = (e: PointerEvent) => {
      dragging = { x: e.clientX, moved: false };
      el.setPointerCapture(e.pointerId);
    };
    const onUp = () => {
      const wasDrag = dragging?.moved;
      dragging = null;
      if (!wasDrag && live.current.hover) live.current.onOpen(live.current.hover);
    };
    const onLeave = () => (mouse = null);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <div className="br-clusters" ref={wrap}>
      <canvas ref={canvas} aria-label="Brain clusters" />
      {hover && (
        <div className="br-tip" ref={tip}>
          <div className="br-tip__kind">
            {KIND_LABEL[hover.kind]} · <span className="mono">{stamp(hover.createdAt)}</span>
          </div>
          <div className="br-tip__title">{hover.title}</div>
          {hover.subtitle && <div className="br-tip__sub">{hover.subtitle}</div>}
          {(hover.tickers.length > 0 || hover.themes.length > 0) && (
            <div className="br-tip__tags mono">{[...hover.tickers.map((t) => `$${t}`), ...hover.themes.map((t) => `#${t}`)].join('  ')}</div>
          )}
        </div>
      )}
    </div>
  );
}
