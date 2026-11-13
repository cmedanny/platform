// The reading spider: body + 8 legs (3 segments each) with 2-bone IK.
// Feet plant on real word positions in the document, legs step in an
// alternating tetrapod gait (L1 R2 L3 R4 / R1 L2 R3 L4).

export interface Pt {
  x: number;
  y: number;
}

export type AnchorFn = (p: Pt, radius: number) => Pt | null;

const FEMUR = 17;
const TIBIA = 19;
const TARSUS = 7;

// Per leg (front to back): rest angle from heading (deg), rest radius, hip offset along body.
const LEGS = [
  { ang: 38, rad: 33, hip: 4 },
  { ang: 72, rad: 35, hip: 1.5 },
  { ang: 108, rad: 35, hip: -1.5 },
  { ang: 146, rad: 33, hip: -4 },
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
  x = 80;
  y = 80;
  heading = 0; // radians, 0 = facing right
  private targetHeading = 0;
  private vx = 0;
  private vy = 0;
  private lastX = 80;
  private lastY = 80;
  private turn: 0 | 1 = 0;
  private legs: Leg[] = [];
  moving = 0; // 0..1, smoothed

  constructor(x = 80, y = 80) {
    this.place(x, y);
  }

  /** Teleport, with legs at rest. */
  place(x: number, y: number) {
    this.x = this.lastX = x;
    this.y = this.lastY = y;
    this.legs = [];
    for (const side of [1, -1] as const)
      LEGS.forEach((_, i) => {
        const foot = this.rest(side, i);
        // tetrapod groups: L0 R1 L2 R3 vs R0 L1 R2 L3
        const group = ((i + (side === 1 ? 0 : 1)) % 2) as 0 | 1;
        this.legs.push({ side, i, group, foot, from: foot, to: foot, t0: 0, dur: 0, stepping: false });
      });
  }

  private hip(side: 1 | -1, i: number): Pt {
    const o = rot(LEGS[i].hip, side * 3.2, this.heading);
    return { x: this.x + o.x, y: this.y + o.y };
  }

  private rest(side: 1 | -1, i: number, lead = 0): Pt {
    const a = this.heading + side * (LEGS[i].ang * Math.PI) / 180;
    const h = this.hip(side, i);
    // feet reach a little ahead in the direction of travel (capped so fast moves don't fold the legs)
    let lx = this.vx * lead;
    let ly = this.vy * lead;
    const lm = Math.hypot(lx, ly);
    if (lm > 9) {
      lx *= 9 / lm;
      ly *= 9 / lm;
    }
    return { x: h.x + Math.cos(a) * LEGS[i].rad + lx, y: h.y + Math.sin(a) * LEGS[i].rad + ly };
  }

  /** Point the body toward something (used when reading a token). */
  face(angle: number) {
    this.targetHeading = angle;
  }

  update(dt: number, now: number, speed: number, anchor: AnchorFn | null, reduced: boolean) {
    const sdt = Math.max(dt, 1e-3);
    const nvx = (this.x - this.lastX) / sdt;
    const nvy = (this.y - this.lastY) / sdt;
    this.vx += (nvx - this.vx) * Math.min(1, sdt * 12);
    this.vy += (nvy - this.vy) * Math.min(1, sdt * 12);
    this.lastX = this.x;
    this.lastY = this.y;
    const sp = Math.hypot(this.vx, this.vy);
    this.moving += ((sp > 20 ? 1 : 0) - this.moving) * Math.min(1, sdt * 6);
    // face the reading direction; quick sweeps back to the start of a row don't turn the spider around
    if (sp > 120 && !(this.vx < 0 && Math.abs(this.vx) > Math.abs(this.vy) * 0.6 && sp < 2500)) this.targetHeading = Math.atan2(this.vy, this.vx);
    // ease heading along the shortest arc
    let d = this.targetHeading - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, sdt * (reduced ? 30 : 3.2));

    if (reduced) {
      for (const l of this.legs) l.foot = this.rest(l.side, l.i);
      return;
    }

    const stepDur = Math.max(45, Math.min(120 / Math.sqrt(speed), 120 - Math.min(70, sp / 12)));
    // finish steps
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
    // A foot left out of reach (after a long move) re-plants right away, out of turn.
    const reach = FEMUR + TIBIA + TARSUS;
    for (const l of this.legs) {
      if (l.stepping) continue;
      const h = this.hip(l.side, l.i);
      if (dist(h, l.foot) > reach * 1.02) {
        const ideal = this.rest(l.side, l.i, 0.05);
        l.from = { x: h.x + ((l.foot.x - h.x) / dist(h, l.foot)) * reach, y: h.y + ((l.foot.y - h.y) / dist(h, l.foot)) * reach };
        l.to = anchor?.(ideal, 14) ?? ideal;
        l.t0 = now;
        l.dur = stepDur * 0.7;
        l.stepping = true;
      }
    }
    // The next group may lift once the current one is halfway down (overlapping gait keeps up with fast moves).
    const stepping = this.legs.filter((l) => l.stepping);
    const progress = stepping.length ? Math.min(...stepping.map((l) => (now - l.t0) / l.dur)) : 1;
    const busyGroups = new Set(stepping.map((l) => l.group));
    const threshold = this.moving > 0.3 ? 10 : 16;
    if (progress >= 0.5 && busyGroups.size < 2) {
      for (const g of [this.turn, (1 - this.turn) as 0 | 1]) {
        if (busyGroups.has(g)) continue;
        const group = this.legs.filter((l) => l.group === g);
        const lead = 0.09;
        const needs = group.some((l) => dist(l.foot, this.rest(l.side, l.i, lead)) > threshold);
        if (!needs) continue;
        for (const l of group) {
          const ideal = this.rest(l.side, l.i, lead);
          if (dist(l.foot, ideal) < 3) continue;
          const snapped = anchor?.(ideal, 16) ?? ideal;
          l.from = l.foot;
          l.to = snapped;
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
    const bob = reduced ? 0 : Math.sin(now / 85) * 0.9 * this.moving + Math.sin(now / 900) * 0.4;
    const bx = this.x;
    const by = this.y + bob;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = colors.body;
    ctx.shadowBlur = 7;

    // legs
    for (const l of this.legs) {
      const h = this.hip(l.side, l.i);
      h.y += bob;
      let f = l.foot;
      // never draw a leg longer than it is
      const reach = FEMUR + TIBIA + TARSUS;
      const fd = dist(h, f);
      if (fd > reach) f = { x: h.x + ((f.x - h.x) / fd) * reach, y: h.y + ((f.y - h.y) / fd) * reach };
      if (l.stepping) {
        const t = Math.min(1, (now - l.t0) / l.dur);
        const lift = Math.sin(Math.PI * t) * 3.5;
        f = { x: f.x, y: f.y - lift };
      }
      const toF = { x: f.x - h.x, y: f.y - h.y };
      const len = Math.max(1e-3, Math.hypot(toF.x, toF.y));
      const ux = toF.x / len;
      const uy = toF.y / len;
      // ankle sits a tarsus-length short of the foot, nudged outward for a visible joint
      const out = l.side;
      const nx = -uy * out;
      const ny = ux * out;
      const ankle = { x: f.x - ux * TARSUS + nx * 2.5, y: f.y - uy * TARSUS + ny * 2.5 };
      const d = Math.min(FEMUR + TIBIA - 0.5, Math.max(Math.abs(FEMUR - TIBIA) + 0.5, Math.hypot(ankle.x - h.x, ankle.y - h.y)));
      const base = Math.atan2(ankle.y - h.y, ankle.x - h.x);
      const a = Math.acos((FEMUR * FEMUR + d * d - TIBIA * TIBIA) / (2 * FEMUR * d));
      // bend the knee away from the body (up-and-out, like a real spider seen from above)
      const k1 = { x: h.x + Math.cos(base + a) * FEMUR, y: h.y + Math.sin(base + a) * FEMUR };
      const k2 = { x: h.x + Math.cos(base - a) * FEMUR, y: h.y + Math.sin(base - a) * FEMUR };
      const knee = dist(k1, { x: bx, y: by }) > dist(k2, { x: bx, y: by }) ? k1 : k2;

      ctx.strokeStyle = colors.body;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(h.x, h.y);
      ctx.lineTo(knee.x, knee.y);
      ctx.lineTo(ankle.x, ankle.y);
      ctx.lineWidth = 1.1;
      ctx.lineTo(f.x, f.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.joint;
      dot(ctx, knee.x, knee.y, 1.7);
      dot(ctx, ankle.x, ankle.y, 1.3);
      ctx.fillStyle = colors.foot;
      dot(ctx, f.x, f.y, l.stepping ? 2.1 : 1.6);
    }

    // abdomen, thorax, head (with a soft glow underneath)
    const back = rot(-11, 0, this.heading);
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, 26);
    g.addColorStop(0, 'rgba(111, 227, 234, 0.22)');
    g.addColorStop(1, 'rgba(111, 227, 234, 0)');
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = g;
    ctx.fillRect(bx - 26, by - 26, 52, 52);
    ctx.restore();
    ctx.fillStyle = colors.bg;
    ctx.strokeStyle = colors.body;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(bx + back.x, by + back.y, 9, 6.5, this.heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // abdomen marking
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    const m1 = rot(-15, 0, this.heading);
    const m2 = rot(-7, 0, this.heading);
    ctx.moveTo(bx + m1.x, by + m1.y);
    ctx.lineTo(bx + m2.x, by + m2.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.ellipse(bx, by, 5.2, 4.4, this.heading, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const head = rot(7.5, 0, this.heading);
    ctx.shadowColor = colors.head;
    ctx.shadowBlur = 12;
    ctx.fillStyle = colors.head;
    dot(ctx, bx + head.x, by + head.y, 2.7);
    ctx.restore();
  }

  /** Where the silk thread leaves the body (spinnerets). */
  tail(): Pt {
    const t = rot(-19, 0, this.heading);
    return { x: this.x + t.x, y: this.y + t.y };
  }
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}
