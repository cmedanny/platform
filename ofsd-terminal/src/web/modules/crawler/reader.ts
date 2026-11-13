// Moves the spider slowly down the document on a wandering path and reads
// extracted tokens as its head passes them. It can only go as far as the
// parser has produced and the page has rendered, and it can't get ahead of
// values it hasn't read yet, so the pace stays bound to the real crawl.

import type { DocToken, Tone } from '../../../shared/crawl.ts';
import type { DocLayout } from './layout.ts';
import type { CrawlSession } from './session.ts';
import { Spider, type Pt } from './spider.ts';

export interface Callout {
  tok: DocToken;
  text: string;
  tone: Tone;
  t0: number;
}

// Time spent reading each token (ms at 1x).
const READ_MS: Record<DocToken['kind'], number> = {
  header: 90,
  label: 45,
  date: 50,
  period: 45,
  money: 32,
  number: 32,
  percent: 36,
};
const CALL_HOLD = 420; // pause on a statement line item
const CRUISE = 140; // px/s at 1x
const SCURRY = 2.2; // multiplier across stretches with nothing to read

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;

export class Reader {
  spider = new Spider(300, 200);
  idx = 0;
  cur = -1;
  mode: 'walk' | 'visit' | 'done' = 'walk';
  callouts: Callout[] = [];
  private vx = 0;
  private vy = 0;
  private wp: Pt | null = null;
  private pauseUntil = 0;
  private holdUntil = 0;
  private nextReadAt = 0;
  private waitSince = 0;
  private placed = false;
  private phase = Math.random() * 10;
  private pendingJump: { tok: number; visit: boolean } | null = null;
  private visitTok = -1;
  private visitUntil = 0;
  private resume: { x: number; y: number; idx: number } | null = null;

  constructor(private s: CrawlSession) {}

  calloutText(t: DocToken) {
    let x = t.text;
    if (t.kind === 'money' && !x.includes('$')) x = `$${x}`;
    if (t.kind === 'percent' && !x.includes('%') && !/percent|basis|bps/i.test(x)) x = `${x}%`;
    return x;
  }

  private markRead(t: DocToken, now: number) {
    if (this.s.readAt[t.id] === undefined) {
      this.s.readAt[t.id] = now;
      if (t.v !== undefined) this.s.figuresRead++;
    }
    this.cur = t.id;
    this.s.notify();
  }

  private callout(t: DocToken, now: number) {
    // one at a time: a new callout replaces the old one
    this.callouts = [{ tok: t, text: t.kind === 'header' || t.kind === 'label' ? t.text : this.calloutText(t), tone: t.tone, t0: now }];
  }

  /** Continue reading from a token (Jump to statements). */
  jump(tokenId: number) {
    this.pendingJump = { tok: tokenId, visit: false };
    this.s.readerDone = false;
    if (this.mode === 'done') this.mode = 'walk';
  }

  /** Walk to one token, call it out, then go back to where reading was (report source links). */
  visit(tokenId: number) {
    this.pendingJump = { tok: tokenId, visit: true };
  }

  /** Open an old crawl: everything already read and settled, spider parked. */
  settleAll(layout: DocLayout) {
    for (const t of this.s.tokens)
      if (t && this.s.readAt[t.id] === undefined) {
        this.s.readAt[t.id] = -1e9;
        if (t.v !== undefined) this.s.figuresRead++;
      }
    this.idx = this.s.tokens.length;
    this.mode = 'done';
    this.s.readerDone = true;
    const park = this.s.figures[0]?.token ?? this.s.tokens.length - 1;
    const r = park >= 0 ? layout.rect(park) : null;
    this.fitScale(layout);
    if (r) {
      this.spider.place(r.x + r.w / 2 - 60 * this.spider.scale, r.y - 70 * this.spider.scale);
      this.cur = park;
    }
    this.placed = true;
    this.s.notify();
  }

  private fitScale(layout: DocLayout) {
    const b = layout.bounds();
    this.spider.scale = Math.max(0.55, Math.min(1.05, (b.right - b.left) / 640));
  }

  private doneReading() {
    const total = this.s.parsed?.tokens;
    return this.s.rawDone && total !== undefined && this.idx >= total;
  }

  /** Where unread values are coming up, so the wander leans toward them. */
  private upcomingX(layout: DocLayout, fromY: number, span: number) {
    let sum = 0;
    let n = 0;
    for (let i = this.idx; i < this.s.tokens.length && n < 8; i++) {
      const r = layout.rect(i);
      if (!r) break;
      if (r.y > fromY + span) break;
      sum += r.x + r.w / 2;
      n++;
    }
    return n ? sum / n : null;
  }

  private pickWaypoint(layout: DocLayout, now: number, speed: number) {
    const b = layout.bounds();
    const sp = this.spider;
    const k = sp.scale;
    const margin = 70 * k;
    const dy = rand(130, 280) * k;
    const lean = this.upcomingX(layout, sp.y, 420 * k);
    const randomX = rand(b.left + margin, b.right - margin);
    let x = lean !== null ? lean * 0.55 + randomX * 0.45 : randomX;
    x += randn() * 50 * k;
    x = Math.max(b.left + margin, Math.min(b.right - margin, x));
    // don't walk past what has rendered while the document is still arriving
    const limit = this.s.rawDone ? b.bottom + 120 * k : b.bottom - 140 * k;
    const y = Math.min(sp.y + dy, Math.max(sp.y, limit));
    this.wp = { x, y };
    // real spiders stop and go
    if (Math.random() < 0.18) this.pauseUntil = now + rand(250, 800) / speed;
  }

  step(now: number, dt: number, speed: number, layout: DocLayout, reduced: boolean) {
    const sp = this.spider;
    this.fitScale(layout);
    const k = sp.scale;
    const b = layout.bounds();
    if (!this.placed) {
      sp.place((b.left + b.right) / 2, b.top + 110 * k);
      this.placed = true;
    }
    this.callouts = this.callouts.filter((c) => now - c.t0 < 1300 / Math.max(1, speed * 0.6));

    // ---- jumps and visits: hop near the target, then walk the last bit ----
    if (this.pendingJump) {
      const r = layout.rect(this.pendingJump.tok);
      if (r) {
        const { tok, visit } = this.pendingJump;
        this.pendingJump = null;
        if (visit) {
          if (this.mode !== 'visit') this.resume = this.mode === 'done' ? null : { x: sp.x, y: sp.y, idx: this.idx };
          this.mode = 'visit';
          this.visitTok = tok;
          this.visitUntil = 0;
        } else {
          this.mode = 'walk';
          this.idx = tok;
        }
        sp.place(Math.max(b.left + 80 * k, Math.min(b.right - 80 * k, r.x + r.w / 2 + rand(-60, 60) * k)), r.y - 190 * k);
        this.vx = this.vy = 0;
        this.wp = { x: r.x + r.w / 2 - 30 * k, y: r.y - 50 * k };
        this.pauseUntil = 0;
      }
    }

    if (this.mode === 'visit') {
      if (this.wp && !this.visitUntil && Math.hypot(sp.x - this.wp.x, sp.y - this.wp.y) < 30 * k) {
        const t = this.s.tokens[this.visitTok];
        this.markRead(t, now);
        this.callout(t, now);
        this.visitUntil = now + 1300;
      }
      if (this.visitUntil && now > this.visitUntil) {
        if (this.resume) {
          sp.place(this.resume.x, this.resume.y);
          this.idx = this.resume.idx;
          this.mode = 'walk';
        } else this.mode = 'done';
        this.resume = null;
        this.wp = null;
        this.visitUntil = 0;
      }
      this.move(dt, this.visitUntil ? 0 : 260 * Math.sqrt(speed), now, true);
      if (reduced) sp.place(sp.x, sp.y);
      sp.update(dt, now, speed, reduced ? null : layout.nearestAnchor, reduced);
      return;
    }

    // ---- reading: tokens are read in order once the spider's head reaches them ----
    const readLine = sp.head().y + 40 * k;
    let backlog = 0;
    if (this.mode === 'walk') {
      if (this.nextReadAt < now - 120) this.nextReadAt = now - 120; // no long catch-up bursts
      for (let guard = 0; guard < 40 && now >= this.nextReadAt && now >= this.holdUntil; guard++) {
        const tok = this.s.tokens[this.idx];
        if (!tok) break;
        const r = layout.rect(this.idx);
        if (!r) {
          if (!this.waitSince) this.waitSince = now;
          if (now - this.waitSince > 400) {
            this.waitSince = 0;
            this.idx++;
          }
          break;
        }
        this.waitSince = 0;
        if (r.y > readLine) break;
        this.markRead(tok, now);
        this.idx++;
        this.nextReadAt += READ_MS[tok.kind] / speed;
        if (tok.call) {
          this.callout(tok, now);
          // stop briefly on statement figures; other callouts pop while it keeps walking
          if (tok.f) {
            this.holdUntil = now + CALL_HOLD / speed;
            break;
          }
        }
      }
      // how many values the spider has passed but not read yet
      for (let i = this.idx; i < this.s.tokens.length && backlog < 30; i++) {
        const r = layout.rect(i);
        if (!r || r.y > readLine) break;
        backlog++;
      }
      if (!this.s.tokens[this.idx] && (this.doneReading() || this.s.status === 'error')) {
        this.mode = 'done';
        this.s.readerDone = true;
        this.s.notify();
      }
    }

    // ---- wandering walk down the page ----
    let cruise = 0;
    if (this.mode === 'walk') {
      const next = layout.rect(this.idx);
      const nothingNear = !next || next.y > readLine + 520 * k;
      const factor = Math.max(0, 1 - backlog / 14);
      cruise = CRUISE * speed * factor * (nothingNear && (next || this.s.rawDone) ? SCURRY : 1);
      if (now < this.holdUntil || now < this.pauseUntil) cruise = 0;
      // pick the next waypoint before arriving so the path flows instead of braking at every point
      if (!this.wp || Math.hypot(sp.x - this.wp.x, sp.y - this.wp.y) < 70 * k || this.wp.y < sp.y - 40 * k) this.pickWaypoint(layout, now, speed);
    }
    this.move(dt, cruise, now, false);
    if (reduced) sp.place(sp.x, sp.y);
    sp.update(dt, now, speed, reduced ? null : layout.nearestAnchor, reduced);
  }

  /** Steer toward the waypoint with smooth acceleration and a gentle meander. */
  private move(dt: number, cruise: number, now: number, arriveSlow: boolean) {
    const sp = this.spider;
    let dvx = 0;
    let dvy = 0;
    if (this.wp && cruise > 0) {
      const dx = this.wp.x - sp.x;
      const dy = this.wp.y - sp.y;
      const d = Math.hypot(dx, dy) || 1;
      const arrive = arriveSlow ? Math.min(1, d / (60 * sp.scale)) : 1;
      const c = cruise * (0.35 + 0.65 * arrive);
      dvx = (dx / d) * c;
      dvy = (dy / d) * c;
      // meander perpendicular to the direction of travel
      const sway = Math.sin(now / 900 + this.phase) * 0.28 + Math.sin(now / 2300 + this.phase * 2) * 0.18;
      dvx += (-dy / d) * c * sway;
      dvy += (dx / d) * c * sway;
    }
    const accel = Math.min(1, dt * 2.6);
    this.vx += (dvx - this.vx) * accel;
    this.vy += (dvy - this.vy) * accel;
    sp.x += this.vx * dt;
    sp.y += this.vy * dt;
  }
}
