// Commands never print text. They return blocks, and each terminal
// (CLI as ANSI text, browser as HTML) renders them its own way.

export type Tone =
  | 'default'
  | 'muted'
  | 'dim'
  | 'accent'
  | 'late'
  | 'today'
  | 'wait'
  | 'done'
  | 'teal'
  | 'violet'
  | 'pink'
  | 'sky'
  | 'lime'
  | 'amber';

export interface Span {
  text: string;
  tone?: Tone;
  bold?: boolean;
  /** Clickable in the browser: runs `show <ref>`. */
  ref?: string;
  /** External link, e.g. a Slack thread. */
  href?: string;
}

export interface NoteField {
  label: string;
  value: string;
}

export interface Bar {
  label: string;
  value: number;
  display: string;
  tone?: Tone;
}

export type Block =
  | { kind: 'heading'; text: string; tone?: Tone }
  | { kind: 'line'; spans: Span[]; indent?: number }
  | { kind: 'table'; rows: Span[][]; indent?: number }
  | { kind: 'note'; title: Span[]; fields: NoteField[] }
  | { kind: 'bars'; items: Bar[] }
  | { kind: 'status'; level: 'success' | 'warning' | 'error'; spans: Span[] }
  | { kind: 'raw'; text: string }
  | { kind: 'blank' };

export function s(text: string, tone?: Tone, extra: Omit<Span, 'text' | 'tone'> = {}): Span {
  return tone ? { text, tone, ...extra } : { text, ...extra };
}

export const heading = (text: string, tone?: Tone): Block => ({ kind: 'heading', text, tone });
export const line = (spans: Span[] | string, indent = 0): Block => ({
  kind: 'line',
  spans: typeof spans === 'string' ? [s(spans)] : spans,
  indent,
});
export const table = (rows: Span[][], indent = 2): Block => ({ kind: 'table', rows, indent });
export const blank = (): Block => ({ kind: 'blank' });
export const ok = (spans: Span[] | string): Block => status('success', spans);
export const warn = (spans: Span[] | string): Block => status('warning', spans);
export const fail = (spans: Span[] | string): Block => status('error', spans);
export const hint = (text: string): Block => line([s(text, 'muted')], 2);

function status(level: 'success' | 'warning' | 'error', spans: Span[] | string): Block {
  return { kind: 'status', level, spans: typeof spans === 'string' ? [s(spans)] : spans };
}
