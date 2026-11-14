// SEC filings through the viewer's Robinhood connector (the page itself has
// no internet access). Every call shows up in the network strip.

import type { NetLine } from '../../shared/crawl.ts';
import { capability, UserError } from './claudeapp.ts';
import type { LocalRun } from './runs.ts';

export const SERVER = 'robinhood';
let netSeq = 0;

interface Mcp {
  callTool(server: string, tool: string, input?: unknown): Promise<{ payload?: unknown; content?: Array<{ type: string; text?: string }> }>;
  listTools(): Promise<{ servers?: Array<{ name: string }> } & Record<string, unknown>>;
}

function explain(code: string | undefined, message: string) {
  switch (code) {
    case 'server_not_connected':
      return 'Robinhood isn’t connected. Add it in claude.ai → Settings → Connectors, then try again.';
    case 'needs_reauth':
      return 'Your Robinhood connection expired. Reconnect it in claude.ai → Settings → Connectors.';
    case 'not_granted':
    case 'approval_required':
      return 'OFSD needs your OK to use Robinhood. Choose Allow when Claude asks, then try again.';
    case 'rate_limited':
      return 'Robinhood is rate limiting requests. Wait a minute and try again.';
    case 'server_unavailable':
      return 'Robinhood didn’t answer in time. Try again in a moment.';
    case 'tool_error':
      return `Robinhood couldn't do that: ${message.slice(0, 200)}`;
    case 'blocked_by_policy':
      return 'Your organization blocks this connector here.';
    default:
      return `Robinhood request failed (${code ?? 'error'}).`;
  }
}

function net(run: LocalRun, line: NetLine) {
  run.emit({ type: 'x:net', data: line as unknown as Record<string, unknown> });
}

export async function robinhoodConnected(): Promise<boolean> {
  const mcp = await capability<Mcp>('mcp');
  if (!mcp) return false;
  try {
    const res = await mcp.listTools();
    return JSON.stringify(res).toLowerCase().includes('robinhood');
  } catch {
    return false;
  }
}

/** One connector call, reported line by line like a network request. */
export async function rh<T>(run: LocalRun, tool: string, input: Record<string, unknown>, label: string): Promise<T> {
  const mcp = await capability<Mcp>('mcp');
  if (!mcp) throw new UserError('Filings come through your Robinhood connector, which only works inside the Claude app.');
  const id = ++netSeq;
  const url = `mcp://robinhood/${tool}${label ? `/${label}` : ''}`;
  const t0 = performance.now();
  net(run, { id, method: 'CALL', url, phase: 'start' });
  try {
    const res = await mcp.callTool(SERVER, tool, input);
    let payload = res.payload;
    if (payload === undefined) {
      const txt = res.content?.find((c) => c.type === 'text')?.text ?? '';
      try {
        payload = JSON.parse(txt);
      } catch {
        payload = { text: txt };
      }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    net(run, { id, method: 'CALL', url, phase: 'done', status: 200, bytes, ms: Math.round(performance.now() - t0) });
    return payload as T;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const msg = explain(e.code, e.message ?? '');
    net(run, { id, method: 'CALL', url, phase: 'error', ms: Math.round(performance.now() - t0), note: msg });
    throw new UserError(msg);
  }
}
