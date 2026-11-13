// Picks out what's worth highlighting: numbers, $, %, dates, fiscal periods,
// table line items and section headers. Never plain words.

import type { DocBlock, DocToken, KeyFigure, StatementKind, Tone, TokenKind } from '../../shared/crawl.ts';

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
const DATE = `\\b${MONTH}\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b`;
const PERIOD =
  "\\b(?:first|second|third|fourth)\\s+quarter\\s+of\\s+fiscal\\s+(?:year\\s+)?\\d{4}\\b|\\b(?:first|second)\\s+half\\s+of\\s+fiscal\\s+(?:year\\s+)?\\d{4}\\b|\\bfiscal\\s+(?:year\\s+)?\\d{4}\\b|\\b(?:three|six|nine|twelve)\\s+months\\s+ended\\b|\\bQ[1-4]\\s?(?:FY)?\\s?'?\\d{2,4}\\b|\\bFY\\s?'?\\d{2,4}\\b";
const MONEY = '\\$\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:million|billion|trillion|thousand)\\b)?';
const PCT = '\\(?-?\\d+(?:\\.\\d+)?\\)?\\s?%|\\b\\d+(?:\\.\\d+)?\\s(?:percent|basis points|bps)\\b';
const NUM = '\\b\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?(?:\\s(?:million|billion|trillion|thousand|shares))?\\b|\\b\\d+(?:\\.\\d+)?\\s(?:million|billion|trillion)\\b';

const PROSE = new RegExp(`(?<date>${DATE})|(?<period>${PERIOD})|(?<money>${MONEY})|(?<pct>${PCT})|(?<num>${NUM})`, 'gi');
const DATE_OR_PERIOD = new RegExp(`(?<date>${DATE})|(?<period>${PERIOD})`, 'gi');
const CELL_NUM = /^\(?\s?\$?\s?-?\d[\d,]*(?:\.\d+)?\s?\)?\s?%?$/;
const PRIOR_CUE = /\b(compared (?:to|with)|from|versus|vs\.?|a year ago|year[- ]ago|prior (?:year|period|quarter)|previous(?:ly)?|last year|same period last)\b/gi;
const CURRENT_CUE = /\b(to|was|were|totaled|of|reached|increased|decreased|grew|rose|fell|declined|is|are)\b/gi;

export function parseNumber(text: string): number | undefined {
  const neg = /^\s*\(|^-/.test(text) || /\)\s*%?$/.test(text);
  const n = Number(text.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || !/\d/.test(text)) return undefined;
  return neg ? -n : n;
}

function yearOf(s: string): number | undefined {
  const m = s.match(/\b(19|20)\d{2}\b/);
  if (m) return Number(m[0]);
  const fy = s.match(/(?:FY|Q[1-4])\s?'?(\d{2})\b/i);
  return fy ? 2000 + Number(fy[1]) : undefined;
}

function lastMatchIndex(re: RegExp, s: string) {
  re.lastIndex = 0;
  let idx = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) idx = m.index;
  return idx;
}

export interface ValueRow {
  token: number;
  label: string;
  text: string;
  value: number | undefined;
  tone: Tone;
  page: number;
  statement: StatementKind | '';
  column: number;
}

export class Extractor {
  private next = 0;
  private maxFiscal = 0;
  private datesCalled = new Set<string>();
  private figN = 0;
  figures: KeyFigure[] = [];
  values: ValueRow[] = [];
  counts = { tokens: 0, values: 0, callouts: 0 };

  constructor(private currentYear: number) {}

  private push(block: DocBlock, t: Omit<DocToken, 'id' | 'b'>) {
    const tok: DocToken = { id: this.next++, b: block.id, ...t };
    block.tokens.push(tok);
    this.counts.tokens++;
    if (tok.v !== undefined) this.counts.values++;
    if (tok.call) this.counts.callouts++;
    return tok;
  }

  private dateTone(text: string, kind: TokenKind, ref = this.currentYear): Tone {
    const y = yearOf(text);
    if (y === undefined) return 'label';
    if (kind === 'period' && /fiscal|FY|Q[1-4]/i.test(text)) {
      this.maxFiscal = Math.max(this.maxFiscal, y);
      return y >= this.maxFiscal ? 'current' : 'prior';
    }
    return y >= ref ? 'current' : 'prior';
  }

  prose(block: Extract<DocBlock, { t: 'p' | 'h' }>, srcAt: (s: number) => number) {
    if (block.t === 'h') {
      const e = Math.min(block.text.length, 110);
      this.push(block, { s: 0, e, text: block.text.slice(0, e), kind: 'header', tone: 'header', src: srcAt(0) });
      return;
    }
    let calls = 0;
    PROSE.lastIndex = 0;
    for (let m = PROSE.exec(block.text); m; m = PROSE.exec(block.text)) {
      const g = m.groups!;
      const text = m[0].trim();
      const s = m.index + (m[0].length - m[0].trimStart().length);
      const e = s + text.length;
      let kind: TokenKind;
      let tone: Tone;
      let call: 1 | undefined;
      if (g.date) {
        kind = 'date';
        tone = this.dateTone(text, kind);
        if (!this.datesCalled.has(text) && calls < 1) {
          this.datesCalled.add(text);
          call = 1;
        }
      } else if (g.period) {
        kind = 'period';
        tone = this.dateTone(text, kind);
      } else {
        kind = g.money ? 'money' : g.pct ? 'percent' : 'number';
        const before = block.text.slice(Math.max(0, s - 60), s);
        const p = lastMatchIndex(PRIOR_CUE, before);
        const c = lastMatchIndex(CURRENT_CUE, before);
        tone = p >= 0 && p >= c ? 'prior' : 'current';
        if ((kind === "money" || kind === "percent") && calls < 1) call = 1;
      }
      if (call) calls++;
      const v = kind === 'date' || kind === 'period' ? undefined : parseNumber(text);
      this.push(block, { s, e, text, kind, tone, v, call, src: srcAt(s) });
    }
  }

  table(block: Extract<DocBlock, { t: 'table' }>, srcAt: (r: number, c: number, s: number) => number, context: string) {
    const rows = block.rows;
    const isNum = (x: string) => CELL_NUM.test(x) && /\d/.test(x) && !/^(19|20)\d{2}$/.test(x.trim());
    const firstNumRow = rows.findIndex((r) => r.some((c) => isNum(c.x)));
    const unitMatch = (context + ' ' + rows.slice(0, 4).flat().map((c) => c.x).join(' ')).match(/in (millions|thousands|billions)/i);
    const unit = unitMatch ? unitMatch[1].toLowerCase() : '';

    // Header years in column order, from the header row closest to the data.
    let headerYears: number[] = [];
    for (let r = 0; r < (firstNumRow < 0 ? rows.length : firstNumRow); r++) {
      const ys = rows[r].map((c) => (/\b(19|20)\d{2}\b/.test(c.x) ? yearOf(c.x)! : undefined)).filter((y): y is number => y !== undefined);
      if (ys.length >= 2) headerYears = ys;
    }
    const maxYear = headerYears.length ? Math.max(...headerYears) : this.currentYear;

    let groupLabel = '';
    rows.forEach((row, r) => {
      const numIdx = row.map((c, i) => (isNum(c.x) ? i : -1)).filter((i) => i >= 0);
      if (!numIdx.length) {
        const only = row.filter((c) => c.x);
        if (r > firstNumRow && only.length === 1 && /[a-z]{2}/i.test(only[0].x)) groupLabel = /:\s*$/.test(only[0].x) ? only[0].x.replace(/:\s*$/, '') : '';
        // header-ish row: highlight dates and periods only
        row.forEach((cell, c) => {
          DATE_OR_PERIOD.lastIndex = 0;
          for (let m = DATE_OR_PERIOD.exec(cell.x); m; m = DATE_OR_PERIOD.exec(cell.x)) {
            const kind: TokenKind = m.groups!.date ? 'date' : 'period';
            this.push(block, { r, c, s: m.index, e: m.index + m[0].length, text: m[0], kind, tone: this.dateTone(m[0], kind, maxYear), src: srcAt(r, c, m.index) });
          }
        });
        return;
      }
      const labelIdx = row.findIndex((c, i) => i < numIdx[0] && /[a-z]{2}/i.test(c.x));
      let label = '';
      if (labelIdx >= 0) {
        label = row[labelIdx].x;
        const e = Math.min(label.length, 90);
        this.push(block, { r, c: labelIdx, s: 0, e, text: label.slice(0, e), kind: 'label', tone: 'label', src: srcAt(r, labelIdx, 0) });
      }
      const n = numIdx.length;
      const toks: DocToken[] = [];
      numIdx.forEach((c, k) => {
        const x = row[c].x;
        let tone: Tone;
        if (headerYears.length === n) tone = headerYears[k] === maxYear ? 'current' : 'prior';
        else if (headerYears.length && n % headerYears.length === 0) tone = headerYears[k % headerYears.length] === maxYear ? 'current' : 'prior';
        else tone = k === 0 ? 'current' : k === 1 ? 'prior' : k % 2 === 0 ? 'current' : 'prior';
        const prev = row[c - 1]?.x.trim();
        const nextCell = row[c + 1]?.x.trim();
        const kind: TokenKind = x.includes('%') || nextCell === '%' ? 'percent' : x.includes('$') || prev === '$' ? 'money' : 'number';
        const close = nextCell === ')' ? ')' : '';
        const v = parseNumber(x + close);
        const tok = this.push(block, { r, c, s: 0, e: x.length, text: x, kind, tone, v, src: srcAt(r, c, 0) });
        toks.push(tok);
        this.values.push({ token: tok.id, label, text: x + close, value: v, tone, page: block.page, statement: block.stmt ?? '', column: k });
      });
      if (block.stmt && label && toks.length >= 1 && toks[0].v !== undefined) {
        const cur = toks[0].v!;
        const prior = toks[1]?.v;
        const id = `f${++this.figN}`;
        const full = groupLabel && /^(basic|diluted|total|other|net|current|non-?current)\b/i.test(label) ? `${groupLabel}: ${label}` : label;
        const perShare = /per share/i.test(full);
        const change = prior !== undefined && prior !== 0 ? (cur - prior) / Math.abs(prior) : null;
        this.figures.push({ id, label: full, current: cur, prior: prior ?? null, change, unit: perShare ? 'per share' : unit, statement: block.stmt, token: toks[0].id, page: block.page });
        toks[0].call = 1;
        toks[0].f = id;
        if (toks[1]) toks[1].f = id;
        this.counts.callouts++;
      }
    });
  }
}
