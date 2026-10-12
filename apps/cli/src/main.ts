import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Keel, renderText, type Block, type Paint } from '@keel/core';
import { ansiPaint, argvToLine, banner, formatPrompt, resolveTheme, useColor } from './terminal';

const VERSION = '0.1.0';

function databaseUrl(): string {
  const url = process.env.KEEL_DB_URL || `file:${join(homedir(), '.keel', 'keel.db')}`;
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  return url;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const url = databaseUrl();
  const keel = await Keel.open({ url, authToken: process.env.KEEL_DB_TOKEN || undefined });

  try {
    if (args[0] === 'serve') {
      const { startServer } = await import('@keel/server');
      const portArg = args.indexOf('--port');
      const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.KEEL_PORT || 4242);
      await startServer({ keel, port });
      return new Promise<number>(() => {}); // runs until Ctrl+C
    }

    const state = await keel.state();
    const color = useColor(process.env, Boolean(process.stdout.isTTY)) && !args.includes('--json');
    const paint = color ? ansiPaint(resolveTheme(process.env, state.theme)) : undefined;

    if (args.length === 0) {
      process.stdout.write(banner(paint ?? ((t) => t), VERSION, url.startsWith('file:') ? 'local' : 'remote') + '\n');
      return 0;
    }

    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes('--json');
    return await runCommand(keel, argvToLine(args), paint ?? ((t) => t), Boolean(paint), interactive);
  } finally {
    if (args[0] !== 'serve') keel.close();
  }
}

const hasError = (blocks: Block[]) => blocks.some((b) => b.kind === 'status' && b.level === 'error');

/** Runs one command; answers its questions at the prompt, or skips them when not interactive. */
async function runCommand(keel: Keel, line: string, paint: Paint, color: boolean, interactive: boolean): Promise<number> {
  const print = (blocks: Block[]) => {
    if (blocks.length) process.stdout.write(renderText(blocks, color ? paint : undefined) + '\n');
  };
  let result = await keel.exec(line);
  let failed = hasError(result.blocks) || Boolean(result.failed);
  print(result.blocks);
  if (!result.question) return failed ? 1 : 0;

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  let current: AbortController | null = null;
  // Ctrl+C or Ctrl+D cancels the command, keeping whatever was already saved.
  rl?.on('SIGINT', () => current?.abort());
  rl?.on('close', () => current?.abort());
  let lastHint: string | undefined;
  try {
    while (result.question && result.session) {
      let answer: string | null = '';
      if (rl) {
        current = new AbortController();
        const showHint = result.question.hint !== lastHint;
        lastHint = result.question.hint;
        try {
          answer = await rl.question(formatPrompt(result.question, paint, showHint), { signal: current.signal });
        } catch {
          answer = null;
          process.stdout.write('\n');
        }
      }
      result = await keel.answer(result.session, answer);
      failed ||= hasError(result.blocks);
      print(result.blocks);
    }
  } finally {
    rl?.close();
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
