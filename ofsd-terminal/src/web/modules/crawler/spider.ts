// The reading spider: a large body + 8 long legs (3 segments each).
//
// Gait: an alternating tetrapod (L1 R2 L3 R4 / R1 L2 R3 L4) driven by the
// distance the body actually travels, so every stride matches the movement.
// Each group swings for 40% of the cycle; the rest is stance, with a short
// moment where all eight feet are down. Swinging feet land ahead of their
// rest spot so the body passes over them, and they plant on real words.
//
// Legs: 2-bone IK (femur, tibia+metatarsus) with the knee always bent away
// from the body, then a gentle second bend at the ankle.

export interface Pt {
  x: number;
  y: number;
}

export type AnchorFn = (p: Pt, radius: number) => Pt | null;

// Geometry at scale 1 (about a 250px leg span).
const FEMUR = 58;
const TIBIA = 64;
const TARSUS = 26;
const HIP_SIDE = 8;
const STRIDE = 78; // body travel per full gait cycle
const SWING = 0.4; // fraction of the cycle each group spends in the air

// Per leg (front to back): rest angle from heading (deg), rest radius, hip offset along body.
const LEGS = [
  { ang: 36, rad: 114, hip: 9 },
  { ang: 72, rad: 116, hip: 3 },
  { ang: 112, rad: 112, hip: -3 },
  { ang: 148, rad: 106, hip: -9 },
];

interface Leg {
  side: 1 | -1;
  i: number;
  group: 0 | 1;
  foot: Pt;
  /** swing progress 0..1, or -1 when planted */
  s: number;
  from: Pt;
  snap: Pt; // offset from the ideal landing spot to the nearest real word
  /** time-based settle step (when the body is standing still) */
  timed: boolean;
  /** already stepped in the current swing window */
  stepped: boolean;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const rot = (x: number, y: number, a: number): Pt => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const frac = (v: number) => v - Math.floor(v);

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
  private lastHeading = Math.PI / 2;
  private phase = 0;
  private stillFor = 0;
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
        this.legs.push({ side, i, group, foot, s: -1, from: foot, snap: { x: 0, y: 0 }, timed: false, stepped: false });
      });
  }

  private hip(side: 1 | -1, i: number): Pt {
    const o = rot(LEGS[i].hip * this.scale, side * HIP_SIDE * this.scale, this.heading);
    return { x: this.x + o.x, y: this.y + o.y };
  }

  private rest(side: 1 | -1, i: number): Pt {
    const a = this.heading + side * (LEGS[i].ang * Math.PI) / 180;
    const h = this.hip(side, i);
    const r = LEGS[i].rad * this.scale;
    return { x: h.x + Math.cos(a) * r, y: h.y + Math.sin(a) * r };
  }

  /** Where a swinging foot should land: ahead of rest along the direction of travel. */
  private landing(l: Leg): Pt {
    const r = this.rest(l.side, l.i);
    const sp = Math.hypot(this.vx, this.vy);
    if (sp < 1) return r;
    const ahead = STRIDE * this.scale * (1 - SWING) * 0.5;
    return { x: r.x + (this.vx / sp) * ahead, y: r.y + (this.vy / sp) * ahead };
  }

  /** Front of the head (where silk is shot from). */
  head(): Pt {
    const h = rot(20 * this.scale, 0, this.heading);
    return { x: this.x + h.x, y: this.y + h.y };
  }

  update(dt: number, _now: number, speed: number, anchor: AnchorFn | null, reduced: boolean) {
    const sdt = Math.max(dt, 1e-3);
    const k = this.scale;
    const mx = this.x - this.lastX;
    const my = this.y - this.lastY;
    this.vx += (mx / sdt - this.vx) * Math.min(1, sdt * 8);
    this.vy += (my / sdt - this.vy) * Math.min(1, sdt * 8);
    this.lastX = this.x;
    this.lastY = this.y;
    const sp = Math.hypot(this.vx, this.vy);
    this.moving += ((sp > 10 ? 1 : 0) - this.moving) * Math.min(1, sdt * 4);
    if (sp > 14) this.targetHeading = Math.atan2(this.vy, this.vx);
    let d = this.targetHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, sdt * (reduced ? 30 : 2.2));
    const turned = Math.abs(Math.atan2(Math.sin(this.heading - this.lastHeading), Math.cos(this.heading - this.lastHeading)));
    this.lastHeading = this.heading;

    if (reduced) {
      for (const l of this.legs) l.foot = this.rest(l.side, l.i);
      return;
    }

    // Gait phase advances with distance walked (turning in place counts too).
    const travel = Math.hypot(mx, my) + turned * 60 * k;
    const dPhase = travel / (STRIDE * k);
    this.phase += dPhase;
    this.stillFor = sp < 6 ? this.stillFor + sdt : 0;
    const reach = this.reach;

    for (const l of this.legs) {
      const local = frac(this.phase + l.group * 0.5);
      const inWindow = local < SWING;
      const h = this.hip(l.side, l.i);

      // after a teleport or a very fast hop: put the foot back under the body
      if (dist(h, l.foot) > reach * 1.35) {
        l.foot = this.rest(l.side, l.i);
        l.s = -1;
        continue;
      }

      if (l.s < 0) {
        if (!inWindow) l.stepped = false;
        const wantsStep = inWindow && !l.stepped && this.stillFor === 0;
        if (wantsStep) this.lift(l, anchor, false);
      }
      if (l.s >= 0) {
        // progress: tied to distance while walking, to time when the body has stopped
        const byDist = dPhase / SWING;
        const byTime = l.timed || this.stillFor > 0 ? sdt / Math.max(0.12, 0.2 / Math.sqrt(speed)) : 0;
        l.s = Math.min(1, l.s + Math.max(byDist, byTime));
        const target = this.landing(l);
        const to = { x: target.x + l.snap.x, y: target.y + l.snap.y };
        const e = easeInOut(l.s);
        l.foot = { x: l.from.x + (to.x - l.from.x) * e, y: l.from.y + (to.y - l.from.y) * e };
        if (l.s >= 1) {
          l.s = -1;
          l.stepped = true;
          l.timed = false;
        }
      }
    }

    // Standing still with a foot far from where it belongs (after a turn): settle, one group at a time.
    if (this.stillFor > 0.25 && !this.legs.some((l) => l.s >= 0)) {
      let worst: 0 | 1 | null = null;
      let worstErr = 0.32 * STRIDE * k;
      for (const l of this.legs) {
        const err = dist(l.foot, this.rest(l.side, l.i));
        if (err > worstErr) {
          worstErr = err;
          worst = l.group;
        }
      }
      if (worst !== null) for (const l of this.legs) if (l.group === worst && dist(l.foot, this.rest(l.side, l.i)) > 6 * k) this.lift(l, anchor, true);
    }
  }

  private lift(l: Leg, anchor: AnchorFn | null, timed: boolean) {
    l.s = 0;
    l.from = l.foot;
    l.timed = timed;
    const ideal = this.landing(l);
    const snapped = anchor?.(ideal, 16 * this.scale);
    l.snap = snapped ? { x: snapped.x - ideal.x, y: snapped.y - ideal.y } : { x: 0, y: 0 };
  }

  draw(ctx: CanvasRenderingContext2D, now: number, colors: { body: string; joint: string; foot: string; head: string; bg: string }, reduced: boolean) {
    const k = this.scale;
    // body bobs with the gait: lowest when a group plants
    const gaitBob = Math.cos(this.phase * Math.PI * 4) * 1.4 * k * this.moving;
    const breathe = reduced ? 0 : Math.sin(now / 1100) * 0.7 * k;
    const bx = this.x;
    const by = this.y + (reduced ? 0 : gaitBob) + breathe;
    const reach = this.reach;
    const A = FEMUR * k;
    const BC = (TIBIA + TARSUS) * k;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const g = ctx.createRadialGradient(bx, by, 0, bx, by, 80 * k);
    g.addColorStop(0, 'rgba(111, 227, 234, 0.18)');
    g.addColorStop(1, 'rgba(111, 227, 234, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(bx - 80 * k, by - 80 * k, 160 * k, 160 * k);

    ctx.shadowColor = colors.body;
    ctx.shadowBlur = 10 * k;

    for (const l of this.legs) {
      const h = this.hip(l.side, l.i);
      h.y += by - this.y;
      const lift = l.s >= 0 ? Math.sin(Math.PI * l.s) : 0;
      let f = l.foot;
      // a raised foot looks closer to the body from above
      if (lift) f = { x: f.x + (h.x - f.x) * 0.14 * lift, y: f.y + (h.y - f.y) * 0.14 * lift };
      const fd = dist(h, f);
      if (fd > reach * 0.99) f = { x: h.x + ((f.x - h.x) / fd) * reach * 0.99, y: h.y + ((f.y - h.y) / fd) * reach * 0.99 };

      // knee: 2-bone IK, always bent outward (away from the body's midline)
      const d = Math.min(A + BC - 0.5, Math.max(Math.abs(A - BC) + 0.5, dist(h, f)));
      const base = Math.atan2(f.y - h.y, f.x - h.x);
      const a = Math.acos(Math.max(-1, Math.min(1, (A * A + d * d - BC * BC) / (2 * A * d))));
      const lat = { x: Math.cos(this.heading + (l.side * Math.PI) / 2), y: Math.sin(this.heading + (l.side * Math.PI) / 2) };
      const k1 = { x: h.x + Math.cos(base + a) * A, y: h.y + Math.sin(base + a) * A };
      const k2 = { x: h.x + Math.cos(base - a) * A, y: h.y + Math.sin(base - a) * A };
      const out1 = (k1.x - h.x) * lat.x + (k1.y - h.y) * lat.y;
      const out2 = (k2.x - h.x) * lat.x + (k2.y - h.y) * lat.y;
      const knee = out1 >= out2 ? k1 : k2;
      // ankle: along knee->foot, bulging the same way as the knee so the leg reads as one smooth arc
      const t = TIBIA / (TIBIA + TARSUS);
      const kx = f.x - knee.x;
      const ky = f.y - knee.y;
      const kl = Math.hypot(kx, ky) || 1;
      let nx = -ky / kl;
      let ny = kx / kl;
      if (nx * (knee.x - (h.x + f.x) / 2) + ny * (knee.y - (h.y + f.y) / 2) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const ankle = { x: knee.x + kx * t + nx * 5 * k, y: knee.y + ky * t + ny * 5 * k };

      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = colors.body;
      ctx.lineWidth = (2.5 + lift * 0.6) * k;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.stroke();
      ctx.lineWidth = (2 + lift * 0.4) * k;
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
      dot(ctx, knee.x, knee.y, (3.4 + lift) * k);
      dot(ctx, ankle.x, ankle.y, 2.5 * k);
      ctx.fillStyle = colors.foot;
      ctx.globalAlpha = 1 - lift * 0.35;
      dot(ctx, f.x, f.y, (3 + lift * 1.2) * k);
      ctx.globalAlpha = 1;
    }

    // pedipalps, twitching a little with the gait
    const palp = Math.sin(this.phase * Math.PI * 2) * 2 * k * this.moving;
    for (const side of [1, -1]) {
      const p0 = rot(17 * k, side * 4 * k, this.heading);
      const p1 = rot(27 * k + palp * side, side * 9 * k, this.heading);
      const p2 = rot(33 * k + palp * side, side * 6 * k, this.heading);
      ctx.strokeStyle = colors.body;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.moveTo(bx + p0.x, by + p0.y);
      ctx.lineTo(bx + p1.x, by + p1.y);
      ctx.lineTo(bx + p2.x, by + p2.y);
      ctx.stroke();
    }

    // abdomen (swings slightly opposite the gait), thorax, head
    const sway = Math.sin(this.phase * Math.PI * 2) * 0.06 * this.moving;
    ctx.fillStyle = colors.bg;
    ctx.strokeStyle = colors.body;
    ctx.lineWidth = 2 * k;
    const ah = this.heading + sway;
    const back = rot(-30 * k, 0, ah);
    ctx.beginPath();
    ctx.ellipse(bx + back.x, by + back.y, 24 * k, 17 * k, ah, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1.3 * k;
    for (const off of [-40, -31, -22]) {
      const c = rot(off * k, 0, ah);
      const l1 = rot((off - 5) * k, 7 * k, ah);
      const r1 = rot((off - 5) * k, -7 * k, ah);
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
