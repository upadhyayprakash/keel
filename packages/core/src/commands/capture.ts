import { hint, ok, s } from '../blocks';
import { formatDay, parseDue } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import type { Parsed } from '../parse';
import type { Store } from '../store';
import { parseSource, projectSpan, type Command } from './shared';

/** Validates owe/wait input. Shared with the live preview in the browser. */
export async function readCommitment(k: Store, p: Parsed, direction: 'owe' | 'wait') {
  const title = p.words.join(' ').trim();
  const example = `${direction} send pricing deck @ravi due:thu`;
  if (!title) throw new KeelError('What is the promise?', `Example: ${example}`);
  if (p.people.length === 0) throw new KeelError(direction === 'owe' ? 'Who do you owe it to? Add @name.' : 'Who owes it to you? Add @name.', `Example: ${example}`);
  if (p.people.length > 1) throw new KeelError('One person per commitment.', 'Split it into one commitment per person.');
  if (!p.kv.due) throw new KeelError('When is it due? Add due:<when>.', 'Examples: due:thu, due:tomorrow, due:+3d, due:2026-10-20');
  const dueOn = parseDue(p.kv.due, k.now());
  if (!dueOn) throw new KeelError(`Can't read the date "${p.kv.due}".`, 'Examples: due:thu, due:tomorrow, due:+3d, due:2026-10-20');
  const project = await k.projectFromArgs(p);
  const { source, sourceRef } = parseSource(p.kv.from);
  return { title, handle: p.people[0]!, dueOn, project, source, sourceRef };
}

function commitmentCommand(direction: 'owe' | 'wait'): Command {
  return {
    name: direction,
    usage: `${direction} <what> @who due:<when> [+client/project] [from:meeting|slack:<link>] [#tag]`,
    summary: direction === 'owe' ? 'New "I owe" commitment' : 'New "waiting on" commitment',
    async run(k, p) {
      const input = await readCommitment(k, p, direction);
      const person = await k.person(input.handle);
      const id = k.newId();
      const refNo = await k.nextRef(t.commitments);
      await k.batch([
        ...person.queries,
        k.db.insert(t.commitments).values({
          id,
          ...k.stamps(),
          refNo,
          direction,
          title: input.title,
          personId: person.id,
          projectId: input.project?.project.id ?? null,
          dueOn: input.dueOn,
          source: input.source,
          sourceRef: input.sourceRef,
          tags: p.tags.length ? p.tags.join(' ') : null,
        }),
        k.event('commitment', id, 'created', { direction, dueOn: input.dueOn }),
      ]);
      const ref = `c${refNo}`;
      return [
        ok([
          s(ref, 'default', { bold: true, ref }),
          s(direction === 'owe' ? ` I owe ${person.name}` : ` waiting on ${person.name}`),
          s(` · ${formatDay(input.dueOn)}`),
          ...(input.project ? [s(' · '), projectSpan(input.project)] : [s(' · no project', 'dim')]),
        ]),
      ];
    },
  };
}

export const owe = commitmentCommand('owe');
export const wait = commitmentCommand('wait');

export const inbox: Command = {
  name: 'in',
  usage: 'in <anything> [+client/project]',
  summary: 'Capture to the inbox, sort it later',
  async run(k, p) {
    const text = p.raw
      .filter((tok) => tok.quoted || !/^\+[\w-]+(\/[\w-]+)?$/.test(tok.text))
      .map((tok) => tok.text)
      .join(' ')
      .trim();
    if (!text) throw new KeelError('Nothing to capture.', 'Example: in ask Ravi about the phase 2 budget');
    const project = await k.projectFromArgs(p);
    const id = k.newId();
    const refNo = await k.nextRef(t.inboxItems);
    await k.batch([
      k.db.insert(t.inboxItems).values({ id, ...k.stamps(), refNo, text, projectId: project?.project.id ?? null }),
      k.event('inbox', id, 'created'),
    ]);
    const ref = `i${refNo}`;
    return [
      ok([s(ref, 'default', { bold: true, ref }), s(' added to inbox'), ...(project ? [s(' · '), projectSpan(project)] : [])]),
      ...(refNo === 1 ? [hint('Sort it later with: ls inbox')] : []),
    ];
  },
};
