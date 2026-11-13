import { useStore, usePref } from '../../lib/store.ts';
import { EmptyState, Row, Section, Switch } from '../../ui/index.tsx';
import { ClusterGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';

const ID = 'thesis';

function Canvas() {
  const setDraft = useStore((s) => s.setDraft);
  return (
    <EmptyState
      glyph={<ClusterGlyph />}
      title="No theses yet"
      text="Pulls the last 24h from your macro and rates accounts, clusters it by theme, and drafts today's view for you to edit."
    >
      <button className="chip" onClick={() => setDraft('/thesis')}>/thesis</button>
    </EmptyState>
  );
}

function Inspector() {
  const [auto, setAuto] = usePref(ID, 'autoRun', false);
  const [time, setTime] = usePref(ID, 'autoTime', '07:30');
  return (
    <>
      <Section title="Accounts" hint="0 handles">
        <div className="dim" style={{ fontSize: 11 }}>Add and tag X handles (rates, Fed, credit, FX, data) in step 3.</div>
      </Section>
      <Section title="Schedule">
        <Row label="Daily auto-run"><Switch on={auto} onChange={setAuto} /></Row>
        <Row label="Time">
          <input className="input mono" style={{ width: 80 }} type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!auto} />
        </Row>
      </Section>
      <Section title="Style rules" hint="Short · casual · no em dashes" defaultOpen={false}>
        <div className="dim" style={{ fontSize: 11 }}>Short paragraphs, casual first person, no em dashes, no hype.</div>
      </Section>
    </>
  );
}

export const thesis: ModuleDef = {
  id: ID,
  title: 'Thesis',
  blurb: 'Daily macro thesis from your X list · sent to private Discord',
  Canvas,
  Inspector,
  commands: [{ name: 'thesis', usage: '/thesis', description: "Draft today's macro thesis.", soon: 'step 3' }],
};
