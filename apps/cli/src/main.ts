import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { autoBackup, Keel, VERSION, type AutoBackupOptions } from '@keel/core';
import { completionScript, formatSuggestions, isShell } from './completion';
import { runCommand } from './run';
import { questionAsker, runShell } from './shell';
import { ansiPaint, argvToLine, banner, needsProbe, probeBackground, resolveTheme, useColor } from './terminal';

function databaseUrl(): string {
  const url = process.env.KEEL_DB_URL || `file:${join(homedir(), '.keel', 'keel.db')}`;
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  return url;
}

/** Keel's own folder: next to the database file, or ~/.keel for a remote one. */
function keelHome(url: string): string {
  return url.startsWith('file:') ? dirname(url.slice('file:'.length)) : join(homedir(), '.keel');
}

/** Daily backups go in a backups folder in Keel's own folder. */
function backupOptions(url: string): AutoBackupOptions {
  const keep = Number(process.env.KEEL_BACKUP_KEEP ?? 14);
  const dir = process.env.KEEL_BACKUP_DIR || join(keelHome(url), 'backups');
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

    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const painter = paint ?? ((text: string) => text);

    // `keel` alone in a terminal opens the Keel shell; piped, it just prints the banner.
    if ((args.length === 0 && tty) || args[0] === 'shell') {
      await backup(keel, url);
      return await runShell(keel, {
        paint: painter,
        color: Boolean(paint),
        historyFile: join(keelHome(url), 'history'),
        afterCommand: () => backup(keel, url),
      });
    }

    let code = 0;
    if (args.length === 0) {
      process.stdout.write(banner(painter, VERSION, keel.storage) + '\n');
    } else {
      const interactive = tty && !args.includes('--json');
      const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
      try {
        code = await runCommand(keel, argvToLine(args), painter, Boolean(paint), rl ? questionAsker(rl) : null);
      } finally {
        rl?.close();
      }
    }
    await backup(keel, url);
    return code;
  } finally {
    if (args[0] !== 'serve') keel.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
