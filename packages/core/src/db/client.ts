import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './schema';

// The only place in Keel that opens a database (Turso-ready rule 1).
// `file:` and `libsql://` URLs go through the same client.

export type Db = LibSQLDatabase<typeof schema>;

export interface DbOptions {
  url: string;
  authToken?: string;
  /** With a `file:` url: keep that file as a synced copy of this hosted database (ADR 0001). */
  syncUrl?: string;
}

export function openDb(opts: DbOptions): { db: Db; client: Client } {
  const client = createClient({ url: opts.url, authToken: opts.authToken, ...(opts.syncUrl ? { syncUrl: opts.syncUrl } : {}) });
  return { db: drizzle(client, { schema }), client };
}

// Next to the bundle in the published package, or packages/core/drizzle when running from source.
const migrationsFolder = [new URL('./drizzle', import.meta.url), new URL('../../drizzle', import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => existsSync(dir));

/** True for errors that mean "the hosted database can't be reached", not "the query was wrong". */
export function isConstraintError(e: unknown): boolean {
  return /SQLITE_CONSTRAINT|UNIQUE constraint/i.test(`${e instanceof Error ? e.message : String(e)} ${(e as { cause?: unknown })?.cause ?? ''}`);
}

export function isConnectionError(e: unknown): boolean {
  const text = `${(e as { code?: string })?.code ?? ''} ${e instanceof Error ? e.message : String(e)} ${(e as { cause?: unknown })?.cause ?? ''}`;
  return /error trying to connect|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|timed out|error sending request|other side closed|UND_ERR_SOCKET|network/i.test(text);
}

/**
 * Applies new migrations. When the database is already up to date it only reads,
 * because on a synced copy every write (even drizzle's CREATE TABLE IF NOT EXISTS
 * bookkeeping) is a round trip to the hosted database: about 3 seconds from Asia to Europe.
 */
export async function migrateDb(db: Db): Promise<void> {
  if (await upToDate(db)) return;
  await migrate(db, { migrationsFolder: folder() });
}

function folder(): string {
  if (!migrationsFolder) throw new Error('Keel could not find its database migrations. The install looks incomplete.');
  return migrationsFolder;
}

/** Same rule drizzle uses: the newest applied migration's created_at against the journal's newest `when`. Reads only. */
export async function upToDate(db: Db): Promise<boolean> {
  try {
    const journal = JSON.parse(readFileSync(join(folder(), 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ when: number }> };
    const newest = Math.max(...journal.entries.map((e) => e.when));
    const rows = await db.all<{ applied: number | null }>(sql`select max(created_at) as applied from __drizzle_migrations`);
    return Number(rows[0]?.applied ?? 0) >= newest;
  } catch {
    return false; // no bookkeeping table yet: a new database
  }
}
