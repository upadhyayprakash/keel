import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline/promises';
import { VERSION, type Keel, type KeelState, type Paint } from '@keel/core';
import { runCommand, type Ask } from './run';
import { banner } from './terminal';

export interface ShellOptions {
  paint: Paint;
  color: boolean;
  /** Command history across sessions (one line per command, newest last). */
  historyFile: string;
  /** Runs after every command (the daily backup check). */
  afterCommand: () => Promise<void>;
}

const HISTORY = 1000;
const EXIT = new Set(['exit', 'quit', 'q']);

/**
 * Asks on a readline interface. Ctrl+C or Ctrl+D cancels the question (null);
 * the interface stays open, so the caller decides what cancelling means.
 */
export function questionAsker(rl: Interface, state = { closed: false }): Ask {
  let current: AbortController | null = null;
  rl.on('SIGINT', () => current?.abort());
  rl.on('close', () => {
    state.closed = true;
    current?.abort();
  });
  return async (prompt) => {
    if (state.closed) return null;
    current = new AbortController();
    try {
      return await rl.question(prompt, { signal: current.signal });
    } catch {
      process.stdout.write('\n');
      return null;
    } finally {
      current = null;
    }
  };
}

function loadHistory(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-HISTORY).reverse(); // readline wants newest first
  } catch {
    return [];
  }
}

function remember(file: string, line: string): void {
  try {
    appendFileSync(file, line.replace(/\n/g, ' ') + '\n', { mode: 0o600 });
  } catch {
    // History is a convenience; never fail a command over it.
  }
}

/** "acme/website › " in the client's color, or just "› ". */
function shellPrompt(state: KeelState, paint: Paint): string {
  const where = state.context ? `${paint(state.context.path, { tone: state.context.hue })} ` : '';
  return `${where}${paint('›', { tone: 'accent', bold: true })} `;
}

/**
 * The Keel shell: one session where every line is a Keel command, no `keel`
 * prefix needed. Tab completes from the same completer as the browser terminal.
 */
export async function runShell(keel: Keel, o: ShellOptions): Promise<number> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadHistory(o.historyFile),
    historySize: HISTORY,
    removeHistoryDuplicates: true,
    completer: async (line: string): Promise<[string[], string]> => {
      try {
        const c = await keel.complete(line);
        return [c.suggestions.map((sug) => sug.insert + (sug.continues ? '' : ' ')), line.slice(c.replaceFrom)];
      } catch {
        return [[], line];
      }
    },
  });
  const state = { closed: false };
  const ask = questionAsker(rl, state);
  const write = (text: string) => process.stdout.write(text + '\n');
  const muted = (text: string) => o.paint(text, { tone: 'muted' });

  write(banner(o.paint, VERSION, keel.storage, { shell: true }));
  await runCommand(keel, 'today', o.paint, o.color, ask);
  write('');

  while (!state.closed) {
    const line = await ask(shellPrompt(await keel.state(), o.paint));
    if (line === null) continue; // Ctrl+C: fresh prompt. Ctrl+D closes, which ends the loop.
    const input = line.trim().replace(/^keel\s+/, '');
    if (!input) continue;
    remember(o.historyFile, input);

    if (EXIT.has(input)) break;
    if (input === 'clear') {
      process.stdout.write('\x1b[2J\x1b[H');
      continue;
    }
    if (/^(serve|shell|completion|db|auth)\b/.test(input)) {
      write(muted(`${input.split(' ')[0]} runs outside the shell. Use it from your terminal: keel ${input}`));
      write('');
      continue;
    }

    await runCommand(keel, input, o.paint, o.color, ask);
    write('');
    await o.afterCommand();
  }

  rl.close();
  write(muted('Bye. Your data is saved.'));
  return 0;
}
