import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportJson } from './commands/backup';
import type { Keel } from './keel';

export interface AutoBackupOptions {
  dir: string;
  /** How many daily files to keep. 0 turns backups off. */
  keep: number;
}

const FILE = /^keel-\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Writes `keel-YYYY-MM-DD.json` (a full export) the first time Keel runs each day,
 * then deletes all but the newest `keep` files. Restore one with `keel import`.
 * Returns the file it wrote, or null when today's backup already exists.
 */
export async function autoBackup(keel: Keel, { dir, keep }: AutoBackupOptions): Promise<string | null> {
  if (keep <= 0) return null;
  await mkdir(dir, { recursive: true });
  const name = `keel-${keel.store.today()}.json`;
  const existing = (await readdir(dir)).filter((f) => FILE.test(f));
  if (existing.includes(name)) return null;

  const file = join(dir, name);
  const partial = `${file}.partial`;
  await writeFile(partial, await exportJson(keel.store), { mode: 0o600 });
  await rename(partial, file); // a crash mid-write never leaves a half file under the real name

  const old = [...existing, name].sort().reverse().slice(keep);
  await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));
  return file;
}
