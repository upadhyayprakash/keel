import { inbox, owe, wait } from './capture';
import { done, drop, focus, nudge, renegotiate, set } from './edit';
import { exportCommand, helpCommand, theme } from './misc';
import { client, park, project, switchCommand } from './projects';
import type { Command } from './shared';
import { ls, show, today } from './views';

export type { Command } from './shared';

const list: Command[] = [];
const help = helpCommand(() => list);

list.push(
  today,
  owe,
  wait,
  inbox,
  ls,
  show,
  focus,
  done,
  drop,
  renegotiate,
  nudge,
  set,
  switchCommand,
  park,
  client,
  project,
  theme,
  exportCommand,
  help,
);

export const commands: readonly Command[] = list;

/** Shortcuts that expand to a full command line. */
const EXPANSIONS: Record<string, string> = { clients: 'client ls', projects: 'project ls', inbox: 'ls inbox' };

export function expand(name: string): string | undefined {
  return EXPANSIONS[name];
}

export function findCommand(name: string): Command | undefined {
  return list.find((c) => c.name === name || c.aliases?.includes(name));
}
