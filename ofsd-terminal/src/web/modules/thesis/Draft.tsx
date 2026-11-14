import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { thesisToText, type ParsedStream, type ThesisDraft, type ThesisRecord, type XPost } from '../../../shared/thesis.ts';
import { api } from '../../lib/api.ts';
import { stamp } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { Badge, Draft as DraftBadge } from '../../ui/index.tsx';

const H = ({ children }: { children: string }) => <div className="th-h">{children}</div>;

function Sources({ refs, posts, onHover }: { refs: string[]; posts: Map<string, XPost>; onHover?: (refs: string[] | null) => void }) {
  if (!refs.length) return null;
  return (
    <span className="th-src">
      {refs.map((r) => {
        const p = posts.get(r);
        if (!p) return null;
        return (
          <a
            key={r}
            className="chip th-chip"
            href={p.url}
            target="_blank"
            rel="noreferrer"
            title={p.text}
            onMouseEnter={() => onHover?.([r])}
            onMouseLeave={() => onHover?.(null)}
          >
            @{p.handle} ↗
          </a>
        );
      })}
    </span>
  );
}

/** The draft as Claude types it, read-only. */
export function LiveDraft({ parsed, posts, typing }: { parsed: ParsedStream; posts: XPost[]; typing: boolean }) {
  const byRef = new Map(posts.map((p) => [p.ref, p]));
  const d = parsed.draft;
  const w = typing ? parsed.writing : null;
  const caret = <span className="caret" />;
  const tagged = parsed.tags.size;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  });
  return (
    <div className="th-draft" ref={body}>
      <div className="th-draft__head">
        <span className="label">Today's thesis</span>
        <DraftBadge />
        {typing && <Badge kind="live">Writing</Badge>}
      </div>
      {!d.view && !d.points.length ? (
        <div className="th-wait mono">
          {posts.length ? `Clustering ${posts.length} posts… ${tagged} tagged` : 'Waiting for posts…'}
          {typing && w === 'tags' && caret}
        </div>
      ) : (
        <>
          <H>Main view</H>
          <p className="th-p">
            {d.view}
            {w === 'view' && caret}
          </p>
          {d.points.length > 0 && <H>Supporting points</H>}
          <ol className="th-points">
            {d.points.map((p, i) => (
              <li key={i}>
                <span>{p.text}</span>
                {w === 'point' && i === d.points.length - 1 && caret}
                <Sources refs={p.refs} posts={byRef} />
              </li>
            ))}
          </ol>
          {d.invalidation && <H>What would invalidate it</H>}
          {d.invalidation && (
            <p className="th-p">
              {d.invalidation}
              {w === 'invalidation' && caret}
            </p>
          )}
          {d.watch.length > 0 && <H>Watch today</H>}
          <ul className="th-watch">
            {d.watch.map((x, i) => (
              <li key={i}>
                {x}
                {w === 'watch' && i === d.watch.length - 1 && caret}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function AutoText({ value, onChange, placeholder, className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} className={`th-input ${className}`} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} rows={1} spellCheck />;
}

const STATUS_LABEL = { draft: 'Draft', edited: 'Edited', approved: 'Approved', sent: 'Sent' } as const;

/** Editable thesis. Autosaves; DRAFT until edited or approved; sends only on an explicit click. */
export function Editor({ rec, onChange, onHover, onDeleted }: { rec: ThesisRecord; onChange: (r: ThesisRecord) => void; onHover: (refs: string[] | null) => void; onDeleted: () => void }) {
  const [d, setD] = useState<ThesisDraft>({ view: rec.view, points: rec.points, invalidation: rec.invalidation, watch: rec.watch });
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const discordOk = useStore((s) => s.health?.keys.discord);
  const dirty = useRef(false);
  const byRef = new Map(rec.posts.map((p) => [p.ref, p]));

  // Autosave edits after a short pause.
  useEffect(() => {
    if (!dirty.current) return;
    setSaving('saving');
    const t = setTimeout(async () => {
      try {
        const out = await api.put<ThesisRecord>(`/api/m/thesis/${rec.id}`, d);
        dirty.current = false;
        setSaving('saved');
        onChange(out);
      } catch (e) {
        setSaving('error');
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<ThesisDraft>) => {
    dirty.current = true;
    setD((x) => ({ ...x, ...patch }));
  };

  const approve = async () => {
    try {
      onChange(await api.post<ThesisRecord>(`/api/m/thesis/${rec.id}/approve`, {}));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    setSending(true);
    setErr('');
    try {
      onChange(await api.post<ThesisRecord>(`/api/m/thesis/${rec.id}/send`, {}));
      setConfirm(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const text = thesisToText(d, rec.posts, new Date(rec.createdAt));
  const isDraft = rec.status === 'draft';

  return (
    <div className="th-draft th-editor">
      <div className="th-draft__head">
        <span className="label">Thesis · {new Date(rec.createdAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
        {isDraft ? <DraftBadge /> : <Badge kind={rec.status === 'approved' || rec.status === 'sent' ? 'new' : undefined}>{STATUS_LABEL[rec.status]}</Badge>}
        {rec.auto && <Badge>Scheduled</Badge>}
        <span className="th-save mono">{saving === 'saving' ? 'saving…' : saving === 'saved' ? 'saved' : saving === 'error' ? 'not saved' : ''}</span>
      </div>

      <H>Main view</H>
      <AutoText value={d.view} onChange={(view) => edit({ view })} placeholder="Your main view for today" />

      <H>Supporting points</H>
      <ol className="th-points th-points--edit">
        {d.points.map((p, i) => (
          <li key={i} onMouseEnter={() => onHover(p.refs)} onMouseLeave={() => onHover(null)}>
            <div className="th-point">
              <AutoText value={p.text} onChange={(t) => edit({ points: d.points.map((x, k) => (k === i ? { ...x, text: t } : x)) })} />
              <button className="iconbtn" title="Remove point" onClick={() => edit({ points: d.points.filter((_, k) => k !== i) })}>
                ×
              </button>
            </div>
            <Sources refs={p.refs} posts={byRef} onHover={onHover} />
          </li>
        ))}
      </ol>
      <button className="btn btn--ghost th-add" onClick={() => edit({ points: [...d.points, { text: '', refs: [] }] })}>
        + Add point
      </button>

      <H>What would invalidate it</H>
      <AutoText value={d.invalidation} onChange={(invalidation) => edit({ invalidation })} placeholder="What would make this wrong" />

      <H>Watch today</H>
      <ul className="th-watch th-watch--edit">
        {d.watch.map((w, i) => (
          <li key={i}>
            <input className="th-input th-input--line" value={w} onChange={(e) => edit({ watch: d.watch.map((x, k) => (k === i ? e.target.value : x)) })} />
            <button className="iconbtn" title="Remove" onClick={() => edit({ watch: d.watch.filter((_, k) => k !== i) })}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn--ghost th-add" onClick={() => edit({ watch: [...d.watch, ''] })}>
        + Add item
      </button>

      {err && <div className="th-err">{err}</div>}

      <div className="th-actions">
        {(rec.status === 'draft' || rec.status === 'edited') && (
          <button className="btn" onClick={approve} title="Mark as reviewed (removes the DRAFT label)">
            Approve
          </button>
        )}
        <button
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setErr("Couldn't copy. Your browser blocked clipboard access.");
            }
          }}
        >
          {copied ? 'Copied' : 'Copy text'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={async () => {
            if (!window.confirm('Delete this thesis? This cannot be undone.')) return;
            await api.del(`/api/m/thesis/${rec.id}`).catch(() => {});
            onDeleted();
          }}
        >
          Delete
        </button>
        <span className="th-actions__spacer" />
        {rec.sentAt && <span className="th-sent mono">sent {stamp(rec.sentAt)} ✓</span>}
        <button className="btn btn--primary" disabled={!discordOk || saving === 'saving'} onClick={() => setConfirm(true)} title={discordOk ? 'Preview, then send to your private Discord channel' : 'Add DISCORD_WEBHOOK_URL to .env first'}>
          {rec.sentAt ? 'Send again…' : 'Send to Discord…'}
        </button>
      </div>
      {!discordOk && <div className="th-hint">Discord isn't connected yet. Add your private channel's webhook to .env (see Settings).</div>}

      {confirm && (
        <div className="th-confirm" role="dialog" aria-label="Send to Discord">
          <div className="th-confirm__box">
            <div className="label">Send to your private Discord channel</div>
            <pre className="th-preview">{text}</pre>
            <div className="th-actions">
              <span className="th-hint">Posts only to the webhook in your .env. Mentions are disabled.</span>
              <span className="th-actions__spacer" />
              <button className="btn" onClick={() => setConfirm(false)}>
                Cancel
              </button>
              <button className="btn btn--primary" disabled={sending} onClick={send}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
