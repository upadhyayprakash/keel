import { eq } from 'drizzle-orm';
import { blank, data, fail, hint, line, ok, s, type Block } from '../blocks';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { classify, tokenize } from '../parse';
import type { Store } from '../store';
import { commitmentQueries, createdLine, readCommitment, type Direction } from './capture';
import type { Command, Flow } from './shared';

const TRIAGE_HINT = 'owe @who due:<when> · wait @who due:<when> · keep · drop · skip · quit';

/** Walks the open inbox. Also step 1 of the weekly review. */
export async function* triageFlow(k: Store): Flow {
  const items = await k.openInbox();
  if (items.length === 0) return [hint('Inbox is empty.'), data({ commitments: 0, kept: 0, dropped: 0, skipped: 0 })];
  const projects = new Map((await k.listProjects()).map((pv) => [pv.project.id, pv]));
  const tally = { commitments: 0, kept: 0, dropped: 0, skipped: 0 };
  let blocks: Block[] = [];

  items: for (const [index, item] of items.entries()) {
    blocks.push(line([s(`${index + 1}/${items.length}  `, 'muted'), s(`i${item.refNo}  `, 'muted'), s(item.text, 'default', { bold: true })]));
    for (;;) {
      const answer = (yield { blocks, question: { prompt: 'Turn into', hint: TRIAGE_HINT } }).trim();
      blocks = [];
      const [word = '', ...rest] = answer.split(/\s+/);
      const verb = word.toLowerCase();
      const at = k.iso();

      if (verb === '' || verb === 's' || verb === 'skip') {
        tally.skipped++;
        continue items;
      }
      if (verb === 'q' || verb === 'quit') break items;
      if (verb === 'k' || verb === 'keep') {
        await k.batch([
          k.db.update(t.inboxItems).set({ triagedAt: at, updatedAt: at }).where(eq(t.inboxItems.id, item.id)),
          k.event('inbox', item.id, 'kept'),
        ]);
        tally.kept++;
        continue items;
      }
      if (verb === 'd' || verb === 'drop') {
        await k.batch([
          k.db.update(t.inboxItems).set({ triagedAt: at, deletedAt: at, updatedAt: at }).where(eq(t.inboxItems.id, item.id)),
          k.event('inbox', item.id, 'dropped'),
        ]);
        tally.dropped++;
        continue items;
      }
      if (['o', 'owe', 'w', 'wait'].includes(verb)) {
        const direction: Direction = verb.startsWith('o') ? 'owe' : 'wait';
        // The item text is the title unless the answer gives a new one.
        const parsed = classify(tokenize(rest.join(' ')));
        if (parsed.words.length === 0) parsed.words.push(item.text);
        const pv = item.projectId ? projects.get(item.projectId) : undefined;
        if (parsed.projects.length === 0 && pv) parsed.projects.push(pv.path);
        try {
          const input = await readCommitment(k, parsed, direction);
          const created = await commitmentQueries(k, input, direction, await k.nextRef(t.commitments));
          await k.batch([
            ...created.queries,
            k.db.update(t.inboxItems).set({ triagedAt: at, updatedAt: at }).where(eq(t.inboxItems.id, item.id)),
            k.event('inbox', item.id, 'triaged', { into: created.ref }),
          ]);
          blocks.push(ok(createdLine(created.ref, direction, created.personName, input)));
          tally.commitments++;
          continue items;
        } catch (e) {
          if (!(e instanceof KeelError)) throw e;
          blocks.push(fail(e.message), ...(e.hint ? [hint(e.hint)] : []));
          continue;
        }
      }
      blocks.push(fail(`"${word}" isn't an option.`), hint(TRIAGE_HINT));
    }
  }

  return [
    ...blocks,
    blank(),
    ok(`Inbox: ${tally.commitments} turned into commitments, ${tally.kept} kept, ${tally.dropped} dropped, ${tally.skipped} skipped.`),
    data({ ...tally }),
  ];
}

export const triage: Command = {
  name: 'triage',
  usage: 'triage',
  summary: 'Walk the inbox: turn each item into owe, wait, keep or drop',
  flow: (k) => triageFlow(k),
};
