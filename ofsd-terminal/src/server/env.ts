import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const ENV_PATH = join(ROOT, '.env');

export interface Env {
  anthropicKey: string;
  model: string;
  secUserAgent: string;
  twitterKey: string;
  discordWebhook: string;
  port: number;
  /** Test-only overrides so the app can run against local stand-ins. */
  twitterBase: string;
  discordBase: string;
}

const PLACEHOLDER_UA = /your name|you@example\.com/i;

/**
 * Re-reads .env on every call so edits apply without restarting the app.
 * Non-empty values in .env win over shell environment variables.
 */
export function getEnv(): Env {
  let file: Record<string, string> = {};
  if (existsSync(ENV_PATH)) {
    try {
      file = parse(readFileSync(ENV_PATH));
    } catch {
      file = {};
    }
  }
  const v = (k: string) => (file[k]?.trim() || process.env[k] || '').trim();
  return {
    anthropicKey: v('ANTHROPIC_API_KEY'),
    model: v('CLAUDE_MODEL') || 'claude-opus-5-5',
    secUserAgent: v('SEC_USER_AGENT'),
    twitterKey: v('TWITTERAPI_IO_KEY'),
    discordWebhook: v('DISCORD_WEBHOOK_URL'),
    port: Number(v('PORT') || 8787),
    twitterBase: (v('TWITTERAPI_BASE_URL') || 'https://api.twitterapi.io').replace(/\/$/, ''),
    discordBase: v('DISCORD_API_BASE').replace(/\/$/, ''),
  };
}

/** Booleans only. Secrets never leave the backend. */
export function keyStatus(env = getEnv()) {
  return {
    anthropic: env.anthropicKey.length > 10,
    sec: env.secUserAgent.includes('@') && !PLACEHOLDER_UA.test(env.secUserAgent),
    twitter: env.twitterKey.length > 5,
    discord: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(env.discordWebhook),
  };
}
