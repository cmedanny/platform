// Thin, typed access to the Claude app's page capabilities (window.claude.use).

/* eslint-disable @typescript-eslint/no-explicit-any */
type Use = (name: string) => Promise<any>;

const use: Use = (name) => {
  const c = (window as unknown as { claude?: { use?: Use } }).claude;
  return c?.use ? c.use(name).catch(() => null) : Promise.resolve(null);
};

const memo = new Map<string, Promise<any>>();
export function capability<T = any>(name: string): Promise<T | null> {
  if (!memo.has(name)) memo.set(name, use(name));
  return memo.get(name)!;
}

export class UserError extends Error {}
