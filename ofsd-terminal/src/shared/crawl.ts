// Shapes for crawler events, shared by the backend parser and the browser renderer.

/** What a highlight means. Maps to accent colors in the UI. */
export type Tone = 'current' | 'prior' | 'label' | 'header';
export type TokenKind = 'money' | 'number' | 'percent' | 'date' | 'period' | 'label' | 'header';
export type StatementKind = 'income' | 'comprehensive' | 'balance' | 'cashflow' | 'equity';

/** One extracted value or label. Offsets point into the block text (or one table cell). */
export interface DocToken {
  id: number;
  /** block id */
  b: number;
  /** table row / cell (tables only) */
  r?: number;
  c?: number;
  /** start/end char offsets in the text */
  s: number;
  e: number;
  text: string;
  kind: TokenKind;
  tone: Tone;
  /** numeric value, when it's a number */
  v?: number;
  /** pop a callout when read */
  call?: 1;
  /** approx byte offset in the raw source */
  src: number;
  /** key figure id this token belongs to */
  f?: string;
}

export interface TableCell {
  x: string;
  cs?: number;
}

export type DocBlock =
  | { id: number; t: 'p' | 'h'; text: string; page: number; src: number; center?: 1; tokens: DocToken[] }
  | { id: number; t: 'table'; rows: TableCell[][]; page: number; src: number; stmt?: StatementKind; tokens: DocToken[] }
  | { id: number; t: 'pb'; page: number; src: number; tokens: DocToken[] };

export interface KeyFigure {
  id: string;
  label: string;
  current: number;
  prior: number | null;
  /** fractional change, e.g. 0.12 = +12% */
  change: number | null;
  unit: string;
  statement: StatementKind;
  /** token id of the current value (spider goes here) */
  token: number;
  page: number;
}

export interface Observation {
  i: number;
  text: string;
  refs: string[];
}

export interface CrawlMeta {
  crawlId: string;
  kind: 'edgar' | 'url';
  title: string;
  url: string;
  ticker?: string;
  form?: string;
  company?: string;
  cik?: string;
  filed?: string;
  period?: string;
}

export interface NetLine {
  id: number;
  method: string;
  url: string;
  phase: 'start' | 'progress' | 'done' | 'error';
  status?: number;
  bytes?: number;
  ms?: number;
  note?: string;
}

export interface CrawlListItem {
  id: string;
  runId: string;
  title: string;
  ticker: string | null;
  form: string | null;
  createdAt: number;
  status: string;
  attached: boolean;
}
