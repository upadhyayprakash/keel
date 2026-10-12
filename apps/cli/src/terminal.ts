import { palettes, type Paint, type Question, type ThemeName } from '@keel/core';

/**
 * Picks the palette for the terminal's background: KEEL_THEME, then the saved
 * `theme` setting, then COLORFGBG, then what the terminal reported (OSC 11), then dark.
 */
export function resolveTheme(env: NodeJS.ProcessEnv, saved: string | null, reported: ThemeName | null = null): ThemeName {
  const choice = env.KEEL_THEME || saved || 'auto';
  if (choice === 'light' || choice === 'dark') return choice;
  // COLORFGBG is "fg;bg" (sometimes "fg;default;bg"). Background 7 or 15 means a light terminal.
  const bg = Number(env.COLORFGBG?.split(';').pop());
  if (!Number.isNaN(bg) && env.COLORFGBG) return bg === 7 || bg === 15 ? 'light' : 'dark';
  return reported ?? 'dark';
}

/** True when the theme is left to the terminal, so asking it is worth the round trip. */
export function needsProbe(env: NodeJS.ProcessEnv, saved: string | null): boolean {
  const choice = env.KEEL_THEME || saved || 'auto';
  return choice !== 'light' && choice !== 'dark' && !env.COLORFGBG;
}

/** Reads an OSC 11 reply like "\x1b]11;rgb:ffff/ffff/ffff\x07" into light or dark. */
export function parseBackgroundReply(reply: string): ThemeName | null {
  const m = /\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(reply);
  if (!m) return null;
  const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((hex) => parseInt(hex, 16) / (16 ** hex.length - 1)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark';
}

/**
 * Asks the terminal for its background color (OSC 11). Most modern terminals
 * answer within a few milliseconds; ones that don't are given up on after `timeoutMs`.
 */
export function probeBackground(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream, timeoutMs = 150): Promise<ThemeName | null> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let reply = '';
    const wasRaw = stdin.isRaw;
    const finish = (theme: ThemeName | null) => {
      clearTimeout(timer);
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(theme);
    };
    const onData = (chunk: Buffer) => {
      reply += chunk.toString('latin1');
      if (reply.includes('\x07') || reply.includes('\x1b\\')) finish(parseBackgroundReply(reply));
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
    stdout.write('\x1b]11;?\x07');
  });
}

export function useColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return isTTY;
}

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

/** Truecolor ANSI painter. The default tone keeps the terminal's own foreground. */
export function ansiPaint(theme: ThemeName): Paint {
  const tones = palettes[theme].tones;
  return (text, span) => {
    if (!text) return text;
    let open = '';
    if (span.bold) open += '\x1b[1m';
    if (span.tone && span.tone !== 'default') open += `\x1b[38;2;${rgb(tones[span.tone])}m`;
    return open ? `${open}${text}\x1b[0m` : text;
  };
}

/** Rebuilds a command line from argv, quoting what the shell unquoted. */
export function argvToLine(args: string[]): string {
  return args
    .map((arg) => {
      if (!/\s/.test(arg) && arg !== '') return arg;
      const quote = arg.includes('"') ? "'" : '"';
      const kv = /^([a-z]+):(.*)$/s.exec(arg);
      return kv ? `${kv[1]}:${quote}${kv[2]}${quote}` : `${quote}${arg}${quote}`;
    })
    .join(' ');
}

// Direction A: the hull-and-keel mark, beside the KEEL wordmark.
const MARK = [
  ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ ',
  ' ▀██████████████▀ ',
  '   ▀██████████▀   ',
  ' ━━━━━━━━━━━━━━━━ ',
  '        ██        ',
  '        ██        ',
  '      ▄████▄      ',
];
const WORD = [
  '██╗  ██╗███████╗███████╗██╗',
  '██║ ██╔╝██╔════╝██╔════╝██║',
  '█████╔╝ █████╗  █████╗  ██║',
  '██╔═██╗ ██╔══╝  ██╔══╝  ██║',
  '██║  ██╗███████╗███████╗███████╗',
  '╚═╝  ╚═╝╚══════╝╚══════╝╚══════╝',
  '',
];

const COMMAND_TIPS = [
  ['keel', 'open the Keel shell'],
  ['keel today', 'what matters now'],
  ['keel owe ...', 'promise something'],
  ['keel serve', 'open the browser terminal'],
  ['keel help', 'everything else'],
];

const SHELL_TIPS = [
  ['today', 'what matters now'],
  ['owe ...', 'promise something'],
  ['switch ...', 'change project'],
  ['help', 'everything else'],
  ['exit', 'leave (or Ctrl+D)'],
  ['', 'Tab completes · ↑ history · Ctrl+C cancels'],
];

export function banner(paint: Paint, version: string, dbLabel: string, opts: { shell?: boolean } = {}): string {
  const rows = MARK.map((m, i) => {
    const mark = i === 3 ? paint(m, { tone: 'accent' }) : m;
    const word = i === 6 ? paint('steady focus · kept promises · sound decisions', { tone: 'muted' }) : (WORD[i] ?? '');
    return `${mark}    ${word}`;
  });
  return [
    '',
    ...rows,
    '',
    `  ${paint(`v${version} · ${dbLabel}`, { tone: 'muted' })}`,
    '',
    ...(opts.shell ? SHELL_TIPS : COMMAND_TIPS).map(([cmd, what]) => `  ${paint(cmd!.padEnd(17), { tone: 'accent' })}${paint(what!, { tone: 'muted' })}`),
    '',
  ].join('\n');
}

/** The hint on its own line (only when it changes), then "│ Where are you? " with the cursor after it. */
export function formatPrompt(q: Question, paint: Paint, showHint: boolean): string {
  const hint = showHint && q.hint ? `${paint(q.hint, { tone: 'muted' })}\n` : '';
  if (q.prompt === '›') return `${hint}${paint('›', { tone: 'accent', bold: true })} `;
  return `${hint}${paint('│', { tone: 'muted' })} ${paint(q.prompt, { tone: 'accent', bold: true })} `;
}
