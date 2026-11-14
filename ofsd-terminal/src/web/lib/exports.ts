// Crawl exports. The local-server version downloads from the backend; the
// Claude-app version builds the file in the page and offers it through the
// app's own save prompt (pages there can't start downloads themselves).

import type { KeyFigure, Observation } from '../../shared/crawl.ts';
import { capability } from '../local/claudeapp.ts';
import { IS_ARTIFACT } from './platform.ts';

export interface ExportData {
  crawlId: string;
  base: string;
  figures: KeyFigure[];
  key: string[];
  summary: string;
  obs: Observation[];
}

const pct = (c: number | null) => (c === null ? '' : `${(c * 100).toFixed(1)}%`);

function ordered(d: ExportData) {
  const key = new Set(d.key);
  return [...d.key.map((k) => d.figures.find((f) => f.id === k)).filter((f): f is KeyFigure => !!f), ...d.figures.filter((f) => !key.has(f.id))];
}

function csv(d: ExportData) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const key = new Set(d.key);
  const lines = [['key', 'line_item', 'current', 'prior', 'change_pct', 'statement', 'unit', 'section'].join(',')];
  for (const f of ordered(d)) lines.push([key.has(f.id) ? 'yes' : '', f.label, f.current, f.prior, pct(f.change), f.statement, f.unit, f.page].map(esc).join(','));
  return '﻿' + lines.join('\n');
}

let xlsxLib: Promise<unknown> | null = null;
function loadXlsx(): Promise<{ utils: Record<string, (...a: unknown[]) => unknown>; write: (wb: unknown, o: unknown) => ArrayBuffer }> {
  xlsxLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve((window as unknown as { XLSX: unknown }).XLSX);
    s.onerror = () => reject(new Error("Couldn't load the Excel writer."));
    document.head.appendChild(s);
  });
  return xlsxLib as never;
}

async function xlsx(d: ExportData): Promise<ArrayBuffer> {
  const X = await loadXlsx();
  const key = new Set(d.key);
  const figs = [['Key', 'Line item', 'Current', 'Prior', 'Change', 'Statement', 'Unit', 'Section'], ...ordered(d).map((f) => [key.has(f.id) ? '★' : '', f.label, f.current, f.prior, f.change, f.statement, f.unit, f.page])];
  const obs = [['#', 'Observation (DRAFT)', 'Figures'], ...(d.summary ? [['', `Summary: ${d.summary}`, '']] : []), ...d.obs.map((o) => [o.i, o.text, o.refs.map((id) => d.figures.find((f) => f.id === id)?.label ?? id).join('; ')])];
  const wb = X.utils.book_new();
  const s1 = X.utils.aoa_to_sheet(figs) as Record<string, unknown>;
  s1['!cols'] = [{ wch: 5 }, { wch: 44 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 8 }];
  X.utils.book_append_sheet(wb, s1, 'Key figures');
  const s2 = X.utils.aoa_to_sheet(obs) as Record<string, unknown>;
  s2['!cols'] = [{ wch: 4 }, { wch: 110 }, { wch: 30 }];
  X.utils.book_append_sheet(wb, s2, 'Observations');
  return X.write(wb, { bookType: 'xlsx', type: 'array' });
}

/** Returns an error message, or null on success / when the viewer cancels. */
export async function exportCrawl(d: ExportData, fmt: 'csv' | 'xlsx'): Promise<string | null> {
  if (!IS_ARTIFACT) {
    const a = document.createElement('a');
    a.href = `/api/m/crawler/${d.crawlId}/export.${fmt}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return null;
  }
  const downloads = await capability<{ save(r: { filename: string; data: string | ArrayBuffer }): Promise<unknown> }>('downloads');
  if (!downloads) return 'Saving files isn’t available here. Open OFSD in the Claude app.';
  try {
    const data = fmt === 'csv' ? csv(d) : await xlsx(d);
    await downloads.save({ filename: `${d.base}-${fmt === 'csv' ? 'figures.csv' : 'crawl.xlsx'}`, data });
    return null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'cancelled' || code === 'declined' || code === 'dismissed') return null;
    return `Couldn't save the file (${code ?? (err as Error).message}).`;
  }
}
