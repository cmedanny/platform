// The reading spider: a large body + 8 long legs (3 segments each) with 2-bone IK.
// Feet plant on real word positions in the document and step in an
// alternating tetrapod gait (L1 R2 L3 R4 / R1 L2 R3 L4).

export interface Pt {
  x: number;
  y: number;
}

export type AnchorFn = (p: Pt, radius: number) => Pt | null;

// Geometry at scale 1 (about a 250px leg span).
const FEMUR = 58;
const TIBIA = 66;
const TARSUS = 22;
const HIP_SIDE = 8;

// Per leg (front to back): rest angle from heading (deg), rest radius, hip offset along body.
const LEGS = [
  { ang: 34, rad: 120, hip: 9 },
  { ang: 70, rad: 124, hip: 3 },
  { ang: 112, rad: 120, hip: -3 },
  { ang: 150, rad: 112, hip: -9 },
];

interface Leg {
  side: 1 | -1;
  i: number;
  group: 0 | 1;
  foot: Pt;
  from: Pt;
  to: Pt;
  t0: number;
  dur: number;
  stepping: boolean;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const rot = (x: number, y: number, a: number): Pt => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export class Spider {
  x = 0;
  y = 0;
  heading = Math.PI / 2; // facing down the page
  scale = 1;
  private targetHeading = Math.PI / 2;
  private vx = 0;
  private vy = 0;
  private lastX = 0;
  private lastY = 0;
  private turn: 0 | 1 = 0;
  private legs: Leg[] = [];
  moving = 0; // 0..1, smoothed

  constructor(x = 200, y = 200) {
    this.place(x, y);
  }

  get reach() {
    return (FEMUR + TIBIA + TARSUS) * this.scale;
  }

  /** Teleport, with legs at rest. */
  place(x: number, y: number) {
    this.x = this.lastX = x;
    this.y = this.lastY = y;
    this.vx = this.vy = 0;
    this.legs = [];
    for (const side of [1, -1] as const)
      LEGS.forEach((_, i) => {
        const foot = this.rest(side, i);
        const group = ((i + (side === 1 ? 0 : 1)) % 2) as 0 | 1;
        this.legs.push({ side, i, group, foot, from: foot, to: foot, t0: 0, dur: 0, stepping: false });
      });
  }

  private hip(side: 1 | -1, i: number): Pt {
    const o = rot(LEGS[i].hip * this.scale, side * HIP_SIDE * this.scale, this.heading);
    return { x: this.x + o.x, y: this.y + o.y };
  }

  private rest(side: 1 | -1, i: number, lead = 0): Pt {
    const a = this.heading + side * (LEGS[i].ang * Math.PI) / 180;
    const h = this.hip(side, i);
    // feet reach a little ahead in the direction of travel
    let lx = this.vx * lead;
    let ly = this.vy * lead;
    const lm = Math.hypot(lx, ly);
    const cap = 22 * this.scale;
    if (lm > cap) {
      lx *= cap / lm;
      ly *= cap / lm;
    }
    const r = LEGS[i].rad * this.scale;
    return { x: h.x + Math.cos(a) * r + lx, y: h.y + Math.sin(a) * r + ly };
  }

  /** Front of the head (where the silk is drawn from). */
  head(): Pt {
    const h = rot(20 * this.scale, 0, this.heading);
    return { x: this.x + h.x, y: this.y + h.y };
  }

  update(dt: number, now: number, speed: number, anchor: AnchorFn | null, reduced: boolean) {
    const sdt = Math.max(dt, 1e-3);
    const nvx = (this.x - this.lastX) / sdt;
    const nvy = (this.y - this.lastY) / sdt;
    this.vx += (nvx - this.vx) * Math.min(1, sdt * 8);
    this.vy += (nvy - this.vy) * Math.min(1, sdt * 8);
    this.lastX = this.x;
    this.lastY = this.y;
    const sp = Math.hypot(this.vx, this.vy);
    this.moving += ((sp > 12 ? 1 : 0) - this.moving) * Math.min(1, sdt * 4);
    if (sp > 14) this.targetHeading = Math.atan2(this.vy, this.vx);
    let d = this.targetHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, sdt * (reduced ? 30 : 2.4));

    if (reduced) {
      for (const l of this.legs) l.foot = this.rest(l.side, l.i);
      return;
    }

    const reach = this.reach;
    const stepDur = Math.max(110, Math.min(260, 250 / Math.sqrt(speed)) - Math.min(90, sp / 4));
    for (const l of this.legs) {
      if (!l.stepping) continue;
      const t = Math.min(1, (now - l.t0) / l.dur);
      const e = ease(t);
      l.foot = { x: l.from.x + (l.to.x - l.from.x) * e, y: l.from.y + (l.to.y - l.from.y) * e };
      if (t >= 1) {
        l.stepping = false;
        l.foot = l.to;
      }
    }
    // A foot left out of reach (after a teleport or quick turn) re-plants out of turn.
    for (const l of this.legs) {
      if (l.stepping) continue;
      const h = this.hip(l.side, l.i);
      const fd = dist(h, l.foot);
      if (fd > reach * 1.02) {
        const ideal = this.rest(l.side, l.i, 0.15);
        l.from = { x: h.x + ((l.foot.x - h.x) / fd) * reach, y: h.y + ((l.foot.y - h.y) / fd) * reach };
        l.to = anchor?.(ideal, 40 * this.scale) ?? ideal;
        l.t0 = now;
        l.dur = stepDur * 0.7;
        l.stepping = true;
      }
    }
    // Tetrapod gait: the next group may lift once the current one is halfway down.
    const stepping = this.legs.filter((l) => l.stepping);
    const progress = stepping.length ? Math.min(...stepping.map((l) => (now - l.t0) / l.dur)) : 1;
    const busy = new Set(stepping.map((l) => l.group));
    const threshold = (this.moving > 0.3 ? 30 : 46) * this.scale;
    if (progress >= 0.5 && busy.size < 2) {
      for (const g of [this.turn, (1 - this.turn) as 0 | 1]) {
        if (busy.has(g)) continue;
        const group = this.legs.filter((l) => l.group === g);
        const lead = 0.35;
        if (!group.some((l) => dist(l.foot, this.rest(l.side, l.i, lead)) > threshold)) continue;
        for (const l of group) {
          const ideal = this.rest(l.side, l.i, lead);
          if (dist(l.foot, ideal) < 6 * this.scale) continue;
          l.from = l.foot;
          l.to = anchor?.(ideal, 40 * this.scale) ?? ideal;
          l.t0 = now;
          l.dur = stepDur;
          l.stepping = true;
        }
        this.turn = (1 - g) as 0 | 1;
        break;
      }
    }
  }

  draw(ctx: CanvasRenderingContext2D, now: number, colors: { body: string; joint: string; foot: string; head: string; bg: string }, reduced: boolean) {
    const k = this.scale;
    const bob = reduced ? 0 : Math.sin(now / 140) * 1.6 * k * this.moving + Math.sin(now / 1100) * 0.8 * k;
    const bx = this.x;
    const by = this.y + bob;
    const reach = this.reach;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // soft glow under the body
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, 80 * k);
    g.addColorStop(0, 'rgba(111, 227, 234, 0.18)');
    g.addColorStop(1, 'rgba(111, 227, 234, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(bx - 80 * k, by - 80 * k, 160 * k, 160 * k);

    ctx.shadowColor = colors.body;
    ctx.shadowBlur = 10 * k;

    for (const l of this.legs) {
      const h = this.hip(l.side, l.i);
      h.y += bob;
      let f = l.foot;
      const fd = dist(h, f);
      if (fd > reach) f = { x: h.x + ((f.x - h.x) / fd) * reach, y: h.y + ((f.y - h.y) / fd) * reach };
      let lift = 0;
      if (l.stepping) lift = Math.sin(Math.PI * Math.min(1, (now - l.t0) / l.dur));
      // lifted feet tuck slightly toward the body (seen from above)
      if (lift) f = { x: f.x + (h.x - f.x) * 0.08 * lift, y: f.y + (h.y - f.y) * 0.08 * lift - 6 * k * lift };
      const len = Math.max(1e-3, dist(h, f));
      const ux = (f.x - h.x) / len;
      const uy = (f.y - h.y) / len;
      const nx = -uy * l.side;
      const ny = ux * l.side;
      const ankle = { x: f.x - ux * TARSUS * k + nx * 6 * k, y: f.y - uy * TARSUS * k + ny * 6 * k };
      const A = FEMUR * k;
      const B = TIBIA * k;
      const d = Math.min(A + B - 0.5, Math.max(Math.abs(A - B) + 0.5, dist(h, ankle)));
      const base = Math.atan2(ankle.y - h.y, ankle.x - h.x);
      const a = Math.acos((A * A + d * d - B * B) / (2 * A * d));
      const k1 = { x: h.x + Math.cos(base + a) * A, y: h.y + Math.sin(base + a) * A };
      const k2 = { x: h.x + Math.cos(base - a) * A, y: h.y + Math.sin(base - a) * A };
      // knee bends away from the body, like a real spider seen from above
      const knee = dist(k1, { x: bx, y: by }) > dist(k2, { x: bx, y: by }) ? k1 : k2;

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = colors.body;
      ctx.lineWidth = 2.4 * k;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.stroke();
      ctx.lineWidth = 1.9 * k;
      ctx.beginPath();
      ctx.moveTo(knee.x, knee.y);
      ctx.lineTo(ankle.x, ankle.y);
      ctx.stroke();
      ctx.lineWidth = 1.4 * k;
      ctx.beginPath();
      ctx.moveTo(ankle.x, ankle.y);
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.joint;
      dot(ctx, knee.x, knee.y, 3.4 * k);
      dot(ctx, ankle.x, ankle.y, 2.6 * k);
      ctx.fillStyle = colors.foot;
      dot(ctx, f.x, f.y, (3 + lift * 1.4) * k);
    }

    // pedipalps
    for (const side of [1, -1]) {
      const p0 = rot(17 * k, side * 4 * k, this.heading);
      const p1 = rot(27 * k, side * 9 * k, this.heading);
      const p2 = rot(33 * k, side * 6 * k, this.heading);
      ctx.strokeStyle = colors.body;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(bx + p0.x, by + p0.y);
      ctx.lineTo(bx + p1.x, by + p1.y);
      ctx.lineTo(bx + p2.x, by + p2.y);
      ctx.stroke();
    }

    // abdomen, thorax, head
    ctx.fillStyle = colors.bg;
    ctx.strokeStyle = colors.body;
    ctx.lineWidth = 2 * k;
    const back = rot(-30 * k, 0, this.heading);
    ctx.beginPath();
    ctx.ellipse(bx + back.x, by + back.y, 24 * k, 17 * k, this.heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // abdomen chevrons
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.3 * k;
    for (const off of [-40, -31, -22]) {
      const c = rot(off * k, 0, this.heading);
      const l1 = rot((off - 5) * k, 7 * k, this.heading);
      const r1 = rot((off - 5) * k, -7 * k, this.heading);
      ctx.beginPath();
      ctx.moveTo(bx + l1.x, by + l1.y);
      ctx.lineTo(bx + c.x, by + c.y);
      ctx.lineTo(bx + r1.x, by + r1.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.ellipse(bx, by, 14 * k, 11.5 * k, this.heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const head = rot(15 * k, 0, this.heading);
    ctx.shadowColor = colors.head;
    ctx.shadowBlur = 18 * k;
    ctx.fillStyle = colors.head;
    dot(ctx, bx + head.x, by + head.y, 5.5 * k);
    ctx.restore();
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
