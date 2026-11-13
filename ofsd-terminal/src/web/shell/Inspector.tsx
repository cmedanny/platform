import { useStore } from '../lib/store.ts';
import type { ModuleDef } from '../modules/types.ts';

/** Collapsible settings panel for the open module, styled like a floating tool panel. */
export function Inspector({ mod }: { mod: ModuleDef }) {
  const open = useStore((s) => s.inspectorOpen && !!mod.Inspector);
  const toggle = useStore((s) => s.toggleInspector);
  const Body = mod.Inspector;
  return (
    <div className={`inspector-wrap ${open ? '' : 'inspector-wrap--closed'}`} aria-hidden={!open}>
      {Body && (
        <aside className="inspector" aria-label={`${mod.title} settings`}>
          <div className="inspector__head">
            <span className="inspector__title">inspector</span>
            <span className="inspector__sub">· {mod.title.toLowerCase()}</span>
            <span className="inspector__actions">
              <button className="iconbtn" onClick={toggle} title="Hide inspector">×</button>
            </span>
          </div>
          <div className="inspector__body">
            <Body />
          </div>
        </aside>
      )}
    </div>
  );
}
