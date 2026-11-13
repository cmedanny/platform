import ExcelJS from 'exceljs';
import type { CrawlListItem, CrawlMeta, DocBlock, KeyFigure, Observation } from '../../shared/crawl.ts';
import { explainError, streamClaude, UserFacingError } from '../claude.ts';
import { analysisMessages, AnalysisParser, askMessages, docBlock, docToText, MAX_DOC_CHARS, SYSTEM } from '../crawler/analyze.ts';
import { fetchFilingDoc, findExhibit99, FORMS, latestFiling, lookupTicker, type Form } from '../crawler/edgar.ts';
import { Extractor, type ValueRow } from '../crawler/extract.ts';
import { fetchStream } from '../crawler/fetch.ts';
import { HtmlStreamParser } from '../crawler/parse.ts';
import { db, newId } from '../db.ts';
import { keyStatus } from '../env.ts';
import type { Run } from '../runs.ts';
import type { ServerModule } from './types.ts';

const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OFSD-Terminal/0.2 Safari/537.36';

type CrawlRow = {
  id: string;
  run_id: string;
  kind: string;
  ticker: string | null;
  form: string | null;
  url: string;
  title: string;
  company: string | null;
  cik: string | null;
  accession: string | null;
  period: string | null;
  filed: string | null;
  status: string;
  created_at: number;
  figures: string | null;
  vals: string | null;
  report: string | null;
  text: string | null;
  attached: number;
};

interface Report {
  summary: string;
  key: string[];
  obs: Observation[];
}

function parseTarget(args: string) {
  const a = args.trim();
  if (!a) throw new UserFacingError('Tell me what to crawl: /crawl NVDA 10-Q, /crawl AAPL 8-K, or /crawl https://example.com/page');
  if (/^https?:\/\//i.test(a) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(a) && a.includes('.') && !/^[A-Z]{1,5}\.[A-Z]$/.test(a))) {
    const url = /^https?:\/\//i.test(a) ? a : `https://${a}`;
    try {
      new URL(url);
    } catch {
      throw new UserFacingError(`"${a}" doesn't look like a valid URL.`);
    }
    return { kind: 'url' as const, url };
  }
  const [ticker, formRaw = '10-Q', ...rest] = a.split(/\s+/);
  if (rest.length) throw new UserFacingError('Use /crawl TICKER FORM, like /crawl NVDA 10-Q.');
  if (!/^[A-Za-z][A-Za-z0-9.-]{0,9}$/.test(ticker)) throw new UserFacingError(`"${ticker}" isn't a valid ticker.`);
  const norm = formRaw.toUpperCase().replace(/^(10|8)-?/, '$1-') as Form;
  if (!FORMS.includes(norm)) throw new UserFacingError(`Form "${formRaw}" isn't supported. Use 10-Q, 10-K or 8-K.`);
  return { kind: 'edgar' as const, ticker, form: norm };
}

async function crawl(args: string, run: Run) {
  const target = parseTarget(args);
  const crawlId = newId('crawl');
  db.prepare('INSERT INTO crawls (id, run_id, kind, ticker, form, url, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    crawlId,
    run.id,
    target.kind,
    target.kind === 'edgar' ? target.ticker.toUpperCase() : null,
    target.kind === 'edgar' ? target.form : null,
    target.kind === 'url' ? target.url : '',
    target.kind === 'edgar' ? `${target.ticker.toUpperCase()} ${target.form}` : target.url,
    'running',
    Date.now(),
  );
  const fail = () => db.prepare("UPDATE crawls SET status = 'error' WHERE id = ?").run(crawlId);
  const meta: CrawlMeta = { crawlId, kind: target.kind, title: '', url: '' };
  const phase = (p: string) => run.emit({ type: 'x:phase', data: { phase: p } });
  const sendMeta = () => run.emit({ type: 'x:crawl', data: { ...meta } as unknown as Record<string, unknown> });

  try {
    phase('resolve');
    const docs: Array<{ url: string; label?: string }> = [];
    let currentYear = new Date().getFullYear();
    if (target.kind === 'edgar') {
      meta.ticker = target.ticker.toUpperCase();
      meta.form = target.form;
      meta.title = `${meta.ticker} ${target.form}`;
      sendMeta();
      const t = await lookupTicker(run, target.ticker);
      run.log(`${t.ticker} → ${t.company} (CIK ${t.cik})`);
      const f = await latestFiling(run, t.cik, target.form);
      run.log(`Latest ${target.form}: filed ${f.filed}, period ${f.period || 'n/a'}, accession ${f.accession}`);
      Object.assign(meta, { company: f.company, cik: String(t.cik), filed: f.filed, period: f.period, url: f.url });
      currentYear = Number((f.period || f.filed).slice(0, 4)) || currentYear;
      docs.push({ url: f.url });
      if (target.form === '8-K') {
        const ex = await findExhibit99(run, f.folder);
        if (ex) {
          docs.push({ url: ex, label: 'Exhibit 99' });
          run.log('Found exhibit 99 (press release). Reading it after the cover.');
        }
      }
      db.prepare('UPDATE crawls SET company = ?, cik = ?, accession = ?, period = ?, filed = ?, url = ? WHERE id = ?').run(
        f.company,
        String(t.cik),
        f.accession,
        f.period,
        f.filed,
        f.url,
        crawlId,
      );
    } else {
      meta.url = target.url;
      meta.title = new URL(target.url).hostname;
      docs.push({ url: target.url });
    }
    sendMeta();

    // Fetch + parse, streaming. Raw bytes and parsed blocks go out as they land.
    phase('fetch');
    const ex = new Extractor(currentYear);
    const blocks: DocBlock[] = [];
    let pending: DocBlock[] = [];
    let lastFlush = Date.now();
    const flush = () => {
      if (!pending.length) return;
      run.emit({ type: 'x:doc', data: { blocks: pending } });
      pending = [];
      lastFlush = Date.now();
    };
    const onBlock = (b: DocBlock) => {
      blocks.push(b);
      pending.push(b);
      if (pending.length >= 40 || Date.now() - lastFlush > 80) flush();
    };
    let rawOffset = 0;
    let parser = new HtmlStreamParser(ex, onBlock);
    let pageTitle = '';
    for (let d = 0; d < docs.length; d++) {
      const doc = docs[d];
      if (d > 0) {
        parser = new HtmlStreamParser(ex, onBlock, { startId: parser.nextBlockId, startPage: parser.page, srcBase: rawOffset });
        parser.section(doc.label ?? 'Attachment', rawOffset);
      }
      let plain: boolean | null = null;
      let plainBuf = '';
      const base = rawOffset;
      const res = await (target.kind === 'edgar' ? fetchFilingDoc : (r: Run, u: string, cb: (s: string) => void) => fetchStream(r, u, { userAgent: WEB_UA, onChunk: cb }))(
        run,
        doc.url,
        (chunk) => {
          if (plain === null) plain = !/<[a-z!?]/i.test(chunk.slice(0, 2000));
          run.emit({ type: 'x:raw', data: { o: rawOffset, s: chunk } });
          rawOffset += chunk.length;
          if (plain) plainBuf += chunk;
          else parser.feed(chunk);
        },
      );
      if (/application\/pdf/i.test(res.contentType)) throw new UserFacingError("That link is a PDF. PDFs aren't supported yet. Try the filing's HTML version.");
      if (/^(image|video|audio)\//i.test(res.contentType)) throw new UserFacingError(`That link is a ${res.contentType.split(';')[0]}, not a document.`);
      if (plain) parser.feedPlain(plainBuf, base);
      parser.end();
      if (d === 0) pageTitle = parser.title;
      flush();
    }
    if (target.kind === 'url' && pageTitle) {
      meta.title = pageTitle.slice(0, 120);
      sendMeta();
    }
    if (!blocks.some((b) => b.t !== 'pb')) throw new UserFacingError("Fetched the page but found no readable text. It may need JavaScript to render, which the crawler can't run.");

    const pages = blocks.reduce((m, b) => Math.max(m, b.page), 1);
    const stmts = Object.fromEntries(blocks.filter((b) => b.t === 'table' && b.stmt).map((b) => [(b as { stmt: string }).stmt, b.id]));
    run.emit({ type: 'x:parsed', data: { blocks: blocks.length, pages, ...ex.counts, figures: ex.figures.length, stmts } });
    run.emit({ type: 'x:figures', data: { list: ex.figures } });
    run.log(`Parsed ${blocks.length.toLocaleString()} blocks over ${pages} pages · ${ex.counts.values.toLocaleString()} values · ${ex.figures.length} statement line items.`);

    let text = docToText(blocks);
    if (text.length > MAX_DOC_CHARS) {
      run.log(`Document is very long (${Math.round(text.length / 1000)}k chars). Claude will see the first ${Math.round(MAX_DOC_CHARS / 1000)}k.`, 'warn');
      text = text.slice(0, MAX_DOC_CHARS);
    }
    db.prepare('UPDATE crawls SET title = ?, doc = ?, figures = ?, vals = ?, text = ?, stats = ? WHERE id = ?').run(
      meta.title,
      JSON.stringify(blocks),
      JSON.stringify(ex.figures),
      JSON.stringify(ex.values),
      text,
      JSON.stringify({ pages, ...ex.counts, figures: ex.figures.length }),
      crawlId,
    );

    // Claude's analysis. The crawl is still useful without it.
    phase('analyze');
    const report: Report = { summary: '', key: [], obs: [] };
    if (!keyStatus().anthropic) {
      run.log('No Claude key in .env, so skipping the summary and observations. The figures table still works.', 'warn');
    } else {
      run.log('Claude is reading the document…');
      const ap = new AnalysisParser({
        summary: (s) => {
          report.summary = s;
          run.emit({ type: 'x:summary', data: { text: s } });
        },
        key: (ids) => {
          report.key = ids;
          run.emit({ type: 'x:key', data: { ids } });
        },
        obs: (o) => {
          report.obs.push(o);
          run.emit({ type: 'x:obs', data: o as unknown as Record<string, unknown> });
        },
      });
      try {
        await streamClaude({
          system: SYSTEM,
          messages: analysisMessages(docBlock(meta.title, meta.url, text), ex.figures),
          maxTokens: 8000,
          onText: (d) => ap.push(d),
        });
        ap.end();
        run.log(`Claude: summary + ${report.obs.length} observations (DRAFT).`);
      } catch (err) {
        run.log(`Claude analysis failed: ${explainError(err)} The extracted figures are still saved.`, 'error');
      }
    }
    db.prepare("UPDATE crawls SET report = ?, status = 'done' WHERE id = ?").run(JSON.stringify(report), crawlId);
    phase('done');
    run.end('done');
  } catch (err) {
    fail();
    phase('error');
    throw err;
  }
}

async function askDoc(args: string, run: Run) {
  const m = args.trim().match(/^(crawl_\w+)\s+([\s\S]+)$/);
  if (!m) throw new UserFacingError('Usage: type your question in the "Ask this document" box on the crawler screen.');
  const row = db.prepare('SELECT title, url, text FROM crawls WHERE id = ?').get(m[1]) as Pick<CrawlRow, 'title' | 'url' | 'text'> | undefined;
  if (!row?.text) throw new UserFacingError("That crawl isn't finished or has no text to ask about.");
  run.emit({ type: 'x:ask', data: { crawlId: m[1] } });
  const { cacheRead } = await streamClaude({
    system: SYSTEM,
    messages: askMessages(docBlock(row.title, row.url, row.text), m[2].trim()),
    maxTokens: 8000,
    onText: (d) => run.text(d),
    onTruncated: () => run.log('Answer hit the length limit and was cut off.', 'warn'),
  });
  if (cacheRead > 0) run.log(`Reused cached document (${cacheRead.toLocaleString()} tokens).`);
  run.end('done');
}

function loadCrawl(id: string) {
  return db.prepare('SELECT * FROM crawls WHERE id = ?').get(id) as CrawlRow | undefined;
}

const fmtPct = (c: number | null) => (c === null ? '' : `${(c * 100).toFixed(1)}%`);

export const crawler: ServerModule = {
  id: 'crawler',
  title: 'Crawler',
  migrations: [
    [
      'crawler:001-crawls',
      `CREATE TABLE crawls (
         id TEXT PRIMARY KEY,
         run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
         kind TEXT NOT NULL,
         ticker TEXT, form TEXT, url TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
         company TEXT, cik TEXT, accession TEXT, period TEXT, filed TEXT,
         status TEXT NOT NULL, created_at INTEGER NOT NULL,
         doc TEXT, figures TEXT, vals TEXT, report TEXT, text TEXT, stats TEXT,
         attached INTEGER NOT NULL DEFAULT 0
       );
       CREATE INDEX crawls_created ON crawls(created_at DESC);`,
    ],
  ],
  commands: {
    crawl: { description: 'Crawl an SEC filing (/crawl NVDA 10-Q) or any URL live.', run: crawl },
    askdoc: { description: 'Ask a question about a crawled document.', run: askDoc },
  },
  records: () => (db.prepare("SELECT COUNT(*) AS n FROM crawls WHERE status = 'done'").get() as { n: number }).n,
  routes: (r) => {
    r.get('/list', (_req, res) => {
      const rows = db
        .prepare('SELECT id, run_id, title, ticker, form, created_at, status, attached FROM crawls ORDER BY created_at DESC LIMIT 100')
        .all() as Array<Pick<CrawlRow, 'id' | 'run_id' | 'title' | 'ticker' | 'form' | 'created_at' | 'status' | 'attached'>>;
      const list: CrawlListItem[] = rows.map((x) => ({
        id: x.id,
        runId: x.run_id,
        title: x.title,
        ticker: x.ticker,
        form: x.form,
        createdAt: x.created_at,
        status: x.status,
        attached: !!x.attached,
      }));
      res.json(list);
    });
    r.post('/:id/attach', (req, res) => {
      const on = !!req.body?.on;
      const out = db.prepare('UPDATE crawls SET attached = ? WHERE id = ?').run(on ? 1 : 0, req.params.id);
      if (!out.changes) res.status(404).json({ error: 'Crawl not found.' });
      else res.json({ ok: true, attached: on });
    });
    r.get('/:id/export.:fmt', async (req, res) => {
      const row = loadCrawl(req.params.id);
      if (!row || !row.figures) {
        res.status(404).json({ error: 'Crawl not found or not finished.' });
        return;
      }
      const figs = JSON.parse(row.figures) as KeyFigure[];
      const vals = JSON.parse(row.vals ?? '[]') as ValueRow[];
      const report = (row.report ? JSON.parse(row.report) : { summary: '', key: [], obs: [] }) as Report;
      const key = new Set(report.key);
      const ordered = [...report.key.map((k) => figs.find((f) => f.id === k)).filter((f): f is KeyFigure => !!f), ...figs.filter((f) => !key.has(f.id))];
      const base = (row.ticker ? `${row.ticker}-${row.form}` : 'crawl').replace(/[^\w-]+/g, '_');
      if (req.params.fmt === 'csv') {
        const esc = (v: unknown) => {
          const s = v === null || v === undefined ? '' : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [['key', 'line_item', 'current', 'prior', 'change_pct', 'statement', 'unit', 'page'].join(',')];
        for (const f of ordered) lines.push([key.has(f.id) ? 'yes' : '', f.label, f.current, f.prior, fmtPct(f.change), f.statement, f.unit, f.page].map(esc).join(','));
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${base}-figures.csv"` });
        res.send('﻿' + lines.join('\n'));
        return;
      }
      if (req.params.fmt !== 'xlsx') {
        res.status(400).json({ error: 'Use .csv or .xlsx' });
        return;
      }
      const wb = new ExcelJS.Workbook();
      wb.creator = 'OFSD Terminal';
      const head = (ws: ExcelJS.Worksheet) => {
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
      };
      const s1 = wb.addWorksheet('Key figures');
      s1.columns = [
        { header: 'Key', key: 'key', width: 6 },
        { header: 'Line item', key: 'label', width: 44 },
        { header: 'Current', key: 'current', width: 14, style: { numFmt: '#,##0.##;(#,##0.##)' } },
        { header: 'Prior', key: 'prior', width: 14, style: { numFmt: '#,##0.##;(#,##0.##)' } },
        { header: 'Change', key: 'change', width: 10, style: { numFmt: '0.0%' } },
        { header: 'Statement', key: 'statement', width: 14 },
        { header: 'Unit', key: 'unit', width: 10 },
        { header: 'Page', key: 'page', width: 6 },
      ];
      for (const f of ordered) s1.addRow({ key: key.has(f.id) ? '★' : '', label: f.label, current: f.current, prior: f.prior, change: f.change, statement: f.statement, unit: f.unit, page: f.page });
      head(s1);
      const s2 = wb.addWorksheet('Observations (DRAFT)');
      s2.columns = [
        { header: '#', key: 'i', width: 4 },
        { header: 'Observation', key: 'text', width: 110 },
        { header: 'Figures', key: 'refs', width: 30 },
      ];
      if (report.summary) s2.addRow({ i: '', text: `Summary: ${report.summary}`, refs: '' });
      for (const o of report.obs) s2.addRow({ i: o.i, text: o.text, refs: o.refs.map((id) => figs.find((f) => f.id === id)?.label ?? id).join('; ') });
      s2.getColumn('text').alignment = { wrapText: true, vertical: 'top' };
      head(s2);
      const s3 = wb.addWorksheet('All values');
      s3.columns = [
        { header: 'Line item', key: 'label', width: 44 },
        { header: 'As printed', key: 'text', width: 14 },
        { header: 'Value', key: 'value', width: 14 },
        { header: 'Period', key: 'tone', width: 10 },
        { header: 'Column', key: 'column', width: 8 },
        { header: 'Statement', key: 'statement', width: 14 },
        { header: 'Page', key: 'page', width: 6 },
      ];
      for (const v of vals) s3.addRow({ ...v, tone: v.tone === 'current' ? 'current' : 'prior', column: v.column + 1 });
      head(s3);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${base}-crawl.xlsx"`,
      });
      res.send(Buffer.from(await wb.xlsx.writeBuffer()));
    });
  },
};
