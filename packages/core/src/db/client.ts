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

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function migrateDb(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
}
