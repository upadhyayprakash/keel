import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as t from '../src/db/schema';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
let dir: string;
const run = async (line: string) => renderText(await keel.run(line));
const json = async (line: string) => {
  const block = (await keel.exec(line)).blocks[0];
  if (block?.kind !== 'raw') throw new Error(`expected raw JSON, got ${JSON.stringify(block)}`);
  return JSON.parse(block.text) as { ok: boolean; data: any; error?: string; hint?: string | null };
};

/** Runs an interactive command, answering each question in order. */
async function play(line: string, answers: string[]) {
  let result = await keel.exec(line);
  const out = [renderText(result.blocks)];
  const questions: string[] = [];
  while (result.question && result.session) {
    questions.push(result.question.prompt);
    result = await keel.answer(result.session, answers.shift() ?? '');
    out.push(renderText(result.blocks));
  }
  return { text: out.join('\n'), questions };
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

beforeEach(async () => {
  keel = await openTestKeel(now);
  dir = mkdtempSync(join(tmpdir(), 'keel-lists-'));
});
afterEach(() => {
  keel.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('list new and list', () => {
  it('starts a list in Personal / General when no project is named or in use', async () => {
    const out = await run('list new "D-mart" --tracked desc:"Weekly shop" #groceries #weekly item:milk item:eggs');
    expect(out).toContain('l1 D-mart');
    expect(out).toContain('tracked');
    expect(out).toContain('personal/general');
    expect(out).toContain('list move l1 +client/project');
    const shown = await json('list show l1 --json');
    expect(shown.data).toMatchObject({ ref: 'l1', name: 'D-mart', kind: 'tracked', description: 'Weekly shop', tags: ['groceries', 'weekly'], project: 'personal/general', progress: { done: 0, total: 2, label: '0 of 2 done' } });
    expect(shown.data.items.map((i: any) => i.text)).toEqual(['milk', 'eggs']);
  });

  it('puts a list under a named project, a named client, or the project you are in', async () => {
    await run('client new acme "Acme Corp"');
    await run('project new acme/website "Website rebuild"'); // becomes the context
    expect(await run('list new Ideas')).toContain('acme/website'); // the project you are in
    expect(await run('list new Release +acme/website --tracked')).toContain('acme/website');
    expect(await run('list new Notes +acme')).toContain('acme/general');
    expect(await run('list new Groceries +personal')).toContain('personal/general');
    expect(await run('list new Bad +nope')).toContain('No client nope');
  });

  it('shows every list with its progress, project and tags, pinned first', async () => {
    await run('list new Groceries --tracked #home item:milk item:eggs');
    await run('list new Ideas item:a item:b item:c');
    await run('list new Trip --pin');
    await run('list done l1 1');
    const out = await run('lists');
    expect(out).toContain('LISTS · 3');
    expect(out.indexOf('Trip')).toBeLessThan(out.indexOf('Ideas')); // pinned first
    expect(out).toContain('1 of 2 done');
    expect(out).toContain('3 items');
    expect(out).toContain('#home');
    expect((await run('list ls #home')).match(/l\d/g)).toEqual(['l1']);
    expect(await run('list ls milk')).toContain('No lists match');
    expect(await run('list ls groceries')).toContain('Groceries');
    expect(await run('list ls +personal')).toContain('LISTS · 3');
    expect(await run('list ls +acme')).toContain('No client acme');
  });

  it('says how to start when there are none, and has JSON', async () => {
    expect(await run('list')).toContain('No lists yet. Start one: list new "D-mart" --tracked');
    expect((await json('list --json')).data).toEqual({ lists: [] });
  });

  it('refuses a missing name and an unknown subcommand', async () => {
    expect(await run('list new')).toContain('A list needs a name');
    expect(await run('list wat')).toContain('Unknown "list wat"');
  });
});

describe('items', () => {
  beforeEach(async () => {
    await run('list new Release --tracked');
  });

  it('adds quoted items one each, or loose words as one', async () => {
    expect(await run('list add l1 "write notes" "tag it"')).toContain('Added 2 items');
    expect(await run('list add l1 ship the thing')).toContain('Added 1 item');
    expect((await json('list show l1 --json')).data.items.map((i: any) => i.text)).toEqual(['write notes', 'tag it', 'ship the thing']);
  });

  it('shows numbered items with states', async () => {
    await run('list add l1 "a" "b" "c" "d"');
    await run('list state l1 2 doing');
    await run('list state l1 3 blocked');
    await run('list done l1 1');
    const out = await run('list show l1');
    expect(out).toContain('tracked · 1 of 4 done');
    expect(out).toMatch(/1\s+✓\s+a/);
    expect(out).toMatch(/2\s+◐\s+b\s+doing/);
    expect(out).toMatch(/3\s+⊘\s+c\s+blocked/);
    expect(out).toMatch(/4\s+○\s+d/);
  });

  it('ticks ranges, skips items already done, and offers reset or archive when all are done', async () => {
    await run('list add l1 "a" "b" "c"');
    const first = await run('list done l1 1-2');
    expect(first).toContain('2 items done');
    expect(first).toContain('2 of 3 done');
    expect(first).not.toContain('Reset it');
    const again = await run('list done l1 2-3');
    expect(again).toContain('1 item done');
    expect(again).toContain('1 item already done');
    expect(again).toContain('All 3 done. Use it again with: list reset l1 · or finish with: list archive l1');
    expect(await run('list show l1')).toContain('All 3 done');
  });

  it('shows plain lists without states or progress', async () => {
    await run('list new Ideas item:alpha item:beta');
    const out = await run('list show l2');
    expect(out).toContain('plain');
    expect(out).not.toMatch(/of 2 done/);
    expect(out).toMatch(/1\s+·\s+alpha/);
    expect((await json('list show l2 --json')).data.progress).toBeNull();
    expect(await run('list done l2 1')).toContain('plain list, so states are not shown');
  });

  it('edits and removes items, and says what is wrong with a number', async () => {
    await run('list add l1 "milk" "eggs" "bread"');
    expect(await run('list edit l1 1 "oat milk" note:"blue one"')).toContain('is now oat milk');
    expect(await run('list show l1')).toContain('blue one');
    expect(await run('list rm l1 2')).toContain('Removed 1 item from l1 · eggs');
    expect((await json('list show l1 --json')).data.items.map((i: any) => i.text)).toEqual(['oat milk', 'bread']);
    expect(await run('list done l1 9')).toContain('no item 9');
    expect(await run('list done l1 x')).toContain('isn\'t an item number');
    expect(await run('list state l1 1 later')).toContain('Which state?');
  });

  it('reorders by number, and sort changes only how the list is shown', async () => {
    await run('list add l1 "cherry" "apple" "banana"');
    expect(await run('list order l1 3 to 1')).toContain('Moved "banana" to place 1');
    expect((await json('list show l1 --json')).data.items.map((i: any) => i.text)).toEqual(['banana', 'cherry', 'apple']);
    expect(await run('list order l1 1 to 3')).toContain('place 3');
    expect((await json('list show l1 --json')).data.items.map((i: any) => i.text)).toEqual(['cherry', 'apple', 'banana']);

    await run('list done l1 1');
    expect(await run('list set l1 sort:alpha')).toContain('updated · viewSort');
    const shown = (await json('list show l1 --json')).data;
    // Numbers stay with the stored order; only the rows move.
    expect(shown.items.map((i: any) => i.text)).toEqual(['cherry', 'apple', 'banana']);
    expect(shown.shownOrder).toEqual([2, 3, 1]);
    const out = await run('list show l1');
    expect(out.indexOf('apple')).toBeLessThan(out.indexOf('banana'));
    expect(out).toContain('sorted by alpha');
    // A drag means "this order": the list goes back to manual.
    expect(await run('list order l1 1 to 2')).toContain('back to manual order');
    expect((await json('list show l1 --json')).data.viewSort).toBe('manual');
    expect(await run('list order l1 1 to 9')).toContain('between 1 and 3');
  });
});

describe('the list itself', () => {
  beforeEach(async () => {
    await run('list new "D-mart" --tracked item:milk item:eggs');
  });

  it('changes name, description, kind and tags', async () => {
    expect(await run('list set l1 name:"D-Mart run" desc:"Saturdays" kind:plain #groceries')).toContain('updated');
    const data = (await json('list show l1 --json')).data;
    expect(data).toMatchObject({ name: 'D-Mart run', description: 'Saturdays', kind: 'plain', tags: ['groceries'] });
    expect(await run('list set l1')).toContain('Change what?');
    expect(await run('list set l1 kind:odd')).toContain('plain or tracked');
    expect(await run('list set l1 sort:random')).toContain('Sort a list by');
  });

  it('resets after a confirmation, and counts it', async () => {
    await run('list done l1 1-2');
    const asked = await play('list reset l1', ['n']);
    expect(asked.questions).toEqual(['Reset it?']);
    expect(asked.text).toContain('sets 2 items of l1 D-mart back to open');
    expect(asked.text).toContain('Nothing reset.');
    expect((await json('list show l1 --json')).data.progress.done).toBe(2);

    const yes = await play('list reset l1', ['y']);
    expect(yes.text).toContain('is ready again · 2 items back to open');
    const data = (await json('list show l1 --json')).data;
    expect(data).toMatchObject({ resetCount: 1, progress: { done: 0, total: 2 } });
    expect(await run('list reset l1')).toContain('nothing to reset');
    await run('list done l1 1');
    expect((await json('list reset l1 --yes --json')).data.reset).toBe(true);
    expect(await run('list reset l1 --yes')).toContain('nothing to reset');
  });

  it('refuses to reset a plain list', async () => {
    await run('list new Ideas item:a');
    expect(await run('list reset l2')).toContain('plain list');
  });

  it('archives, unarchives, pins and moves', async () => {
    expect(await run('list pin l1')).toContain('pinned');
    expect((await json('list show l1 --json')).data.pinned).toBe(true);
    expect(await run('list unpin l1')).toContain('unpinned');
    expect(await run('list archive l1')).toContain('archived');
    expect(await run('list')).toContain('No lists yet');
    expect(await run('list')).toContain('1 archived');
    expect(await run('list --archived')).toContain('D-mart');
    expect(await run('list --all')).toContain('archived');
    expect(await run('list unarchive l1')).toContain('active again');

    await run('client new acme "Acme Corp"');
    await run('project new acme/website "Website"');
    expect(await run('list move l1 +acme/website')).toContain('is now in acme/website');
    expect(await run('list move l1 +acme/website')).toContain('already in acme/website');
    expect(await run('list move l1')).toContain('Move it where?');
  });

  it('deletes with a typed confirmation', async () => {
    const no = await play('list delete l1', ['nope']);
    expect(no.text).toContain('Nothing deleted.');
    expect(await run('list show l1')).toContain('D-mart');
    const yes = await play('list delete l1', ['l1']);
    expect(yes.text).toContain('Deleted l1 D-mart with 2 items');
    expect(await run('list show l1')).toContain('No list l1');
    await run('list new Again');
    expect(await run('list delete l2 --yes')).toContain('Deleted l2 Again');
  });

  it('sets a cover from a file, with a dark one, and clears it', async () => {
    const light = join(dir, 'light.svg');
    const dark = join(dir, 'dark.svg');
    writeFileSync(light, SVG);
    writeFileSync(dark, SVG.replace('<rect', '<rect fill="#111"'));
    const out = await run(`list cover l1 ${light} dark:${dark}`);
    expect(out).toContain('Cover set on l1');
    expect(out).toContain('light and dark');
    const data = (await json('list show l1 --json')).data;
    expect(data.cover).toMatchObject({ kind: 'svg', dark: true });
    // The bytes themselves stay out of JSON (they can be 200 KB).
    expect(JSON.stringify(data)).not.toContain('<svg');
    expect(await run('list show l1')).toContain('SVG, light and dark');
    expect(await run('list cover l1 --clear')).toContain('cover cleared');
    expect((await json('list show l1 --json')).data.cover).toBeNull();
    expect(await run('list cover l1')).toContain('Which file?');
    expect(await run(`list cover l1 ${join(dir, 'missing.svg')}`)).toContain("Can't read");
    writeFileSync(join(dir, 'x.txt'), 'hello');
    expect(await run(`list cover l1 ${join(dir, 'x.txt')}`)).toContain('SVG or a PNG');
  });
});

describe('around the lists', () => {
  it('shows a list with show l1, and a project page lists its lists', async () => {
    await run('client new acme "Acme Corp"');
    await run('project new acme/website "Website rebuild"');
    await run('list new Release --tracked item:a item:b');
    await run('list new Ideas item:x');
    expect(await run('show l1')).toContain('Release');
    const page = await run('show p1');
    expect(page).toContain('LISTS · 2');
    expect(page).toContain('Release');
    expect(page).toContain('0 of 2 done');
    expect((await json('show p1 --json')).data.lists.map((l: any) => l.ref).sort()).toEqual(['l1', 'l2']);
  });

  it('keeps lists out of today, the review and the summary', async () => {
    await run('list new Groceries --tracked item:milk');
    for (const line of ['today', 'summary', 'review']) expect(await run(line)).not.toMatch(/Groceries|LISTS/);
  });

  it('keeps a default project out of "going quiet", and out of projects until it holds a list', async () => {
    await run('client new acme "Acme Corp"');
    await run('project new acme/website "Website"');
    expect(await run('projects')).not.toContain('acme/general');
    await run('list new Notes +acme');
    expect(await run('projects')).toContain('acme/general');
    await run('owe @ravi "send the deck" due:+60d +acme/website');
    await run('owe @ravi "send the notes" due:+60d +acme/general');
    // A month later, the project nobody touched is going quiet; the shelf never is.
    keel.store.now = () => new Date(2026, 10, 12);
    const out = await run('today');
    expect(out).toContain('GOING QUIET');
    expect(out).toContain('acme/website');
    expect(out.slice(out.indexOf('GOING QUIET'))).not.toContain('acme/general');
  });

  it('hides an empty default project from the project list but shows it with --all', async () => {
    await run('list new Groceries');
    await run('list delete l1 --yes');
    expect(await run('projects')).not.toContain('personal/general');
    expect(await run('projects --all')).toContain('personal/general');
  });

  it('deletes a project with its lists, and says so', async () => {
    await run('client new acme "Acme Corp"');
    await run('project new acme/website "Website"');
    await run('list new Release --tracked item:a item:b');
    const asked = await play('project delete acme/website', ['no']);
    expect(asked.text).toContain('1 list (with their items)');
    expect((await play('project delete acme/website', ['acme/website'])).text).toContain('Deleted project');
    expect(await run('show l1')).toContain('No list l1');
    expect((await keel.store.db.select().from(t.listItems)).every((i) => i.deletedAt)).toBe(true);
  });

  it('deletes a client with the lists on its General shelf', async () => {
    await run('client new acme "Acme Corp"');
    await run('list new Notes +acme item:x');
    const asked = await play('client delete acme', ['no']);
    expect(asked.text).toContain('1 list (with their items)');
    await play('client delete acme', ['acme']);
    expect(await run('lists')).toContain('No lists yet');
  });

  it('suggests subcommands, list refs, item numbers and states', async () => {
    await run('list new Groceries --tracked item:milk item:eggs');
    const labels = async (input: string) => (await keel.complete(input)).suggestions.map((x) => x.insert);
    expect(await labels('list ')).toContain('new');
    expect(await labels('list re')).toEqual(['reset']);
    expect(await labels('list show ')).toEqual(['l1']);
    expect(await labels('list done l1 ')).toEqual(['1', '2']);
    expect(await labels('list state l1 1 ')).toEqual(['open', 'doing', 'blocked', 'done']);
    expect(await labels('show ')).toContain('l1');
    expect(await labels('li')).toContain('list');
    expect(await labels('lis')).toContain('lists');
  });
});

describe('export and import', () => {
  it('carries lists and items through a JSON export, and a v2 file still imports', async () => {
    await run('list new Groceries --tracked #home item:milk item:eggs');
    await run('list done l1 1');
    await run('list cover l1 --clear');
    const out = JSON.parse(await run('export'));
    expect(out.version).toBe(3);
    expect(out.data.lists).toHaveLength(1);
    expect(out.data.listItems).toHaveLength(2);
    expect(out.data.projects.some((p: any) => p.isDefault)).toBe(true);
    const file = join(dir, 'lists.json');
    writeFileSync(file, JSON.stringify(out));

    keel.close();
    keel = await openTestKeel(now);
    expect(await run(`import ${file}`)).toContain('1 list');
    expect(JSON.parse(await run('export')).data).toEqual(out.data);
    expect(await run('list show l1')).toContain('1 of 2 done');

    const v2 = join(dir, 'v2.json');
    writeFileSync(v2, JSON.stringify({ ...out, version: 2, data: { ...out.data, lists: undefined, listItems: undefined } }));
    keel.close();
    keel = await openTestKeel(now);
    expect(await run(`import ${v2}`)).toContain('Imported');
    expect(await run('lists')).toContain('No lists yet');
  });

  it('writes lists into the Markdown export', async () => {
    await run('list new Groceries --tracked #home desc:"Weekly" item:milk item:eggs');
    await run('list state l1 2 blocked');
    await run('list done l1 1');
    await run('list new Ideas item:alpha');
    const md = await run('export --md');
    expect(md).toContain('## Lists');
    expect(md).toContain('### l1 Groceries · personal/general · 1 of 2 done');
    expect(md).toContain('- [x] milk');
    expect(md).toContain('- [ ] eggs (blocked)');
    expect(md).toContain('#home');
    expect(md).toContain('- alpha');
  });
});

describe('adding items from a regular shell', () => {
  it('adds several items with item:, the way that survives a shell removing the quotes', async () => {
    await run('list new Groceries --tracked');
    // `keel list add l1 item:milk item:"oat milk"` reaches Keel as this line, with the quotes added back around words with spaces.
    expect(await run('list add l1 item:milk item:"oat milk" item:eggs')).toContain('Added 3 items');
    expect((await json('list show l1 --json')).data.items.map((i: any) => i.text)).toEqual(['milk', 'oat milk', 'eggs']);
    // Plain words are one item: a shell cannot tell "milk" "eggs" from milk eggs.
    expect(await run('list add l1 bread and butter')).toContain('Added 1 item');
    expect((await json('list show l1 --json')).data.items.at(-1).text).toBe('bread and butter');
  });
});
