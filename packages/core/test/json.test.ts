import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const json = async (line: string) => {
  const result = await keel.exec(line);
  const block = result.blocks[0];
  if (block?.kind !== 'raw') throw new Error(`expected raw JSON, got ${JSON.stringify(result.blocks)}`);
  return { ...(JSON.parse(block.text) as { ok: boolean; data: any; text?: string; error?: string; hint?: string | null }), failed: result.failed };
};

const dir = mkdtempSync(join(tmpdir(), 'keel-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(async () => {
  keel = await openTestKeel(now);
  await run('client new acme "Acme Corp"');
  await run('project new acme/website "Website rebuild"');
});

afterEach(() => keel.close());

describe('--json', () => {
  it('returns the created commitment', async () => {
    const out = await json('owe pricing deck @ravi due:thu from:slack:https://x.slack.com/p1 #legal --json');
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({
      ref: 'c1',
      direction: 'owe',
      title: 'pricing deck',
      person: 'ravi',
      project: 'acme/website',
      dueOn: '2026-10-15',
      status: 'open',
      source: 'slack',
      sourceRef: 'https://x.slack.com/p1',
      tags: ['legal'],
    });
    expect(out.text).toContain('c1 I owe Ravi');
  });

  it('reports errors with ok:false and marks the result failed', async () => {
    const out = await json('owe pricing deck --json');
    expect(out).toMatchObject({ ok: false, error: 'Who do you owe it to? Add @name.', failed: true });
    expect(out.hint).toContain('Example');
  });

  it('covers edits, lists and views', async () => {
    await run('owe pricing deck @ravi due:today');
    await run('wait design files @meera due:today');
    expect((await json('done c1 --json')).data).toMatchObject({ ref: 'c1', status: 'done' });
    expect((await json('renegotiate c2 due:fri --json')).data).toMatchObject({ dueOn: '2026-10-16', renegotiatedCount: 1 });

    const ls = await json('ls --json');
    expect(ls.data.commitments.map((c: { ref: string }) => c.ref)).toEqual(['c2']);

    const today = await json('today --json');
    expect(today.data.date).toBe('2026-10-12');
    expect(today.data.context.path).toBe('acme/website');

    const show = await json('show c1 --json');
    expect(show.data.history.map((e: { kind: string }) => e.kind)).toContain('done');

    const project = await json('show p1 --json');
    expect(project.data).toMatchObject({ ref: 'p1', path: 'acme/website', resumeNote: null });
  });

  it('runs interactive commands without asking', async () => {
    await run('project new acme/app "App"');
    const out = await json('switch acme/app --json');
    expect(out.data).toMatchObject({ context: { path: 'acme/app' }, left: { project: 'acme/website', resumeNoteSaved: false } });
  });

  it('lists every command in help', async () => {
    const names = (await json('help --json')).data.commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(expect.arrayContaining(['owe', 'export', 'import']));
  });
});

describe('export and import', () => {
  it('writes readable Markdown', async () => {
    await run('owe pricing deck @ravi due:thu from:slack:https://x.slack.com/p1');
    await run('wait design files @meera due:fri');
    await run('owe old thing @ravi due:today');
    await run('drop c3');
    await run('park where:"pricing page" next:"send deck"');
    await run('in ask about phase 2');
    const md = await run('export --md');
    expect(md).toContain('## Acme Corp (acme)');
    expect(md).toContain('### Website rebuild · acme/website · p1 · active');
    expect(md).toContain('- Where: pricing page');
    expect(md).toContain('- [ ] **c1** pricing deck → Ravi · due 2026-10-15 · from [slack](https://x.slack.com/p1)');
    expect(md).toContain('- [ ] **c2** design files ← Meera · due 2026-10-16');
    expect(md).toContain('~~old thing~~');
    expect(md).toContain('- **i1** ask about phase 2');
  });

  it('round-trips a JSON export into an empty database', async () => {
    await run('owe pricing deck @ravi due:thu');
    await run('park where:"pricing page"');
    await run('in ask about phase 2');
    await run('theme dark');
    const before = JSON.parse(await run('export'));
    const file = join(dir, 'backup.json');
    writeFileSync(file, JSON.stringify(before));

    expect(await run(`import ${file}`)).toContain('already has data');

    keel.close();
    keel = await openTestKeel(now); // a fresh, empty database
    expect(await run(`import ${file}`)).toContain('Imported 1 client, 1 project, 1 commitment, 1 inbox item, 1 resume note');
    const after = JSON.parse(await run('export'));
    expect(after.data).toEqual(before.data);
    expect(await run('ls')).toContain('pricing deck');
  });

  it('rejects files that are not Keel exports', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ hello: 1 }));
    expect(await run(`import ${bad}`)).toContain("isn't a Keel export");
    writeFileSync(bad, 'not json');
    expect(await run(`import ${bad}`)).toContain("isn't JSON");
    expect(await run(`import ${join(dir, 'missing.json')}`)).toContain("Can't read");
  });
});

describe('daily backups', () => {
  it('writes one file a day and keeps the newest ones', async () => {
    const { autoBackup } = await import('../src/auto-backup');
    const { mkdirSync, readdirSync, readFileSync, writeFileSync: write } = await import('node:fs');
    const backups = join(dir, 'backups');
    mkdirSync(backups, { recursive: true });
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) write(join(backups, `keel-${day}.json`), '{}');
    const file = await autoBackup(keel, { dir: backups, keep: 3 });
    expect(file).toBe(join(backups, 'keel-2026-10-12.json'));
    expect(JSON.parse(readFileSync(file!, 'utf8')).data.clients).toHaveLength(1);
    expect(await autoBackup(keel, { dir: backups, keep: 3 })).toBeNull();
    expect(readdirSync(backups).sort()).toEqual(['keel-2026-10-02.json', 'keel-2026-10-03.json', 'keel-2026-10-12.json']);
    expect(await autoBackup(keel, { dir: join(dir, 'off'), keep: 0 })).toBeNull();
  });
});
