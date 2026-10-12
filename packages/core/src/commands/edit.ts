import { and, eq, isNull } from 'drizzle-orm';
import { data, hint, ok, s, warn, type Block } from '../blocks';
import { formatDay, parseDue } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { parseRef } from '../parse';
import type { Store } from '../store';
import { commitmentData, inboxData, projectData, projectSpan, refArg, type Command } from './shared';
import { today as todayCommand } from './views';

const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'] as const;
const COMMITMENT_STATUSES = ['open', 'done', 'dropped'] as const;

function close(status: 'done' | 'dropped'): Command {
  const name = status === 'done' ? 'done' : 'drop';
  return {
    name,
    usage: `${name} <c42|i3>`,
    summary: status === 'done' ? 'Mark a commitment done' : 'Drop a commitment or inbox item',
    async run(k, p) {
      const ref = refArg(p, status === 'done' ? ['c'] : ['c', 'i'], `Example: ${name} c42`);
      const at = k.iso();
      if (ref.kind === 'i') {
        const item = await k.inboxByRef(ref.n);
        await k.batch([
          k.db.update(t.inboxItems).set({ triagedAt: at, deletedAt: at, updatedAt: at }).where(eq(t.inboxItems.id, item.id)),
          k.event('inbox', item.id, 'dropped'),
        ]);
        const project = item.projectId ? await k.projectById(item.projectId) : null;
        return [
          ok([s(`i${item.refNo}`, 'default', { bold: true }), s(' dropped')]),
          data(inboxData({ ...item, triagedAt: at, deletedAt: at, updatedAt: at }, project?.path ?? null)),
        ];
      }
      const v = await k.commitmentByRef(ref.n);
      if (v.c.status !== 'open') return [warn(`c${v.c.refNo} is already ${v.c.status}.`), data(commitmentData(v))];
      await k.batch([
        k.db.update(t.commitments).set({ status, closedAt: at, updatedAt: at }).where(eq(t.commitments.id, v.c.id)),
        k.event('commitment', v.c.id, status),
      ]);
      return [
        ok([s(`c${v.c.refNo}`, 'default', { bold: true, ref: `c${v.c.refNo}` }), s(` ${status} · ${v.c.title}`)]),
        data(commitmentData(await k.commitmentByRef(ref.n))),
      ];
    },
  };
}

export const done = close('done');
export const drop = close('dropped');

export const renegotiate: Command = {
  name: 'renegotiate',
  usage: 'renegotiate <c42> due:<when>',
  summary: 'Agree a new due date (counts differently from a silent slip)',
  async run(k, p) {
    const ref = refArg(p, ['c'], 'Example: renegotiate c42 due:mon');
    const v = await k.commitmentByRef(ref.n);
    if (!p.kv.due) throw new KeelError('What is the new date? Add due:<when>.');
    const dueOn = parseDue(p.kv.due, k.now());
    if (!dueOn) throw new KeelError(`Can't read the date "${p.kv.due}".`);
    const at = k.iso();
    await k.batch([
      k.db
        .update(t.commitments)
        .set({ dueOn, renegotiatedCount: v.c.renegotiatedCount + 1, updatedAt: at })
        .where(eq(t.commitments.id, v.c.id)),
      k.event('commitment', v.c.id, 'renegotiated', { from: v.c.dueOn, to: dueOn }),
    ]);
    return [
      ok([s(`c${v.c.refNo}`, 'default', { bold: true }), s(` renegotiated to ${formatDay(dueOn)}`)]),
      data(commitmentData(await k.commitmentByRef(ref.n))),
    ];
  },
};

export const nudge: Command = {
  name: 'nudge',
  usage: 'nudge <c42>',
  summary: 'Record that you followed up on a waiting-on item',
  async run(k, p) {
    const ref = refArg(p, ['c'], 'Example: nudge c38');
    const v = await k.commitmentByRef(ref.n);
    if (v.c.direction !== 'wait') throw new KeelError(`c${v.c.refNo} is something you owe, not something you wait on.`);
    const at = k.iso();
    await k.batch([
      k.db.update(t.commitments).set({ lastNudgedAt: at, updatedAt: at }).where(eq(t.commitments.id, v.c.id)),
      k.event('commitment', v.c.id, 'nudged'),
    ]);
    return [
      ok([s(`c${v.c.refNo}`, 'default', { bold: true }), s(` nudged · ${v.personName} · ${v.c.title}`)]),
      data(commitmentData(await k.commitmentByRef(ref.n))),
    ];
  },
};

export const set: Command = {
  name: 'set',
  usage: 'set <c42|p7> [title:"..."] [due:<when>] [@who] [+client/project] [status:<status>] [slug:<new-slug>]',
  summary: 'Edit fields of a commitment or project',
  async run(k, p) {
    const ref = refArg(p, ['c', 'p'], 'Example: set c42 due:fri, set p7 status:paused');
    const at = k.iso();

    if (ref.kind === 'p') {
      const pv = await k.projectByRef(ref.n);
      if (!pv) throw new KeelError(`No project p${ref.n}.`);
      const changes: Partial<typeof t.projects.$inferInsert> = {};
      if (p.kv.status !== undefined) {
        if (!(PROJECT_STATUSES as readonly string[]).includes(p.kv.status)) {
          throw new KeelError(`Unknown status "${p.kv.status}".`, `Use one of: ${PROJECT_STATUSES.join(', ')}`);
        }
        changes.status = p.kv.status as (typeof PROJECT_STATUSES)[number];
      }
      if (p.kv.title) changes.name = p.kv.title;
      if (p.kv.slug !== undefined) {
        const slug = p.kv.slug.toLowerCase();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new KeelError(`"${slug}" can't be a slug.`, 'Use lowercase letters, numbers and dashes.');
        const taken = await k.db
          .select({ id: t.projects.id })
          .from(t.projects)
          .where(and(eq(t.projects.clientId, pv.client.id), eq(t.projects.slug, slug), isNull(t.projects.deletedAt)));
        if (taken.some((x) => x.id !== pv.project.id)) throw new KeelError(`Project ${pv.client.slug}/${slug} already exists.`);
        changes.slug = slug;
      }
      if (Object.keys(changes).length === 0) throw new KeelError('Nothing to change.', 'Example: set p7 status:paused');
      await k.batch([
        k.db.update(t.projects).set({ ...changes, updatedAt: at }).where(eq(t.projects.id, pv.project.id)),
        k.event('project', pv.project.id, 'updated', changes),
      ]);
      const out: Block[] = [ok([projectSpan(pv), s(` updated: ${describe(changes)}`)])];
      if (changes.status === 'paused') out.push(hint('Paused projects drop out of today but stay in the weekly review.'));
      out.push(data(projectData((await k.projectByRef(ref.n))!)));
      return out;
    }

    const v = await k.commitmentByRef(ref.n);
    const changes: Partial<typeof t.commitments.$inferInsert> = {};
    const queries = [];
    if (p.kv.title) changes.title = p.kv.title;
    if (p.kv.due) {
      const dueOn = parseDue(p.kv.due, k.now());
      if (!dueOn) throw new KeelError(`Can't read the date "${p.kv.due}".`);
      changes.dueOn = dueOn;
    }
    if (p.kv.status !== undefined) {
      if (!(COMMITMENT_STATUSES as readonly string[]).includes(p.kv.status)) {
        throw new KeelError(`Unknown status "${p.kv.status}".`, `Use one of: ${COMMITMENT_STATUSES.join(', ')}`);
      }
      changes.status = p.kv.status as (typeof COMMITMENT_STATUSES)[number];
      changes.closedAt = changes.status === 'open' ? null : at;
    }
    if (p.people[0]) {
      const person = await k.person(p.people[0]);
      queries.push(...person.queries);
      changes.personId = person.id;
    }
    if (p.projects[0]) changes.projectId = (await k.projectByPath(p.projects[0])).project.id;
    if (Object.keys(changes).length === 0) throw new KeelError('Nothing to change.', 'Example: set c42 title:"Send revised deck"');

    await k.batch([
      ...queries,
      k.db.update(t.commitments).set({ ...changes, updatedAt: at }).where(eq(t.commitments.id, v.c.id)),
      k.event('commitment', v.c.id, changes.dueOn ? 'moved' : 'updated', changes),
    ]);
    const out: Block[] = [ok([s(`c${v.c.refNo}`, 'default', { bold: true, ref: `c${v.c.refNo}` }), s(` updated: ${describe(changes)}`)])];
    if (changes.dueOn) out.push(hint(`Logged as a silent move. If you agreed the new date, use: renegotiate c${v.c.refNo} due:${p.kv.due}`));
    out.push(data(commitmentData(await k.commitmentByRef(ref.n))));
    return out;
  },
};

function describe(changes: Record<string, unknown>): string {
  return Object.entries(changes)
    .filter(([key]) => key !== 'closedAt')
    .map(([key, value]) => `${key.replace(/Id$/, '')} ${key === 'dueOn' ? formatDay(String(value)) : key.endsWith('Id') ? 'changed' : String(value)}`)
    .join(', ');
}

export const focus: Command = {
  name: 'focus',
  usage: 'focus <c42> [c51] [c60] | focus clear',
  summary: "Pick today's top 3",
  async run(k, p) {
    const date = k.today();
    if (p.words.length === 0) return todayCommand.run!(k, p);

    const at = k.iso();
    const clear = p.words[0] === 'clear';
    const refs = clear ? [] : p.words.map((w) => parseRef(w));
    if (refs.length > 3) throw new KeelError('Three at most. The rest is bonus.');
    if (refs.some((r) => !r || r.kind !== 'c')) throw new KeelError('Focus takes commitment refs.', 'Example: focus c42 c51 c60');

    const views = [];
    for (const r of refs) {
      const v = await k.commitmentByRef(r!.n);
      if (v.c.status !== 'open') throw new KeelError(`c${v.c.refNo} is already ${v.c.status}.`);
      views.push(v);
    }

    const queries = [];
    for (let slot = 1; slot <= 3; slot++) {
      const v = views[slot - 1];
      const id = `${date}:${slot}`;
      if (v) {
        queries.push(
          k.db
            .insert(t.focus)
            .values({ id, ...k.stamps(), date, slot, commitmentId: v.c.id })
            .onConflictDoUpdate({ target: t.focus.id, set: { commitmentId: v.c.id, deletedAt: null, updatedAt: at } }),
        );
      } else {
        queries.push(k.db.update(t.focus).set({ deletedAt: at, updatedAt: at }).where(eq(t.focus.id, id)));
      }
    }
    await k.batch(queries);
    const result = data({ date, focus: views.map(commitmentData) });
    return clear
      ? [ok('Focus cleared for today.'), result]
      : [ok([s('Focus set: '), s(views.map((v) => `c${v.c.refNo}`).join(' '), 'accent', { bold: true })]), hint('See it with: today'), result];
  },
};
