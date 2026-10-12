import type { Block, Span } from './blocks';

/** Decorates a piece of text. The CLI passes an ANSI painter; plain output passes nothing. */
export type Paint = (text: string, span: Pick<Span, 'tone' | 'bold'>) => string;

const plain: Paint = (text) => text;

const MARKS = { success: '✓', warning: '!', error: '✗' } as const;
const MARK_TONES = { success: 'done', warning: 'today', error: 'late' } as const;

export function renderText(blocks: Block[], paint: Paint = plain): string {
  const out: string[] = [];
  const spans = (list: Span[]) => list.map((sp) => paint(sp.text, sp)).join('');

  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push(paint(b.text, { tone: b.tone, bold: true }));
        break;
      case 'line':
        out.push(' '.repeat(b.indent ?? 0) + spans(b.spans));
        break;
      case 'blank':
        out.push('');
        break;
      case 'raw':
        out.push(b.text);
        break;
      case 'status':
        out.push(`${paint(MARKS[b.level], { tone: MARK_TONES[b.level], bold: true })} ${spans(b.spans)}`);
        break;
      case 'note': {
        out.push(`${paint('◆', { tone: 'accent' })} ${spans(b.title)}`);
        const width = Math.max(...b.fields.map((f) => f.label.length), 0) + 2;
        for (const f of b.fields) {
          out.push(`${paint('│', { tone: 'muted' })} ${paint((f.label + ':').padEnd(width), { tone: 'muted' })}${f.value}`);
        }
        break;
      }
      case 'bars': {
        const max = Math.max(...b.items.map((i) => i.value), 1);
        const labelWidth = Math.max(...b.items.map((i) => i.label.length), 0) + 2;
        for (const i of b.items) {
          const len = Math.max(1, Math.round((i.value / max) * 20));
          const bar = '█'.repeat(len).padEnd(22);
          out.push(`  ${paint(i.label.padEnd(labelWidth), { tone: i.tone })}${paint(bar, { tone: i.tone })}${i.display}`);
        }
        break;
      }
      case 'table': {
        const cols = Math.max(...b.rows.map((r) => r.length), 0);
        const widths = Array.from({ length: cols }, (_, c) =>
          Math.max(...b.rows.map((r) => (r[c] ? r[c].text.length : 0))),
        );
        for (const row of b.rows) {
          const cells = row.map((cell, c) => {
            const last = c === row.length - 1;
            const padded = last ? cell.text : cell.text.padEnd(widths[c] ?? 0);
            return paint(padded, cell);
          });
          out.push(' '.repeat(b.indent ?? 0) + cells.join('  ').trimEnd());
        }
        break;
      }
    }
  }
  return out.join('\n');
}
