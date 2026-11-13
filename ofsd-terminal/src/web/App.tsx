import { useEffect } from 'react';
import { api } from './lib/api.ts';
import { useStore } from './lib/store.ts';
import { modules } from './modules/registry.ts';
import { CommandBar } from './shell/CommandBar.tsx';
import { CommandLog } from './shell/CommandLog.tsx';
import { Inspector } from './shell/Inspector.tsx';
import { Sidebar } from './shell/Sidebar.tsx';
import { TopBar } from './shell/TopBar.tsx';

export function App() {
  const active = useStore((s) => s.active);
  const motion = useStore((s) => s.motion);
  const mod = modules.find((m) => m.id === active) ?? modules[0];

  // ⌘K / Ctrl+K focuses the command bar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useStore.getState().focusBar();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Connection status. Polls so .env edits show up without a reload.
  useEffect(() => {
    const check = () => api.health().then((h) => useStore.getState().setHealth(h)).catch(() => useStore.getState().setHealth(null));
    check();
    const t = setInterval(check, 20000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', check);
    };
  }, []);

  useEffect(() => {
    if (motion === 'system') delete document.documentElement.dataset.motion;
    else document.documentElement.dataset.motion = motion;
  }, [motion]);

  const Canvas = mod.Canvas;
  return (
    <div className="app">
      <Sidebar />
      <main className="workspace">
        <TopBar mod={mod} />
        <div className="body">
          <div className="canvas" key={mod.id}>
            <Canvas />
          </div>
          <Inspector mod={mod} />
        </div>
        <CommandLog />
        <CommandBar />
      </main>
    </div>
  );
}
