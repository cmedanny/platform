// Connector filings arrive as markdown, one section at a time. This turns each
// section into the same document blocks the HTML parser produces, so the
// spider, highlights and figures work unchanged.

import type { DocBlock, StatementKind, TableCell } from '../../shared/crawl.ts';
import { Extractor } from '../../server/crawler/extract.ts';

const clean = (s: string) =>
  s
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/â€”|â/g, '—')
    .replace(/\s+/g, ' ')
    .trim();

const isBoldLine = (s: string) => /^\*\*[^*].*\*\*$/.test(s.trim());

export class MarkdownDocParser {
  private nextId = 0;
  private recentHeads: string[] = [];
  private seenStmt = new Set<StatementKind>();

  constructor(
    private extractor: Extractor,
    private onBlock: (b: DocBlock) => void,
    /** finds a token's real offset in the raw text near a guess */
    private locate: (text: string, near: number) => number,
  ) {}

  section(index: number, title: string, content: string, srcBase: number) {
    const page = index + 1;
    const lines = content.split('\n');
    let pos = srcBase;
    let para: { text: string; src: number } | null = null;
    let table: { rows: string[]; src: number } | null = null;

    const flushPara = () => {
      if (!para) return;
      const raw = para.text.trim();
      const text = clean(raw);
      const src = para.src;
      para = null;
      if (!text || /^[-—_*|\s]*$/.test(text)) return;
      const head = text.length < 140 && isBoldLine(raw);
      this.emitText(text, head ? 'h' : 'p', page, src);
    };
    const flushTable = () => {
      if (!table) return;
      const t = table;
      table = null;
      const rows: TableCell[][] = t.rows
        .filter((r) => !(/^\|?[\s:|-]+\|?$/.test(r) && r.includes('-')))
        .map((r) => {
          const cells = r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
          return cells.map((c) => ({ x: clean(c) }));
        })
        .filter((r) => r.some((c) => c.x));
      if (!rows.length) return;
      const block: DocBlock = { id: this.nextId++, t: 'table', rows, page, src: t.src, tokens: [] };
      const stmt = this.detectStatement(rows);
      if (stmt) block.stmt = stmt;
      this.extractor.table(block, (r, c, s) => this.locate(rows[r]?.[c]?.x.slice(s, s + 12) ?? '', t.src), this.recentHeads.join(' '));
      this.onBlock(block);
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const lineStart = pos;
      pos += line.length + 1;
      if (trimmed.startsWith('|')) {
        flushPara();
        if (!table) table = { rows: [], src: lineStart };
        table.rows.push(trimmed);
        continue;
      }
      flushTable();
      const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        flushPara();
        const text = clean(h[2]);
        if (text) this.emitText(text, 'h', page, lineStart);
        continue;
      }
      if (!trimmed || /^-{3,}$/.test(trimmed)) {
        flushPara();
        continue;
      }
      const bullet = trimmed.match(/^([-*•]|\d+\.)\s+(.*)$/);
      if (bullet) {
        flushPara();
        para = { text: bullet[2], src: lineStart };
        flushPara();
        continue;
      }
      if (para) para.text += ` ${trimmed}`;
      else para = { text: trimmed, src: lineStart };
    }
    flushPara();
    flushTable();
    void title;
  }

  private emitText(text: string, t: 'p' | 'h', page: number, src: number) {
    const block: DocBlock = { id: this.nextId++, t, text, page, src, tokens: [] };
    this.extractor.prose(block as Extract<DocBlock, { t: 'p' | 'h' }>, (s) => this.locate(text.slice(s, s + 12), src));
    if (t === 'h') {
      this.recentHeads.push(text);
      if (this.recentHeads.length > 5) this.recentHeads.shift();
    }
    this.onBlock(block);
  }

  private detectStatement(rows: TableCell[][]): StatementKind | undefined {
    const numericRows = rows.filter((r) => r.some((c) => /^\(?\$?\s?-?\d[\d,]*(\.\d+)?\)?%?$/.test(c.x.trim()))).length;
    if (numericRows < 8) return;
    const heads = this.recentHeads.slice(-3).join(' | ');
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
}
