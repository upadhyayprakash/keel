import { blank, data, hint, line, ok, s, warn, type Block } from '../blocks';
import { formatDay } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import { classify, tokenize } from '../parse';
import { commitmentQueries, readCommitment, type CommitmentInput, type Direction } from './capture';
import { projectSpan, type Command } from './shared';

type Captured = { kind: Direction; input: CommitmentInput } | { kind: 'note'; text: string };

const MEETING_HINT = '> owe · < waiting · plain line = note · empty line ends';

export const meeting: Command = {
  name: 'meeting',
  usage: 'meeting [+client/project] ["title"]',
  summary: 'Capture promises as they happen: > owe, < waiting, anything else is a note',
  async *flow(k, p) {
    const project = await k.projectFromArgs(p);
    const title = p.words.join(' ').trim() || 'meeting';
    const people = new Map((await k.listPeople()).map((x) => [x.handle, x.name]));
    const items: Captured[] = [];

    let blocks: Block[] = [
      line([s('◆ ', 'accent'), s(`Meeting mode · ${title}`), ...(project ? [s(' · '), projectSpan(project)] : [s(' · no project', 'dim')])]),
    ];

    for (;;) {
      const answer = (yield { blocks, question: { prompt: '›', hint: MEETING_HINT } }).trim();
      if (!answer) break;
      blocks = [];

      const marker = answer[0];
      if (marker !== '>' && marker !== '<') {
        items.push({ kind: 'note', text: answer });
        blocks.push(line([s('note  ', 'muted'), s(answer)], 2));
        continue;
      }

      const direction: Direction = marker === '>' ? 'owe' : 'wait';
      const parsed = classify(tokenize(answer.slice(1)));
      if (parsed.projects.length === 0 && project) parsed.projects.push(project.path);
      if (!parsed.kv.from) parsed.kv.from = 'meeting';
      try {
        const input = await readCommitment(k, parsed, direction);
        items.push({ kind: direction, input });
        const name = people.get(input.handle) ?? input.handle.charAt(0).toUpperCase() + input.handle.slice(1);
        blocks.push(
          line(
            [
              s(direction === 'owe' ? 'owe   ' : 'wait  ', direction === 'owe' ? 'accent' : 'wait'),
              s(`${input.title} ${direction === 'owe' ? '→' : '←'} ${name} · ${formatDay(input.dueOn)}`),
            ],
            2,
          ),
        );
      } catch (e) {
        if (!(e instanceof KeelError)) throw e;
        // Never lose what was said: keep it as a note to sort out later.
        const text = answer.slice(1).trim();
        items.push({ kind: 'note', text });
        blocks.push(line([s('note  ', 'muted'), s(text), s(`  (kept as a note: ${e.message})`, 'today')], 2));
      }
    }

    if (items.length === 0) return [hint('Nothing captured.'), data({ saved: [] })];

    const count = (kind: Captured['kind']) => items.filter((i) => i.kind === kind).length;
    const summary = `${count('owe')} owe · ${count('wait')} waiting · ${count('note')} note${count('note') === 1 ? '' : 's'}`;
    const confirm = yield {
      blocks: [blank(), line([s('Captured ', 'default', { bold: true }), s(summary)])],
      question: { prompt: 'Save all?', hint: 'Y/n', choices: [{ key: 'y', label: 'yes' }, { key: 'n', label: 'no' }] },
    };
    if (/^n/i.test(confirm.trim())) return [warn('Nothing saved.'), data({ saved: [] })];

    const queries = [];
    const refs: string[] = [];
    const cache = new Map<string, { id: string; name: string }>();
    let nextCommitment = await k.nextRef(t.commitments);
    let nextInbox = await k.nextRef(t.inboxItems);
    for (const item of items) {
      if (item.kind === 'note') {
        const id = k.newId();
        queries.push(
          k.db.insert(t.inboxItems).values({ id, ...k.stamps(), refNo: nextInbox, text: item.text, projectId: project?.project.id ?? null, source: 'meeting' }),
          k.event('inbox', id, 'created', { meeting: title }),
        );
        refs.push(`i${nextInbox++}`);
      } else {
        const created = await commitmentQueries(k, item.input, item.kind, nextCommitment++, cache);
        queries.push(...created.queries);
        refs.push(created.ref);
      }
    }
    await k.batch(queries);
    return [
      ok([s(refs.join(' '), 'default', { bold: true }), s(' saved')]),
      ...(count('note') ? [hint('Notes went to the inbox. Sort them with: triage')] : []),
      data({ saved: refs }),
    ];
  },
};
