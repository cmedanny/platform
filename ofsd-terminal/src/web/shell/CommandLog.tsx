import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { stamp } from '../lib/format.ts';
import { useStore, type LogEntry } from '../lib/store.ts';
import { modules } from '../modules/registry.ts';
import { Badge, Draft, Label } from '../ui/index.tsx';

/** Minimal inline formatting for Claude's plain-text replies: **bold** and `code`. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    return part;
  });
}

function Entry({ e }: { e: LogEntry }) {
  const hasText = e.items.some((i) => i.kind === 'text');
  const lastIsText = e.items[e.items.length - 1]?.kind === 'text';
  const who = !e.module || e.module === 'terminal' ? 'Claude' : (modules.find((m) => m.id === e.module)?.title ?? e.module);
  return (
    <div className="entry">
      <div className="entry__cmd">
        <span className="entry__prompt">›</span>
        <span>{e.command}</span>
        {e.source === 'replay' && <Badge>Replay</Badge>}
        <span className="entry__time">{stamp(e.ts)}</span>
      </div>
      {e.source !== 'local' && (hasText || e.status === 'running') && (
        <div className="entry__meta">
          <span className="entry__who">{who}</span>
          {hasText && <Draft />}
          {e.status === 'running' && <Badge kind="live">Live</Badge>}
        </div>
      )}
      {e.items.map((item, i) =>
        item.kind === 'line' ? (
          <div key={i} className={`entry__line entry__line--${item.level}`}>{item.text}</div>
        ) : (
          <div key={i} className="entry__text">
            {inline(item.text)}
            {e.status === 'running' && lastIsText && i === e.items.length - 1 && <span className="caret" />}
          </div>
        ),
      )}
      {e.status === 'running' && !hasText && e.items.length === 0 && <div className="entry__line">thinking…</div>}
    </div>
  );
}

export function CommandLog() {
  const entries = useStore((s) => s.entries);
  const open = useStore((s) => s.logOpen);
  const setOpen = useStore((s) => s.setLogOpen);
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Stay pinned to the bottom while text streams, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = body.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries, open]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const live = entries.filter((e) => e.status === 'running').length;
  return (
    <section className={`log ${open ? 'log--open' : 'log--closed'}`} aria-label="Command log">
      <div className="log__head">
        <button className="log__head-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Label>Command log</Label>
          <span className="log__count">{entries.length}</span>
          {live > 0 && <Badge kind="live">{live} live</Badge>}
          <span className="log__chev" style={{ marginLeft: 'auto' }}>▾</span>
        </button>
      </div>
      <div className="log__body" ref={body}>
        {entries.length === 0 ? (
          <div className="entry__line" style={{ padding: '6px 0' }}>
            Nothing yet. Type a question, or /help to see commands.
          </div>
        ) : (
          entries.map((e) => <Entry key={e.id} e={e} />)
        )}
      </div>
    </section>
  );
}
