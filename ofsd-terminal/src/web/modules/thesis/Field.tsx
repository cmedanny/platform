// Posts stream in as cards, get tagged, then dissolve into particles that
// drift into slowly turning theme clouds. One canvas, no DOM per post.

import { useEffect, useRef } from 'react';
import { THEMES, type Theme, type XPost } from '../../../shared/thesis.ts';
import { useReducedMotion } from '../../lib/motion.ts';

const PER_POST = 22;
const FEED_W = 232;
const CARD_H = 46;
const CARD_GAP = 6;

interface Particle {
  x: number;
  y: number;
  ox: number; // unit-sphere offset
  oy: number;
  oz: number;
  k: number; // drift stiffness
  delay: number;
}

interface PostState {
  ref: string;
  arrived: number;
  theme: Theme | null;
  taggedAt: number;
  parts: Particle[];
  card: { x: number; y: number } | null;
}

export interface FieldProps {
  posts: XPost[];
  /** ref -> theme as known so far */
  themeOf: (ref: string) => Theme | undefined;
  arrived?: Map<string, number>;
  /** refs cited anywhere in the draft */
  cited: Set<string>;
  /** refs of the point being written or hovered */
  active: Set<string>;
  /** open already settled (no fly-in) */
  settled?: boolean;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, lines: number) {
  const words = text.replace(/\s+/g, ' ').split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > width) {
      out.push(cur);
      cur = w;
      if (out.length === lines) break;
    } else cur = next;
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, '…');
  return out;
}

export function Field(props: FieldProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrapEl = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  useEffect(() => {
    const cv = canvas.current!;
    const el = wrapEl.current!;
    const ctx = cv.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const C = {
      dot: css.getPropertyValue('--text-dim').trim(),
      faint: css.getPropertyValue('--text-faint').trim(),
      lime: css.getPropertyValue('--lime').trim(),
      cyan: css.getPropertyValue('--cyan').trim(),
      text: css.getPropertyValue('--text').trim(),
      panel: css.getPropertyValue('--panel-2').trim(),
      border: css.getPropertyValue('--border-strong').trim(),
    };
    const states = new Map<string, PostState>();
    let W = 0;
    let H = 0;
    let raf = 0;
    let last = performance.now();
    const firstSettled = !!propsRef.current.settled;

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

    const centers = (rail: boolean) => {
      const left = rail ? FEED_W + 30 : 20;
      const cx = left + (W - left) / 2;
      const cy = H * 0.52;
      const rx = Math.max(90, (W - left) * 0.34);
      const ry = Math.max(70, H * 0.3);
      return THEMES.map((_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / THEMES.length;
        return { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
      });
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const p = propsRef.current;
      const red = reducedRef.current;

      // sync post states
      for (const post of p.posts) {
        let st = states.get(post.ref);
        if (!st) {
          const arrived = p.arrived?.get(post.ref) ?? (firstSettled ? -1e9 : now);
          st = { ref: post.ref, arrived, theme: null, taggedAt: 0, card: null, parts: [] };
          for (let i = 0; i < PER_POST; i++) {
            // random point in a unit sphere
            let x = 0;
            let y = 0;
            let z = 0;
            do {
              x = Math.random() * 2 - 1;
              y = Math.random() * 2 - 1;
              z = Math.random() * 2 - 1;
            } while (x * x + y * y + z * z > 1);
            st.parts.push({ x: 0, y: 0, ox: x, oy: y, oz: z, k: 1.6 + Math.random() * 1.6, delay: Math.random() * 380 });
          }
          states.set(post.ref, st);
        }
        const th = p.themeOf(post.ref) ?? null;
        if (th && !st.theme) {
          st.theme = th;
          st.taggedAt = firstSettled && p.settled ? -1e9 : now;
        }
      }

      const counts = new Map<Theme, number>();
      for (const st of states.values()) if (st.theme) counts.set(st.theme, (counts.get(st.theme) ?? 0) + 1);
      const untagged = [...states.values()].filter((s) => !s.theme).sort((a, b) => b.arrived - a.arrived);
      const rail = untagged.length > 0;
      const cs = centers(rail);
      const slots = Math.max(1, Math.floor((H - 60) / (CARD_H + CARD_GAP)));
      const rotA = red ? 0.5 : now * 0.00012;

      ctx.clearRect(0, 0, W, H);

      // feed rail (only while there are untagged posts)
      if (rail) {
        ctx.fillStyle = 'rgba(255,255,255,0.015)';
        ctx.fillRect(0, 0, FEED_W + 16, H);
        ctx.font = "500 9.5px 'Inter', sans-serif";
        ctx.fillStyle = C.faint;
        ctx.fillText(`INCOMING · ${untagged.length}`, 14, 18);
      }

      // cluster labels
      THEMES.forEach((t, i) => {
        const n = counts.get(t) ?? 0;
        const c = cs[i];
        const r = 20 + 9 * Math.sqrt(n);
        ctx.font = "500 9.5px 'Inter', sans-serif";
        ctx.fillStyle = n ? C.cyan : C.faint;
        ctx.globalAlpha = n ? 0.9 : 0.45;
        const label = `${t.toUpperCase()} · ${n}`;
        ctx.fillText(label, c.x - ctx.measureText(label).width / 2, c.y + r + 18);
        ctx.globalAlpha = 1;
      });

      // particles
      const waitC = { x: FEED_W / 2 + 6, y: H - 34 };
      for (const st of states.values()) {
        const isCited = p.cited.has(st.ref);
        const isActive = p.active.has(st.ref);
        const ti = st.theme ? THEMES.indexOf(st.theme) : -1;
        const cardIdx = st.theme ? -1 : untagged.indexOf(st);
        const asCard = !st.theme && cardIdx < slots;
        // card stack position (newest on top), sliding as new ones arrive
        const cardTarget = { x: 14, y: 30 + Math.max(0, cardIdx) * (CARD_H + CARD_GAP) };
        if (!st.card) st.card = { x: 14, y: cardTarget.y - 30 };
        st.card.x += (cardTarget.x - st.card.x) * Math.min(1, dt * 8);
        st.card.y += (cardTarget.y - st.card.y) * Math.min(1, dt * 8);

        const n = ti >= 0 ? counts.get(st.theme!) ?? 1 : 1;
        const R = ti >= 0 ? 20 + 9 * Math.sqrt(n) : 22;
        const c = ti >= 0 ? cs[ti] : waitC;
        const spin = rotA + ti * 0.9;
        const cos = Math.cos(spin);
        const sin = Math.sin(spin);
        for (const q of st.parts) {
          // rotate the offset around the vertical axis, slight tilt, project
          const rx = q.ox * cos - q.oz * sin;
          const rz = q.ox * sin + q.oz * cos;
          const ry = q.oy * 0.92 + rz * 0.12;
          const tx = c.x + rx * R;
          const ty = c.y + ry * R;
          if (q.x === 0 && q.y === 0) {
            if (asCard || (firstSettled && p.settled)) {
              q.x = asCard ? st.card.x + 20 + Math.random() * 180 : tx;
              q.y = asCard ? st.card.y + 10 + Math.random() * 26 : ty;
            } else {
              q.x = waitC.x + (Math.random() - 0.5) * 40;
              q.y = waitC.y + (Math.random() - 0.5) * 20;
            }
          }
          if (asCard) {
            // particles hide inside the card until it's tagged
            q.x = st.card.x + 20 + (q.ox + 1) * 90;
            q.y = st.card.y + 10 + (q.oy + 1) * 13;
            continue;
          }
          const since = now - st.taggedAt - q.delay;
          if (since < 0 && st.theme) continue;
          const kk = red ? 1 : 1 - Math.exp(-dt * q.k);
          q.x += (tx - q.x) * kk;
          q.y += (ty - q.y) * kk;
          const depth = (rz + 1) / 2;
          let a = 0.25 + depth * 0.55;
          let size = 1.1 + depth * 0.9;
          let col = C.dot;
          if (isCited) {
            col = C.lime;
            a = Math.max(a, 0.55);
          }
          if (isActive) {
            col = C.lime;
            a = 1;
            size += 1;
          }
          ctx.globalAlpha = a;
          ctx.fillStyle = col;
          ctx.fillRect(q.x - size / 2, q.y - size / 2, size, size);
        }
      }
      ctx.globalAlpha = 1;

      // cards
      ctx.textBaseline = 'top';
      for (const st of untagged.slice(0, slots)) {
        const post = p.posts.find((x) => x.ref === st.ref);
        if (!post || !st.card) continue;
        const age = now - st.arrived;
        const a = red ? 1 : Math.min(1, age / 220);
        ctx.globalAlpha = a;
        ctx.fillStyle = C.panel;
        ctx.strokeStyle = C.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(st.card.x, st.card.y, FEED_W - 12, CARD_H, 3);
        ctx.fill();
        ctx.stroke();
        ctx.font = "500 10px 'JetBrains Mono', monospace";
        ctx.fillStyle = C.cyan;
        ctx.fillText(`@${post.handle}`, st.card.x + 8, st.card.y + 6);
        if (post.tags.length) {
          ctx.font = "9px 'Inter', sans-serif";
          ctx.fillStyle = C.faint;
          const tg = post.tags.join(' · ');
          ctx.fillText(tg, st.card.x + FEED_W - 20 - ctx.measureText(tg).width, st.card.y + 7);
        }
        ctx.font = "10.5px 'Inter', sans-serif";
        ctx.fillStyle = C.text;
        wrap(ctx, post.text, FEED_W - 28, 2).forEach((line, i) => ctx.fillText(line, st.card!.x + 8, st.card!.y + 19 + i * 12.5));
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <div className="field" ref={wrapEl}>
      <canvas ref={canvas} aria-label="Posts clustering into themes" />
    </div>
  );
}
