import { existsSync } from 'node:fs';
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
export function isConnectionError(e: unknown): boolean {
  const text = `${(e as { code?: string })?.code ?? ''} ${e instanceof Error ? e.message : String(e)} ${(e as { cause?: unknown })?.cause ?? ''}`;
  return /error trying to connect|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|timed out|error sending request|network/i.test(text);
}

export async function migrateDb(db: Db): Promise<void> {
  if (!migrationsFolder) throw new Error('Keel could not find its database migrations. The install looks incomplete.');
  await migrate(db, { migrationsFolder });
}
