import { useStore, usePref } from '../../lib/store.ts';
import { EmptyState, Row, Section, Segmented, Select, Switch } from '../../ui/index.tsx';
import { SpiderGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';

const ID = 'crawler';

function Canvas() {
  const setDraft = useStore((s) => s.setDraft);
  return (
    <EmptyState
      glyph={<SpiderGlyph />}
      title="No crawls yet"
      text="Point the spider at an SEC filing or any URL. It reads the real document live and pulls out every figure."
    >
      <button className="chip" onClick={() => setDraft('/crawl NVDA 10-Q')}>/crawl NVDA 10-Q</button>
      <button className="chip" onClick={() => setDraft('/crawl https://')}>/crawl &lt;url&gt;</button>
    </EmptyState>
  );
}

function Inspector() {
  const [source, setSource] = usePref(ID, 'source', 'EDGAR');
  const [form, setForm] = usePref(ID, 'form', '10-Q');
  const [speed, setSpeed] = usePref(ID, 'speed', '1x');
  const [callouts, setCallouts] = usePref(ID, 'callouts', true);
  const [silk, setSilk] = usePref(ID, 'silk', true);
  const [trail, setTrail] = usePref(ID, 'trail', true);
  return (
    <>
      <Section title="Source">
        <Segmented options={['EDGAR', 'URL'] as const} value={source as 'EDGAR' | 'URL'} onChange={setSource} />
        <Row label="Default form">
          <Select options={['10-Q', '10-K', '8-K'] as const} value={form as '10-Q'} onChange={setForm} />
        </Row>
      </Section>
      <Section title="Playback">
        <Segmented options={['0.5x', '1x', '2x', '4x'] as const} value={speed as '1x'} onChange={setSpeed} />
      </Section>
      <Section title="Layers">
        <Row label="Value callouts"><Switch on={callouts} onChange={setCallouts} /></Row>
        <Row label="Silk line"><Switch on={silk} onChange={setSilk} /></Row>
        <Row label="Highlight trail"><Switch on={trail} onChange={setTrail} /></Row>
      </Section>
      <Section title="Report" hint="Key figures · observations" defaultOpen={false}>
        <div className="dim" style={{ fontSize: 11 }}>Report and export appear after the first crawl.</div>
      </Section>
    </>
  );
}

export const crawler: ModuleDef = {
  id: ID,
  title: 'Crawler',
  blurb: 'Live document reading · SEC EDGAR or any URL',
  Canvas,
  Inspector,
  commands: [
    { name: 'crawl', usage: '/crawl NVDA 10-Q | <url>', description: 'Crawl a filing or web page live.', soon: 'step 2' },
  ],
};
