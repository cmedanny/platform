import { useEffect, useMemo, useRef, useState } from 'react';
import { allCommands, execute } from '../lib/commands.ts';
import { useStore } from '../lib/store.ts';
import { Kbd } from '../ui/index.tsx';

const HISTORY_KEY = 'ofsd-history';
const loadHistory = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
};

export function CommandBar() {
  const [value, setValue] = useState('');
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const history = useRef<string[]>(loadHistory());
  const hIndex = useRef(-1);
  const input = useRef<HTMLInputElement>(null);
  const focusTick = useStore((s) => s.focusTick);
  const draft = useStore((s) => s.draft);
  const live = useStore((s) => s.entries.some((e) => e.status === 'running'));

  useEffect(() => {
    if (focusTick) input.current?.focus();
  }, [focusTick]);
  useEffect(() => {
    if (!draft.tick) return;
    setValue(draft.text);
    setDismissed(true);
    requestAnimationFrame(() => {
      const el = input.current;
      if (el) {
        el.focus();
        el.setSelectionRange(draft.text.length, draft.text.length);
      }
    });
  }, [draft]);

  const suggestions = useMemo(() => {
    const m = value.match(/^\/(\S*)$/);
    if (!m || dismissed) return [];
    return allCommands().filter((c) => !c.hidden && c.name.startsWith(m[1].toLowerCase()));
  }, [value, dismissed]);
  const showSuggest = suggestions.length > 0;

  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    history.current = [t, ...history.current.filter((h) => h !== t)].slice(0, 50);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.current));
    } catch {
      /* private mode: history just won't persist */
    }
    hIndex.current = -1;
    setValue('');
    setDismissed(false);
    execute(t);
  };

  const complete = (name: string) => {
    setValue(`/${name} `);
    setDismissed(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (showSuggest) {
      if (e.key === 'ArrowDown') return e.preventDefault(), setSel((sel + 1) % suggestions.length);
      if (e.key === 'ArrowUp') return e.preventDefault(), setSel((sel - 1 + suggestions.length) % suggestions.length);
      if (e.key === 'Tab') return e.preventDefault(), complete(suggestions[sel].name);
      if (e.key === 'Escape') return e.preventDefault(), setDismissed(true);
      if (e.key === 'Enter') {
        const c = suggestions[sel];
        const typed = value.slice(1).toLowerCase();
        const takesArgs = /[<|]/.test(c.usage);
        if (typed !== c.name || takesArgs) {
          e.preventDefault();
          if (typed === c.name && takesArgs) setValue(`/${c.name} `), setDismissed(true);
          else if (takesArgs) complete(c.name);
          else submit(`/${c.name}`);
          return;
        }
      }
    }
    if (e.key === 'Enter') return e.preventDefault(), submit(value);
    if (e.key === 'Escape') return input.current?.blur();
    if (e.key === 'ArrowUp' && history.current.length) {
      e.preventDefault();
      hIndex.current = Math.min(hIndex.current + 1, history.current.length - 1);
      setValue(history.current[hIndex.current]);
      setDismissed(true);
    }
    if (e.key === 'ArrowDown' && hIndex.current >= 0) {
      e.preventDefault();
      hIndex.current -= 1;
      setValue(hIndex.current >= 0 ? history.current[hIndex.current] : '');
      setDismissed(true);
    }
  };

  return (
    <div className="bar">
      {showSuggest && (
        <div className="suggest" role="listbox">
          {suggestions.map((c, i) => (
            <button
              key={c.name}
              role="option"
              aria-selected={i === sel}
              className={`suggest__item ${i === sel ? 'suggest__item--on' : ''}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(c.name);
                input.current?.focus();
              }}
            >
              <span className="suggest__usage">{c.usage}</span>
              <span className="suggest__desc">
                {c.description}
                {c.soon && <span className="suggest__soon">· {c.soon}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <span className="bar__prompt">›</span>
      <input
        ref={input}
        className="bar__input"
        value={value}
        placeholder="Ask anything, or type / for commands"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setValue(e.target.value);
          setSel(0);
          setDismissed(false);
          hIndex.current = -1;
        }}
        onKeyDown={onKeyDown}
        aria-label="Command bar"
      />
      <div className="bar__hints">
        {live && <span className="bar__busy"><span className="dot dot--live" /> Live</span>}
        <span><Kbd>/</Kbd> commands</span>
        <span><Kbd>↵</Kbd> run</span>
        <span><Kbd>⌘K</Kbd> focus</span>
      </div>
    </div>
  );
}
