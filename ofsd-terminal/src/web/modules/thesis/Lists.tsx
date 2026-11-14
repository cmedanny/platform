import { useEffect, useState } from 'react';
import { HANDLE_TAGS, type ThesisListItem, type XHandle } from '../../../shared/thesis.ts';
import { api } from '../../lib/api.ts';
import { stamp } from '../../lib/format.ts';
import { Badge, Draft, EmptyState } from '../../ui/index.tsx';

function TagToggles({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <span className="tagset">
      {HANDLE_TAGS.map((t) => {
        const on = value.includes(t);
        return (
          <button key={t} className={`tag ${on ? 'tag--on' : ''}`} onClick={() => onChange(on ? value.filter((x) => x !== t) : [...value, t])} aria-pressed={on}>
            {t}
          </button>
        );
      })}
    </span>
  );
}

export function useHandles() {
  const [list, setList] = useState<XHandle[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .get<XHandle[]>('/api/m/thesis/handles')
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);
  return { list, setList, error, setError };
}

export function Accounts() {
  const { list, setList, error, setError } = useHandles();
  const [input, setInput] = useState('');
  const [tags, setTags] = useState<string[]>(['rates']);

  const add = async () => {
    if (!input.trim()) return;
    try {
      const out = await api.post<{ added: number; handles: XHandle[] }>('/api/m/thesis/handles', { handles: input, tags });
      setList(out.handles);
      setInput('');
      setError(out.added ? '' : 'Already in your list.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="th-list">
      <div className="th-addbar">
        <input
          className="input mono"
          value={input}
          placeholder="@handle, or paste several separated by spaces or commas"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <TagToggles value={tags} onChange={setTags} />
        <button className="btn btn--primary" onClick={add}>
          Add
        </button>
      </div>
      {error && <div className="th-err">{error}</div>}
      {list && list.length === 0 ? (
        <EmptyState title="No accounts yet" text="Add the macro, rates, credit and FX accounts you read every morning. Tag each one so the thesis knows what it covers." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Tags</th>
              <th className="num">Last run</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {(list ?? []).map((h) => (
              <tr key={h.handle}>
                <td>
                  <a className="mono th-handle" href={`https://x.com/${h.handle}`} target="_blank" rel="noreferrer">
                    @{h.handle}
                  </a>
                </td>
                <td>
                  <TagToggles
                    value={h.tags}
                    onChange={async (t) => {
                      setList((l) => l && l.map((x) => (x.handle === h.handle ? { ...x, tags: t } : x)));
                      await api.patch(`/api/m/thesis/handles/${encodeURIComponent(h.handle)}`, { tags: t }).catch((e) => setError(e.message));
                    }}
                  />
                </td>
                <td className="num dim">{h.lastCount === null ? '—' : `${h.lastCount} posts`}</td>
                <td>
                  <button
                    className="iconbtn"
                    title={`Remove @${h.handle}`}
                    onClick={async () => setList(await api.del<XHandle[]>(`/api/m/thesis/handles/${encodeURIComponent(h.handle)}`))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const STATUS = { draft: 'Draft', edited: 'Edited', approved: 'Approved', sent: 'Sent' } as const;

export function History({ onOpen, onReplay }: { onOpen: (id: string) => void; onReplay: (runId: string) => void }) {
  const [list, setList] = useState<ThesisListItem[] | null>(null);
  useEffect(() => {
    const load = () => api.get<ThesisListItem[]>('/api/m/thesis/list').then(setList).catch(() => setList([]));
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);
  if (list && !list.length) return <EmptyState title="No theses yet" text="Each daily draft is saved here with the posts it used." />;
  return (
    <div className="th-list">
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 130 }}>When</th>
            <th style={{ width: 90 }}>Status</th>
            <th>Main view</th>
            <th className="num" style={{ width: 70 }}>
              Posts
            </th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {(list ?? []).map((t) => (
            <tr key={t.id} className="th-row" onClick={() => onOpen(t.id)}>
              <td className="mono dim">{stamp(t.createdAt)}</td>
              <td>
                {t.status === 'draft' ? <Draft /> : <Badge kind={t.status === 'sent' || t.status === 'approved' ? 'new' : undefined}>{STATUS[t.status]}</Badge>} {t.auto && <Badge>Auto</Badge>}
              </td>
              <td className="th-preview-cell">{t.view}</td>
              <td className="num dim">{t.posts}</td>
              <td style={{ textAlign: 'right' }}>
                <button
                  className="btn btn--ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReplay(t.runId);
                  }}
                >
                  ▶ Replay
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
