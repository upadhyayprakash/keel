import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keel } from '@keel/core';
import { createApp } from '../src/index';

// Monday 12 October 2026, 09:00 local time.
const HOST = { host: '127.0.0.1:4242' };
let keel: Keel;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  keel = await Keel.open({ url: ':memory:', now: () => new Date(2026, 9, 12, 9, 0) });
  app = createApp({ keel, port: 4242 });
});

afterEach(() => keel.close());

const get = (path: string) => app.request(path, { headers: HOST });
const post = (path: string, body?: unknown, type = 'application/json') =>
  app.request(path, { method: 'POST', headers: { ...HOST, 'content-type': type }, body: body === undefined ? undefined : JSON.stringify(body) });

const RUN_5K = {
  title: 'Run 5 km',
  doneMeans: 'I run 5 km in one go',
  dueOn: '2026-11-08',
  appetite: '3 runs a week',
  obstacle: 'rainy mornings',
  plan: 'If it is raining at 7:00, then I will use the treadmill',
  steps: [{ text: 'Run 1 km', cueAt: '2026-10-17T07:00', cuePlace: 'the park', minimum: '10 minutes' }, { text: 'Run 3 km' }, { text: 'Run 5 km' }],
};

type GoalJson = { ref: string; status: string; progress: { done: number; total: number; label: string }; steps: Array<{ position: number; status: string; firstStep: boolean }> };
type ErrorJson = { error: string; hint: string | null; field: string | null };

describe('owner goals API', () => {
  it('creates a goal and returns it like goal show --json', async () => {
    const res = await post('/api/goals', RUN_5K);
    expect(res.status).toBe(201);
    const goal = (await res.json()) as GoalJson;
    expect(goal).toMatchObject({ ref: 'g1', title: 'Run 5 km', dueOn: '2026-11-08', status: 'active', progress: { done: 0, total: 3, label: '0 of 3 done' } });
    expect(goal.steps[0]).toMatchObject({ position: 1, text: 'Run 1 km', cueAt: '2026-10-17T07:00', cuePlace: 'the park', minimum: '10 minutes', firstStep: true, status: 'open' });

    const cli = (await keel.exec('goal show g1 --json')).blocks[0] as { text: string };
    expect(await (await get('/api/goals/g1')).json()).toEqual((JSON.parse(cli.text) as { data: unknown }).data);
  });

  it('says which field is wrong, so the form can show it there', async () => {
    const plan = await post('/api/goals', { ...RUN_5K, plan: 'treadmill when it rains' });
    expect(plan.status).toBe(400);
    expect(await plan.json()).toEqual({ error: 'Write the plan as "If ..., then I will ...".', hint: expect.stringContaining('treadmill'), field: 'plan' });
    expect(((await (await post('/api/goals', { ...RUN_5K, dueOn: '2026-01-01' })).json()) as ErrorJson).field).toBe('dueOn');
    expect(((await (await post('/api/goals', { ...RUN_5K, steps: [] })).json()) as ErrorJson).field).toBe('steps');
    expect(((await (await post('/api/goals', { ...RUN_5K, title: 42 })).json()) as ErrorJson).field).toBe('title');
    expect((await get('/api/goals')).status).toBe(200);
    expect(((await (await get('/api/goals')).json()) as { goals: unknown[] }).goals).toEqual([]);
  });

  it('refuses bodies that are not a JSON object', async () => {
    expect((await post('/api/goals', RUN_5K, 'text/plain')).status).toBe(415);
    expect((await post('/api/goals', [RUN_5K])).status).toBe(400);
    const broken = await app.request('/api/goals', { method: 'POST', headers: { ...HOST, 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
  });

  it('lists active goals with the server date, and closed ones with ?all=1', async () => {
    await post('/api/goals', RUN_5K);
    await post('/api/goals', { ...RUN_5K, title: 'Read a book', dueOn: '2026-10-20' });
    await keel.run('goal drop g1');
    const active = (await (await get('/api/goals')).json()) as { today: string; goals: GoalJson[] };
    expect(active.today).toBe('2026-10-12');
    expect(active.goals.map((g) => g.ref)).toEqual(['g2']);
    const all = (await (await get('/api/goals?all=1')).json()) as { goals: GoalJson[] };
    expect(all.goals.map((g) => [g.ref, g.status])).toEqual([
      ['g2', 'active'],
      ['g1', 'dropped'],
    ]);
  });

  it('marks a step done, and a second tap is a conflict that says what happened', async () => {
    await post('/api/goals', RUN_5K);
    const res = await post('/api/goals/g1/steps/1/done');
    expect(res.status).toBe(200);
    expect(((await res.json()) as GoalJson).progress).toEqual({ done: 1, total: 3, label: '1 of 3 done' });

    const again = await post('/api/goals/g1/steps/1/done');
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorJson).error).toMatch(/^Step 1 of g1 was already done on /);
  });

  it('lets only one of two taps at once through (ADR 0003)', async () => {
    await post('/api/goals', RUN_5K);
    const statuses = (await Promise.all([post('/api/goals/g1/steps/2/done'), post('/api/goals/g1/steps/2/done')])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(((await (await get('/api/goals/g1')).json()) as GoalJson).progress.done).toBe(1);
  });

  it('refuses steps on a closed goal with 409', async () => {
    await post('/api/goals', RUN_5K);
    await keel.run('goal done g1');
    const res = await post('/api/goals/g1/steps/1/done');
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorJson).error).toMatch(/^g1 is already done/);
  });

  it('answers 404 for a missing goal or step, and 400 for a step that is not a number', async () => {
    await post('/api/goals', RUN_5K);
    expect((await get('/api/goals/g9')).status).toBe(404);
    expect(await (await get('/api/goals/g9')).json()).toMatchObject({ error: 'No goal g9.' });
    expect((await post('/api/goals/g1/steps/9/done')).status).toBe(404);
    expect((await post('/api/goals/g1/steps/one/done')).status).toBe(400);
  });

  it('keeps the host and origin checks', async () => {
    expect((await app.request('/api/goals', { headers: { host: 'evil.example' } })).status).toBe(403);
    expect((await app.request('/api/goals', { method: 'POST', headers: { ...HOST, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify(RUN_5K) })).status).toBe(403);
  });
});
