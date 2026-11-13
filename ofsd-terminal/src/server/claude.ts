import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from './env.ts';
import type { Run } from './runs.ts';

export class UserFacingError extends Error {}

export function getClient() {
  const env = getEnv();
  if (!env.anthropicKey) {
    throw new UserFacingError(
      'No Claude API key found. Open ofsd-terminal/.env, paste your key after ANTHROPIC_API_KEY=, save, and try again.',
    );
  }
  return { client: new Anthropic({ apiKey: env.anthropicKey, maxRetries: 2 }), model: env.model };
}

/** Turns SDK errors into plain-English messages for the command log. */
export function explainError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof Anthropic.AuthenticationError)
    return 'Claude rejected the API key. Check ANTHROPIC_API_KEY in .env (it should start with sk-ant-).';
  if (err instanceof Anthropic.PermissionDeniedError)
    return 'This API key is not allowed to use that model. Check CLAUDE_MODEL in .env or your Anthropic Console plan.';
  if (err instanceof Anthropic.NotFoundError)
    return `Model not found. Check CLAUDE_MODEL in .env (currently "${getEnv().model}").`;
  if (err instanceof Anthropic.RateLimitError) {
    const wait = err.headers?.get?.('retry-after');
    return `Claude rate limit hit. Wait ${wait ? `${wait}s` : 'a minute'} and try again.`;
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.message || '';
    if (/credit balance/i.test(msg)) return 'Your Anthropic account is out of credits. Add credits in the Anthropic Console.';
    return `Claude couldn't process that request: ${msg}`;
  }
  if (err instanceof Anthropic.InternalServerError) return 'Claude is having trouble right now (server error). Try again shortly.';
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

interface StreamOpts {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  maxTokens?: number;
}

/**
 * Streams Claude's reply into a run as `text` events and returns the full text.
 * Server-side fallback ("default") is on: if the model declines for policy
 * reasons, Anthropic retries on a fallback model inside the same call.
 */
export async function streamToRun(run: Run, opts: StreamOpts): Promise<string> {
  const { client, model } = getClient();
  const stream = client.beta.messages.stream({
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: opts.messages,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  stream.on('text', (delta) => run.text(delta));
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new UserFacingError("Claude declined to answer this one. Try rephrasing.");
  }
  if (final.stop_reason === 'max_tokens') run.log('Reply hit the length limit and was cut off.', 'warn');
  return final.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}
