import { useEffect, useState, type ReactNode } from 'react';
import type { RunStatus } from '../../shared/types.ts';

/** Tiny uppercase letter-spaced label (ARRANGEMENT, FORM, AXES...). */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`label ${className}`}>{children}</span>;
}

/** Collapsible inspector section. */
export function Section({
  title,
  hint,
  children,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`section ${open ? '' : 'section--closed'}`}>
      <button className="section__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <Label>{title}</Label>
          {!open && hint && <div className="section__hint">{hint}</div>}
        </span>
        <span className="section__chev">▾</span>
      </button>
      {open && <div className="section__body">{children}</div>}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row__label">{label}</span>
      <span className="row__control">{children}</span>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  wrap,
  label,
}: {
  options: ReadonlyArray<T | { value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  wrap?: boolean;
  label?: string;
}) {
  return (
    <div className={`seg ${wrap ? 'seg--wrap' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const l = typeof o === 'string' ? o : o.label;
        return (
          <button
            key={v}
            role="radio"
            aria-checked={v === value}
            className={`seg__btn ${v === value ? 'seg__btn--on' : ''}`}
            onClick={() => onChange(v)}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<T | { value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <span className="select">
      <select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label}>
        {options.map((o) => {
          const v = typeof o === 'string' ? o : o.value;
          const l = typeof o === 'string' ? o : o.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </span>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'switch--on' : ''}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Badge({ kind, children }: { kind?: 'draft' | 'live' | 'new' | 'error'; children: ReactNode }) {
  return <span className={`badge ${kind ? `badge--${kind}` : ''}`}>{children}</span>;
}

/** Everything Claude writes carries this until the user edits or approves it. */
export const Draft = () => <Badge kind="draft">Draft</Badge>;

export function StatusDot({ status }: { status: RunStatus }) {
  const cls = status === 'running' ? 'dot--live' : status === 'error' ? 'dot--error' : 'dot--done';
  return <span className={`dot ${cls}`} aria-label={status} />;
}

export function EmptyState({
  glyph,
  title,
  text,
  children,
}: {
  glyph?: ReactNode;
  title: string;
  text?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__inner">
        {glyph && <div className="empty__glyph">{glyph}</div>}
        <div className="empty__title">{title}</div>
        {text && <div className="empty__text">{text}</div>}
        {children && <div className="empty__actions">{children}</div>}
      </div>
    </div>
  );
}

export const SearchIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
    <circle cx="7" cy="7" r="5" />
    <path d="M11 11l3.5 3.5" strokeLinecap="round" />
  </svg>
);

/**
 * A delete-style button that asks for a second click instead of a browser
 * confirm dialog (which the Claude app doesn't show).
 */
export function ConfirmButton({ label, confirmLabel = 'Click again to confirm', onConfirm, className = 'btn btn--ghost', title }: { label: React.ReactNode; confirmLabel?: string; onConfirm: () => void; className?: string; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3500);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`${className} ${armed ? 'btn--armed' : ''}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
