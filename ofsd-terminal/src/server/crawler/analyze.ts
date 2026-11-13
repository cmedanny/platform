// Claude's part of a crawl: summary, key figures, observations, and Q&A.
// The document is the first (cached) content block, so follow-up questions
// about the same document reuse the cache.

import type Anthropic from '@anthropic-ai/sdk';
import type { DocBlock, KeyFigure, Observation } from '../../shared/crawl.ts';

export const MAX_DOC_CHARS = 1_400_000; // ~350k tokens

export const SYSTEM = `You are the research analyst inside OFSD Terminal, a private markets workspace. You read SEC filings and web documents for one experienced reader.
Rules:
- Be specific and numeric. Only use numbers that appear in the document. Never invent figures.
- If something is unclear or missing from the document, say so.
- Plain text only. No markdown, no em dashes, no hype.`;

export function docToText(blocks: DocBlock[]): string {
  const out: string[] = [];
  let page = 0;
  for (const b of blocks) {
    if (b.page !== page) {
      page = b.page;
      out.push(`\n[page ${page}]`);
    }
    if (b.t === 'h') out.push(`## ${b.text}`);
    else if (b.t === 'p') out.push(b.text);
    else if (b.t === 'table') {
      if (b.stmt) out.push(`(table: ${b.stmt} statement)`);
      for (const row of b.rows) {
        const cells = row.map((c) => c.x).filter((x) => x && x !== '$' && x !== ')' && x !== '%');
        if (cells.length) out.push(cells.join(' | '));
      }
    }
  }
  return out.join('\n');
}

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

export function figureLines(figs: KeyFigure[]) {
  return figs
    .map((f) => `${f.id} | ${f.label} | ${fmt(f.current)} | ${fmt(f.prior)} | ${f.change === null ? '—' : `${(f.change * 100).toFixed(1)}%`} | ${f.statement} | ${f.unit || 'units as shown'}`)
    .join('\n');
}

export function docBlock(title: string, source: string, text: string): Anthropic.Beta.BetaTextBlockParam {
  return {
    type: 'text',
    text: `<document title="${title.replace(/"/g, "'")}" source="${source}">\n${text}\n</document>`,
    cache_control: { type: 'ephemeral' },
  };
}

export function analysisMessages(doc: Anthropic.Beta.BetaTextBlockParam, figs: KeyFigure[]): Anthropic.Beta.BetaMessageParam[] {
  const cand = figs.length
    ? `Key figure candidates extracted from the financial statements (id | line item | current period | prior period | change | statement | unit):\n${figureLines(figs)}`
    : 'No financial statement tables were found, so there are no key figure candidates.';
  return [
    {
      role: 'user',
      content: [
        doc,
        {
          type: 'text',
          text: `${cand}

Analyze the document. Reply in exactly this line format and nothing else:
SUMMARY: 2 to 4 sentences on what this document is and what changed. One line.
KEY: comma-separated ids of the 8 to 16 most important figures above, most important first. Write KEY: none if there are no candidates.
OBS: one observation per line, 5 to 8 lines total. Each is one or two specific sentences with numbers, ending with the figure ids it relies on in square brackets, like [f1, f4]. Use [] when it relies on none.`,
        },
      ],
    },
  ];
}

export function askMessages(doc: Anthropic.Beta.BetaTextBlockParam, question: string): Anthropic.Beta.BetaMessageParam[] {
  return [
    {
      role: 'user',
      content: [
        doc,
        {
          type: 'text',
          text: `Answer this question using only the document above. Cite pages like (p. 12) when the document has page markers. Short paragraphs.\n\nQuestion: ${question}`,
        },
      ],
    },
  ];
}

/** Parses the SUMMARY/KEY/OBS stream line by line as it arrives. */
export class AnalysisParser {
  private buf = '';
  private last: 'summary' | 'obs' | null = null;
  summary = '';
  key: string[] = [];
  obs: Observation[] = [];

  constructor(
    private on: {
      summary: (s: string) => void;
      key: (ids: string[]) => void;
      obs: (o: Observation) => void;
    },
  ) {}

  push(delta: string) {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      this.line(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
    }
  }

  end() {
    if (this.buf.trim()) this.line(this.buf);
    this.buf = '';
  }

  private line(raw: string) {
    const line = raw.trim().replace(/\s+—\s+/g, ', ');
    if (!line) return;
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^SUMMARY:\s*(.*)$/i))) {
      this.summary = m[1];
      this.last = 'summary';
      this.on.summary(this.summary);
    } else if ((m = line.match(/^KEY:\s*(.*)$/i))) {
      this.key = /^none$/i.test(m[1].trim()) ? [] : m[1].split(/[\s,]+/).filter((x) => /^f\d+$/.test(x));
      this.last = null;
      this.on.key(this.key);
    } else if ((m = line.match(/^(?:OBS:|[-•]\s+)\s*(.*)$/i))) {
      const refsM = m[1].match(/\[([^\]]*)\]\s*\.?$/);
      const refs = refsM ? refsM[1].split(/[\s,]+/).filter((x) => /^f\d+$/.test(x)) : [];
      const text = refsM ? m[1].slice(0, refsM.index).trim() : m[1];
      const o = { i: this.obs.length + 1, text, refs };
      this.obs.push(o);
      this.last = 'obs';
      this.on.obs(o);
    } else if (this.last === 'summary') {
      this.summary += ' ' + line;
      this.on.summary(this.summary);
    }
  }
}
