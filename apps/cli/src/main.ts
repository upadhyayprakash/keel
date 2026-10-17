import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { AuthStore, autoBackup, fail, hint, Keel, KeelError, parsePublicUrl, renderText, VERSION, warn, type AutoBackupOptions } from '@keel/core';
import { authCommand, TOTP_ACCOUNT } from './auth';
import { dbConnect, dbDisconnect, dbStatus, storageOptions, terminalIo } from './db';
import { completionScript, formatSuggestions, isShell } from './completion';
import { runCommand } from './run';
import { secretStore } from './secrets';
import { questionAsker, runShell } from './shell';
import { ansiPaint, argvToLine, banner, needsProbe, probeBackground, resolveTheme, useColor } from './terminal';

/** Keel's folder: database, synced copy, config, backups, history. `KEEL_HOME` moves it. */
const HOME = process.env.KEEL_HOME || join(homedir(), '.keel');

/** Where backups and history go: next to a database file, or Keel's folder for a remote one. */
function keelHome(url: string): string {
  return url.startsWith('file:') ? dirname(url.slice('file:'.length)) : HOME;
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

  mkdirSync(HOME, { recursive: true });

  // keel db: where this device's data lives, and syncing it with a hosted database (ADR 0001).
  if (args[0] === 'db') {
    const color = useColor(process.env, Boolean(process.stdout.isTTY));
    const io = terminalIo(color ? ansiPaint(resolveTheme(process.env, null)) : (text) => text, color);
    try {
      if (!args[1]) return await dbStatus(HOME, io);
      if (args[1] === 'connect') return await dbConnect(HOME, args[2], io);
      if (args[1] === 'disconnect') return await dbDisconnect(HOME, io);
      throw new KeelError(`Unknown "db ${args[1]}".`, 'Try: keel db, keel db connect <address>, keel db disconnect');
    } catch (e) {
      if (!(e instanceof KeelError)) throw e;
      io.print([fail(e.message), ...(e.hint ? [hint(e.hint)] : [])]);
      return 1;
    }
  }

  // keel auth: pair phones with passkeys and manage sessions, from this terminal only (ADR 0002).
  if (args[0] === 'auth') {
    const color = useColor(process.env, Boolean(process.stdout.isTTY));
    const paint = color ? ansiPaint(resolveTheme(process.env, null)) : (text: string) => text;
    const io = {
      ...terminalIo(paint, color),
      write: (text: string) => process.stdout.write(text + '\n'),
      async ask(prompt: string) {
        if (!process.stdin.isTTY) return '';
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await rl.question(`${paint('│', { tone: 'muted' })} ${paint(prompt, { tone: 'accent', bold: true })} `);
        } finally {
          rl.close();
        }
      },
    };
    const cancelled = new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    try {
      return await authCommand(AuthStore.at(HOME), args.slice(1), io, { cancelled, secrets: await secretStore(HOME) });
    } catch (e) {
      if (!(e instanceof KeelError)) throw e;
      io.print([fail(e.message), ...(e.hint ? [hint(e.hint)] : [])]);
      return 1;
    }
  }

  const storage = await storageOptions(HOME);
  const url = storage.url;
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  const keel = await Keel.open(storage);

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
      setInterval(() => void keel.sync(), 30 * 1000); // pick up changes from other devices
      const { checkServe, startServer } = await import('@keel/server');
      const flag = (name: string) => {
        const i = args.indexOf(name);
        if (i < 0) return undefined;
        const value = args[i + 1];
        if (!value || value.startsWith('--')) throw new KeelError(`${name} needs a value.`);
        return value;
      };
      const port = Number(flag('--port') ?? (process.env.KEEL_PORT || 4242));
      const host = flag('--host') ?? '127.0.0.1';
      const publicUrl = flag('--public-url');
      const [certFile, keyFile] = [flag('--cert'), flag('--key')];
      const store = AuthStore.at(HOME);
      const { login } = checkServe({ host, publicUrl, cert: certFile, key: keyFile }, store);
      const tls = certFile && keyFile ? { cert: readFileSync(certFile, 'utf8'), key: readFileSync(keyFile, 'utf8') } : undefined;

      if (publicUrl) {
        const { rpId } = parsePublicUrl(publicUrl);
        const others = [...new Set(store.passkeys().map((p) => p.rpId))].filter((h) => h !== rpId);
        if (others.length) process.stderr.write(renderText([warn(`Your passkeys are for ${others.join(', ')}, not ${rpId}. Pair your phone again: keel auth passkey add`)]) + '\n');
        // So `keel auth passkey add` can find this server; removed on exit.
        store.writeServerInfo({ publicUrl: new URL(publicUrl).origin, port, pid: process.pid });
        process.on('exit', () => store.clearServerInfo(process.pid));
        for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => process.exit(0));
      }
      const secrets = await secretStore(HOME);
      const totpSecret = () => secrets.get(TOTP_ACCOUNT);
      await startServer({ keel, port, host, tls, auth: login ? { store, publicUrl, totpSecret } : undefined });
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
    if (error instanceof KeelError) {
      process.stderr.write(renderText([fail(error.message), ...(error.hint ? [hint(error.hint)] : [])]) + '\n');
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
