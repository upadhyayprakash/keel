import { useId, type ReactNode } from 'react';
import { cueLabel, fraction } from './format';

// The Goals app's building blocks (designs/SCREENS.md, "Shared across screens").
// Colours only through the CSS variables theme.ts writes from @keel/core palettes.

export function Header({ label = 'goals', action }: { label?: string; action?: ReactNode }) {
  return (
    <header className="top">
      <span className="wordmark" aria-label="keel">
        <span className="chev">›</span>
        <span className="word">keel</span>
      </span>
      <span className="label">{label}</span>
      {action ? <span className="top-action">{action}</span> : null}
    </header>
  );
}

/** A screen title, with a back arrow when there is somewhere to go back to. */
export function ScreenTitle({ title, sub, onBack }: { title: string; sub?: ReactNode; onBack?: () => void }) {
  return (
    <div className="screen-title">
      {onBack ? (
        <button type="button" className="back" onClick={onBack} aria-label="Back">
          ←
        </button>
      ) : null}
      <div>
        <h1 className="title">{title}</h1>
        {sub ? <p className="sub">{sub}</p> : null}
      </div>
    </div>
  );
}

/** A card on `panel`, or on `waitTint` for what the partner says. Tappable when given `onOpen`. */
export function Card({ children, tint, onOpen, label }: { children: ReactNode; tint?: 'wait'; onOpen?: () => void; label?: string }) {
  const className = `card${tint === 'wait' ? ' card-wait' : ''}${onOpen ? ' card-open' : ''}`;
  if (!onOpen) return <section className={className}>{children}</section>;
  // The whole card opens; buttons inside it stop the tap from reaching the card.
  return (
    <section
      className={className}
      role="link"
      tabIndex={0}
      aria-label={label}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      {children}
    </section>
  );
}

/** The bar, then the label the server sends: "4 of 12 done" early, "2 left" past halfway. */
export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  return (
    <div className="progress">
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={label}>
        <div className="progress-fill" style={{ width: `${fraction(done, total) * 100}%` }} />
      </div>
      <p className="progress-label">{label}</p>
    </div>
  );
}

/** "Today 7:00 · park" on `selection`. Nothing when the step has no cue. */
export function CueChip({ cueAt, place, today }: { cueAt: string | null; place: string | null; today: string }) {
  const text = cueLabel(cueAt, place, today);
  return text ? <span className="chip chip-cue">{text}</span> : null;
}

/** "first tiny step", "Missed yesterday": `accent` or `today` text on `accentTint`. */
export function StatusChip({ children, tone = 'accent' }: { children: ReactNode; tone?: 'accent' | 'today' }) {
  return <span className={`chip chip-status tone-${tone}`}>{children}</span>;
}

/** A dot and a line: "Ravi is following this goal" (`wait`), "Missed yesterday: ..." (`today`). */
export function StatusLine({ children, tone }: { children: ReactNode; tone: 'wait' | 'today' | 'late' }) {
  return (
    <p className={`status-line tone-${tone}`}>
      <span className="dot" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/** The round check on Today. `label` names the step, for screen readers. */
export function CheckButton({ checked, label, onCheck, busy }: { checked: boolean; label: string; onCheck: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`check${checked ? ' check-on' : ''}`}
      aria-pressed={checked}
      aria-label={checked ? `${label}, done` : `Mark done: ${label}`}
      disabled={checked || busy}
      onClick={(e) => {
        e.stopPropagation();
        onCheck();
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 12.5l4 4 8-9" />
      </svg>
    </button>
  );
}

/** The square box in step lists. */
export function Checkbox({ checked, label, onChange, disabled }: { checked: boolean; label: ReactNode; onChange?: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="box" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M6 12.5l4 4 8-9" />
        </svg>
      </span>
      <span className="checkbox-label">{label}</span>
    </label>
  );
}

/** "Step 1 of 2" with one segment per step; segments up to `step` are filled. */
export function StepBar({ step, total }: { step: number; total: number }) {
  return (
    <div className="step-bar" role="img" aria-label={`Step ${step} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < step ? 'on' : ''} />
      ))}
    </div>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  placeholder?: string;
  /** Shown under the field in `late`; the border turns `late` too. The fill stays (D22). */
  error?: string | null;
  multiline?: boolean;
  type?: 'text' | 'date' | 'datetime-local';
  /** Earliest date for `type: 'date'`. */
  min?: string;
}

/** A labelled input. `type: 'date'` and `'datetime-local'` use the phone's own pickers. */
export function Field({ label, value, onChange, helper, placeholder, error, multiline, type = 'text', min }: FieldProps) {
  const id = useId();
  const described = [helper ? `${id}-help` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  const common = {
    id,
    value,
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': described,
    className: `input${error ? ' input-error' : ''}`,
  };
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {helper ? (
        <p id={`${id}-help`} className="field-help">
          {helper}
        </p>
      ) : null}
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input {...common} type={type} min={min} onChange={(e) => onChange(e.target.value)} />
      )}
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "1 week · 3 weeks · 6 weeks · Other": one choice, the chosen one in `accent`. */
export function ChoiceChips({ label, options, value, onChange }: { label: string; options: string[]; value: string | null; onChange: (value: string) => void }) {
  return (
    <fieldset className="choices">
      <legend className="field-label">{label}</legend>
      <div className="choice-row">
        {options.map((option) => (
          <button key={option} type="button" className={`choice${option === value ? ' choice-on' : ''}`} aria-pressed={option === value} onClick={() => onChange(option)}>
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Primary (full width, `accent`), outline, or a plain link-style button. */
export function Button({ children, variant = 'primary', onClick, disabled, type = 'button' }: { children: ReactNode; variant?: 'primary' | 'outline' | 'link'; onClick?: () => void; disabled?: boolean; type?: 'button' | 'submit' }) {
  return (
    <button type={type} className={`btn btn-${variant}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
