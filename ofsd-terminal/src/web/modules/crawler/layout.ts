// Measures where tokens and words actually sit in the rendered document,
// in content coordinates (relative to the scroll container's content box).

import type { Pt } from './spider.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class DocLayout {
  private rects = new Map<number, Rect | null>();
  private anchors = new Map<number, Pt[]>();
  private boxes: Array<{ id: number; y: number; h: number; el: HTMLElement }> | null = null;

  constructor(
    private scroller: HTMLElement,
    private content: HTMLElement,
  ) {}

  invalidate() {
    this.rects.clear();
    this.anchors.clear();
    this.boxes = null;
  }

  /** New blocks were appended: earlier geometry is unchanged, only the block index needs refreshing. */
  appended() {
    this.boxes = null;
    for (const [k, v] of this.rects) if (v === null) this.rects.delete(k);
  }

  private origin() {
    const r = this.scroller.getBoundingClientRect();
    return { x: r.left - this.scroller.scrollLeft, y: r.top - this.scroller.scrollTop };
  }

  rect(tokenId: number): Rect | null {
    const hit = this.rects.get(tokenId);
    if (hit !== undefined) return hit;
    const el = this.content.querySelector<HTMLElement>(`[data-t="${tokenId}"]`);
    if (!el) {
      this.rects.set(tokenId, null);
      return null;
    }
    const o = this.origin();
    const rs = el.getClientRects();
    const r = rs.length ? rs[0] : el.getBoundingClientRect();
    const out = { x: r.left - o.x, y: r.top - o.y, w: Math.max(4, r.width), h: Math.max(8, r.height) };
    this.rects.set(tokenId, out);
    return out;
  }

  private blockBoxes() {
    if (this.boxes) return this.boxes;
    const o = this.origin();
    this.boxes = Array.from(this.content.querySelectorAll<HTMLElement>('[data-b]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: Number(el.dataset.b), y: r.top - o.y, h: r.height, el };
    });
    return this.boxes;
  }

  private blockAnchors(id: number, el: HTMLElement): Pt[] {
    const hit = this.anchors.get(id);
    if (hit) return hit;
    const o = this.origin();
    const pts: Pt[] = [];
    if (el.tagName === 'TABLE') {
      el.querySelectorAll('td').forEach((td) => {
        if (!td.textContent?.trim() || pts.length > 500) return;
        const r = td.getBoundingClientRect();
        pts.push({ x: r.left - o.x + r.width / 2, y: r.bottom - o.y - 2 });
      });
    } else {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let n = walker.nextNode(); n && pts.length < 400; n = walker.nextNode()) {
        const text = n.textContent ?? '';
        const re = /\S+/g;
        for (let m = re.exec(text); m && pts.length < 400; m = re.exec(text)) {
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const r = range.getBoundingClientRect();
          if (r.width) pts.push({ x: r.left - o.x + r.width / 2, y: r.bottom - o.y - 2 });
        }
      }
    }
    this.anchors.set(id, pts);
    return pts;
  }

  /** Nearest real word/cell position to p within radius, for planting feet. */
  nearestAnchor = (p: Pt, radius: number): Pt | null => {
    const boxes = this.blockBoxes();
    // binary search the first block that could reach p.y - radius
    let lo = 0;
    let hi = boxes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (boxes[mid].y + boxes[mid].h < p.y - radius) lo = mid + 1;
      else hi = mid;
    }
    let best: Pt | null = null;
    let bestD = radius;
    for (let i = lo; i < boxes.length && boxes[i].y <= p.y + radius; i++) {
      for (const a of this.blockAnchors(boxes[i].id, boxes[i].el)) {
        const d = Math.hypot(a.x - p.x, a.y - p.y);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
    }
    return best;
  };

  blockTop(id: number) {
    return this.blockBoxes().find((b) => b.id === id)?.y ?? null;
  }
}
