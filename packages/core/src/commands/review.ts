import { eq } from 'drizzle-orm';
import { blank, fail, heading, hint, line, ok, s, table, warn, type Block, type Question } from '../blocks';
import { addDays, dayDiff, formatDay, weekStart } from '../dates';
import { goalRef, listGoals, openGoal } from '../goals';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { classify, tokenize } from '../parse';
import type { CommitmentView, Store } from '../store';
import { done, drop, nudge, renegotiate, set } from './edit';
import { askReview, closeBlocks, goalRow, nextStepLine, stepsDoneIn } from './goals';
import { askNote, saveNote } from './projects';
import { commitmentRow, projectSpan, type Command } from './shared';
import { summaryBlocks } from './summary';
import { triageFlow } from './triage';

const STEPS = ['Inbox to zero', 'Overdue: decide each', 'Waiting on', 'Goals', 'Projects and resume notes', 'Next week per client', 'Week summary'];

/** The week whose priorities a review sets: next week when run Friday to Sunday. */
export const priorityWeek = (today: string) => weekStart(addDays(today, 3));

/** Runs an existing command (done, drop, ...) and returns its output, or the error as blocks. */
async function apply(k: Store, command: { run?: Command['run'] }, args: string): Promise<{ ok: boolean; blocks: Block[] }> {
  try {
    return { ok: true, blocks: await command.run!(k, classify(tokenize(args))) };
  } catch (e) {
    if (!(e instanceof KeelError)) throw e;
    return { ok: false, blocks: [fail(e.message), ...(e.hint ? [hint(e.hint)] : [])] };
  }
}

/** Splits "r fri" or "renegotiate due:fri" into a verb and a date. */
function verbAndDate(answer: string): { verb: string; when: string } {
  const [verb = '', ...rest] = answer.trim().split(/\s+/);
  return { verb: verb.toLowerCase(), when: rest.join(' ').replace(/^due:/, '') };
}

export const review: Command = {
  name: 'review',
  usage: 'review',
  summary: 'Guided weekly review, about 30 minutes',
  async *flow(k) {
    const day = k.today();
    let pending: Block[] = [];
    const take = () => {
      const out = pending;
      pending = [];
      return out;
    };
    const step = (n: number) => pending.push(blank(), heading(`STEP ${n} OF ${STEPS.length} · ${STEPS[n - 1]!.toUpperCase()}`, 'accent'));
    const ask = (question: Question) => ({ blocks: take(), question });

    // 1. Inbox
    step(1);
    pending.push(...(yield* triageFlow(k)));

    // 2. Overdue things I owe
    step(2);
    const open = await k.commitmentViews([eq(t.commitments.status, 'open')]);
    const overdue = open.filter((v) => v.c.direction === 'owe' && v.c.dueOn < day);
    if (overdue.length === 0) pending.push(hint('Nothing overdue.'));
    for (const v of overdue) {
      pending.push(table([commitmentRow(v, day)]));
      for (;;) {
        const { verb, when } = verbAndDate(yield ask({ prompt: 'Decide', hint: 'done · renegotiate <when> · drop · skip' }));
        const result = await decide(k, v, verb, when, {
          done: () => apply(k, done, `c${v.c.refNo}`),
          renegotiate: () => apply(k, renegotiate, `c${v.c.refNo} due:${when}`),
          drop: () => apply(k, drop, `c${v.c.refNo}`),
        });
        pending.push(...result.blocks);
        if (result.ok) break;
      }
    }

    // 3. Waiting on
    step(3);
    const waiting = open.filter((v) => v.c.direction === 'wait' && v.c.dueOn <= addDays(day, 3));
    if (waiting.length === 0) pending.push(hint('Nobody owes you anything due soon.'));
    for (const v of waiting) {
      pending.push(table([commitmentRow(v, day)]));
      for (;;) {
        const { verb, when } = verbAndDate(yield ask({ prompt: 'Decide', hint: 'nudge · got it · new date <when> · drop · skip' }));
        const result = await decide(k, v, verb, when, {
          nudge: () => apply(k, nudge, `c${v.c.refNo}`),
          got: () => apply(k, done, `c${v.c.refNo}`),
          renegotiate: () => apply(k, renegotiate, `c${v.c.refNo} due:${when}`),
          drop: () => apply(k, drop, `c${v.c.refNo}`),
        });
        pending.push(...result.blocks);
        if (result.ok) break;
      }
    }

    // 4. Goals: how each one went this week, then keep going, close or drop it (ADR 0004).
    step(4);
    const goals = await listGoals(k, 'active');
    if (goals.length === 0) pending.push(hint('No active goals. Start one with: goal new "Run 5 km"'));
    for (const g of goals) {
      const thisWeek = stepsDoneIn(g, weekStart(day), day);
      pending.push(table([goalRow(g, day, [s(`${thisWeek} done this week`, thisWeek ? 'done' : 'muted')])]), nextStepLine(g, day));
      for (;;) {
        const verb = (yield ask({ prompt: 'Still on track?', hint: 'ok · done · drop · skip' })).trim().toLowerCase();
        if (verb === '' || verb === 'ok' || verb === 's' || verb === 'skip') break;
        const outcome = verb === 'd' || verb === 'done' ? 'done' : verb === 'x' || verb === 'drop' ? 'dropped' : null;
        if (!outcome) {
          pending.push(fail(`"${verb}" isn't an option.`));
          continue;
        }
        // Closed on another device meanwhile: say so and move on (first close wins, ADR 0003).
        try {
          const answers = yield* askReview(await openGoal(k, goalRef(g.goal)), day, take());
          pending.push(...(await closeBlocks(k, goalRef(g.goal), outcome, answers)));
        } catch (e) {
          if (!(e instanceof KeelError)) throw e;
          pending.push(fail(e.message), ...(e.hint ? [hint(e.hint)] : []));
        }
        break;
      }
    }

    // 5. Projects and their resume notes
    step(5);
    const projects = (await k.listProjects()).filter((pv) => pv.project.status === 'active' && !pv.project.isDefault);
    if (projects.length === 0) pending.push(hint('No active projects.'));
    for (const pv of projects) {
      const note = await k.latestResumeNote(pv.project.id);
      const age = note ? dayDiff(note.createdAt.slice(0, 10), k.iso().slice(0, 10)) : null;
      const openHere = open.filter((v) => v.project === pv.path).length;
      pending.push(
        line([
          projectSpan(pv),
          s(`  ${openHere} open · `, 'muted'),
          age === null ? s('no resume note', 'today') : s(`note ${age === 0 ? 'from today' : `${age}d old`}`, age > 7 ? 'today' : 'muted'),
        ]),
      );
      for (;;) {
        const verb = (yield ask({ prompt: 'Still right?', hint: 'ok · note (write a new one) · pause · done' })).trim().toLowerCase();
        if (verb === '' || verb === 'ok' || verb === 's' || verb === 'skip') break;
        if (verb === 'n' || verb === 'note') {
          const fields = yield* askNote(pv, 'Resume note for');
          if (fields) {
            await k.batch(saveNote(k, pv.project.id, fields));
            pending.push(ok([s('Resume note saved for '), projectSpan(pv)]));
          }
          break;
        }
        if (verb === 'p' || verb === 'pause' || verb === 'd' || verb === 'done') {
          const status = verb.startsWith('p') ? 'paused' : 'done';
          pending.push(...(await apply(k, set, `p${pv.project.refNo} status:${status}`)).blocks);
          break;
        }
        pending.push(fail(`"${verb}" isn't an option.`));
      }
    }

    // 6. Next week's priority per client
    step(6);
    const week = priorityWeek(day);
    const clients = (await k.listClients()).filter((c) => projects.some((pv) => pv.client.id === c.id));
    const priorities: Record<string, string> = JSON.parse((await k.getSetting(`priorities:${week}`)) ?? '{}');
    if (clients.length === 0) pending.push(hint('No clients with active projects.'));
    for (const c of clients) {
      const answer = (yield ask({
        prompt: `Top priority for ${c.name}, week of ${formatDay(week, day)}?`,
        hint: priorities[c.slug] ? `enter keeps: ${priorities[c.slug]}` : 'enter skips',
      })).trim();
      if (answer) priorities[c.slug] = answer;
    }

    // 7. Summary
    step(7);
    await k.batch([
      k.setSetting(`priorities:${week}`, JSON.stringify(priorities)),
      k.setSetting('lastReviewAt', k.iso()),
      k.event('review', week, 'done', { priorities }),
    ]);
    return [...take(), ...(await summaryBlocks(k, 'week')), blank(), ok('Review done. Priorities show up in today.')];
  },
};

type Actions = Partial<Record<'done' | 'renegotiate' | 'drop' | 'nudge' | 'got', () => Promise<{ ok: boolean; blocks: Block[] }>>>;

/** Maps a short answer to one of the allowed actions. Skip counts as decided. */
async function decide(_k: Store, v: CommitmentView, verb: string, when: string, actions: Actions): Promise<{ ok: boolean; blocks: Block[] }> {
  const aliases: Record<string, keyof Actions> = {
    d: 'done', done: 'done',
    r: 'renegotiate', renegotiate: 'renegotiate', new: 'renegotiate', date: 'renegotiate',
    x: 'drop', drop: 'drop',
    n: 'nudge', nudge: 'nudge',
    g: 'got', got: 'got',
  };
  if (verb === '' || verb === 's' || verb === 'skip') return { ok: true, blocks: [line([s(`c${v.c.refNo} skipped`, 'muted')], 2)] };
  const action = aliases[verb];
  const run = action ? actions[action] : undefined;
  if (!run) return { ok: false, blocks: [fail(`"${verb}" isn't an option here.`)] };
  if (action === 'renegotiate' && !when) return { ok: false, blocks: [warn('Which date? For example: renegotiate fri')] };
  return run();
}
