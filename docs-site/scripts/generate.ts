// Generates the parts of the docs site that must never drift from the code:
//   reference/commands.mdx  from Keel's own command list (`help --json`) plus the examples below
//   changelog.mdx           from CHANGELOG.md
//   images, logo, favicon   copied from assets/brand
// Run from the repo root: pnpm docs:generate. CI fails if the committed output is stale.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keel } from '../../packages/core/src/index';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(site, '..');
const GITHUB = 'https://github.com/upadhyayprakash/keel/blob/main';

interface CommandInfo {
  name: string;
  usage: string;
  summary: string;
  interactive: boolean;
}

/** Hand-written examples for each command. The script fails if a command is missing here. */
const EXAMPLES: Record<string, { examples: string[]; note?: string }> = {
  today: { examples: ['today', 'today +acme'], note: 'Shows the project you are working on, your focus, what is due or late, follow-ups, the next three days and projects going quiet.' },
  owe: {
    examples: ['owe send pricing deck @ravi due:thu', 'owe revised SOW @ravi due:mon +northwind/portal from:slack:https://acme.slack.com/archives/C1/p2', 'owe contract review @priya due:+3d #legal'],
    note: 'Lands in the project you are working on unless you add `+client/project`.',
  },
  wait: { examples: ['wait design files @meera due:fri', 'wait API keys @tom due:tomorrow +northwind/portal'] },
  in: { examples: ['in ask Ravi about the phase 2 budget', 'in check the contract renewal date +acme/website'], note: 'No person or date needed. Sort it later with `triage`.' },
  meeting: {
    examples: ['meeting +acme/website "weekly sync"'],
    note: 'Then type one line per item: `> pricing deck to @ravi due:thu` for something you owe, `< design files from @meera due:fri` for something you wait on, anything else is a note. An empty line ends the meeting and asks before saving.',
  },
  ls: { examples: ['ls', 'ls owe', 'ls wait @meera', 'ls overdue +acme', 'ls inbox'] },
  show: { examples: ['show c12', 'show p3', 'show i5'] },
  focus: { examples: ['focus c12 c15', 'focus clear'], note: 'Up to three. Everything else stays visible below the line.' },
  done: { examples: ['done c12'] },
  drop: { examples: ['drop c12', 'drop i5'] },
  renegotiate: { examples: ['renegotiate c12 due:mon'], note: 'For a date you agreed with the other person. It counts differently from a silent slip in the weekly summary.' },
  nudge: { examples: ['nudge c15'], note: 'Records that you followed up on something you are waiting on.' },
  set: { examples: ['set c12 title:"send revised deck" due:fri', 'set c12 @priya +northwind/portal', 'set p3 status:paused', 'set p3 title:"Website v2" slug:site'] },
  switch: {
    examples: ['switch northwind/portal', 'switch acme/website where:"pricing page half done" next:"send deck"'],
    note: 'Asks three short questions about the project you are leaving (where you are, what is next, what you are unsure about), then shows the note you left on the one you are going to.',
  },
  park: { examples: ['park', 'park where:"draft sent" next:"wait for feedback"'], note: 'Saves a resume note and leaves you in no project.' },
  triage: { examples: ['triage'], note: 'Walks the inbox one item at a time: turn it into an owe or wait, keep it, or drop it.' },
  review: { examples: ['review'], note: 'The Friday review: inbox, overdue items, follow-ups, resume notes, next week’s priorities, then the week summary.' },
  summary: { examples: ['summary', 'summary day', 'summary last +acme'] },
  client: {
    examples: ['client new acme "Acme Corp"', 'clients', 'client rename acme "Acme Inc"', 'client rename acme slug:acme-inc', 'client archive acme', 'client delete acme'],
    note: 'Deleting shows what goes with the client and asks you to type its slug. `--yes` skips the question in scripts.',
  },
  project: { examples: ['project new acme/website "Website rebuild"', 'projects', 'project delete p3'] },
  person: { examples: ['people', 'person rename @ravi "Ravi Kumar"', 'person merge @rav @ravi'] },
  theme: { examples: ['theme', 'theme light', 'theme auto'] },
  export: { examples: ['export > keel-backup.json', 'export --md > keel.md'] },
  import: { examples: ['import keel-backup.json'], note: 'Only into an empty database, so nothing is ever overwritten.' },
  help: { examples: ['help', 'help --json'] },
};

/** Commands that live in the `keel` program itself rather than the shared command list. */
const PROGRAM: Array<{ usage: string; summary: string; examples: string[] }> = [
  { usage: 'keel', summary: 'Open the Keel shell: type commands without the keel prefix, with Tab completion and history.', examples: ['keel', 'keel shell'] },
  { usage: 'keel serve [--port 4242]', summary: 'Open the same terminal in your browser, on this machine only.', examples: ['keel serve'] },
  { usage: 'keel db | keel db connect <address> | keel db disconnect', summary: 'Show where your data lives, or sync it across devices.', examples: ['keel db', 'keel db connect libsql://keel-<you>.turso.io', 'keel db disconnect'] },
  { usage: 'keel completion zsh|bash', summary: 'Print the shell completion script.', examples: ['echo \'eval "$(keel completion zsh)"\' >> ~/.zshrc'] },
  { usage: 'keel --version', summary: 'Print the installed version.', examples: ['keel --version'] },
];

const GROUPS: Array<[string, string[]]> = [
  ['Capture', ['owe', 'wait', 'in', 'meeting']],
  ['Daily', ['today', 'focus', 'ls', 'show']],
  ['Close the loop', ['done', 'drop', 'renegotiate', 'nudge', 'set']],
  ['Projects and context', ['switch', 'park', 'client', 'project', 'person']],
  ['Weekly', ['triage', 'review', 'summary']],
  ['Data and settings', ['export', 'import', 'theme', 'help']],
];

const header = (title: string, description: string) =>
  `---\ntitle: "${title}"\ndescription: "${description}"\n---\n\n{/* Generated by docs-site/scripts/generate.ts. Edit that script, not this file. */}\n`;

async function commandList(): Promise<CommandInfo[]> {
  const keel = await Keel.open({ url: ':memory:' });
  try {
    const result = await keel.exec('help --json');
    const block = result.blocks[0];
    if (block?.kind !== 'raw') throw new Error('help --json did not print JSON');
    return (JSON.parse(block.text) as { data: { commands: CommandInfo[] } }).data.commands;
  } finally {
    keel.close();
  }
}

function commandsPage(commands: CommandInfo[]): string {
  const missing = commands.filter((c) => !EXAMPLES[c.name]).map((c) => c.name);
  const unknown = Object.keys(EXAMPLES).filter((name) => !commands.some((c) => c.name === name));
  const ungrouped = commands.filter((c) => !GROUPS.some(([, names]) => names.includes(c.name))).map((c) => c.name);
  if (missing.length || unknown.length || ungrouped.length) {
    throw new Error(`Docs out of step with the commands. Missing examples: ${missing.join(', ') || '-'}. Examples for unknown commands: ${unknown.join(', ') || '-'}. Not in a group: ${ungrouped.join(', ') || '-'}.`);
  }
  const byName = new Map(commands.map((c) => [c.name, c]));
  const out = [
    header('Commands', 'Every Keel command, with examples.'),
    'Type these in the Keel shell (run `keel`), in the browser terminal (`keel serve`), or after `keel` in any terminal: `today` and `keel today` are the same.',
    '',
    'Add `--json` to any command for machine-readable output. See [JSON output](/reference/json).',
  ];
  for (const [group, names] of GROUPS) {
    out.push('', `## ${group}`);
    for (const name of names) {
      const c = byName.get(name)!;
      const extra = EXAMPLES[name]!;
      out.push('', `### ${c.name}`, '', `${c.summary}.${c.interactive ? ' Asks questions as it goes.' : ''}`, '', '```text Usage', c.usage, '```');
      if (extra.note) out.push('', extra.note);
      out.push('', '```bash Examples', ...extra.examples, '```');
    }
  }
  out.push('', '## The keel program', '', 'These run in your terminal, outside the Keel shell.');
  for (const p of PROGRAM) {
    out.push('', `### ${p.usage.split(' ').slice(0, 2).join(' ')}`, '', p.summary, '', '```text Usage', p.usage, '```', '', '```bash Examples', ...p.examples, '```');
  }
  return out.join('\n') + '\n';
}

function changelogPage(): string {
  const text = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8');
  const out = [header('Changelog', 'What changed in each release of Keel.')];
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const [titleLine, ...body] = section.split('\n');
    const m = /^\[([^\]]+)\](?: - (\S+))?/.exec(titleLine ?? '');
    if (!m || m[1] === 'Unreleased') continue;
    const content = body
      .filter((line) => !/^\[[^\]]+\]: /.test(line)) // link definitions at the end
      .join('\n')
      .replace(/\]\((docs\/[^)]+)\)/g, `](${GITHUB}/$1)`) // repo-relative links point at GitHub
      .trim();
    out.push('', `<Update label="${m[1]}" description="${m[2] ?? ''}">`, '', content, '', '</Update>');
  }
  return out.join('\n') + '\n';
}

function copyAssets(): void {
  const brand = join(repo, 'assets', 'brand');
  mkdirSync(join(site, 'images'), { recursive: true });
  mkdirSync(join(site, 'logo'), { recursive: true });
  copyFileSync(join(brand, 'png', 'keel-cli-welcome.png'), join(site, 'images', 'keel-shell.png'));
  copyFileSync(join(brand, 'png', 'keel-browser.png'), join(site, 'images', 'keel-browser.png'));
  copyFileSync(join(brand, 'keel-wordmark.svg'), join(site, 'logo', 'light.svg'));
  copyFileSync(join(brand, 'keel-wordmark-dark.svg'), join(site, 'logo', 'dark.svg'));
  copyFileSync(join(brand, 'keel-icon.svg'), join(site, 'favicon.svg'));
}

mkdirSync(join(site, 'reference'), { recursive: true });
writeFileSync(join(site, 'reference', 'commands.mdx'), commandsPage(await commandList()));
writeFileSync(join(site, 'changelog.mdx'), changelogPage());
copyAssets();
console.log('Generated reference/commands.mdx, changelog.mdx and assets.');
