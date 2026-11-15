import { useState, type ReactNode } from 'react';
import { coverSources, STATE_LABEL, type CoverInfo, type ItemState } from './list';

// Building blocks for Lists (ADR 0005), next to the Goals ones in ui.tsx.

/**
 * A list's cover: its own, or the built-in placeholder. Both themes are named, and the
 * browser loads only the one that matches (a <picture>, so no script decides).
 */
export function Cover({ list, large }: { list: { ref: string; cover: CoverInfo | null; updatedAt: string }; large?: boolean }) {
  const { light, dark } = coverSources(list);
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={dark} />
      <img className={`cover${large ? ' cover-large' : ''}`} src={light} alt="" loading="lazy" decoding="async" />
    </picture>
  );
}

/** "Doing", "Blocked": text in the state's tone on `selection`. Nothing for open or done (the box says those). */
export function StateChip({ state }: { state: ItemState }) {
  if (state === 'open' || state === 'done') return null;
  return <span className={`chip chip-state state-${state}`}>{STATE_LABEL[state]}</span>;
}

/** `#groceries #home`, quietly. */
export function Tags({ tags }: { tags: string[] }) {
  return tags.length ? <p className="list-tags">{tags.map((t) => `#${t}`).join(' ')}</p> : null;
}

/** One tap to open, a second tap to do it: for what changes every item or removes the list. No browser dialog. */
export function Confirm({ label, sure, onConfirm, disabled, variant = 'outline' }: { label: string; sure: string; onConfirm: () => void; disabled?: boolean; variant?: 'outline' | 'link' }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={`btn btn-${variant}`} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="confirm" role="group" aria-label={sure}>
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => { setAsking(false); onConfirm(); }}>
        {sure}
      </button>
      <button type="button" className="btn btn-link" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

/** A small titled block that opens and closes, for the less used controls. */
export function Section({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="list-section" open={open}>
      <summary>{title}</summary>
      <div className="list-section-body">{children}</div>
    </details>
  );
}
