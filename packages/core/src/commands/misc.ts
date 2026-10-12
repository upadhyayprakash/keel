import { blank, heading, hint, line, ok, s, table, type Block } from '../blocks';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import type { Command } from './shared';

const THEMES = ['light', 'dark', 'auto'] as const;

export const theme: Command = {
  name: 'theme',
  usage: 'theme [light|dark|auto]',
  summary: 'Pick the color theme',
  async run(k, p) {
    const choice = p.words[0]?.toLowerCase();
    if (!choice) return [line([s('theme '), s((await k.getSetting('theme')) ?? 'auto', 'accent', { bold: true })])];
    if (!(THEMES as readonly string[]).includes(choice)) throw new KeelError(`Unknown theme "${choice}".`, 'Use: theme light, theme dark or theme auto');
    await k.batch([k.setSetting('theme', choice)]);
    return [ok([s('Theme set to '), s(choice, 'accent', { bold: true })])];
  },
};

export const exportCommand: Command = {
  name: 'export',
  usage: 'export [--json]',
  summary: 'Export everything as JSON. Your data is always yours',
  async run(k, p) {
    if (p.flags.has('md')) throw new KeelError('Markdown export comes later. Use: export --json');
    const tables = {
      clients: t.clients,
      projects: t.projects,
      resumeNotes: t.resumeNotes,
      people: t.people,
      commitments: t.commitments,
      inboxItems: t.inboxItems,
      focus: t.focus,
      contextLog: t.contextLog,
      events: t.events,
      settings: t.settings,
    };
    const data: Record<string, unknown[]> = {};
    for (const [name, table] of Object.entries(tables)) {
      data[name] = await k.db.select().from(table as typeof t.clients);
    }
    return [{ kind: 'raw', text: JSON.stringify({ app: 'keel', version: 1, exportedAt: k.iso(), data }, null, 2) }];
  },
};

/** Built by the registry so it can list every command. */
export function helpCommand(all: () => Command[]): Command {
  return {
    name: 'help',
    aliases: ['?'],
    usage: 'help',
    summary: 'Show all commands',
    async run(): Promise<Block[]> {
      return [
        heading('COMMANDS', 'accent'),
        table(all().map((c) => [s(c.usage), s(c.summary, 'muted')])),
        blank(),
        heading('TOKENS', 'accent'),
        table([
          [s('@ravi'), s('person', 'muted')],
          [s('+acme/website'), s('project (or +acme for a whole client)', 'muted')],
          [s('due:thu  due:tomorrow  due:+3d  due:2026-10-20'), s('due date', 'muted')],
          [s('from:meeting  from:slack:<link>'), s('where the promise came from', 'muted')],
          [s('#legal'), s('tag', 'muted')],
          [s('c42  p7  i3'), s('refs: commitment, project, inbox item', 'muted')],
        ]),
        blank(),
        hint('Quote text with spaces in key:value, e.g. where:"pricing copy done"'),
      ];
    },
  };
}
