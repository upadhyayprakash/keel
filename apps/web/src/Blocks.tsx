import type { CSSProperties } from 'react';
import type { Block, Span, Tone } from '@keel/core/ui';

const toneColor = (tone?: Tone): CSSProperties => (tone ? { color: `var(--t-${tone})` } : {});

const MARKS = { success: ['✓', 'done'], warning: ['!', 'today'], error: ['✗', 'late'] } as const;

export function SpanView({ span, onRef }: { span: Span; onRef: (ref: string) => void }) {
  const style: CSSProperties = { ...toneColor(span.tone), fontWeight: span.bold ? 700 : undefined };
  if (span.ref) {
    return (
      <button type="button" className="ref" style={style} onClick={() => onRef(span.ref!)} title={`show ${span.ref}`}>
        {span.text}
      </button>
    );
  }
  if (span.href) {
    return (
      <a href={span.href} target="_blank" rel="noreferrer" style={style}>
        {span.text}
      </a>
    );
  }
  return <span style={style}>{span.text}</span>;
}

function Spans({ spans, onRef }: { spans: Span[]; onRef: (ref: string) => void }) {
  return (
    <>
      {spans.map((sp, i) => (
        <SpanView key={i} span={sp} onRef={onRef} />
      ))}
    </>
  );
}

export function BlockView({ block, onRef }: { block: Block; onRef: (ref: string) => void }) {
  switch (block.kind) {
    case 'heading':
      return <div className="heading" style={toneColor(block.tone)}>{block.text}</div>;
    case 'line':
      return (
        <div style={{ paddingLeft: `${block.indent ?? 0}ch` }}>
          <Spans spans={block.spans} onRef={onRef} />
        </div>
      );
    case 'blank':
      return <div className="blank" />;
    case 'raw':
      return <pre className="raw">{block.text}</pre>;
    case 'data':
      return null;
    case 'status': {
      const [mark, tone] = MARKS[block.level];
      return (
        <div role={block.level === 'error' ? 'alert' : undefined}>
          <span style={{ ...toneColor(tone), fontWeight: 700 }}>{mark}</span> <Spans spans={block.spans} onRef={onRef} />
        </div>
      );
    }
    case 'note': {
      const width = Math.max(...block.fields.map((f) => f.label.length), 0) + 2;
      return (
        <div>
          <div>
            <span style={toneColor('accent')}>◆</span> <Spans spans={block.title} onRef={onRef} />
          </div>
          {block.fields.map((f) => (
            <div key={f.label} className="note-field">
              <span style={toneColor('muted')}>│ </span>
              <span style={{ ...toneColor('muted'), display: 'inline-block', width: `${width}ch` }}>{f.label}:</span>
              <span>{f.value}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'bars': {
      const max = Math.max(...block.items.map((i) => i.value), 1);
      return (
        <div>
          {block.items.map((item) => (
            <div key={item.label} style={{ paddingLeft: '2ch' }}>
              <span style={{ ...toneColor(item.tone), display: 'inline-block', width: '14ch' }}>{item.label}</span>
              <span style={{ ...toneColor(item.tone), display: 'inline-block', width: '22ch' }}>
                {'█'.repeat(Math.max(1, Math.round((item.value / max) * 20)))}
              </span>
              {item.display}
            </div>
          ))}
        </div>
      );
    }
    case 'table':
      return (
        <table className="tbl" style={{ marginLeft: `${block.indent ?? 0}ch` }}>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c}>
                    <SpanView span={cell} onRef={onRef} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}
