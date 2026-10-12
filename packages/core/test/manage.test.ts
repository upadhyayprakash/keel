import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));

/** Starts an interactive command and answers its questions in order. */
async function answer(line: string, ...answers: string[]): Promise<string> {
  let result = await keel.exec(line);
  const out = [renderText(result.blocks)];
  for (const a of answers) {
    if (!result.session) break;
    result = await keel.answer(result.session, a);
    out.push(renderText(result.blocks));
  }
  return out.join('\n');
}

beforeEach(async () => {
  keel = await openTestKeel(now);
  await run('client new acme "Acme Corp"');
  await run('client new northwind Northwind');
  await run('project new acme/website "Website rebuild"');
  await run('project new acme/app "Mobile app"');
  await run('project new northwind/portal "Customer portal"');
  await run('owe pricing deck @ravi due:thu');
  await run('wait design files @meera due:fri +acme/app');
  await run('owe portal demo @tom due:fri +northwind/portal');
  await run('park where:"pricing page"');
  await run('switch acme/website');
  await run('in ask about phase 2 +acme/website');
});

afterEach(() => keel.close());

describe('clients', () => {
  it('renames the name and the slug, and paths follow', async () => {
    expect(await run('client rename acme "Acme Inc"')).toContain('acme · Acme Inc');
    expect(await run('client rename acme slug:acme-inc')).toContain('Its projects are now acme-inc/...');
    expect(await run('projects')).toContain('acme-inc/website');
    expect(await run('ls')).toContain('acme-inc/website');
    expect(await run('client rename acme-inc slug:northwind')).toContain('already exists');
  });

  it('archives and brings back', async () => {
    const out = await run('client archive acme');
    expect(out).toContain('acme archived');
    expect(out).toContain('2 open commitments stay');
    expect(await run('clients')).not.toContain('Acme Corp');
    expect(await run('clients')).toContain('1 archived');
    expect(await run('clients --all')).toContain('archived');
    expect(await run('projects')).not.toContain('acme/website');
    expect(await run('switch acme/app')).toContain('acme is archived');
    expect((await keel.state()).context).toBeNull();
    expect(await run('ls')).toContain('pricing deck'); // open work stays visible

    expect(await run('client unarchive acme')).toContain('active again');
    expect(await run('projects')).toContain('acme/website');
  });

  it('asks before deleting, and only the exact name confirms', async () => {
    const asked = await answer('client delete acme', 'yes');
    expect(asked).toContain('This deletes client acme (Acme Corp) with 2 projects, 2 commitments, 1 resume note and 1 inbox item.');
    expect(asked).toContain('Nothing deleted.');
    expect(await run('clients')).toContain('acme');

    expect(await answer('client delete acme', 'acme')).toContain('Deleted client acme');
    expect(await run('clients')).not.toContain('acme');
    expect(await run('ls')).not.toContain('pricing deck');
    expect(await run('ls')).toContain('portal demo');
    expect(await run('ls inbox')).toContain('Inbox is empty');
    expect((await keel.state()).context).toBeNull();

    // The slug is free again.
    expect(await run('client new acme "Acme Again"')).toContain('client acme created');
  });

  it('never deletes from a script unless told to', async () => {
    expect(await run('client delete acme')).toContain('Nothing deleted.');
    const json = await keel.exec('client delete acme --json');
    expect(JSON.parse((json.blocks[0] as { text: string }).text).data).toEqual({ deleted: false });
    expect(await run('client delete acme --yes')).toContain('Deleted client acme');
  });
});

describe('projects', () => {
  it('renames the slug with set', async () => {
    expect(await run('set p1 slug:site')).toContain('slug site');
    expect(await run('projects')).toContain('acme/site');
    expect(await run('set p1 slug:app')).toContain('already exists');
  });

  it('deletes a project by ref or path, after confirming', async () => {
    expect(await answer('project delete p2', 'nope')).toContain('Nothing deleted.');
    expect(await answer('project delete p2', 'acme/app')).toContain('Deleted project acme/app (Mobile app) with 1 commitment');
    expect(await run('projects')).not.toContain('acme/app');
    expect(await run('ls')).not.toContain('design files');
    expect(await run('project delete northwind/portal --yes')).toContain('Deleted project northwind/portal');
    expect(await run('project new acme/app "App again"')).toContain('created');
  });
});

describe('people', () => {
  it('lists, renames and merges', async () => {
    expect(await run('people')).toContain('@ravi');
    expect(await run('person rename @ravi "Ravi Kumar"')).toContain('@ravi is now Ravi Kumar');
    expect(await run('show c1')).toContain('I owe Ravi Kumar');

    await run('owe follow-up notes @rav due:fri');
    const merged = await run('person merge @rav @ravi');
    expect(merged).toContain('@rav merged into @ravi · 1 commitment moved');
    expect(await run('ls @ravi')).toContain('follow-up notes');
    expect(await run('people')).not.toContain('@rav ');
    expect(await run('person merge @nobody @ravi')).toContain('No person @nobody');
  });
});
