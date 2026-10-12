import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configFile, dbConnect, hostOf, storageOptions } from '../src/db';
import { secretStore } from '../src/secrets';

const home = mkdtempSync(join(tmpdir(), 'keel-home-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const fileEnv = { KEEL_SECRET_STORE: 'file' } as NodeJS.ProcessEnv;
const silentIo = {
  paint: (text: string) => text,
  print: () => {},
  confirm: async () => true,
  hidden: async () => '',
};

describe('storage on this device', () => {
  it('uses the local file by default', async () => {
    expect(await storageOptions(home, fileEnv)).toEqual({ url: `file:${join(home, 'keel.db')}` });
  });

  it('lets KEEL_DB_URL override everything', async () => {
    expect(await storageOptions(home, { ...fileEnv, KEEL_DB_URL: 'libsql://x.turso.io', KEEL_DB_TOKEN: 't' })).toEqual({
      url: 'libsql://x.turso.io',
      authToken: 't',
    });
  });

  it('opens a synced copy once connected, with the token from the secret store', async () => {
    writeFileSync(configFile(home), JSON.stringify({ sync: { url: 'libsql://keel-you.turso.io' } }));
    await expect(storageOptions(home, fileEnv)).rejects.toThrow('No token for keel-you.turso.io');
    const store = await secretStore(home, fileEnv);
    await store.set('keel-you.turso.io', 'eyJhbGciOi.abc-_123');
    expect(await storageOptions(home, fileEnv)).toEqual({
      url: `file:${join(home, 'sync.db')}`,
      syncUrl: 'libsql://keel-you.turso.io',
      authToken: 'eyJhbGciOi.abc-_123',
    });
    expect(statSync(join(home, 'secrets.json')).mode & 0o777).toBe(0o600);
    await store.delete('keel-you.turso.io');
    expect(await store.get('keel-you.turso.io')).toBeNull();
    rmSync(configFile(home));
  });
});

describe('keel db connect', () => {
  it('reads hosts from addresses', () => {
    expect(hostOf('libsql://keel-you.turso.io')).toBe('keel-you.turso.io');
    expect(hostOf('http://127.0.0.1:8080/')).toBe('127.0.0.1:8080');
  });

  it('refuses addresses that would send the token unencrypted', async () => {
    await expect(dbConnect(home, 'http://db.example.com', silentIo, fileEnv)).rejects.toThrow('so the token travels encrypted');
    await expect(dbConnect(home, 'keel-you.turso.io', silentIo, fileEnv)).rejects.toThrow("isn't a database address");
    await expect(dbConnect(home, undefined, silentIo, fileEnv)).rejects.toThrow('Which database?');
  });

  it('needs a token for a hosted database', async () => {
    await expect(dbConnect(home, 'libsql://keel-you.turso.io', silentIo, fileEnv)).rejects.toThrow('A token is needed.');
  });

  it('says so when the database is unreachable, changing nothing', async () => {
    await expect(dbConnect(home, 'http://127.0.0.1:9', silentIo, fileEnv)).rejects.toThrow("Can't reach 127.0.0.1:9");
    expect(await storageOptions(home, fileEnv)).toEqual({ url: `file:${join(home, 'keel.db')}` });
  });
});

describe('Turso address typos', () => {
  it('suggests the dot before the region', async () => {
    const { suggestTursoHost } = await import('../src/db');
    expect(suggestTursoHost('keel-you-aws-ap-south-1.turso.io')).toBe('keel-you.aws-ap-south-1.turso.io');
    expect(suggestTursoHost('keel-you.aws-ap-south-1.turso.io')).toBeNull();
    expect(suggestTursoHost('127.0.0.1:8080')).toBeNull();
  });
});
