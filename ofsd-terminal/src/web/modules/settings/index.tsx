import type { Health } from '../../../shared/types.ts';
import { useStore } from '../../lib/store.ts';
import { Label, Section, Segmented } from '../../ui/index.tsx';
import type { ModuleDef } from '../types.ts';

const CONNECTIONS: Array<{ key: keyof Health['keys']; name: string; env: string; used: string; how: string }> = [
  { key: 'anthropic', name: 'Claude', env: 'ANTHROPIC_API_KEY', used: 'Everything', how: 'console.anthropic.com → API Keys → Create Key' },
  { key: 'sec', name: 'SEC EDGAR', env: 'SEC_USER_AGENT', used: 'Crawler (step 2)', how: 'No signup. Put your name and email in quotes.' },
  { key: 'twitter', name: 'TwitterAPI.io', env: 'TWITTERAPI_IO_KEY', used: 'Thesis (step 3)', how: 'twitterapi.io → sign up → copy API key' },
  { key: 'discord', name: 'Discord webhook', env: 'DISCORD_WEBHOOK_URL', used: 'Thesis (step 3)', how: 'Private channel → Edit Channel → Integrations → Webhooks' },
];

function Canvas() {
  const health = useStore((s) => s.health);
  const offline = useStore((s) => s.offline);
  return (
    <div style={{ padding: '18px 22px', maxWidth: 880 }}>
      <Label>Connections</Label>
      {offline && (
        <p style={{ color: 'var(--red)', fontSize: 12 }}>Backend offline. Start it with npm start in the ofsd-terminal folder.</p>
      )}
      <table className="table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 24 }} />
            <th>Service</th>
            <th>.env line</th>
            <th>Used by</th>
            <th>Where to get it</th>
          </tr>
        </thead>
        <tbody>
          {CONNECTIONS.map((c) => {
            const ok = health?.keys[c.key];
            return (
              <tr key={c.key}>
                <td><span className={`dot ${ok ? 'dot--ok' : 'dot--off'}`} /></td>
                <td className="bright">{c.name}<div className="dim" style={{ fontSize: 10 }}>{ok ? 'Connected' : 'Not set'}</div></td>
                <td className="mono" style={{ color: 'var(--cyan)' }}>{c.env}</td>
                <td className="dim">{c.used}</td>
                <td className="dim">{c.how}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 22, display: 'grid', gridTemplateColumns: '140px 1fr', rowGap: 8, fontSize: 12 }}>
        <span className="dim">Claude model</span>
        <span className="mono bright">{health?.model ?? '—'}</span>
        <span className="dim">Settings file</span>
        <span className="mono" style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{health?.envPath ?? '—'}</span>
        <span className="dim">Privacy</span>
        <span className="dim">Keys stay in that file on your computer. The browser only ever sees connected / not set.</span>
      </div>
      <p className="dim" style={{ marginTop: 18, fontSize: 11 }}>
        Edit the file, save it, and this page updates within ~20 seconds. No restart needed.
      </p>
    </div>
  );
}

function Inspector() {
  const motion = useStore((s) => s.motion);
  const setMotion = useStore((s) => s.setMotion);
  const clearLog = useStore((s) => s.clearLog);
  return (
    <>
      <Section title="Motion">
        <Segmented
          options={[{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }]}
          value={motion}
          onChange={setMotion}
        />
        <div className="dim" style={{ fontSize: 10.5 }}>System follows your OS "reduce motion" setting.</div>
      </Section>
      <Section title="Command log">
        <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={clearLog}>Clear log</button>
        <div className="dim" style={{ fontSize: 10.5 }}>Runs stay saved. Only the on-screen log clears.</div>
      </Section>
    </>
  );
}

export const settings: ModuleDef = {
  id: 'settings',
  title: 'Settings',
  blurb: 'Keys, model and motion',
  Canvas,
  Inspector,
  placement: 'footer',
  stats: false,
};
