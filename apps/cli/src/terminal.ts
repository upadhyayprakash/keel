import { palettes, type Paint, type Question, type ThemeName } from '@keel/core';

/**
 * Picks the palette for the terminal's background:
 * KEEL_THEME, then the saved `theme` setting, then COLORFGBG, then dark.
 */
export function resolveTheme(env: NodeJS.ProcessEnv, saved: string | null): ThemeName {
  const choice = env.KEEL_THEME || saved || 'auto';
  if (choice === 'light' || choice === 'dark') return choice;
  // COLORFGBG is "fg;bg" (sometimes "fg;default;bg"). Background 7 or 15 means a light terminal.
  const bg = Number(env.COLORFGBG?.split(';').pop());
  if (!Number.isNaN(bg) && env.COLORFGBG) return bg === 7 || bg === 15 ? 'light' : 'dark';
  return 'dark';
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

export function banner(paint: Paint, version: string, dbLabel: string): string {
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
    `  ${paint('keel today', { tone: 'accent' })}       ${paint('what matters now', { tone: 'muted' })}`,
    `  ${paint('keel owe ...', { tone: 'accent' })}     ${paint('promise something', { tone: 'muted' })}`,
    `  ${paint('keel switch ...', { tone: 'accent' })}  ${paint('change project', { tone: 'muted' })}`,
    `  ${paint('keel serve', { tone: 'accent' })}       ${paint('open the browser terminal', { tone: 'muted' })}`,
    `  ${paint('keel help', { tone: 'accent' })}        ${paint('everything else', { tone: 'muted' })}`,
    '',
  ].join('\n');
}

/** The hint on its own line (only when it changes), then "│ Where are you? " with the cursor after it. */
export function formatPrompt(q: Question, paint: Paint, showHint: boolean): string {
  const hint = showHint && q.hint ? `${paint(q.hint, { tone: 'muted' })}\n` : '';
  if (q.prompt === '›') return `${hint}${paint('›', { tone: 'accent', bold: true })} `;
  return `${hint}${paint('│', { tone: 'muted' })} ${paint(q.prompt, { tone: 'accent', bold: true })} `;
}
