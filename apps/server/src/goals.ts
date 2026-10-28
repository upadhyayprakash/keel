import type { Context, Hono } from 'hono';
import { Conflict, KeelError, NotFound, completeStep, createGoal, findGoal, goalData, listGoals, type Keel, type NewGoal, type NewStep } from '@keel/core';

// ADR 0004: the owner's API for the Goals app. Every route works on the goal model
// in @keel/core, so the phone, the CLI and the browser terminal share one set of
// rules (ADR 0003 guards included). With login on, these need a Goals or terminal
// session (see index.ts). JSON field names are the same as `keel goal ... --json`.

/** A problem with the request, in the user's words, with the field it is about. */
function failure(c: Context, e: unknown) {
  if (!(e instanceof KeelError)) throw e;
  const status = e instanceof NotFound ? 404 : e instanceof Conflict ? 409 : 400;
  return c.json({ error: e.message, hint: e.hint || null, field: e.field ?? null }, status);
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
const optional = (value: unknown) => (typeof value === 'string' ? value : null);

/** Reads a new goal from a request body. Wrong types read as missing, so the model's own checks answer. */
function newGoal(body: Record<string, unknown>): NewGoal {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  return {
    title: text(body.title) ?? '',
    doneMeans: text(body.doneMeans) ?? '',
    dueOn: text(body.dueOn) ?? '',
    appetite: optional(body.appetite),
    obstacle: optional(body.obstacle),
    plan: text(body.plan) ?? '',
    steps: steps.map((raw): NewStep => {
      const step = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      return { text: text(step.text) ?? '', cueAt: optional(step.cueAt), cuePlace: optional(step.cuePlace), minimum: optional(step.minimum), firstStep: step.firstStep === true };
    }),
  };
}

export function goalRoutes(app: Hono, keel: Keel): void {
  const k = keel.store;

  // Active goals, nearest deadline first; ?all=1 adds closed ones. `today` is the
  // server's local date, which deadlines and "days left" count from.
  app.get('/api/goals', async (c) => {
    const all = c.req.query('all') === '1';
    const goals = (await listGoals(k)).filter((v) => all || v.goal.status === 'active');
    return c.json({ today: k.today(), goals: goals.map(goalData) });
  });

  app.post('/api/goals', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.text('Expected JSON', 415);
    const body = await c.req.json<unknown>().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Expected a goal as a JSON object.', hint: null, field: null }, 400);
    try {
      return c.json(goalData(await createGoal(k, newGoal(body as Record<string, unknown>))), 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  app.get('/api/goals/:ref', async (c) => {
    try {
      return c.json(goalData(await findGoal(k, c.req.param('ref'))));
    } catch (e) {
      return failure(c, e);
    }
  });

  // Marks one step done. A second tap, or a tap after another device closed the goal, is a 409 that says what happened.
  app.post('/api/goals/:ref/steps/:position/done', async (c) => {
    const position = Number(c.req.param('position'));
    if (!Number.isInteger(position) || position < 1) return c.json({ error: 'Which step? Give its number.', hint: null, field: null }, 400);
    try {
      return c.json(goalData(await completeStep(k, c.req.param('ref'), position)));
    } catch (e) {
      return failure(c, e);
    }
  });
}
