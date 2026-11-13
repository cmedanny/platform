const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export function clock(d = new Date()) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function stamp(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return sameDay ? time : `${MONTHS[d.getMonth()]} ${d.getDate()} ${time}`;
}

export function duration(ms: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function dayKey(ms: number) {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
