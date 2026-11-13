// Walks the spider through the extracted tokens in document order.
// It can only read what the parser has actually produced and the page has
// actually rendered, so the pace is bound to the real crawl.

import type { DocToken, Tone } from '../../../shared/crawl.ts';
import type { DocLayout, Rect } from './layout.ts';
import type { CrawlSession } from './session.ts';
import { Spider, type Pt } from './spider.ts';

export interface Callout {
  tok: DocToken;
  text: string;
  tone: Tone;
  t0: number;
}

const DWELL: Record<DocToken['kind'], number> = {
  header: 130,
  label: 45,
  date: 90,
  period: 70,
  money: 22,
  number: 22,
  percent: 26,
};
const CALL_DWELL = 210;

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class Reader {
  spider = new Spider(70, 30);
  idx = 0;
  cur = -1;
  mode: 'wait' | 'move' | 'dwell' | 'done' = 'wait';
  private from: Pt = { x: 70, y: 30 };
  private to: Pt = { x: 70, y: 30 };
  private t0 = 0;
  private dur = 0;
  private until = 0;
  private visitTok: number | null = null;
  private waitSince = 0;
  private clock = 0;
  private placed = false;
  callouts: Callout[] = [];

  constructor(private s: CrawlSession) {}

  static target(r: Rect): Pt {
    // sit just below the token so the text stays readable
    return { x: r.x + Math.min(r.w, 120) / 2, y: r.y + r.h + 22 };
  }

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
    this.s.notify();
  }

  jump(tokenId: number) {
    this.visitTok = null;
    this.idx = tokenId;
    this.interrupt();
  }

  visit(tokenId: number) {
    this.visitTok = tokenId;
    this.interrupt();
  }

  private interrupt() {
    if (this.mode === 'done' || this.mode === 'dwell' || this.mode === 'move') this.mode = 'wait';
    this.s.readerDone = false;
  }

  /** Open an old crawl: everything already read and settled, spider parked. */
  settleAll(layout: DocLayout) {
    for (const t of this.s.tokens) if (t && this.s.readAt[t.id] === undefined) {
      this.s.readAt[t.id] = -1e9;
      if (t.v !== undefined) this.s.figuresRead++;
    }
    this.idx = this.s.tokens.length;
    this.mode = 'done';
    this.s.readerDone = true;
    const park = this.s.figures[0]?.token ?? this.s.tokens.length - 1;
    const r = park >= 0 ? layout.rect(park) : null;
    if (r) {
      const p = Reader.target(r);
      this.spider.place(p.x, p.y);
      this.from = this.to = p;
      this.cur = park;
    }
    this.placed = true;
    this.s.notify();
  }

  private doneReading() {
    const total = this.s.parsed?.tokens;
    return this.s.rawDone && total !== undefined && this.idx >= total;
  }

  /**
   * Advances on the reader's own clock: several move/read/pause transitions can
   * complete inside one frame, so pace follows the speed setting, not the frame rate.
   */
  step(now: number, dt: number, speed: number, layout: DocLayout, reduced: boolean) {
    if (!this.placed) {
      this.spider.place(this.from.x, this.from.y);
      this.placed = true;
    }
    this.callouts = this.callouts.filter((c) => now - c.t0 < 1300 / Math.max(1, speed * 0.6));
    // after a long pause (hidden tab), don't fast-forward through the backlog
    if (now - this.clock > 250) this.clock = now - 250;

    for (let guard = 0; guard < 60; guard++) {
      if (this.mode === 'wait') {
        const want = this.visitTok ?? this.idx;
        const tok = this.s.tokens[want];
        if (!tok) {
          this.clock = now;
          if (this.visitTok === null && this.doneReading()) {
            this.mode = 'done';
            this.s.readerDone = true;
            this.s.notify();
          } else if (this.visitTok === null && this.s.status === 'error') {
            this.mode = 'done';
            this.s.readerDone = true;
            this.s.notify();
          }
          break;
        }
        const r = layout.rect(want);
        if (!r) {
          this.clock = now;
          if (!this.waitSince) this.waitSince = now;
          // a token that never rendered (shouldn't happen) is skipped rather than stalling
          if (now - this.waitSince > 400) {
            this.waitSince = 0;
            if (this.visitTok !== null) this.visitTok = null;
            else this.idx++;
          }
          break;
        }
        this.waitSince = 0;
        this.cur = want;
        this.from = { x: this.spider.x, y: this.spider.y };
        this.to = Reader.target(r);
        const d = Math.hypot(this.to.x - this.from.x, this.to.y - this.from.y);
        // long hops (end of a row back to the next label) zip; short ones step
        this.dur = reduced ? 0 : (d > 1400 ? 700 : Math.min(420, 18 + d / 6)) / speed;
        this.t0 = this.clock;
        this.mode = 'move';
        continue;
      }

      if (this.mode === 'move') {
        const end = this.t0 + this.dur;
        if (now < end) {
          const e = ease((now - this.t0) / this.dur);
          this.spider.x = this.from.x + (this.to.x - this.from.x) * e;
          this.spider.y = this.from.y + (this.to.y - this.from.y) * e;
          break;
        }
        this.spider.x = this.to.x;
        this.spider.y = this.to.y;
        const tok = this.s.tokens[this.cur];
        this.markRead(tok, end);
        let dwell = DWELL[tok.kind];
        const visiting = this.visitTok !== null;
        if (tok.call || visiting) {
          this.callouts = [...this.callouts.slice(-2), { tok, text: tok.kind === 'header' || tok.kind === 'label' ? tok.text : this.calloutText(tok), tone: tok.tone, t0: end }];
          dwell = visiting ? 900 : CALL_DWELL;
        }
        this.until = end + dwell / speed;
        this.mode = 'dwell';
        continue;
      }

      if (this.mode === 'dwell') {
        if (now < this.until) break;
        this.clock = this.until;
        if (this.visitTok !== null) this.visitTok = null;
        else this.idx = this.cur + 1;
        this.mode = 'wait';
        continue;
      }
      break; // done
    }
    if (reduced) this.spider.place(this.spider.x, this.spider.y);

    this.spider.update(dt, now, speed, reduced ? null : layout.nearestAnchor, reduced);
  }
}
