import { eq } from 'drizzle-orm';
import type { Client as LibsqlClient } from '@libsql/client';
import { fail, hint, s, warn, type Block, type RunResult, type Span, type Tone } from './blocks';
import { readCommitment } from './commands/capture';
import { expand, findCommand, type Command, type Flow } from './commands/index';
import { formatDay } from './dates';
import { existsSync } from 'node:fs';
import { isConnectionError, migrateDb, openDb } from './db/client';
import * as t from './db/schema';
import { KeelError } from './errors';
import type { ThemeSetting } from './palettes';
import { classify, tokenize, type Parsed } from './parse';
import { renderText } from './render-text';
import { suggest, type Completion } from './complete';
import { Store } from './store';
import { VERSION } from './version';

export interface KeelOptions {
  /** `file:/path/keel.db`, `:memory:`, or `libsql://...` */
  url: string;
  authToken?: string;
  /** With a `file:` url: keep it as a synced copy of this hosted database (ADR 0001). */
  syncUrl?: string;
  /** Override the clock (tests). */
  now?: () => Date;
}

export interface KeelState {
  context: { path: string; hue: Tone; ref: string } | null;
  counts: { overdue: number; today: number; waiting: number };
  theme: ThemeSetting;
  version: string;
  storage: Storage;
}

/**
 * `local`: a file or memory database. `remote`: talking to a hosted database directly.
 * `synced`: a local copy kept in sync with a hosted one. `offline`: synced, but the
 * hosted database was unreachable when Keel opened, so changes can't be saved.
 */
export type Storage = 'local' | 'remote' | 'synced' | 'offline';

const SYNC_EVERY_MS = 10_000;

export type { Completion, Suggestion } from './complete';

const hostOf = (url: string) => url.replace(/^[a-z]+:\/\//, '').split('/')[0];

function errorBlocks(e: unknown): Block[] {
  if (e instanceof KeelError) return [fail(e.message), ...(e.hint ? [hint(e.hint)] : [])];
  throw e;
}

/** One Keel instance per database. Both terminals talk to it through `run`. */
export class Keel {
  private lastSync = Date.now();

  private constructor(
    readonly store: Store,
    private client: LibsqlClient,
    readonly storage: Storage,
  ) {}

  static async open(opts: KeelOptions): Promise<Keel> {
    const now = opts.now ?? (() => new Date());
    if (opts.syncUrl) {
      try {
        // Opening a synced copy pulls the latest changes first.
        const { db, client } = openDb(opts);
        await migrateDb(db);
        return new Keel(new Store(db, now), client, 'synced');
      } catch (e) {
        if (!isConnectionError(e)) throw e;
        // Offline: read this device's copy directly, and refuse writes.
        const path = opts.url.replace(/^file:/, '');
        if (!existsSync(path)) {
          throw new KeelError(`Can't reach ${hostOf(opts.syncUrl)}, and this device has no copy of your data yet.`, 'Connect to the internet and try again.');
        }
        const { db, client } = openDb({ url: opts.url });
        return new Keel(new Store(db, now, true), client, 'offline');
      }
    }
    const { db, client } = openDb({ url: opts.url, authToken: opts.authToken });
    await migrateDb(db);
    const storage = opts.url.startsWith('file:') || opts.url === ':memory:' ? 'local' : 'remote';
    return new Keel(new Store(db, now), client, storage);
  }

  /** Pulls changes made on other devices. A no-op unless synced; never throws. */
  async sync(): Promise<void> {
    if (this.storage !== 'synced') return;
    try {
      await this.client.sync();
      this.lastSync = Date.now();
    } catch {
      // Offline for now; reads use the local copy and writes report it.
    }
  }

  private async syncIfStale(): Promise<void> {
    if (this.storage === 'synced' && Date.now() - this.lastSync > SYNC_EVERY_MS) await this.sync();
  }

  close(): void {
    this.client.close();
  }

  /** Paused interactive commands, by session id. Single user, so a small in-memory map is enough. */
  private sessions = new Map<string, { flow: Flow; touched: number }>();

  /** Starts a command. If it asks a question, the result carries `question` and `session`. */
  async exec(input: string): Promise<RunResult> {
    await this.syncIfStale();
    let tokens = tokenize(input.trim());
    if (tokens[0]?.text === 'keel') tokens = tokens.slice(1);
    if (tokens.length === 0) return { blocks: await findCommand('help')!.run!(this.store, classify([])) };

    const name = tokens[0]!.text.toLowerCase();
    const expansion = expand(name);
    if (expansion) return this.exec(`${expansion} ${tokens.slice(1).map((x) => (x.quoted ? JSON.stringify(x.text) : x.text)).join(' ')}`);

    const command = findCommand(name);
    if (!command) return { blocks: [fail(`Unknown command "${name}".`), hint('Type help to see all commands.')] };
    const parsed = classify(tokens.slice(1));
    if (parsed.flags.has('json') && !command.ownsJson) return this.json(command, parsed);
    try {
      if (command.flow) return await this.step(command.flow(this.store, parsed), undefined, this.store.newId());
      return { blocks: await command.run!(this.store, parsed) };
    } catch (e) {
      return { blocks: errorBlocks(e) };
    }
  }

  /** Answers the question a paused command asked. `null` cancels it. */
  async answer(session: string, text: string | null): Promise<RunResult> {
    this.expireSessions();
    const entry = this.sessions.get(session);
    if (!entry) return { blocks: [fail('That question expired. Run the command again.')] };
    if (text === null) {
      this.sessions.delete(session);
      await entry.flow.return([]);
      return { blocks: [warn('Cancelled. Anything already saved stays saved.')] };
    }
    return this.step(entry.flow, text, session);
  }

  /** Runs a command to the end, answering every question with "skip". For scripts, pipes and tests. */
  async run(input: string): Promise<Block[]> {
    let result = await this.exec(input);
    const blocks = [...result.blocks];
    for (let guard = 0; result.question && result.session && guard < 1000; guard++) {
      result = await this.answer(result.session, '');
      blocks.push(...result.blocks);
    }
    return blocks;
  }

  /**
   * --json: runs the command to the end (questions are skipped) and prints one object:
   * { ok: true, data, text } or { ok: false, error, hint }. `data` is the command's
   * last data block, `text` the plain output, so every command has a JSON form.
   */
  private async json(command: Command, parsed: Parsed): Promise<RunResult> {
    const print = (value: unknown, failed = false): RunResult => ({ blocks: [{ kind: 'raw', text: JSON.stringify(value, null, 2) }], ...(failed ? { failed } : {}) });
    const blocks: Block[] = [];
    try {
      if (command.flow) {
        const flow = command.flow(this.store, parsed);
        let next = await flow.next(undefined as never);
        for (let guard = 0; !next.done && guard < 1000; guard++) {
          blocks.push(...next.value.blocks);
          next = await flow.next('');
        }
        if (!next.done) {
          await flow.return([]);
          throw new KeelError(`${command.name} kept asking questions, so it was stopped.`);
        }
        blocks.push(...next.value);
      } else {
        blocks.push(...(await command.run!(this.store, parsed)));
      }
    } catch (e) {
      if (!(e instanceof KeelError)) throw e;
      return print({ ok: false, error: e.message, hint: e.hint ?? null }, true);
    }
    const last = [...blocks].reverse().find((b) => b.kind === 'data');
    return print({ ok: true, data: last?.kind === 'data' ? last.value : null, text: renderText(blocks) });
  }

  private async step(flow: Flow, answer: string | undefined, session: string): Promise<RunResult> {
    try {
      const next = await flow.next(answer as string);
      if (next.done) {
        this.sessions.delete(session);
        return { blocks: next.value };
      }
      this.sessions.set(session, { flow, touched: Date.now() });
      return { blocks: next.value.blocks, question: next.value.question, session };
    } catch (e) {
      this.sessions.delete(session);
      return { blocks: errorBlocks(e) };
    }
  }

  private expireSessions(): void {
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const [id, entry] of this.sessions) if (entry.touched < cutoff) this.sessions.delete(id);
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
      version: VERSION,
      storage: this.storage,
    };
  }

  async complete(input: string): Promise<Completion> {
    const result: Completion = { ...(await suggest(this.store, input)), preview: null };
    const words = input.trim().split(/\s+/);
    if (words[0] === 'keel') words.shift();
    const cmd = words[0]?.toLowerCase();
    if ((cmd === 'owe' || cmd === 'wait') && words.length > 1) {
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
