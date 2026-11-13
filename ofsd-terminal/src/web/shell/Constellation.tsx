import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../lib/motion.ts';

/** Small slow-turning node sphere for the sidebar. One canvas, no DOM nodes per point. */
export function Constellation() {
  const ref = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    const N = 72;
    const pts = Array.from({ length: N }, (_, i) => {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const a = i * 2.39996;
      const j = 0.82 + ((i * 37) % 11) / 40; // slight irregularity
      return { x: Math.cos(a) * r * j, y: y * j, z: Math.sin(a) * r * j, c: i === 29 ? 'lime' : i === 9 || i === 52 ? 'magenta' : '' };
    });
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < N; i++)
      for (let k = i + 1; k < N; k++) {
        const d = Math.hypot(pts[i].x - pts[k].x, pts[i].y - pts[k].y, pts[i].z - pts[k].z);
        if (d < 0.42) edges.push([i, k]);
      }

    const css = getComputedStyle(document.documentElement);
    const col = {
      lime: css.getPropertyValue('--lime').trim(),
      magenta: css.getPropertyValue('--magenta').trim(),
      dim: css.getPropertyValue('--text-dim').trim(),
    };
    const R = Math.min(W, H) * 0.4;
    let raf = 0;
    let last = performance.now();
    let angle = 0.6;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const tilt = 0.35;
      const proj = pts.map((p) => {
        const x = p.x * cos - p.z * sin;
        const z0 = p.x * sin + p.z * cos;
        const y = p.y * Math.cos(tilt) - z0 * Math.sin(tilt);
        const z = p.y * Math.sin(tilt) + z0 * Math.cos(tilt);
        const s = 1 / (1.9 - z * 0.45);
        return { x: W / 2 + x * R * s * 2, y: H / 2 + y * R * s * 2, z, c: p.c };
      });
      ctx.lineWidth = 0.6;
      for (const [a, b] of edges) {
        const depth = (proj[a].z + proj[b].z) / 2;
        ctx.strokeStyle = `rgba(160, 175, 205, ${0.05 + (depth + 1) * 0.07})`;
        ctx.beginPath();
        ctx.moveTo(proj[a].x, proj[a].y);
        ctx.lineTo(proj[b].x, proj[b].y);
        ctx.stroke();
      }
      for (const p of proj) {
        const alpha = 0.3 + (p.z + 1) * 0.35;
        ctx.globalAlpha = p.c ? Math.max(alpha, 0.75) : alpha;
        ctx.fillStyle = p.c === 'lime' ? col.lime : p.c === 'magenta' ? col.magenta : col.dim;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.c ? 1.8 : 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      angle += ((now - last) / 1000) * 0.07; // very slow
      last = now;
      draw();
      raf = requestAnimationFrame(tick);
    };
    if (reduced) draw();
    else raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  return <canvas ref={ref} className="constellation" aria-hidden />;
}
