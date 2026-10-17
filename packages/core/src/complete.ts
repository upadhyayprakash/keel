import { eq } from 'drizzle-orm';
import { commands, expand, findCommand } from './commands/index';
import { SOURCES } from './commands/shared';
import { formatDay, parseDue } from './dates';
import * as t from './db/schema';
import { SELF } from './self';
import type { Store } from './store';

export interface Suggestion {
  insert: string;
  label: string;
  detail?: string;
  /** More of the same token follows (`acme/`, `due:`), so don't add a space after it. */
  continues?: boolean;
}

export interface Completion {
  /** Where the token being completed starts; replace from here with `insert`. */
  replaceFrom: number;
  suggestions: Suggestion[];
  /** What the command will create, for owe/wait. */
  preview: import('./blocks').Span[] | null;
}

const MAX = 8;
const DUE_PRESETS = ['today', 'tomorrow', 'mon', 'tue', 'wed', 'thu', 'fri', 'eow', '+3d', '+1w', '+2w'];
const COMMITMENT_STATUSES = ['open', 'done', 'dropped'];
const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];

type Choice = [insert: string, detail?: string];

/** Subcommands and fixed words, by command and position. */
const WORDS: Record<string, Choice[][]> = {
  client: [[['new', 'add a client'], ['rename', 'change name or slug'], ['archive', 'hide, keep everything'], ['unarchive', 'bring back'], ['delete', 'remove with its projects'], ['ls', 'list']]],
  project: [[['new', 'add a project'], ['delete', 'remove with its commitments'], ['ls', 'list']]],
  person: [[['rename', 'set a display name'], ['merge', 'fold a duplicate into another'], ['ls', 'list']]],
  ls: [[['owe', 'what you owe'], ['wait', "what you're waiting on"], ['overdue', 'late'], ['done', 'closed'], ['inbox', 'not sorted yet']]],
  summary: [[['week', 'this week'], ['day', 'today'], ['last', 'last week']]],
  theme: [[['light'], ['dark'], ['auto', 'follow the terminal or OS']]],
  export: [[['--json', 'everything, to back up or move'], ['--md', 'a readable snapshot']]],
};

/**
 * Suggestions for the token under the cursor, shared by the browser terminal,
 * the Keel shell and shell tab completion. Knows each command's arguments,
 * so `client ` offers subcommands, `client rename ` offers clients, and an
 * `owe` with a title but no person offers people next.
 */
export async function suggest(k: Store, input: string): Promise<Omit<Completion, 'preview'>> {
  const replaceFrom = /\S*$/.exec(input)?.index ?? input.length;
  const current = input.slice(replaceFrom);
  const words = input.slice(0, replaceFrom).trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'keel') words.shift();
  const out: Suggestion[] = [];
  const lower = current.toLowerCase();
  const offer = (insert: string, detail?: string, continues = false, label = insert) => {
    if (out.length < MAX && insert.toLowerCase().startsWith(lower)) out.push({ insert, label, ...(detail ? { detail } : {}), ...(continues ? { continues } : {}) });
  };
  const done = () => ({ replaceFrom, suggestions: out });

  // First word: commands and their shortcuts.
  if (words.length === 0) {
    for (const c of commands) offer(c.name, c.summary, false, c.usage);
    for (const [name, detail] of [['clients', 'list clients'], ['projects', 'list projects'], ['people', 'list people'], ['inbox', 'what you captured']]) offer(name!, detail);
    return done();
  }

  const typed = words[0]!.toLowerCase();
  if (expand(typed)) return done();
  const cmd = findCommand(typed)?.name;
  if (!cmd) return done();
  const args = words.slice(1);
  const pos = args.length;

  // Lazy lookups, so a keystroke only reads what it needs.
  // @me (yourself) is offered where it makes sense: not for wait, rename, or as the person merged away.
  const people = async (self: boolean) => [
    ...(self ? [[`@${SELF}`, 'yourself'] as Choice] : []),
    ...(await k.listPeople()).filter((p) => p.handle !== SELF).map((p): Choice => [`@${p.handle}`, p.name]),
  ];
  const projects = async (prefix = '') => (await k.listProjects()).map((pv): Choice => [`${prefix}${pv.path}`, pv.project.name]);
  const openRefs = async (direction?: 'owe' | 'wait') =>
    (await k.commitmentViews([eq(t.commitments.status, 'open')]))
      .filter((v) => !direction || v.c.direction === direction)
      .map((v): Choice => [`c${v.c.refNo}`, `${v.c.title} · @${v.person}`]);
  const projectRefs = async () => (await k.listProjects()).map((pv): Choice => [`p${pv.project.refNo}`, pv.path]);
  const inboxRefs = async () => (await k.openInbox()).map((i): Choice => [`i${i.refNo}`, i.text]);
  const add = (choices: Choice[], continues = false) => choices.forEach(([insert, detail]) => offer(insert, detail, continues));
  const keys = (names: string[]) => names.filter((n) => !args.some((a) => a.startsWith(`${n}:`))).forEach((n) => offer(`${n}:`, undefined, true));

  // Tokens that mean the same thing in every command.
  if (current.startsWith('@')) {
    add(await people(cmd !== 'wait' && cmd !== 'person'));
    return done();
  }
  if (current.startsWith('+')) {
    if (!current.includes('/')) add((await k.listClients()).map((c): Choice => [`+${c.slug}`, c.name]));
    add(await projects('+'));
    return done();
  }
  if (current.startsWith('#')) {
    const tags = new Set((await k.commitmentViews()).flatMap((v) => v.c.tags?.split(' ') ?? []));
    add([...tags].sort().map((tag): Choice => [`#${tag}`]));
    return done();
  }
  const kv = /^([a-z]+):/.exec(current);
  if (kv) {
    const key = kv[1];
    if (key === 'due') {
      for (const preset of DUE_PRESETS) {
        const day = parseDue(preset, k.now());
        offer(`due:${preset}`, day ? formatDay(day, k.today()) : undefined);
      }
    } else if (key === 'from') {
      for (const src of SOURCES) offer(`from:${src}`, src === 'slack' ? 'add :<link to the message>' : undefined, src === 'slack');
    } else if (key === 'status') {
      const isProject = /^p\d+$/i.test(args[0] ?? '');
      for (const st of isProject ? PROJECT_STATUSES : COMMITMENT_STATUSES) offer(`status:${st}`);
    }
    return done();
  }

  // Fixed words for this position.
  const fixed = WORDS[cmd]?.[pos];
  if (fixed) {
    add(fixed);
    return done();
  }

  const sub = args[0];
  switch (cmd) {
    case 'client': {
      if (pos === 1 && ['rename', 'archive', 'unarchive', 'delete'].includes(sub ?? '')) {
        const all = await k.listClients(true);
        const pick = all.filter((c) => (sub === 'archive' ? !c.archivedAt : sub === 'unarchive' ? Boolean(c.archivedAt) : true));
        add(pick.map((c): Choice => [c.slug, c.name]));
      } else if (pos >= 2 && sub === 'rename') {
        keys(['slug']);
      }
      break;
    }
    case 'project':
      if (pos === 1 && sub === 'new') add((await k.listClients()).map((c): Choice => [`${c.slug}/`, c.name]), true);
      if (pos === 1 && sub === 'delete') add([...(await projects()), ...(await projectRefs())]);
      break;
    case 'person':
      if (pos >= 1 && (sub === 'rename' ? pos === 1 : sub === 'merge' ? pos <= 2 : false)) add(await people(sub === 'merge' && pos === 2));
      break;
    case 'switch': {
      const ctx = await k.contextProject();
      if (pos === 0) add((await projects()).filter(([path]) => path !== ctx?.path));
      break;
    }
    case 'park':
      keys(['where', 'next', 'unsure']);
      break;
    case 'set':
      if (pos === 0) add([...(await openRefs()), ...(await projectRefs())]);
      else keys(/^p\d+$/i.test(sub ?? '') ? ['title', 'slug', 'status'] : ['title', 'due', 'status']);
      break;
    case 'done':
    case 'renegotiate':
      if (pos === 0) add(await openRefs());
      else if (cmd === 'renegotiate') keys(['due']);
      break;
    case 'nudge':
      if (pos === 0) add(await openRefs('wait'));
      break;
    case 'focus':
      if (pos < 3) add((await openRefs()).filter(([ref]) => !args.includes(ref)));
      break;
    case 'drop':
      if (pos === 0) add([...(await openRefs()), ...(await inboxRefs())]);
      break;
    case 'show':
      if (pos === 0) add([...(await openRefs()), ...(await projectRefs()), ...(await inboxRefs())]);
      break;
    case 'meeting':
    case 'today':
      if (current === '' && !args.some((a) => a.startsWith('+'))) add(cmd === 'today' ? (await k.listClients()).map((c): Choice => [`+${c.slug}`, c.name]) : await projects('+'));
      break;
    case 'owe':
    case 'wait': {
      // Guide the sentence: what, then who, then when, then where it came from.
      const words = args.filter((a) => !/^[@+#]|^[a-z]+:/.test(a));
      if (current === '' && words.length === 0) break;
      if (current !== '' && !/^[a-z]{2,}$/.test(current)) break;
      if (current !== '') {
        keys(['due', 'from']);
        break;
      }
      if (!args.some((a) => a.startsWith('@'))) add(await people(cmd === 'owe'));
      else if (!args.some((a) => a.startsWith('due:'))) {
        for (const preset of DUE_PRESETS.slice(0, 7)) {
          const day = parseDue(preset, k.now());
          offer(`due:${preset}`, day ? formatDay(day, k.today()) : undefined);
        }
      } else {
        keys(['from']);
        if (!args.some((a) => a.startsWith('+'))) add(await projects('+'));
      }
      break;
    }
  }
  return done();
}
