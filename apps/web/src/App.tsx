import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Block, Completion, KeelState, Question, ThemeSetting } from '@keel/core/ui';
import { api, type ApiResult } from './api';
import { BlockView, SpanView } from './Blocks';
import { applyTheme, resolve } from './theme';

interface Entry {
  id: number;
  line: string;
  blocks: Block[];
}

const THEMES: ThemeSetting[] = ['light', 'dark', 'auto'];
let nextId = 1;

const unreachable: Block[] = [{ kind: 'status', level: 'error', spans: [{ text: "Can't reach keel serve. Is it still running?" }] }];

/** Shows a given answer in the scrollback, like a terminal would. */
function echo(question: Question, text: string | null): Block {
  const answer = text === null ? { text: '(cancelled)', tone: 'dim' as const } : text ? { text } : { text: '(skipped)', tone: 'dim' as const };
  return question.prompt === '›'
    ? { kind: 'line', spans: [{ text: '› ', tone: 'accent' }, answer] }
    : { kind: 'line', spans: [{ text: '│ ', tone: 'muted' }, { text: `${question.prompt} `, tone: 'accent', bold: true }, answer] };
}

export function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState<KeelState | null>(null);
  const [theme, setTheme] = useState<ThemeSetting>('auto');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ session: string; question: Question } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const completeSeq = useRef(0);

  // Theme: follow the saved setting, and the OS while on auto.
  useEffect(() => {
    applyTheme(resolve(theme));
    if (theme !== 'auto') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => applyTheme(resolve('auto'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const settle = useCallback((res: ApiResult) => {
    setState(res.state);
    setTheme(res.state.theme);
    setPending(res.question && res.session ? { session: res.session, question: res.question } : null);
  }, []);

  const run = useCallback(
    async (line: string, record = true) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (record) {
        setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]));
        setHistoryIndex(null);
      }
      if (trimmed === 'clear') {
        setEntries([]);
        return;
      }
      setBusy(true);
      try {
        const res = await api.run(trimmed);
        setEntries((e) => [...e, { id: nextId++, line: trimmed, blocks: res.blocks }]);
        settle(res);
      } catch {
        setEntries((e) => [...e, { id: nextId++, line: trimmed, blocks: unreachable }]);
      } finally {
        setBusy(false);
      }
    },
    [settle],
  );

  /** Answers the waiting question; the reply joins the same entry in the scrollback. */
  const reply = useCallback(
    async (text: string | null) => {
      if (!pending) return;
      const appendToLast = (blocks: Block[]) =>
        setEntries((e) => (e.length ? [...e.slice(0, -1), { ...e[e.length - 1]!, blocks: [...e[e.length - 1]!.blocks, ...blocks] }] : e));
      appendToLast([echo(pending.question, text)]);
      setBusy(true);
      try {
        const res = await api.answer(pending.session, text);
        appendToLast(res.blocks);
        settle(res);
      } catch {
        appendToLast(unreachable);
        setPending(null);
      } finally {
        setBusy(false);
      }
    },
    [pending, settle],
  );

  // Start where the day starts.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run('today', false);
  }, [run]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [entries]);

  // Autocomplete and live preview, debounced; stale answers are ignored.
  useEffect(() => {
    const seq = ++completeSeq.current;
    if (!input.trim() || pending) {
      setCompletion(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const c = await api.complete(input);
        if (seq === completeSeq.current) {
          setCompletion(c);
          setSelected(0);
        }
      } catch {
        // Completion is a nicety; the command still runs without it.
      }
    }, 80);
    return () => clearTimeout(timer);
  }, [input, pending]);

  const suggestions = !dismissed && !pending && completion ? completion.suggestions : [];

  const accept = (index: number) => {
    const pick = suggestions[index];
    if (!pick || !completion) return;
    setInput(input.slice(0, completion.replaceFrom) + pick.insert + (pick.continues ? '' : ' '));
    setDismissed(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const line = input;
      setInput('');
      setCompletion(null);
      setDismissed(false);
      if (pending) void reply(line);
      else void run(line);
    } else if (e.key === 'Escape' && pending) {
      e.preventDefault();
      setInput('');
      void reply(null);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      accept(selected);
    } else if (e.key === 'Escape') {
      setDismissed(true);
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const up = e.key === 'ArrowUp';
      if (suggestions.length > 0) {
        setSelected((i) => (i + (up ? -1 : 1) + suggestions.length) % suggestions.length);
        return;
      }
      if (history.length === 0) return;
      const current = historyIndex ?? history.length;
      const next = Math.min(history.length, Math.max(0, current + (up ? -1 : 1)));
      setHistoryIndex(next === history.length ? null : next);
      setInput(next === history.length ? '' : (history[next] ?? ''));
      setDismissed(true);
    } else {
      setDismissed(false);
    }
  };

  const pickTheme = async (next: ThemeSetting) => {
    setTheme(next);
    try {
      const res = await api.run(`theme ${next}`);
      setState(res.state);
    } catch {
      // The theme still applies for this session.
    }
  };

  const onRef = (ref: string) => void run(`show ${ref}`);

  return (
    <div className="app">
      <div className="window">
        <header className="top">
          <div className="wordmark" aria-label="keel">
            <span className="chev">›</span>
            <span className="word">keel</span>
          </div>
          <span className="meta">{state ? `v${state.version} · ${state.storage}` : ''}</span>
        </header>

        <div
          className="scroll"
          ref={scrollRef}
          onClick={() => {
            if (!window.getSelection()?.toString()) inputRef.current?.focus();
          }}
          aria-live="polite"
        >
          {entries.map((entry) => (
            <section key={entry.id} className="entry" aria-label={entry.line}>
              <div className="cmd">
                <span className="chev">›</span> {entry.line}
              </div>
              {entry.blocks.map((block, i) => (
                <BlockView key={i} block={block} onRef={onRef} />
              ))}
            </section>
          ))}
        </div>

        {(suggestions.length > 0 || completion?.preview) && !dismissed && !pending && (
          <div className="suggest" role="listbox" aria-label="Suggestions">
            {suggestions.map((sug, i) => (
              <div
                key={sug.insert}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'opt sel' : 'opt'}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(i);
                }}
              >
                <span className="ins">{sug.label}</span>
                {sug.detail && <span className="detail">{sug.detail}</span>}
                {i === selected && <span className="key">tab</span>}
              </div>
            ))}
            {completion?.preview && (
              <div className="preview">
                {completion.preview.map((sp, i) => (
                  <SpanView key={i} span={sp} onRef={onRef} />
                ))}
              </div>
            )}
          </div>
        )}

        {pending?.question.hint && <div className="question-hint">{pending.question.hint}</div>}
        <div className="prompt-row">
          <label htmlFor="prompt" className={pending && pending.question.prompt !== '›' ? 'question' : 'chev'}>
            {pending && pending.question.prompt !== '›' ? `│ ${pending.question.prompt}` : '›'}
            {!pending && <span className="sr-only">Command</span>}
          </label>
          <input
            id="prompt"
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            aria-busy={busy}
            placeholder={pending ? 'type your answer, enter to send, esc to cancel' : 'type a command: today, owe, wait, switch, help'}
          />
        </div>

        <footer className="status">
          {state?.context ? (
            <span style={{ color: `var(--t-${state.context.hue})` }}>● {state.context.path}</span>
          ) : (
            <span>not in a project</span>
          )}
          {state && (
            <span>
              <span style={{ color: 'var(--t-late)' }}>{state.counts.overdue} overdue</span> ·{' '}
              <span style={{ color: 'var(--t-today)' }}>{state.counts.today} today</span> ·{' '}
              <span style={{ color: 'var(--t-wait)' }}>{state.counts.waiting} waiting</span>
            </span>
          )}
          <span>tab complete · ↑ history · ctrl+L clear · help</span>
          <div className="toggle" role="group" aria-label="Theme">
            {THEMES.map((t) => (
              <button key={t} type="button" aria-pressed={theme === t} onClick={() => void pickTheme(t)}>
                {t === 'auto' && theme === 'auto' ? `auto (${resolve('auto')})` : t}
              </button>
            ))}
          </div>
        </footer>
      </div>
    </div>
  );
}
