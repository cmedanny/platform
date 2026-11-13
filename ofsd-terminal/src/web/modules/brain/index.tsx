import { usePref } from '../../lib/store.ts';
import { EmptyState, Row, Section, Segmented, Select, Switch } from '../../ui/index.tsx';
import { NetworkGlyph } from '../glyphs.tsx';
import type { ModuleDef } from '../types.ts';

const ID = 'brain';
const FORMS = ['Clusters', 'Grid', 'Timeline', 'Table'] as const;

function Canvas() {
  return (
    <EmptyState
      glyph={<NetworkGlyph />}
      title="Your brain is empty"
      text="Every crawl, thesis and note becomes a node here. Run a crawl or draft a thesis and it shows up automatically."
    />
  );
}

function Inspector() {
  const [form, setForm] = usePref<(typeof FORMS)[number]>(ID, 'form', 'Clusters');
  const [group, setGroup] = usePref(ID, 'group', 'ticker');
  const [order, setOrder] = usePref(ID, 'order', 'newest');
  const [links, setLinks] = usePref(ID, 'links', true);
  return (
    <>
      <Section title="Form">
        <Segmented options={FORMS} value={form} onChange={setForm} wrap />
        <Row label="Links"><Switch on={links} onChange={setLinks} /></Row>
      </Section>
      <Section title="Axes">
        <Row label="Group by">
          <Select options={[{ value: 'ticker', label: 'Ticker' }, { value: 'theme', label: 'Theme' }, { value: 'date', label: 'Date' }]} value={group} onChange={setGroup} />
        </Row>
        <Row label="Order">
          <Select options={[{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }]} value={order} onChange={setOrder} />
        </Row>
      </Section>
    </>
  );
}

export const brain: ModuleDef = {
  id: ID,
  title: 'Brain',
  blurb: 'Every crawl, thesis and note as a node',
  Canvas,
  Inspector,
};
