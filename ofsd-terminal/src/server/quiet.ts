// Node prints an "experimental" warning for its built-in SQLite. It's harmless; hide it.
// Imported first by index.ts so it runs before node:sqlite loads.
const original = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  return (original as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
