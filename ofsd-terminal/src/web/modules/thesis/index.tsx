import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_STYLE, type ThesisListItem, type ThesisRecord, type ThesisSettings } from '../../../shared/thesis.ts';
import { api } from '../../lib/api.ts';
import { execute } from '../../lib/commands.ts';
import { useStore, usePref } from '../../lib/store.ts';
import { EmptyState, Row, Section, Segmented, Switch } from '../../ui/index.tsx';
import { ClusterGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';
import { Editor, LiveDraft } from './Draft.tsx';
import { Field } from './Field.tsx';
import { Accounts, History, useHandles } from './Lists.tsx';
import { closeThesisSession, openThesisSession, useThesisSession } from './session.ts';
import { IS_ARTIFACT } from '../../lib/platform.ts';
import { PastePanel } from './Paste.tsx';
import { hasPendingPosts } from '../../local/thesis.ts';
import './thesis.css';

const ID = 'thesis';
type Tab = 'today' | 'accounts' | 'history';
const setPref = (k: string, v: unknown) => useStore.getState().setPref(ID, k, v);

function phaseText(phase: string, posts: number, handles: number) {
  if (phase === 'fetch') return `fetching ${handles} accounts · ${posts} posts`;
  if (phase === 'analyze') return `clustering ${posts} posts and drafting`;
  if (phase === 'error') return 'failed';
  return 'done';
}

function Today({ goAccounts }: { goAccounts: () => void }) {
  const s = useThesisSession();
  const [thesisId, setThesisId] = usePref<string | null>(ID, 'thesisId', null);
  const [rec, setRec] = useState<ThesisRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<string[] | null>(null);
  const { list: handles } = useHandles();
  const live = !!s && s.active;

  // A live run that just saved a draft becomes the open thesis.
  useEffect(() => {
    if (s?.thesisId && s.thesisId !== thesisId && !s.active) setThesisId(s.thesisId);
  }, [s?.thesisId, s?.active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        let id = thesisId;
        if (!id) {
          const list = await api.get<ThesisListItem[]>('/api/m/thesis/list');
          id = list[0]?.id ?? null;
        }
        const r = id ? await api.get<ThesisRecord>(`/api/m/thesis/${id}`) : null;
        if (alive) setRec(r);
      } catch {
        if (alive) setRec(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [thesisId]);

  const parsed = s?.parsed;
  const posts = live ? s!.posts : (rec?.posts ?? []);
  const themeOf = useMemo(() => {
    if (live) return (ref: string) => s!.parsed.tags.get(ref);
    const m = new Map((rec?.posts ?? []).map((p) => [p.ref, p.theme]));
    return (ref: string) => m.get(ref);
  }, [live, s, rec, s?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const draft = live ? parsed!.draft : rec;
  const cited = useMemo(() => new Set((draft?.points ?? []).flatMap((p) => p.refs)), [draft]);
  const active = useMemo(() => {
    if (hover) return new Set(hover);
    if (live && parsed?.writing === 'point') return new Set(parsed.draft.points.at(-1)?.refs ?? []);
    return new Set<string>();
  }, [hover, live, parsed]);

  if (!live && s?.status === 'error')
    return (
      <div className="th-today">
        <div className="th-fieldwrap">
          <Field key={s.runId} posts={s.posts} themeOf={themeOf} arrived={s.arrived} cited={cited} active={active} />
        </div>
        <div className="th-draft">
          <div className="th-err">{s.error || 'The thesis run failed.'}</div>
          {/accounts/i.test(s.error) && (
            <button className="btn" onClick={goAccounts}>
              Add accounts
            </button>
          )}
        </div>
      </div>
    );

  if (!live && !rec) {
    if (loading) return null;
    const none = !IS_ARTIFACT && handles && handles.length === 0;
    return (
      <EmptyState
        glyph={<ClusterGlyph />}
        title={none ? 'Add your accounts first' : 'No thesis yet'}
        text={
          none
            ? 'Pick the X accounts you read for macro and rates. The thesis builder pulls their last 24 hours each morning.'
            : IS_ARTIFACT
              ? 'Paste today’s posts from your macro and rates accounts. Claude clusters them by theme and drafts today’s view for you to edit.'
              : 'Pull the last 24 hours from your accounts, cluster it by theme, and draft today’s view for you to edit.'
        }
      >
        {none ? (
          <button className="btn btn--primary" onClick={goAccounts}>
            Add accounts
          </button>
        ) : (
          <button className="chip" onClick={() => draftThesis()}>
            /thesis
          </button>
        )}
      </EmptyState>
    );
  }

  // keep the same field (and its particles) when a live run turns into the saved draft
  const fieldKey = live || (s && rec && rec.runId === s.runId) ? s!.runId : rec!.id;
  return (
    <div className="th-today">
      <div className="th-fieldwrap">
        <Field key={fieldKey} posts={posts} themeOf={themeOf} arrived={live ? s!.arrived : undefined} cited={cited} active={active} settled={fieldKey !== s?.runId} />
        {live && (
          <div className="th-status mono">
            <span className="dot dot--live" /> {phaseText(s!.phase, s!.posts.length, s!.handles.length)}
          </div>
        )}
      </div>
      {live ? (
        <LiveDraft parsed={parsed!} posts={s!.posts} typing={s!.phase === 'analyze'} />
      ) : (
        <Editor
          key={rec!.id}
          rec={rec!}
          onChange={setRec}
          onHover={setHover}
          onDeleted={() => {
            setThesisId(null);
            setRec(null);
          }}
        />
      )}
    </div>
  );
}

/** Local server: run /thesis. Claude app: open the paste panel first. */
function draftThesis() {
  if (IS_ARTIFACT) useStore.getState().setPref(ID, 'paste', true);
  else execute('/thesis');
}

function Canvas() {
  const [tab, setTab] = usePref<Tab>(ID, 'tab', 'today');
  const [paste, setPaste] = usePref(ID, 'paste', false);
  const s = useThesisSession();
  return (
    <div className="th">
      <div className="th-tabs">
        <Segmented
          options={[
            { value: 'today', label: 'Today' },
            { value: 'accounts', label: 'Accounts' },
            { value: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {s?.active && (
          <span className="th-tabs__live">
            <span className="dot dot--live" /> Live
          </span>
        )}
        <span className="th-tabs__spacer" />
        <button className="btn btn--primary" onClick={() => draftThesis()} disabled={!!s?.active}>
          Draft today’s thesis
        </button>
        {paste && <PastePanel onClose={() => setPaste(false)} />}
      </div>
      <div className="th-body">
        {tab === 'today' && <Today goAccounts={() => setTab('accounts')} />}
        {tab === 'accounts' && <Accounts />}
        {tab === 'history' && (
          <History
            onOpen={(id) => {
              closeThesisSession();
              setPref('thesisId', id);
              setTab('today');
            }}
            onReplay={(runId) => {
              setTab('today');
              openThesisSession(runId, 'replay');
            }}
          />
        )}
      </div>
    </div>
  );
}

interface ContextCrawl {
  id: string;
  title: string;
  ticker: string | null;
  form: string | null;
}

function Inspector() {
  const [settings, setSettings] = useState<ThesisSettings | null>(null);
  const [style, setStyle] = useState('');
  const [saved, setSaved] = useState('');
  const [ctx, setCtx] = useState<ContextCrawl[]>([]);
  const discord = useStore((s) => s.health?.keys.discord);
  const twitter = useStore((s) => s.health?.keys.twitter);
  const { list: handles } = useHandles();

  useEffect(() => {
    api.get<ThesisSettings>('/api/m/thesis/settings').then((x) => {
      setSettings(x);
      setStyle(x.style);
    });
    api.get<ContextCrawl[]>('/api/m/thesis/context').then(setCtx).catch(() => {});
  }, []);

  const save = async (patch: Partial<ThesisSettings>) => {
    const out = await api.put<ThesisSettings>('/api/m/thesis/settings', patch);
    setSettings(out);
    return out;
  };

  return (
    <>
      <Section title="Run">
        {!IS_ARTIFACT && (
          <Row label="Window">
            <span className="mono dim" style={{ fontSize: 11 }}>last 24h</span>
          </Row>
        )}
        <Row label="Accounts">
          <span className="mono dim" style={{ fontSize: 11 }}>{handles ? handles.length : '—'}</span>
        </Row>
        {IS_ARTIFACT ? (
          <Row label="Posts">
            <span className="dim" style={{ fontSize: 11 }}>pasted in</span>
          </Row>
        ) : (
          <Row label="TwitterAPI.io">
            <span className={`dot ${twitter ? 'dot--ok' : 'dot--off'}`} />
          </Row>
        )}
      </Section>
      {IS_ARTIFACT ? (
        <Section title="Schedule">
          <div className="dim" style={{ fontSize: 10.5 }}>The daily auto-run needs OFSD running on a computer, so it isn't part of this version. Open OFSD and press Draft each morning.</div>
        </Section>
      ) : (
      <Section title="Schedule">
        <Row label="Daily auto-run">
          <Switch on={!!settings?.schedule.enabled} onChange={(enabled) => settings && save({ schedule: { ...settings.schedule, enabled } })} />
        </Row>
        <Row label="Time">
          <input
            className="input mono"
            style={{ width: 84 }}
            type="time"
            value={settings?.schedule.time ?? '07:30'}
            disabled={!settings?.schedule.enabled}
            onChange={(e) => settings && save({ schedule: { ...settings.schedule, time: e.target.value } })}
          />
        </Row>
        <div className="dim" style={{ fontSize: 10.5 }}>Runs once a day while OFSD is open. It only drafts. Nothing is sent until you press Send.</div>
      </Section>
      )}
      <Section title="Style rules">
        <textarea className="input th-style" rows={7} value={style} onChange={(e) => setStyle(e.target.value)} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            className="btn"
            disabled={style === settings?.style}
            onClick={async () => {
              await save({ style });
              setSaved('Saved');
              setTimeout(() => setSaved(''), 1500);
            }}
          >
            Save
          </button>
          <button className="btn btn--ghost" onClick={() => setStyle(DEFAULT_STYLE)}>
            Reset to default
          </button>
          <span className="dim" style={{ fontSize: 10.5 }}>{saved}</span>
        </div>
      </Section>
      <Section title="Extra context" hint={`${ctx.length} attached`}>
        {ctx.length === 0 ? (
          <div className="dim" style={{ fontSize: 10.5 }}>Attach crawls from the crawler’s Report tab and the thesis will use their figures.</div>
        ) : (
          ctx.map((c) => (
            <Row key={c.id} label={c.ticker ? `${c.ticker} ${c.form}` : c.title.slice(0, 26)}>
              <button
                className="iconbtn"
                title="Detach"
                onClick={async () => {
                  await api.post(`/api/m/crawler/${c.id}/attach`, { on: false });
                  setCtx((x) => x.filter((y) => y.id !== c.id));
                }}
              >
                ×
              </button>
            </Row>
          ))
        )}
      </Section>
      <Section title="Discord">
        {!IS_ARTIFACT && (
          <Row label="Webhook">
            <span className={`dot ${discord ? 'dot--ok' : 'dot--off'}`} />
          </Row>
        )}
        <div className="dim" style={{ fontSize: 10.5 }}>
          {IS_ARTIFACT ? 'Use Copy for Discord in the editor, then paste into your private channel.' : discord ? 'Connected to your private channel.' : 'Not set. Add DISCORD_WEBHOOK_URL to .env.'}
        </div>
      </Section>
    </>
  );
}

export const thesis: ModuleDef = {
  id: ID,
  title: 'Thesis',
  blurb: IS_ARTIFACT ? 'Daily macro thesis from posts you paste · copied to Discord' : 'Daily macro thesis from your X list · sent to private Discord',
  Canvas,
  Inspector,
  commands: [
    {
      name: 'thesis',
      usage: '/thesis',
      description: IS_ARTIFACT ? "Draft today's macro thesis from posts you paste." : "Draft today's macro thesis from your X accounts.",
      before: () => {
        if (!IS_ARTIFACT || hasPendingPosts()) return true;
        setPref('tab', 'today');
        setPref('paste', true);
        useStore.getState().open(ID);
        return false;
      },
      onStarted: (runId) => {
        setPref('tab', 'today');
        useStore.getState().open(ID);
        openThesisSession(runId, 'live');
      },
    },
  ],
  onReplay: (run) => {
    setPref('tab', 'today');
    useStore.getState().open(ID);
    openThesisSession(run.id, 'replay');
    return true;
  },
};
