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
}

export function openDb(opts: DbOptions): { db: Db; client: Client } {
  const client = createClient({ url: opts.url, authToken: opts.authToken });
  return { db: drizzle(client, { schema }), client };
}

// Next to the bundle in the published package, or packages/core/drizzle when running from source.
const migrationsFolder = [new URL('./drizzle', import.meta.url), new URL('../../drizzle', import.meta.url)]
  .map((u) => fileURLToPath(u))
  .find((dir) => existsSync(dir));

export async function migrateDb(db: Db): Promise<void> {
  if (!migrationsFolder) throw new Error('Keel could not find its database migrations. The install looks incomplete.');
  await migrate(db, { migrationsFolder });
}
