import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Keel } from '../src/keel';
import { renderText } from '../src/render-text';
import { openTestKeel } from './helpers';

// Monday 12 October 2026, 09:00 local time.
let now: Date;
let keel: Keel;
const run = async (line: string) => renderText(await keel.run(line));
const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

/** Runs an interactive command, answering each question in order. */
async function play(line: string, answers: Array<string | null>) {
  let result = await keel.exec(line);
  const out = [renderText(result.blocks)];
  const questions: string[] = [];
  while (result.question && result.session) {
    questions.push(result.question.prompt);
    if (answers.length === 0) throw new Error(`No answer left for "${result.question.prompt}"`);
    result = await keel.answer(result.session, answers.shift()!);
    out.push(renderText(result.blocks));
  }
  return { text: out.join('\n'), questions };
}

beforeEach(async () => {
  now = new Date(2026, 9, 12, 9, 0);
  keel = await openTestKeel(() => now);
  await run('client new acme "Acme Corp"');
  await run('client new northwind Northwind');
  await run('project new acme/website "Website rebuild"');
  await run('project new northwind/app "Customer app"');
});

afterEach(() => keel.close());

describe('switch and park ask for the resume note', () => {
  it('asks three questions when leaving without a note', async () => {
    later(130);
    const { text, questions } = await play('switch northwind/app', ['pricing copy done', 'send deck', '']);
    expect(questions).toEqual(['Where are you?', "What's next?", 'Unsure about?']);
    expect(text).toContain('Leaving after 2h 10m');
    expect(text).toContain('Resume note saved for acme/website');
    expect(await run('show p1')).toContain('pricing copy done');
  });

  it('skips the questions when a fresh note exists or one is given inline', async () => {
    const { questions } = await play('switch northwind/app where:"done for now"', []);
    expect(questions).toEqual([]);
  });

  it('park can be cancelled midway', async () => {
    const { text } = await play('park', ['half done', null]);
    expect(text).toContain('Cancelled');
    expect((await keel.state()).context?.path).toBe('acme/website');
  });

  it('expired or unknown sessions fail cleanly', async () => {
    expect(renderText((await keel.answer('nope', 'x')).blocks)).toContain('expired');
  });
});

describe('meeting', () => {
  it('captures owe, wait and notes, and keeps bad lines as notes', async () => {
    const { text, questions } = await play('meeting +acme/website "weekly sync"', [
      '> pricing deck @newbie due:thu',
      '< design files @meera due:fri',
      '> another thing for @newbie due:fri',
      'budget approved for phase 2',
      '> call back without a date @ravi',
      '',
      'y',
    ]);
    expect(questions.at(-1)).toBe('Save all?');
    expect(text).toContain('pricing deck → Newbie · Thu 15 Oct');
    expect(text).toContain('kept as a note');
    expect(text).toContain('Captured 2 owe · 1 waiting · 2 notes');
    expect(text).toContain('c1 c2 c3 i1 i2 saved');
    const owe = await run('ls owe');
    expect(owe).toContain('another thing for');
    expect(await run('show c1')).toContain('meeting');
    expect(await run('ls inbox')).toContain('budget approved');
  });

  it('saves nothing when declined', async () => {
    const { text } = await play('meeting', ['> deck @ravi due:thu', '', 'n']);
    expect(text).toContain('Nothing saved');
    expect(await run('ls')).toContain('Nothing here');
  });
});

describe('triage', () => {
  it('turns inbox items into commitments, keeps, drops and retries', async () => {
    await run('in send the sitemap');
    await run('in read the brand guide');
    await run('in old idea');
    const { text } = await play('triage', ['owe @ravi', 'owe @ravi due:fri', 'keep', 'drop']);
    expect(text).toContain('When is it due?');
    expect(text).toContain('c1 I owe Ravi · Fri 16 Oct · acme/website');
    expect(text).toContain('1 turned into commitments, 1 kept, 1 dropped');
    expect(await run('ls inbox')).toContain('Inbox is empty');
  });
});

describe('summary and review', () => {
  it('counts kept, renegotiated, slipped and time per client', async () => {
    await run('owe on time @ravi due:today');
    await run('owe moved @ravi due:today');
    await run('owe slipped one @ravi due:tue');
    await run('done c1');
    await run('renegotiate c2 due:fri');
    later(90);
    await play('switch northwind/app where:"x"', []);
    later(60);
    now = new Date(2026, 9, 14, 9, 0); // Wednesday
    const text = await run('summary week');
    expect(text).toContain('Week 42 · 12 to 18 Oct');
    expect(text).toMatch(/promises kept\s+1/);
    expect(text).toMatch(/renegotiated\s+1/);
    expect(text).toMatch(/slipped\s+1\s+c3 slipped one/);
    expect(text).toContain('kept rate');
    expect(text).toContain('67%');
    expect(text).toContain('TIME PER CLIENT');
    expect(text).toMatch(/acme\s+█+\s+1h 30m/);
  });

  it('walks the whole review and shows priorities in today', async () => {
    await run('in stray thought');
    await run('owe late thing @ravi due:today');
    await run('wait api keys @ops due:today');
    now = new Date(2026, 9, 16, 15, 0); // Friday afternoon
    expect(await run('today')).toContain('Review day');

    const { text, questions } = await play('review', [
      'drop', // inbox item
      'renegotiate mon', // overdue owe
      'nudge', // waiting
      'ok', // acme/website
      'pause', // northwind/app
      'Launch the pricing page', // acme priority
      '', // northwind priority
    ]);
    expect(questions.filter((q) => q === 'Decide')).toHaveLength(2);
    expect(text).toContain('STEP 6 OF 6');
    expect(text).toContain('renegotiated to Mon 19 Oct');
    expect(text).toContain('Review done');
    expect(await run('projects')).toContain('paused');

    now = new Date(2026, 9, 19, 9, 0); // next Monday
    const today = await run('today');
    expect(today).toContain('THIS WEEK');
    expect(today).toContain('Launch the pricing page');
    expect(today).not.toContain('Review day');
  });

  it('runs to the end non-interactively by skipping every question', async () => {
    await run('in stray thought');
    const text = await run('review');
    expect(text).toContain('Review done');
  });
});
