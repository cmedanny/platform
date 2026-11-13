import { useEffect, useState } from 'react';
import { useStore } from './store.ts';

const query = () => window.matchMedia('(prefers-reduced-motion: reduce)');

/** True when the OS asks for less motion, or the user picked "Reduced" in Settings. */
export function useReducedMotion() {
  const pref = useStore((s) => s.motion);
  const [system, setSystem] = useState(() => query().matches);
  useEffect(() => {
    const q = query();
    const on = () => setSystem(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  if (pref === 'reduced') return true;
  if (pref === 'full') return false;
  return system;
}
