import { blank, data, heading, hint, line, ok, s, table, type Block } from '../blocks';
import { KeelError } from '../errors';
import type { Command } from './shared';

const THEMES = ['light', 'dark', 'auto'] as const;

export const theme: Command = {
  name: 'theme',
  usage: 'theme [light|dark|auto]',
  summary: 'Pick the color theme',
  async run(k, p) {
    const choice = p.words[0]?.toLowerCase();
    if (!choice) {
      const current = (await k.getSetting('theme')) ?? 'auto';
      return [line([s('theme '), s(current, 'accent', { bold: true })]), data({ theme: current })];
    }
    if (!(THEMES as readonly string[]).includes(choice)) throw new KeelError(`Unknown theme "${choice}".`, 'Use: theme light, theme dark or theme auto');
    await k.batch([k.setSetting('theme', choice)]);
    return [ok([s('Theme set to '), s(choice, 'accent', { bold: true })]), data({ theme: choice })];
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
        hint('Add --json to any command for machine-readable output.'),
        data({ commands: all().map((c) => ({ name: c.name, usage: c.usage, summary: c.summary, interactive: Boolean(c.flow) })) }),
      ];
    },
  };
}
