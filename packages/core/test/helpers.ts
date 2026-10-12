import { createClient } from '@libsql/client';
import { Keel } from '../src/keel';

/**
 * Where the core tests run. Default: a fresh in-memory database per test.
 * CI also runs them on a file and on a libSQL server (Turso-ready rule 9):
 *   KEEL_TEST_DB_URL=file:/tmp/keel-test.db
 *   KEEL_TEST_DB_URL=http://127.0.0.1:8080
 */
export const TEST_DB_URL = process.env.KEEL_TEST_DB_URL || ':memory:';
const authToken = process.env.KEEL_TEST_DB_TOKEN || undefined;

/** Drops every table so each test starts from an empty database. */
async function reset(url: string): Promise<void> {
  const client = createClient({ url, authToken });
  try {
    const tables = await client.execute("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'");
    for (const row of tables.rows) await client.execute(`drop table if exists "${String(row.name)}"`);
  } finally {
    client.close();
  }
}

export async function openTestKeel(now: () => Date): Promise<Keel> {
  if (TEST_DB_URL !== ':memory:') await reset(TEST_DB_URL);
  return Keel.open({ url: TEST_DB_URL, authToken, now });
}
