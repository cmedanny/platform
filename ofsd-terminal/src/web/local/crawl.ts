// /crawl and "Ask this document" for the Claude-app version.
// Filing text comes through the Robinhood connector, section by section;
// Claude runs on the viewer's plan.

import type { CrawlListItem, CrawlMeta, DocBlock, KeyFigure, Observation } from '../../shared/crawl.ts';
import { AnalysisParser, analysisInstructions, askInstruction, docToText, SYSTEM } from '../../server/crawler/analyze.ts';
import { Extractor } from '../../server/crawler/extract.ts';
import { askClaude, fitBytes, promptBudget } from './claude.ts';
import { UserError } from './claudeapp.ts';
import { MarkdownDocParser } from './markdown.ts';
import type { LocalRun } from './runs.ts';
import { rh } from './sec.ts';
import { store } from './store.ts';

const FORMS = ['10-Q', '10-K', '8-K'];
const CONCURRENCY = 3;

interface Filing {
  filing_id: string;
  form_type: string;
  date_filed: string;
  has_content: boolean;
  cik: string;
  accession_number: string;
}
interface Toc {
  sections: Array<{ id: string; title: string; level: number }>;
}

export interface CrawlRecord {
  id: string;
  runId: string;
  kind: 'edgar';
  ticker: string;
  form: string;
  url: string;
  title: string;
  company: string;
  cik: string;
  accession: string;
  period: string;
  filed: string;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  figures: KeyFigure[];
  report: { summary: string; key: string[]; obs: Observation[] };
  stats: Record<string, unknown>;
  attached: boolean;
}

const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function parseTarget(args: string) {
  const a = args.trim();
  if (!a) throw new UserError('Tell me what to crawl: /crawl NVDA 10-Q, /crawl AAPL 10-K or /crawl MSFT 8-K.');
  if (/^https?:\/\//i.test(a) || /\.[a-z]{2,}(\/|$)/i.test(a))
    throw new UserError("Web pages can't be read from inside the Claude app version. Crawl a filing instead: /crawl NVDA 10-Q.");
  const [ticker, formRaw = '10-Q', ...rest] = a.split(/\s+/);
  if (rest.length) throw new UserError('Use /crawl TICKER FORM, like /crawl NVDA 10-Q.');
  if (!/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(ticker)) throw new UserError(`"${ticker}" isn't a valid ticker.`);
  const form = formRaw.toUpperCase().replace(/^(10|8)-?/, '$1-');
  if (!FORMS.includes(form)) throw new UserError(`Form "${formRaw}" isn't supported. Use 10-Q, 10-K or 8-K.`);
  return { ticker: ticker.toUpperCase(), form };
}

/** Section text in order, fetched a few at a time. */
async function fetchSections(run: LocalRun, filingId: string, toc: Toc, onSection: (i: number, title: string, content: string) => void) {
  const results: Array<string | null> = new Array(toc.sections.length).fill(null);
  let next = 0;
  let emitted = 0;
  const flush = () => {
    while (emitted < results.length && results[emitted] !== null) {
      onSection(emitted, toc.sections[emitted].title, results[emitted]!);
      emitted++;
    }
  };
  const worker = async () => {
    while (next < toc.sections.length) {
      const i = next++;
      const sec = toc.sections[i];
      try {
        const out = await rh<{ data?: { section?: { content?: string } } }>(run, 'get_sec_filing', { filing_id: filingId, section: sec.id }, sec.id);
        results[i] = out.data?.section?.content ?? '';
      } catch (err) {
        // one missing section shouldn't sink the crawl; a broken connection should
        if (i === 0 || /connect|Allow|expired|blocks/.test((err as Error).message)) throw err;
        results[i] = `### ${sec.title}\n\n(This section couldn't be loaded.)`;
      }
      flush();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flush();
}

export async function crawl(args: string, run: LocalRun) {
  const target = parseTarget(args);
  const crawlId = newId('crawl');
  const meta: CrawlMeta = { crawlId, kind: 'edgar', title: `${target.ticker} ${target.form}`, url: '', ticker: target.ticker, form: target.form };
  const rec: CrawlRecord = {
    id: crawlId,
    runId: run.id,
    kind: 'edgar',
    ticker: target.ticker,
    form: target.form,
    url: '',
    title: meta.title,
    company: target.ticker,
    cik: '',
    accession: '',
    period: '',
    filed: '',
    status: 'running',
    createdAt: Date.now(),
    figures: [],
    report: { summary: '', key: [], obs: [] },
    stats: {},
    attached: false,
  };
  store.put('crawls', crawlId, rec);
  const phase = (p: string) => run.emit({ type: 'x:phase', data: { phase: p } });
  const sendMeta = () => run.emit({ type: 'x:crawl', data: { ...meta } as unknown as Record<string, unknown> });
  sendMeta();

  try {
    phase('resolve');
    const index = await rh<{ data?: { filings?: Filing[] } }>(run, 'get_sec_filing_index', { symbol: target.ticker, form_type: [target.form] }, target.ticker);
    const filings = index.data?.filings ?? [];
    if (!filings.length) throw new UserError(`No ${target.form} filings found for ${target.ticker}. Check the ticker (US-listed companies only).`);
    const pick = filings.find((f) => f.has_content);
    if (!pick) throw new UserError(`Robinhood hasn't made the text of ${target.ticker}'s ${target.form} filings readable yet. Try another form or try later.`);
    if (pick !== filings[0])
      run.log(`The newest ${target.form} (filed ${filings[0].date_filed}) isn't readable through Robinhood yet, so this reads the one filed ${pick.date_filed}.`, 'warn');
    run.log(`${target.ticker} ${target.form}: filed ${pick.date_filed}, accession ${pick.accession_number}`);
    const folder = `https://www.sec.gov/Archives/edgar/data/${pick.cik}/${pick.accession_number.replace(/-/g, '')}/`;
    Object.assign(meta, { url: folder, filed: pick.date_filed, cik: pick.cik, company: target.ticker });
    Object.assign(rec, { url: folder, filed: pick.date_filed, cik: pick.cik, accession: pick.accession_number });

    const toc = await rh<{ data?: { table_of_contents?: Toc } }>(run, 'get_sec_filing', { filing_id: pick.filing_id }, 'contents');
    const sections = (toc.data?.table_of_contents?.sections ?? []).filter((s) => !/^table-of-contents/.test(s.id));
    if (!sections.length) throw new UserError('Robinhood returned this filing without any sections to read.');
    const company = sections.find((s) => s.level === 1)?.title;
    const period = sections.map((s) => s.title.match(/(?:quarter|year|period) ended\s+([A-Z][a-z]+\.? \d{1,2}, \d{4})/i)?.[1]).find(Boolean);
    if (company) meta.company = company.replace(/\s+/g, ' ').trim();
    if (period) meta.period = period;
    Object.assign(rec, { company: meta.company, period: meta.period ?? '', title: meta.title });
    sendMeta();
    run.log(`${sections.length} sections to read.`);

    phase('fetch');
    const currentYear = Number((period ?? pick.date_filed).match(/\d{4}/)?.[0]) || new Date().getFullYear();
    const ex = new Extractor(currentYear);
    let raw = '';
    const blocks: DocBlock[] = [];
    let pending: DocBlock[] = [];
    const locate = (text: string, near: number) => {
      if (!text) return near;
      const at = raw.indexOf(text.slice(0, 10), Math.max(0, near - 40));
      return at >= 0 && at - near < 4000 ? at : near;
    };
    const parser = new MarkdownDocParser(ex, (b) => {
      blocks.push(b);
      pending.push(b);
    }, locate);
    await fetchSections(run, pick.filing_id, { sections }, (i, title, content) => {
      const piece = `${content.trim()}\n\n`;
      const base = raw.length;
      raw += piece;
      run.emit({ type: 'x:raw', data: { o: base, s: piece } });
      parser.section(i, title, piece, base);
      if (pending.length) {
        run.emit({ type: 'x:doc', data: { blocks: pending } });
        pending = [];
      }
    });

    const stmts = Object.fromEntries(blocks.filter((b) => b.t === 'table' && b.stmt).map((b) => [(b as { stmt: string }).stmt, b.id]));
    run.emit({ type: 'x:parsed', data: { blocks: blocks.length, pages: sections.length, ...ex.counts, figures: ex.figures.length, stmts } });
    run.emit({ type: 'x:figures', data: { list: ex.figures } });
    run.log(`Read ${sections.length} sections · ${ex.counts.values.toLocaleString()} values · ${ex.figures.length} statement line items.`);
    rec.figures = ex.figures;
    rec.stats = { pages: sections.length, ...ex.counts, figures: ex.figures.length };
    store.put('crawls', crawlId, rec);

    phase('analyze');
    run.log('Claude is reading the document (on your Claude plan)…');
    const budget = (await promptBudget()) - 12_000;
    const doc = fitBytes(docToText(blocks).replace(/\[page (\d+)\]/g, '[§$1]'), Math.max(20_000, budget));
    if (doc.cut) run.log('The filing is longer than Claude can take in one request, so Claude read the first part (statements and MD&A come first in a 10-Q/10-K).', 'warn');
    const prompt = `${SYSTEM}\n\n<document title="${meta.title}" source="${folder}">\n${doc.text}\n</document>\n\n${analysisInstructions(ex.figures)}`;
    const ap = new AnalysisParser({
      summary: (s) => {
        rec.report.summary = s;
        run.emit({ type: 'x:summary', data: { text: s } });
      },
      key: (ids) => {
        rec.report.key = ids;
        run.emit({ type: 'x:key', data: { ids } });
      },
      obs: (o) => {
        rec.report.obs.push(o);
        run.emit({ type: 'x:obs', data: o as unknown as Record<string, unknown> });
      },
    });
    try {
      await askClaude(prompt, (d) => ap.push(d));
      ap.end();
      run.log(`Claude: summary + ${rec.report.obs.length} observations (DRAFT).`);
    } catch (err) {
      run.log(`Claude analysis didn't run: ${(err as Error).message} The figures are still saved.`, 'error');
    }
    rec.status = 'done';
    store.put('crawls', crawlId, rec);
    phase('done');
    run.end('done');
  } catch (err) {
    rec.status = 'error';
    store.put('crawls', crawlId, rec);
    phase('error');
    throw err;
  }
}

export async function askDoc(args: string, run: LocalRun) {
  const m = args.trim().match(/^(crawl_\w+)\s+([\s\S]+)$/);
  if (!m) throw new UserError('Type your question in the "Ask this document" box on the crawler screen.');
  const rec = store.get<CrawlRecord>('crawls', m[1]);
  if (!rec) throw new UserError('That crawl is no longer saved.');
  const { getRunDetail } = await import('./runs.ts');
  const detail = await getRunDetail(rec.runId);
  const blocks = (detail?.events ?? []).filter((e) => e.type === 'x:doc').flatMap((e) => (e.data as { blocks: DocBlock[] }).blocks);
  if (!blocks.length) throw new UserError("This crawl's text isn't available any more.");
  const budget = (await promptBudget()) - 8_000;
  const doc = fitBytes(docToText(blocks).replace(/\[page (\d+)\]/g, '[§$1]'), Math.max(20_000, budget));
  const prompt = `${SYSTEM}\n\n<document title="${rec.title}">\n${doc.text}\n</document>\n\n${askInstruction(m[2].trim())}`;
  await askClaude(prompt, (d) => run.text(d));
  if (doc.cut) run.log('The filing was too long to send whole, so Claude answered from the first part.', 'warn');
  run.end('done');
}

export function crawlList(): CrawlListItem[] {
  return store
    .all<CrawlRecord>('crawls')
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((c) => ({ id: c.id, runId: c.runId, title: c.title, ticker: c.ticker, form: c.form, createdAt: c.createdAt, status: c.status, attached: !!c.attached }));
}
