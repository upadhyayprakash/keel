import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Keel } from '../src/keel';
import { renderText } from '../src/render-text';

// ADR 0001: each device keeps a local copy synced with one hosted database.
// The two-device test needs a libSQL server (CI's libsql-server job sets this):
//   KEEL_TEST_SYNC_URL=http://127.0.0.1:8080
const SYNC_URL = process.env.KEEL_TEST_SYNC_URL;
const now = () => new Date(2026, 9, 12, 9, 0);
const dir = mkdtempSync(join(tmpdir(), 'keel-sync-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const text = async (keel: Keel, line: string) => renderText(await keel.run(line));

describe('offline', () => {
  it('reads this device copy and refuses writes when the hosted database is unreachable', async () => {
    const file = `file:${join(dir, 'offline.db')}`;
    const local = await Keel.open({ url: file, now });
    await local.run('client new acme "Acme Corp"');
    await local.run('project new acme/website Web');
    await local.run('owe pricing deck @ravi due:thu');
    local.close();

    const keel = await Keel.open({ url: file, syncUrl: 'http://127.0.0.1:9', now }); // nothing listens on port 9
    expect(keel.storage).toBe('offline');
    expect((await keel.state()).storage).toBe('offline');
    expect(await text(keel, 'ls')).toContain('pricing deck');
    expect(await text(keel, 'owe another thing @ravi due:fri')).toContain("You're offline, so this wasn't saved.");
    keel.close();
  });

  it('says so when there is no copy on this device yet', async () => {
    await expect(Keel.open({ url: `file:${join(dir, 'never.db')}`, syncUrl: 'http://127.0.0.1:9', now })).rejects.toThrow(
      'this device has no copy of your data yet',
    );
  });
});

describe.skipIf(!SYNC_URL)('two devices', () => {
  it('see each other’s changes through the hosted database', async () => {
    const laptop = await Keel.open({ url: `file:${join(dir, 'laptop.db')}`, syncUrl: SYNC_URL, now });
    const desktop = await Keel.open({ url: `file:${join(dir, 'desktop.db')}`, syncUrl: SYNC_URL, now });
    expect(laptop.storage).toBe('synced');

    const tag = `sync${Date.now()}`;
    await laptop.run(`client new ${tag} "Synced Client"`);
    await desktop.sync();
    expect(await text(desktop, 'clients')).toContain(tag);

    await desktop.run(`client rename ${tag} "Renamed on desktop"`);
    await laptop.sync();
    expect(await text(laptop, 'clients')).toContain('Renamed on desktop');

    laptop.close();
    desktop.close();
  });
});
