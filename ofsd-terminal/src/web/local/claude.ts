// Claude for the Claude-app version: runs on the viewer's own plan.

import { capability, UserError } from './claudeapp.ts';

interface SampleFn {
  (input: string, opts?: Record<string, unknown>): Promise<{ text: string; truncated: boolean }>;
  limits(): Promise<{ maxPromptBytes: number }>;
}

export async function claudeAvailable() {
  return (await capability('sample')) !== null;
}

export async function promptBudget(): Promise<number> {
  const sample = await capability<SampleFn>('sample');
  try {
    const lim = await sample?.limits();
    return lim?.maxPromptBytes ?? 150_000;
  } catch {
    return 150_000;
  }
}

function explain(code: string | undefined): string {
  switch (code) {
    case 'not_granted':
      return 'You chose not to let OFSD use Claude. Reload the page and choose Allow when asked.';
    case 'rate_limited':
      return "You've reached your Claude usage limit for now, or too many requests ran at once. Try again a bit later.";
    case 'sampling_disabled':
      return "Claude isn't available for this page on your account right now.";
    case 'cancelled':
      return 'Stopped.';
    case 'input_too_large':
    case 'invalid_request':
      return 'That was too much text to send to Claude in one go.';
    default:
      return `Claude couldn't answer (${code ?? 'unknown error'}). Try again.`;
  }
}

/** Streams Claude's answer through onDelta and returns the whole text. */
export async function askClaude(prompt: string, onDelta?: (d: string) => void, tier: 'quick' | 'default' | 'complex' = 'default') {
  const sample = await capability<SampleFn>('sample');
  if (!sample) throw new UserError('Claude is only available when OFSD is open inside the Claude app.');
  try {
    const r = await sample(prompt, { onText: onDelta ? ({ delta }: { delta: string }) => onDelta(delta) : undefined, modelTier: tier, cache: false });
    return r;
  } catch (err) {
    const e = err as { code?: string; text?: string };
    throw new UserError(explain(e.code));
  }
}

/** Keep a prompt within Claude's size limit (UTF-8 bytes). */
export function fitBytes(text: string, maxBytes: number) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return { text, cut: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (enc.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return { text: text.slice(0, lo), cut: true };
}
