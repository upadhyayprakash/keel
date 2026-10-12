import { eq } from 'drizzle-orm';
import type { Client as LibsqlClient } from '@libsql/client';
import { fail, hint, s, type Block, type Span, type Tone } from './blocks';
import { readCommitment } from './commands/capture';
import { commands, expand, findCommand } from './commands/index';
import { SOURCES } from './commands/shared';
import { formatDay, parseDue } from './dates';
import { migrateDb, openDb } from './db/client';
import * as t from './db/schema';
import { KeelError } from './errors';
import type { ThemeSetting } from './palettes';
import { classify, tokenize } from './parse';
import { Store } from './store';

export interface KeelOptions {
  /** `file:/path/keel.db`, `:memory:`, or (v2) `libsql://...` */
  url: string;
  authToken?: string;
  /** Override the clock (tests). */
  now?: () => Date;
}

export interface KeelState {
  context: { path: string; hue: Tone; ref: string } | null;
  counts: { overdue: number; today: number; waiting: number };
  theme: ThemeSetting;
}

export interface Suggestion {
  insert: string;
  label: string;
  detail?: string;
}

export interface Completion {
  /** Where the token being completed starts; replace from here with `insert`. */
  replaceFrom: number;
  suggestions: Suggestion[];
  /** What the command will create, for owe/wait. */
  preview: Span[] | null;
}

const REF_COMMANDS = new Set(['done', 'drop', 'renegotiate', 'nudge', 'set', 'show', 'focus']);
const PROJECT_COMMANDS = new Set(['switch']);
const DUE_PRESETS = ['today', 'tomorrow', 'mon', 'tue', 'wed', 'thu', 'fri', 'eow', '+3d', '+1w', '+2w'];

/** One Keel instance per database. Both terminals talk to it through `run`. */
export class Keel {
  private constructor(
    readonly store: Store,
    private client: LibsqlClient,
  ) {}

  static async open(opts: KeelOptions): Promise<Keel> {
    const { db, client } = openDb({ url: opts.url, authToken: opts.authToken });
    await migrateDb(db);
    return new Keel(new Store(db, opts.now ?? (() => new Date())), client);
  }

  close(): void {
    this.client.close();
  }

  async run(input: string): Promise<Block[]> {
    let tokens = tokenize(input.trim());
    if (tokens[0]?.text === 'keel') tokens = tokens.slice(1);
    if (tokens.length === 0) return findCommand('help')!.run(this.store, classify([]));

    const name = tokens[0]!.text.toLowerCase();
    const expansion = expand(name);
    if (expansion) return this.run(`${expansion} ${tokens.slice(1).map((x) => x.text).join(' ')}`);

    const command = findCommand(name);
    if (!command) return [fail(`Unknown command "${name}".`), hint('Type help to see all commands.')];
    try {
      return await command.run(this.store, classify(tokens.slice(1)));
    } catch (e) {
      if (e instanceof KeelError) return [fail(e.message), ...(e.hint ? [hint(e.hint)] : [])];
      throw e;
    }
  }

  async state(): Promise<KeelState> {
    const k = this.store;
    const ctx = await k.contextProject();
    const day = k.today();
    const open = await k.commitmentViews([eq(t.commitments.status, 'open')]);
    const theme = ((await k.getSetting('theme')) ?? 'auto') as ThemeSetting;
    return {
      context: ctx ? { path: ctx.path, hue: ctx.hue, ref: `p${ctx.project.refNo}` } : null,
      counts: {
        overdue: open.filter((v) => v.c.direction === 'owe' && v.c.dueOn < day).length,
        today: open.filter((v) => v.c.direction === 'owe' && v.c.dueOn === day).length,
        waiting: open.filter((v) => v.c.direction === 'wait' && v.c.dueOn <= day).length,
      },
      theme,
    };
  }

  async complete(input: string): Promise<Completion> {
    const k = this.store;
    const start = /\S*$/.exec(input)?.index ?? input.length;
    const current = input.slice(start);
    const before = input.slice(0, start).trim().split(/\s+/).filter(Boolean);
    if (before[0] === 'keel') before.shift();
    const cmd = before[0]?.toLowerCase();
    const result: Completion = { replaceFrom: start, suggestions: [], preview: null };
    const add = (insert: string, label = insert, detail?: string) => result.suggestions.push({ insert, label, detail });

    if (!cmd) {
      for (const c of commands) if (c.name.startsWith(current.toLowerCase())) add(c.name, c.usage, c.summary);
    } else if (current.startsWith('@')) {
      for (const person of await k.listPeople()) if (`@${person.handle}`.startsWith(current)) add(`@${person.handle}`, `@${person.handle}`, person.name);
    } else if (current.startsWith('+') || (PROJECT_COMMANDS.has(cmd) && before.length === 1)) {
      const prefix = current.replace(/^\+/, '');
      const plus = current.startsWith('+') ? '+' : '';
      for (const c of current.startsWith('+') ? await k.listClients() : []) if (c.slug.startsWith(prefix)) add(`+${c.slug}`, `+${c.slug}`, c.name);
      for (const pv of await k.listProjects()) if (pv.path.startsWith(prefix)) add(`${plus}${pv.path}`, `${plus}${pv.path}`, pv.project.name);
    } else if (current.startsWith('due:')) {
      for (const preset of DUE_PRESETS) {
        if (!`due:${preset}`.startsWith(current)) continue;
        const day = parseDue(preset, k.now());
        add(`due:${preset}`, `due:${preset}`, day ? formatDay(day) : undefined);
      }
    } else if (current.startsWith('from:')) {
      for (const src of SOURCES) if (`from:${src}`.startsWith(current)) add(`from:${src}`);
    } else if (cmd === 'theme' && before.length === 1) {
      for (const th of ['light', 'dark', 'auto']) if (th.startsWith(current)) add(th);
    } else if (REF_COMMANDS.has(cmd) && /^c?\d*$/i.test(current)) {
      const open = await k.commitmentViews([eq(t.commitments.status, 'open')]);
      for (const v of open) if (`c${v.c.refNo}`.startsWith(current.toLowerCase() || 'c')) add(`c${v.c.refNo}`, `c${v.c.refNo}`, v.c.title);
    }
    result.suggestions = result.suggestions.slice(0, 8);

    if ((cmd === 'owe' || cmd === 'wait') && input.trim().split(/\s+/).length > 1) {
      result.preview = await this.preview(input, cmd);
    }
    return result;
  }

  private async preview(input: string, direction: 'owe' | 'wait'): Promise<Span[]> {
    let tokens = tokenize(input.trim());
    if (tokens[0]?.text === 'keel') tokens = tokens.slice(1);
    try {
      const c = await readCommitment(this.store, classify(tokens.slice(1)), direction);
      const people = await this.store.listPeople();
      const name = people.find((x) => x.handle === c.handle)?.name ?? c.handle.charAt(0).toUpperCase() + c.handle.slice(1);
      return [
        s('will create  ', 'muted'),
        s(direction === 'owe' ? 'I owe' : 'waiting on', direction === 'owe' ? 'accent' : 'wait', { bold: true }),
        s(` · ${c.title} ${direction === 'owe' ? '→' : '←'} ${name} · `),
        c.project ? s(c.project.path, c.project.hue) : s('no project', 'dim'),
        s(` · ${formatDay(c.dueOn)}`),
        ...(c.source !== 'other' ? [s(` · from ${c.source}`, 'muted')] : []),
      ];
    } catch (e) {
      if (e instanceof KeelError) return [s(e.message, 'muted')];
      throw e;
    }
  }
}
