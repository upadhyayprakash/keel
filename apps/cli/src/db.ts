import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  contentCounts,
  exportJson,
  importDump,
  isConnectionError,
  Keel,
  KeelError,
  parseExport,
  renderText,
  s,
  hint,
  ok,
  warn,
  type Block,
  type KeelOptions,
  type Paint,
} from '@keel/core';
import { secretStore } from './secrets';

// ADR 0001: `keel db connect` turns this device's data into a synced copy of a
// hosted libSQL database (Turso or any libSQL server); `keel db disconnect` undoes it.

export interface Config {
  sync?: { url: string };
}

export const configFile = (home: string) => join(home, 'config.json');
const localFile = (home: string) => join(home, 'keel.db');
const syncFile = (home: string) => join(home, 'sync.db');
const SYNC_FILES = ['sync.db', 'sync.db-client_wal_index', 'sync.db-info', 'sync.db-wal', 'sync.db-shm'];

export function readConfig(home: string): Config {
  try {
    return existsSync(configFile(home)) ? (JSON.parse(readFileSync(configFile(home), 'utf8')) as Config) : {};
  } catch {
    return {};
  }
}

function writeConfig(home: string, config: Config): void {
  writeFileSync(configFile(home), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//, '').split('/')[0]!.split('?')[0]!;
const isLocalHost = (url: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(hostOf(url));

/** How Keel should open storage on this device: env, then `keel db connect` config, then the local file. */
export async function storageOptions(home: string, env: NodeJS.ProcessEnv = process.env): Promise<KeelOptions> {
  if (env.KEEL_DB_URL) return { url: env.KEEL_DB_URL, authToken: env.KEEL_DB_TOKEN || undefined };
  const sync = readConfig(home).sync;
  if (!sync) return { url: `file:${localFile(home)}` };
  const authToken = env.KEEL_DB_TOKEN || (await (await secretStore(home, env)).get(hostOf(sync.url))) || undefined;
  if (!authToken && !isLocalHost(sync.url)) {
    throw new KeelError(`No token for ${hostOf(sync.url)} on this device.`, `Connect again: keel db connect ${sync.url}`);
  }
  return { url: `file:${syncFile(home)}`, syncUrl: sync.url, authToken };
}

// ---- prompts ----

interface Io {
  paint: Paint;
  print(blocks: Block[]): void;
  /** Y/n question; Enter means the default. */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** Input that isn't echoed, for the token. */
  hidden(prompt: string): Promise<string>;
}

export function terminalIo(paint: Paint, color: boolean): Io {
  return {
    paint,
    print: (blocks) => process.stdout.write(renderText(blocks, color ? paint : undefined) + '\n'),
    async confirm(question, defaultYes) {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`${paint('│', { tone: 'muted' })} ${paint(question, { tone: 'accent', bold: true })} ${paint(defaultYes ? 'Y/n' : 'y/N', { tone: 'muted' })} `)).trim();
        return answer === '' ? defaultYes : /^y/i.test(answer);
      } finally {
        rl.close();
      }
    },
    hidden(prompt) {
      if (!process.stdin.isTTY) return Promise.resolve('');
      return new Promise((resolve, reject) => {
        process.stdout.write(`${paint('│', { tone: 'muted' })} ${paint(prompt, { tone: 'accent', bold: true })} `);
        let value = '';
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        const done = (fn: () => void) => {
          stdin.off('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          fn();
        };
        const onData = (chunk: Buffer) => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
            if (ch === '\u0003' || ch === '\u0004') return done(() => reject(new KeelError('Cancelled. Nothing changed.')));
            if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
            else if (ch >= ' ') value += ch;
          }
        };
        stdin.on('data', onData);
      });
    },
  };
}

// ---- commands ----

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
type Counts = Awaited<ReturnType<typeof contentCounts>>;
const describe = (c: Counts) =>
  [plural(c.clients, 'client'), plural(c.projects, 'project'), plural(c.commitments, 'commitment'), plural(c.resumeNotes, 'resume note')].join(', ');
const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const sameCounts = (a: Counts, b: Counts) => (Object.keys(a) as Array<keyof Counts>).every((k) => a[k] === b[k]);
/** The local calendar day, so file names match the user's own date. */
const stamp = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

/** Renames a file out of the way, never over an existing one. */
function retire(file: string, label: string, now: Date): string | null {
  if (!existsSync(file)) return null;
  let target = file.replace(/\.db$/, `-${label}-${stamp(now)}.db`);
  for (let i = 2; existsSync(target); i++) target = file.replace(/\.db$/, `-${label}-${stamp(now)}-${i}.db`);
  renameSync(file, target);
  for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, target + suffix);
  return target;
}

function removeSyncCopy(home: string): void {
  for (const name of SYNC_FILES) rmSync(join(home, name), { force: true });
}

async function openChecked(opts: KeelOptions, host: string): Promise<Keel> {
  try {
    return await Keel.open(opts);
  } catch (e) {
    if (e instanceof KeelError) throw e;
    if (isConnectionError(e)) throw new KeelError(`Can't reach ${host}.`, 'Check the address and your connection.');
    const text = e instanceof Error ? e.message : String(e);
    if (/401|403|unauthori[sz]ed|forbidden|token/i.test(text)) throw new KeelError(`${host} refused the token.`, 'Create a new token for this database and try again.');
    throw e;
  }
}

export async function dbStatus(home: string, io: Io, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const rows: Block[] = [];
  const line = (label: string, value: string) => ({ kind: 'line', spans: [s(label.padEnd(10), 'muted'), s(value)] }) as Block;
  if (env.KEEL_DB_URL) {
    io.print([line('Storage', `KEEL_DB_URL is set: ${env.KEEL_DB_URL.replace(/\?.*$/, '')}`), hint('The environment overrides keel db connect on this device.')]);
    return 0;
  }
  const sync = readConfig(home).sync;
  const keel = await Keel.open(await storageOptions(home, env));
  try {
    const counts = await contentCounts(keel.store);
    if (sync) {
      const store = await secretStore(home, env);
      rows.push(
        line('Storage', `synced with ${hostOf(sync.url)} (${keel.storage === 'offline' ? 'offline: reading only' : 'online'})`),
        line('Copy', syncFile(home)),
        line('Token', env.KEEL_DB_TOKEN ? 'KEEL_DB_TOKEN (environment)' : store.label),
      );
    } else {
      rows.push(line('Storage', `this device only (${localFile(home)})`));
    }
    rows.push(line('Data', describe(counts)));
    if (!sync) rows.push(hint('Use it on several devices: keel db connect libsql://<your-database>'));
    io.print(rows);
    return 0;
  } finally {
    keel.close();
  }
}

export async function dbConnect(home: string, url: string | undefined, io: Io, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<number> {
  if (!url) throw new KeelError('Which database?', 'Example: keel db connect libsql://keel-you.turso.io');
  if (!/^(libsql|https|http|wss|ws):\/\/[^/\s]+/.test(url)) throw new KeelError(`"${url}" isn't a database address.`, 'It looks like libsql://keel-you.turso.io');
  if (/^(http|ws):/.test(url) && !isLocalHost(url)) throw new KeelError('Use libsql:// or https://, so the token travels encrypted.');
  if (env.KEEL_DB_URL) throw new KeelError('KEEL_DB_URL is set, and it overrides keel db connect.', 'Unset it first.');
  const host = hostOf(url);
  const current = readConfig(home).sync;
  if (current && current.url !== url) throw new KeelError(`This device is synced with ${hostOf(current.url)}.`, 'Disconnect first: keel db disconnect');

  const token = env.KEEL_DB_TOKEN || (await io.hidden(`Token for ${host} (hidden):`));
  if (!token && !isLocalHost(url)) throw new KeelError('A token is needed.', 'Create one for this database in your provider (turso db tokens create <db>), then paste it here.');

  // 1. Look at both sides before changing anything.
  const remote = await openChecked({ url, authToken: token || undefined }, host);
  const remoteCounts = await contentCounts(remote.store);
  const hasLocal = existsSync(localFile(home));
  const local = hasLocal ? await Keel.open({ url: `file:${localFile(home)}` }) : null;
  const localCounts = local ? await contentCounts(local.store) : null;
  io.print([ok([s('Connected to '), s(host, 'default', { bold: true })])]);

  try {
    const remoteHas = total(remoteCounts) > 0;
    const localHas = Boolean(localCounts && total(localCounts) > 0);
    if (!remoteHas && localHas) {
      if (!(await io.confirm(`The hosted database is empty. Copy your data there? ${describe(localCounts!)}.`, true))) {
        io.print([warn('Nothing changed.')]);
        return 1;
      }
      await importDump(remote.store, parseExport(await exportJson(local!.store)));
      if (!sameCounts(await contentCounts(remote.store), localCounts!)) throw new KeelError('The copy came out different, so Keel stopped.', 'Nothing on this device changed. Try again, or report it.');
      io.print([ok('Copied and checked.')]);
    } else if (remoteHas && !localHas) {
      if (!(await io.confirm(`Found ${describe(remoteCounts)}. Use them on this device?`, true))) {
        io.print([warn('Nothing changed.')]);
        return 1;
      }
    } else if (remoteHas && localHas) {
      const backup = join(home, 'backups', `keel-local-${stamp(now)}.json`);
      io.print([
        warn(`This device has its own data too (${describe(localCounts!)}).`),
        hint(`Keel never mixes the two. It saves this device's data to ${backup}, then uses the hosted data.`),
      ]);
      if (!(await io.confirm('Continue?', false))) {
        io.print([warn('Nothing changed.')]);
        return 1;
      }
      mkdirSync(join(home, 'backups'), { recursive: true });
      writeFileSync(backup, await exportJson(local!.store), { mode: 0o600 });
      io.print([ok(`Saved this device's data to ${backup}`)]);
    }
  } finally {
    remote.close();
    local?.close();
  }

  // 2. Make the synced copy and check it matches.
  removeSyncCopy(home);
  const synced = await openChecked({ url: `file:${syncFile(home)}`, syncUrl: url, authToken: token || undefined }, host);
  const syncedCounts = await contentCounts(synced.store);
  synced.close();
  const expected = total(remoteCounts) > 0 || !localCounts ? remoteCounts : localCounts;
  if (!sameCounts(syncedCounts, expected)) {
    removeSyncCopy(home);
    throw new KeelError("This device's copy doesn't match the hosted database, so Keel stopped.", 'Nothing on this device changed. Try again.');
  }

  // 3. Switch over: keep the old local file (never deleted), store the token, remember the address.
  const retired = retire(localFile(home), 'before-sync', now);
  const store = await secretStore(home, env);
  if (token && !env.KEEL_DB_TOKEN) await store.set(host, token);
  writeConfig(home, { ...readConfig(home), sync: { url } });

  io.print([
    ok([s('This device now keeps a synced copy of '), s(host, 'default', { bold: true }), s('.')]),
    ...(token && !env.KEEL_DB_TOKEN ? [hint(`The token is in ${store.label}.`)] : []),
    ...(store.fallback && token && !env.KEEL_DB_TOKEN ? [warn('No system keyring was found, so the token is in that file.')] : []),
    ...(retired ? [hint(`Your previous local data is kept at ${retired}.`)] : []),
    hint('On another device: npm install -g @nouisi/keel, then keel db connect with the same address.'),
  ]);
  return 0;
}

export async function dbDisconnect(home: string, io: Io, env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<number> {
  const sync = readConfig(home).sync;
  if (!sync) {
    io.print([hint('This device is not synced. Its data is in ' + localFile(home))]);
    return 0;
  }
  const host = hostOf(sync.url);
  if (!(await io.confirm(`Stop syncing with ${host}? This device keeps a local copy of everything; the hosted database stays as it is.`, true))) {
    io.print([warn('Nothing changed.')]);
    return 1;
  }
  const synced = await Keel.open(await storageOptions(home, env));
  const dump = await exportJson(synced.store);
  const counts = await contentCounts(synced.store);
  synced.close();

  retire(localFile(home), 'before-disconnect', now);
  const local = await Keel.open({ url: `file:${localFile(home)}` });
  try {
    await importDump(local.store, parseExport(dump));
    if (!sameCounts(await contentCounts(local.store), counts)) throw new KeelError('The local copy came out different, so Keel stopped.', 'Still synced; nothing was removed.');
  } finally {
    local.close();
  }

  await (await secretStore(home, env)).delete(host);
  const config = readConfig(home);
  delete config.sync;
  writeConfig(home, config);
  removeSyncCopy(home);
  io.print([
    ok([s('Stopped syncing with '), s(host, 'default', { bold: true }), s('.')]),
    hint(`This device keeps ${describe(counts)} in ${localFile(home)}. The token was removed from this device.`),
  ]);
  return 0;
}
