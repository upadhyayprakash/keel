import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
let now: Date;
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const later = (days: number) => {
  now = new Date(now.getTime() + days * 86_400_000);
};

beforeEach(async () => {
  now = new Date(2026, 9, 12, 9, 0);
  keel = await openTestKeel(() => now);
  await run('client new acme "Acme Corp"');
  await run('client new northwind Northwind');
  await run('project new acme/website "Website rebuild"');
  await run('project new northwind/app "Customer app"');
});

afterEach(() => keel.close());

describe('clients and projects', () => {
  it('creates them and sets the first project as context', async () => {
    expect(await run('projects')).toContain('acme/website');
    expect((await keel.state()).context?.path).toBe('acme/website');
  });

  it('rejects duplicates and unknown clients', async () => {
    expect(await run('client new acme Again')).toContain('already exists');
    expect(await run('project new globex/site Site')).toContain('No client globex');
  });

  it('changes project status', async () => {
    expect(await run('set p1 status:paused')).toContain('status paused');
    expect(await run('projects')).toContain('paused');
  });
});

describe('capturing commitments', () => {
  it('needs a person and a due date', async () => {
    expect(await run('owe pricing deck')).toContain('Add @name');
    expect(await run('owe pricing deck @ravi')).toContain('due:<when>');
    expect(await run('owe pricing deck @ravi due:banana')).toContain("Can't read the date");
  });

  it('creates owe and wait items in the current context', async () => {
    expect(await run('owe pricing deck @ravi due:today from:meeting')).toContain('c1 I owe Ravi · Mon 12 Oct · acme/website');
    expect(await run('wait design files @meera due:today +northwind/app')).toContain('c2 waiting on Meera');
    const today = await run('today');
    expect(today).toContain('I OWE · DUE AND LATE');
    expect(today).toContain('pricing deck');
    expect(today).toContain('WAITING ON · FOLLOW UP');
    expect(today).toContain('northwind/app');
  });

  it('keeps the Slack link as the source', async () => {
    await run('owe revised SOW @ravi due:fri from:slack:https://acme.slack.com/archives/C1/p2');
    const show = await keel.run('show c1');
    expect(JSON.stringify(show)).toContain('"href":"https://acme.slack.com/archives/C1/p2"');
  });

  it('captures to the inbox with free text', async () => {
    expect(await run("in don't forget the CMS question")).toContain('i1 added to inbox');
    expect(await run('ls inbox')).toContain("don't forget the CMS question");
  });
});

describe('working the list', () => {
  beforeEach(async () => {
    await run('owe pricing deck @ravi due:today');
    await run('owe contact form spec @tom due:thu');
    await run('wait api keys @ops due:today');
  });

  it('sets focus and shows it first', async () => {
    expect(await run('focus c2 c1')).toContain('Focus set: c2 c1');
    const today = await run('today');
    const focus = today.slice(today.indexOf('FOCUS'), today.indexOf('WAITING ON'));
    expect(focus).toContain('1  c2');
    expect(focus).toContain('2  c1');
    expect(focus).toContain('(empty)');
    expect(await run('focus c9')).toContain('No commitment c9');
  });

  it('renegotiates, nudges and closes', async () => {
    expect(await run('renegotiate c1 due:wed')).toContain('renegotiated to Wed 14 Oct');
    expect(await run('show c1')).toContain('renegotiated  1x');
    expect(await run('nudge c3')).toContain('nudged');
    expect(await run('nudge c1')).toContain('not something you wait on');
    expect(await run('done c1')).toContain('c1 done');
    expect(await run('done c1')).toContain('already done');
    expect(await run('ls done')).toContain('pricing deck');
  });

  it('counts overdue items as days pass', async () => {
    later(2);
    const state = await keel.state();
    expect(state.counts).toEqual({ overdue: 1, today: 0, waiting: 1 });
    expect(await run('ls overdue')).toContain('2d late');
  });

  it('filters by client and person', async () => {
    await run('owe audit checklist @lena due:fri +northwind/app');
    const acme = await run('ls +acme');
    expect(acme).toContain('pricing deck');
    expect(acme).not.toContain('audit checklist');
    expect(await run('ls @lena')).toContain('audit checklist');
  });
});

describe('context switching', () => {
  it('warns when leaving without a resume note, then shows the next one', async () => {
    await run('park where:"login flow half done" next:"token refresh" unsure:"cookie or memory?" +northwind/app');
    const out = await run('switch northwind/app');
    expect(out).toContain('without a resume note');
    expect(out).toContain('Now in northwind/app');
    expect(out).toContain('login flow half done');
  });

  it('saves the note for the project being left when given inline', async () => {
    const out = await run('switch northwind/app where:"pricing copy done" next:"send deck"');
    expect(out).toContain('Resume note saved for acme/website');
    expect(await run('show p1')).toContain('pricing copy done');
  });

  it('park clears the context', async () => {
    expect(await run('park where:"done for today"')).toContain('not in a project now');
    expect((await keel.state()).context).toBeNull();
  });

  it('flags projects that go quiet', async () => {
    await run('owe pricing deck @ravi due:+10d');
    later(8);
    expect(await run('today')).toContain('GOING QUIET');
  });
});

describe('the terminal surface', () => {
  it('handles unknown commands and help', async () => {
    expect(await run('frobnicate')).toContain('Unknown command "frobnicate"');
    expect(await run('help')).toContain('COMMANDS');
    expect(await run('keel help')).toContain('TOKENS');
  });

  it('completes commands, people, projects and dates, and previews owe', async () => {
    await run('owe pricing deck @ravi due:today');
    expect((await keel.complete('sw')).suggestions.map((x) => x.insert)).toEqual(['switch']);
    expect((await keel.complete('owe deck @r')).suggestions.map((x) => x.insert)).toEqual(['@ravi']);
    expect((await keel.complete('ls +nor')).suggestions.map((x) => x.insert)).toEqual(['+northwind', '+northwind/app']);
    expect((await keel.complete('owe x due:to')).suggestions.map((x) => x.insert)).toEqual(['due:today', 'due:tomorrow']);
    expect((await keel.complete('done ')).suggestions.map((x) => x.insert)).toEqual(['c1']);
    const preview = (await keel.complete('owe revised SOW @ravi due:mon')).preview?.map((x) => x.text).join('');
    expect(preview).toContain('I owe · revised SOW → Ravi · acme/website · Mon 19 Oct');
  });

  it('stores the theme', async () => {
    expect(await run('theme light')).toContain('Theme set to light');
    expect((await keel.state()).theme).toBe('light');
    expect(await run('theme blue')).toContain('Unknown theme');
  });

  it('exports everything as JSON', async () => {
    const [block] = await keel.run('export --json');
    expect(block?.kind).toBe('raw');
    const data = JSON.parse((block as { text: string }).text);
    expect(data.data.projects).toHaveLength(2);
  });
});
