import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Keel } from '../src/keel';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
const now = () => new Date(2026, 9, 12, 9, 0);
let keel: Keel;
const inserts = async (line: string) => (await keel.complete(line)).suggestions.map((s) => s.insert);

beforeEach(async () => {
  keel = await openTestKeel(now);
  for (const line of [
    'client new acme "Acme Corp"',
    'client new northwind Northwind',
    'client new globex Globex',
    'client archive globex',
    'project new acme/website "Website rebuild"',
    'project new northwind/portal "Customer portal"',
    'owe pricing deck @ravi due:thu #legal',
    'wait design files @meera due:fri',
    'in ask about phase 2',
  ]) {
    await keel.run(line);
  }
});

afterEach(() => keel.close());

describe('suggestions follow each command', () => {
  it('offers commands and shortcuts first', async () => {
    expect(await inserts('cl')).toEqual(['client', 'clients']);
    expect(await inserts('peo')).toEqual(['people']);
  });

  it('offers subcommands, then the right clients', async () => {
    expect(await inserts('client ')).toEqual(['new', 'rename', 'archive', 'unarchive', 'delete', 'ls']);
    expect(await inserts('client ar')).toEqual(['archive']);
    expect(await inserts('client rename ')).toEqual(['acme', 'globex', 'northwind']);
    expect(await inserts('client archive ')).toEqual(['acme', 'northwind']);
    expect(await inserts('client unarchive ')).toEqual(['globex']);
    expect(await inserts('client rename acme ')).toEqual(['slug:']);
  });

  it('builds project paths without a space in the middle', async () => {
    const out = await keel.complete('project new ');
    expect(out.suggestions.map((s) => s.insert)).toEqual(['acme/', 'northwind/']);
    expect(out.suggestions[0]?.continues).toBe(true);
    expect(await inserts('project delete ')).toEqual(['acme/website', 'northwind/portal', 'p1', 'p2']);
  });

  it('offers refs that fit the command', async () => {
    expect(await inserts('done ')).toEqual(['c1', 'c2']);
    expect(await inserts('nudge ')).toEqual(['c2']);
    expect(await inserts('drop ')).toEqual(['c1', 'c2', 'i1']);
    expect(await inserts('show ')).toEqual(['c1', 'c2', 'p1', 'p2', 'i1']);
    expect(await inserts('focus c1 ')).toEqual(['c2']);
    expect(await inserts('set p1 ')).toEqual(['title:', 'slug:', 'status:']);
    expect(await inserts('set p1 status:')).toEqual(['status:active', 'status:paused', 'status:done', 'status:archived']);
    expect(await inserts('set c1 status:')).toEqual(['status:open', 'status:done', 'status:dropped']);
    expect(await inserts('renegotiate c1 ')).toEqual(['due:']);
  });

  it('guides owe and wait: who, then when, then where from', async () => {
    expect(await inserts('owe ')).toEqual([]);
    expect(await inserts('owe send deck ')).toEqual(['@me', '@meera', '@ravi']);
    expect(await inserts('wait send deck ')).toEqual(['@meera', '@ravi']);
    expect((await inserts('owe send deck @ravi '))[0]).toBe('due:today');
    expect(await inserts('owe send deck @ravi due:fri ')).toEqual(['from:', '+acme/website', '+northwind/portal']);
    expect(await inserts('owe send deck @ravi du')).toEqual(['due:']);
    expect(await inserts('owe send deck @ravi de')).toEqual([]);
  });

  it('completes shared tokens anywhere', async () => {
    expect(await inserts('ls @r')).toEqual(['@ravi']);
    expect(await inserts('ls +a')).toEqual(['+acme', '+acme/website']);
    expect(await inserts('ls #')).toEqual(['#legal']);
    expect(await inserts('ls ')).toEqual(['owe', 'wait', 'overdue', 'done', 'inbox']);
    expect(await inserts('switch ')).toEqual(['northwind/portal']);
    expect(await inserts('person merge @rav ')).toEqual(['@me', '@meera', '@ravi']);
    expect(await inserts('person rename ')).toEqual(['@meera', '@ravi']);
    expect(await inserts('park ')).toEqual(['where:', 'next:', 'unsure:']);
    expect(await inserts('park where:"x" ')).toEqual(['next:', 'unsure:']);
  });
});
