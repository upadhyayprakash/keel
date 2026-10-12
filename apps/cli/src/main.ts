import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { autoBackup, Keel, renderText, VERSION, type AutoBackupOptions, type Block, type Paint } from '@keel/core';
import { completionScript, formatSuggestions, isShell } from './completion';
import { ansiPaint, argvToLine, banner, formatPrompt, needsProbe, probeBackground, resolveTheme, useColor } from './terminal';

function databaseUrl(): string {
  const url = process.env.KEEL_DB_URL || `file:${join(homedir(), '.keel', 'keel.db')}`;
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  return url;
}

/** Daily backups go next to the database file (or ~/.keel/backups for a remote one). */
function backupOptions(url: string): AutoBackupOptions {
  const keep = Number(process.env.KEEL_BACKUP_KEEP ?? 14);
  const dir =
    process.env.KEEL_BACKUP_DIR || (url.startsWith('file:') ? join(dirname(url.slice('file:'.length)), 'backups') : join(homedir(), '.keel', 'backups'));
  return { dir, keep: Number.isFinite(keep) ? keep : 14 };
}

/** A failed backup never fails the command; it says so on stderr. */
async function backup(keel: Keel, url: string): Promise<void> {
  try {
    await autoBackup(keel, backupOptions(url));
  } catch (e) {
    process.stderr.write(`keel: daily backup failed: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (args[0] === 'completion') {
    const shell = args[1] ?? process.env.SHELL?.split('/').pop();
    if (!isShell(shell)) {
      process.stderr.write('Usage: keel completion zsh|bash\n');
      return 1;
    }
    process.stdout.write(completionScript(shell));
    return 0;
  }

  const url = databaseUrl();
  const keel = await Keel.open({ url, authToken: process.env.KEEL_DB_TOKEN || undefined });

  try {
    // Called by the shell on every Tab: answer fast, print nothing else.
    if (args[0] === '__complete') {
      const shell = args[1];
      if (!isShell(shell)) return 1;
      const completion = await keel.complete(args[2] ?? '');
      if (completion.suggestions.length) process.stdout.write(formatSuggestions(shell, completion.suggestions) + '\n');
      return 0;
    }

    if (args[0] === 'serve') {
      await backup(keel, url);
      setInterval(() => void backup(keel, url), 60 * 60 * 1000); // a long-running server still rolls over at midnight
      const { startServer } = await import('@keel/server');
      const portArg = args.indexOf('--port');
      const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.KEEL_PORT || 4242);
      await startServer({ keel, port });
      return new Promise<number>(() => {}); // runs until Ctrl+C
    }

    const state = await keel.state();
    const color = useColor(process.env, Boolean(process.stdout.isTTY)) && !args.includes('--json');
    const reported = color && needsProbe(process.env, state.theme) ? await probeBackground(process.stdin, process.stdout) : null;
    const paint = color ? ansiPaint(resolveTheme(process.env, state.theme, reported)) : undefined;

    let code = 0;
    if (args.length === 0) {
      process.stdout.write(banner(paint ?? ((t) => t), VERSION, keel.storage) + '\n');
    } else {
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes('--json');
      code = await runCommand(keel, argvToLine(args), paint ?? ((t) => t), Boolean(paint), interactive);
    }
    await backup(keel, url);
    return code;
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
