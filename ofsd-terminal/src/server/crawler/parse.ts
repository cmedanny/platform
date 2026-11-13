// Streaming HTML -> document blocks, with source offsets. No dependencies.
// Handles SEC inline-XBRL filings (well-formed XHTML) and ordinary web pages.

import type { DocBlock, StatementKind, TableCell } from '../../shared/crawl.ts';
import { Extractor } from './extract.ts';

const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'col', 'area', 'base', 'wbr', 'source', 'embed', 'param', 'track']);
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template']);
const SKIP = new Set(['ix:header', 'svg', 'iframe', 'nav', 'select', 'button', 'form', 'head', 'object', 'canvas', 'math']);
const BLOCK = new Set([
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol', 'br', 'section', 'article', 'header', 'footer',
  'main', 'aside', 'blockquote', 'pre', 'dt', 'dd', 'dl', 'figure', 'figcaption', 'caption', 'center', 'address',
]);

const ENT: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', sect: '§', para: '¶',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '', shy: '', deg: '°', times: '×', frac12: '½', frac14: '¼', frac34: '¾',
  euro: '€', pound: '£', yen: '¥', cent: '¢', percnt: '%', dollar: '$',
};

export function decodeEntities(s: string) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      if (code === 160) return ' ';
      return String.fromCodePoint(code);
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

interface Frame {
  name: string;
  bold: boolean;
  hidden: boolean;
  heading: boolean;
  center: boolean;
}

interface Run {
  text: string;
  start: number; // offset in block text
  src: number;
  bold: boolean;
}

interface CellBuild {
  runs: Run[];
  text: string;
  cs: number;
}

interface TableBuild {
  src: number;
  rows: CellBuild[][];
  depth: number;
}

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
};

export interface ParseResult {
  title: string;
  pages: number;
  blocks: number;
}

/**
 * Feed it decoded text chunks as they arrive; it emits finished blocks through onBlock.
 * Block tokens (extracted values) are attached by the Extractor.
 */
export class HtmlStreamParser {
  private buf = '';
  private bufStart = 0;
  private stack: Frame[] = [{ name: '#root', bold: false, hidden: false, heading: false, center: false }];
  private rawUntil: string | null = null;
  private para: Run[] = [];
  private paraLen = 0;
  private paraCenter = false;
  private paraHeading = false;
  private table: TableBuild | null = null;
  private nextId = 0;
  private recentHeads: string[] = [];
  private seenStmt = new Set<StatementKind>();
  title = '';
  page = 1;
  blockCount = 0;
  isPlainText = false;

  constructor(
    private extractor: Extractor,
    private onBlock: (b: DocBlock) => void,
    opts: { startId?: number; startPage?: number; srcBase?: number } = {},
  ) {
    this.nextId = opts.startId ?? 0;
    this.page = opts.startPage ?? 1;
    this.bufStart = opts.srcBase ?? 0;
  }

  get nextBlockId() {
    return this.nextId;
  }

  /** Starts a new document section (e.g. an 8-K exhibit) on a fresh page with a heading. */
  section(title: string, src: number) {
    this.pageBreak(src);
    const block: DocBlock = { id: this.nextId++, t: 'h', text: title, page: this.page, src, tokens: [] };
    this.extractor.prose(block, () => src);
    this.emit(block);
  }

  private get top() {
    return this.stack[this.stack.length - 1];
  }

  feed(chunk: string) {
    this.buf += chunk;
    this.process(false);
  }

  end() {
    this.process(true);
    if (this.buf) this.text(this.buf, this.bufStart);
    this.buf = '';
    this.flushPara();
    if (this.table) this.finishTable();
    return { title: this.title, pages: this.page, blocks: this.blockCount } satisfies ParseResult;
  }

  /** For text/plain responses: every blank-line-separated chunk is a paragraph. */
  feedPlain(all: string, base = 0) {
    this.isPlainText = true;
    let pos = 0;
    for (const part of all.split(/\n\s*\n/)) {
      const t = part.replace(/\s+/g, ' ').trim();
      if (t) {
        this.para = [{ text: t, start: 0, src: base + pos, bold: false }];
        this.paraLen = t.length;
        this.flushPara();
      }
      pos += part.length + 2;
    }
  }

  private process(final: boolean) {
    let i = 0;
    const s = this.buf;
    while (i < s.length) {
      if (this.rawUntil) {
        const close = s.toLowerCase().indexOf(`</${this.rawUntil}`, i);
        if (close < 0) {
          if (!final) break;
          i = s.length;
          break;
        }
        if (this.rawUntil === 'title' && !this.title) this.title = decodeEntities(s.slice(i, close)).replace(/\s+/g, ' ').trim();
        const gt = s.indexOf('>', close);
        if (gt < 0) break;
        this.rawUntil = null;
        i = gt + 1;
        continue;
      }
      const lt = s.indexOf('<', i);
      if (lt < 0) {
        // keep trailing text until we know it's complete (it may continue in the next chunk)
        if (final) {
          this.text(s.slice(i), this.bufStart + i);
          i = s.length;
        }
        break;
      }
      if (lt > i) this.text(s.slice(i, lt), this.bufStart + i);
      i = lt;
      if (s.startsWith('<!--', i)) {
        const end = s.indexOf('-->', i + 4);
        if (end < 0) break;
        i = end + 3;
        continue;
      }
      if (s.startsWith('<?', i) || s.startsWith('<!', i)) {
        const end = s.indexOf('>', i);
        if (end < 0) break;
        i = end + 1;
        continue;
      }
      // find end of tag, respecting quotes
      let j = i + 1;
      let q: string | null = null;
      for (; j < s.length; j++) {
        const ch = s[j];
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '>') break;
      }
      if (j >= s.length) break; // incomplete tag
      this.tag(s.slice(i, j + 1), this.bufStart + i);
      i = j + 1;
    }
    this.buf = s.slice(i);
    this.bufStart += i;
  }

  private tag(raw: string, src: number) {
    const m = raw.match(/^<\s*(\/)?\s*([a-zA-Z][\w:.-]*)/);
    if (!m) return;
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    const selfClose = /\/\s*>$/.test(raw) || VOID.has(name);
    const style = (closing ? '' : (attr(raw, 'style') ?? '')).toLowerCase().replace(/\s+/g, '');

    if (!closing && (/page-break-(after|before):always/.test(style) || /break-(after|before):page/.test(style))) {
      this.pageBreak(src);
    }

    if (closing) {
      this.close(name, src);
      return;
    }

    if (RAWTEXT.has(name)) {
      if (!selfClose) {
        this.rawUntil = name;
      }
      return;
    }

    const parent = this.top;
    if (name === 'hr') {
      if (!parent.hidden) this.boundary();
      return;
    }
    if (name === 'br') {
      if (!parent.hidden) {
        if (this.table) this.cellText(' ', src, parent.bold);
        else this.boundary();
      }
      return;
    }

    const cls = (attr(raw, 'class') ?? '').toLowerCase();
    const role = (attr(raw, 'role') ?? '').toLowerCase();
    const hidden = parent.hidden || SKIP.has(name) || /\b(mw-editsection|navbox|catlinks|printfooter|noprint|mw-jump-link|cookie|sr-only|visually-hidden)\b/.test(cls) || role === 'navigation' || /display:none|visibility:hidden/.test(style) || attr(raw, 'hidden') !== null || attr(raw, 'aria-hidden') === 'true';
    const weight = style.match(/font-weight:(\d+|bold|bolder|normal|lighter)/);
    let bold = parent.bold;
    if (name === 'b' || name === 'strong' || /^h[1-6]$/.test(name)) bold = true;
    if (weight) bold = weight[1] === 'bold' || weight[1] === 'bolder' || Number(weight[1]) >= 600;
    const frame: Frame = {
      name,
      bold,
      hidden,
      heading: parent.heading || /^h[1-6]$/.test(name),
      center: /text-align:center/.test(style) ? true : /text-align:(left|right|justify)/.test(style) ? false : parent.center,
    };

    if (!hidden) {
      if (name === 'table') {
        if (this.table) this.table.depth++;
        else {
          this.flushPara();
          this.table = { src, rows: [], depth: 0 };
        }
      } else if (this.table && this.table.depth === 0) {
        if (name === 'tr') this.table.rows.push([]);
        else if (name === 'td' || name === 'th') {
          if (!this.table.rows.length) this.table.rows.push([]);
          const cs = Math.max(1, Math.min(60, Number(attr(raw, 'colspan')) || 1));
          this.table.rows[this.table.rows.length - 1].push({ runs: [], text: '', cs });
        } else if (BLOCK.has(name)) this.cellText(' ', src, false);
      } else if (BLOCK.has(name) || /^h[1-6]$/.test(name)) {
        this.boundary();
        if (/^h[1-6]$/.test(name)) this.paraHeading = true;
      }
    }

    if (!selfClose) this.stack.push(frame);
  }

  private close(name: string, src: number) {
    // pop up to the matching element (tolerates sloppy HTML)
    let idx = -1;
    for (let k = this.stack.length - 1; k > 0; k--)
      if (this.stack[k].name === name) {
        idx = k;
        break;
      }
    if (idx < 0) return;
    const frame = this.stack[idx];
    this.stack.length = idx;
    if (frame.hidden) return;
    if (name === 'table' && this.table) {
      if (this.table.depth > 0) this.table.depth--;
      else this.finishTable();
      return;
    }
    if (this.table && (name === 'td' || name === 'th' || name === 'tr')) return;
    if (!this.table && (BLOCK.has(name) || /^h[1-6]$/.test(name))) this.boundary();
    void src;
  }

  private text(rawText: string, src: number) {
    const f = this.top;
    if (f.hidden || this.rawUntil) return;
    const t = decodeEntities(rawText).replace(/[\s ​]+/g, ' ');
    if (!t.trim() && !t) return;
    if (this.table) {
      this.cellText(t, src, f.bold);
      return;
    }
    if (!this.para.length) {
      const lead = t.replace(/^\s+/, '');
      if (!lead) return;
      this.paraCenter = f.center;
      this.para.push({ text: lead, start: 0, src, bold: f.bold });
      this.paraLen = lead.length;
      if (f.heading) this.paraHeading = true;
      return;
    }
    const prev = this.para[this.para.length - 1];
    const joined = prev.text.endsWith(' ') && t.startsWith(' ') ? t.slice(1) : t;
    if (!joined) return;
    this.para.push({ text: joined, start: this.paraLen, src, bold: f.bold || !joined.trim() });
    this.paraLen += joined.length;
    if (f.heading) this.paraHeading = true;
  }

  private cellText(t: string, src: number, bold: boolean) {
    const tb = this.table!;
    if (tb.depth > 0 && !tb.rows.length) tb.rows.push([]);
    const row = tb.rows[tb.rows.length - 1];
    if (!row) return;
    if (!row.length) row.push({ runs: [], text: '', cs: 1 });
    const cell = row[row.length - 1];
    const add = cell.text.endsWith(' ') && t.startsWith(' ') ? t.slice(1) : t;
    if (!add) return;
    cell.runs.push({ text: add, start: cell.text.length, src, bold });
    cell.text += add;
  }

  private boundary() {
    this.flushPara();
  }

  private pageBreak(src: number) {
    this.flushPara();
    if (this.table) return;
    this.page++;
    this.emit({ id: this.nextId++, t: 'pb', page: this.page, src, tokens: [] });
  }

  private flushPara() {
    if (!this.para.length) return;
    const runs = this.para;
    this.para = [];
    this.paraLen = 0;
    let text = runs.map((r) => r.text).join('');
    const lead = text.length - text.trimStart().length;
    text = text.trim();
    const heading = this.paraHeading;
    const center = this.paraCenter;
    this.paraHeading = false;
    if (!text || /^[\s|·•\-–—_]*$/.test(text)) return;
    // Lone page numbers become nothing (page markers already exist).
    if (/^(page\s*)?\d{1,3}$/i.test(text) || /^table of contents$/i.test(text)) return;
    const boldChars = runs.reduce((a, r) => a + (r.bold ? r.text.trim().length : 0), 0);
    const allBold = boldChars >= text.replace(/\s/g, '').length * 0.9;
    const isHead = text.length < 160 && (heading || allBold || /^(PART\s+[IVX]+\b|Item\s+\d+[A-Z]?\.)/i.test(text));
    const block: DocBlock = { id: this.nextId++, t: isHead ? 'h' : 'p', text, page: this.page, src: runs[0].src, tokens: [] };
    if (center) block.center = 1;
    const srcAt = (s: number) => {
      const pos = s + lead;
      let r = runs[0];
      for (const x of runs) if (x.start <= pos) r = x;
      return r.src + Math.max(0, pos - r.start);
    };
    this.extractor.prose(block, srcAt);
    if (isHead) {
      this.recentHeads.push(text);
      if (this.recentHeads.length > 5) this.recentHeads.shift();
    }
    this.emit(block);
  }

  private finishTable() {
    const tb = this.table!;
    this.table = null;
    const built = compactTable(tb.rows);
    if (!built.rows.length) return;
    // A single-cell "table" is really a paragraph (common in EDGAR layout).
    const filled = built.rows.flat().filter((c) => c.x).length;
    if (filled === 1 && built.rows.length <= 2) {
      const cell = built.rows.flat().find((c) => c.x)!;
      const srcCell = built.src.flat().find((c) => c && c.text.trim() === cell.x);
      this.para = srcCell?.runs.length ? srcCell.runs.map((r) => ({ ...r })) : [{ text: cell.x, start: 0, src: tb.src, bold: false }];
      this.paraLen = cell.x.length;
      this.flushPara();
      return;
    }
    const stmt = this.detectStatement(built.rows);
    const block: DocBlock = { id: this.nextId++, t: 'table', rows: built.rows, page: this.page, src: tb.src, tokens: [] };
    if (stmt) block.stmt = stmt;
    this.extractor.table(block, (r, c, s) => {
      const cell = built.src[r]?.[c];
      if (!cell?.runs.length) return tb.src;
      const lead = cell.text.length - cell.text.trimStart().length;
      const pos = s + lead;
      let run = cell.runs[0];
      for (const x of cell.runs) if (x.start <= pos) run = x;
      return run.src + Math.max(0, pos - run.start);
    }, this.recentHeads.join(' '));
    this.emit(block);
  }

  private detectStatement(rows: TableCell[][]): StatementKind | undefined {
    const numericRows = rows.filter((r) => r.some((c) => /^\(?\$?\s?-?\d[\d,]*(\.\d+)?\)?%?$/.test(c.x.trim()))).length;
    if (numericRows < 8) return;
    const heads = this.recentHeads.slice(-4).join(' | ');
    const kinds: Array<[StatementKind, RegExp]> = [
      ['comprehensive', /statements? of comprehensive (income|loss)/i],
      ['income', /statements? of (income|operations|earnings)/i],
      ['balance', /balance sheets?|statements? of financial position/i],
      ['cashflow', /statements? of cash flows?/i],
      ['equity', /(shareholders|stockholders)['’]? equity/i],
    ];
    for (const [k, re] of kinds) {
      if (re.test(heads) && !this.seenStmt.has(k)) {
        this.seenStmt.add(k);
        return k;
      }
    }
  }

  private emit(b: DocBlock) {
    this.blockCount++;
    this.onBlock(b);
  }
}

/**
 * EDGAR tables are full of spacer columns. Drop columns that never hold
 * content, keeping colspans consistent. Returns compacted rows plus the
 * matching source cells (for offsets).
 */
function compactTable(rowsIn: CellBuild[][]) {
  const rows = rowsIn.filter((r) => r.length);
  // place cells on a grid
  const placed = rows.map((r) => {
    let x = 0;
    return r.map((c) => {
      const p = { c, x0: x, x1: x + c.cs, text: c.text.replace(/\s+/g, ' ').trim() };
      x += c.cs;
      return p;
    });
  });
  const width = Math.max(0, ...placed.map((r) => (r.length ? r[r.length - 1].x1 : 0)));
  const used = new Array(width).fill(false);
  for (const r of placed) for (const p of r) if (p.text && p.c.cs === 1) used[p.x0] = true;
  // spanning cells with content keep at least their first column
  for (const r of placed) for (const p of r) if (p.text && p.c.cs > 1 && !used.slice(p.x0, p.x1).some(Boolean)) used[p.x0] = true;

  const outRows: TableCell[][] = [];
  const outSrc: Array<Array<CellBuild | null>> = [];
  for (const r of placed) {
    const row: TableCell[] = [];
    const srow: Array<CellBuild | null> = [];
    for (const p of r) {
      const span = used.slice(p.x0, p.x1).filter(Boolean).length;
      if (span === 0) continue;
      const cell: TableCell = { x: p.text };
      if (span > 1) cell.cs = span;
      row.push(cell);
      srow.push(p.c);
    }
    if (row.some((c) => c.x)) {
      outRows.push(row);
      outSrc.push(srow);
    }
  }
  return { rows: outRows, src: outSrc };
}
