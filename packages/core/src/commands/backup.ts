import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { data, ok, s } from '../blocks';
import { weekStart } from '../dates';
import * as t from '../db/schema';
import { KeelError } from '../errors';
import type { CommitmentView, Store } from '../store';
import type { Command } from './shared';

const EXPORT_VERSION = 1;

// Export keys, in insert order for import: parents before the rows that point at them.
const TABLES = {
  clients: t.clients,
  projects: t.projects,
  people: t.people,
  resumeNotes: t.resumeNotes,
  commitments: t.commitments,
  inboxItems: t.inboxItems,
  focus: t.focus,
  contextLog: t.contextLog,
  events: t.events,
  settings: t.settings,
} as const;

type TableName = keyof typeof TABLES;
type Row = Record<string, unknown>;

/** Rows per insert statement, well under SQLite's variable limit. */
const CHUNK = 100;

export const exportCommand: Command = {
  name: 'export',
  usage: 'export [--json|--md]',
  summary: 'Export everything as JSON (or Markdown to read). Your data is always yours',
  ownsJson: true,
  async run(k, p) {
    if (p.flags.has('md')) return [{ kind: 'raw', text: await markdown(k) }];
    return [{ kind: 'raw', text: await exportJson(k) }];
  },
};

/** The full export, as written by `keel export` and read by `keel import`. */
export async function exportJson(k: Store): Promise<string> {
  const tables: Record<string, unknown[]> = {};
  for (const [name, table] of Object.entries(TABLES)) {
    tables[name] = await k.db.select().from(table as typeof t.clients);
  }
  return JSON.stringify({ app: 'keel', version: EXPORT_VERSION, exportedAt: k.iso(), data: tables }, null, 2);
}

export const importCommand: Command = {
  name: 'import',
  usage: 'import <file.json>',
  summary: 'Restore a JSON export into an empty database',
  async run(k, p) {
    const path = p.words.join(' ').trim();
    if (!path) throw new KeelError('Which file?', 'Example: import ~/keel-backup.json');
    const file = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new KeelError(`Can't read ${file}.`);
    }
    const counts = await importDump(k, parseExport(text));

    const label = (n: number | undefined, one: string, many = `${one}s`) => `${n ?? 0} ${n === 1 ? one : many}`;
    return [
      ok([
        s('Imported '),
        s(
          [
            label(counts.clients, 'client'),
            label(counts.projects, 'project'),
            label(counts.commitments, 'commitment'),
            label(counts.inboxItems, 'inbox item'),
            label(counts.resumeNotes, 'resume note'),
          ].join(', '),
          'default',
          { bold: true },
        ),
      ]),
      data({ file, counts }),
    ];
  },
};

export type ExportCounts = Partial<Record<TableName, number>>;

/** Rows that make a database "have data" (settings alone don't count). */
const CONTENT = ['clients', 'projects', 'people', 'commitments', 'inboxItems', 'resumeNotes'] as const;

/** How many live rows each content table holds. */
export async function contentCounts(k: Store): Promise<Record<(typeof CONTENT)[number], number>> {
  const out = {} as Record<(typeof CONTENT)[number], number>;
  for (const name of CONTENT) {
    const table = TABLES[name] as typeof t.clients;
    out[name] = (await k.db.select({ id: table.id }).from(table)).length;
  }
  return out;
}

export async function isEmpty(k: Store): Promise<boolean> {
  return Object.values(await contentCounts(k)).every((n) => n === 0);
}

/**
 * Writes a parsed export into an empty database, in one batch so a bad file
 * saves nothing. Used by `import` and by `keel db connect` to copy data up.
 */
export async function importDump(k: Store, dump: Partial<Record<TableName, Row[]>>): Promise<ExportCounts> {
  // Restoring never overwrites: it only fills an empty database.
  if (!(await isEmpty(k))) {
    throw new KeelError(
      'This database already has data. Import only fills an empty one, so nothing gets overwritten.',
      'Import into a new database: KEEL_DB_URL=file:/path/to/new.db keel import backup.json',
    );
  }
  const queries = [];
  const counts: ExportCounts = {};
  for (const [name, table] of Object.entries(TABLES) as Array<[TableName, typeof t.clients]>) {
    const rows = dump[name] ?? [];
    counts[name] = rows.length;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK) as Array<typeof t.clients.$inferInsert>;
      queries.push(
        name === 'settings'
          ? k.db
              .insert(t.settings)
              .values(chunk as unknown as Array<typeof t.settings.$inferInsert>)
              .onConflictDoUpdate({ target: t.settings.key, set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` } })
          : k.db.insert(table).values(chunk),
      );
    }
  }
  try {
    await k.batch(queries);
  } catch (e) {
    if (e instanceof KeelError) throw e;
    throw new KeelError(`Import failed and nothing was saved: ${e instanceof Error ? e.message : String(e)}`);
  }
  return counts;
}

export function parseExport(text: string): Partial<Record<TableName, Row[]>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeelError("That file isn't JSON.", 'Use a file made by: keel export > backup.json');
  }
  const dump = parsed as { app?: unknown; version?: unknown; data?: unknown };
  if (dump?.app !== 'keel' || !dump.data || typeof dump.data !== 'object') {
    throw new KeelError("That isn't a Keel export.", 'Use a file made by: keel export > backup.json');
  }
  if (dump.version !== EXPORT_VERSION) {
    throw new KeelError(`This Keel reads export version ${EXPORT_VERSION}, and the file is version ${String(dump.version)}.`, 'Update Keel and try again.');
  }
  const tables = dump.data as Record<string, unknown>;
  for (const name of Object.keys(TABLES)) {
    const rows = tables[name];
    if (rows === undefined) continue;
    if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
      throw new KeelError(`"${name}" in the file isn't a list of rows.`);
    }
  }
  return tables as Partial<Record<TableName, Row[]>>;
}

/** A readable snapshot: per client and project, the resume note and every commitment, then the inbox. */
async function markdown(k: Store): Promise<string> {
  const clients = await k.listClients();
  const projects = await k.listProjects();
  const all = await k.commitmentViews();
  const inbox = await k.openInbox();
  const paths = new Set(projects.map((pv) => pv.path));
  const out: string[] = ['# Keel', '', `Exported ${k.iso()}. Dates are YYYY-MM-DD.`];

  const priorities: Record<string, string> = JSON.parse((await k.getSetting(`priorities:${weekStart(k.today())}`)) ?? '{}');
  if (Object.keys(priorities).length) {
    out.push('', '## This week', '', ...Object.entries(priorities).map(([slug, text]) => `- **${slug}**: ${text}`));
  }

  const commitments = (list: CommitmentView[]) => {
    if (list.length === 0) return out.push('', '_No commitments._');
    const section = (title: string, rows: CommitmentView[]) => {
      if (rows.length) out.push('', `**${title}**`, '', ...rows.map(commitmentLine));
    };
    section('I owe', list.filter((v) => v.c.status === 'open' && v.c.direction === 'owe'));
    section('Waiting on', list.filter((v) => v.c.status === 'open' && v.c.direction === 'wait'));
    section('Closed', list.filter((v) => v.c.status !== 'open'));
  };

  for (const c of clients) {
    out.push('', `## ${c.name} (${c.slug})`);
    const own = projects.filter((pv) => pv.client.id === c.id);
    if (own.length === 0) out.push('', '_No projects._');
    for (const pv of own) {
      out.push('', `### ${pv.project.name} · ${pv.path} · p${pv.project.refNo} · ${pv.project.status}`);
      const note = await k.latestResumeNote(pv.project.id);
      if (note) {
        out.push(
          '',
          `Resume note, ${note.createdAt.slice(0, 10)}:`,
          '',
          `- Where: ${note.whereIAm ?? '-'}`,
          `- Next: ${note.nextStep ?? '-'}`,
          `- Unsure: ${note.unsureAbout ?? '-'}`,
        );
      }
      commitments(all.filter((v) => v.project === pv.path));
    }
  }

  const loose = all.filter((v) => !v.project || !paths.has(v.project));
  if (loose.length) {
    out.push('', '## No project');
    commitments(loose);
  }

  const projectPaths = new Map(projects.map((pv) => [pv.project.id, pv.path]));
  out.push('', '## Inbox', '');
  if (inbox.length === 0) out.push('_Empty._');
  for (const item of inbox) {
    const path = item.projectId ? projectPaths.get(item.projectId) : undefined;
    out.push(`- **i${item.refNo}** ${item.text}${path ? ` · ${path}` : ''}`);
  }
  return out.join('\n') + '\n';
}

function commitmentLine(v: CommitmentView): string {
  const c = v.c;
  const title = c.status === 'dropped' ? `~~${c.title}~~` : c.title;
  const who = c.direction === 'owe' ? `→ ${v.personName}` : `← ${v.personName}`;
  const bits = [c.status === 'open' ? `due ${c.dueOn}` : `${c.status} ${c.closedAt?.slice(0, 10) ?? ''}`.trim()];
  if (c.renegotiatedCount) bits.push(`renegotiated ${c.renegotiatedCount}x`);
  if (c.source !== 'other') bits.push(c.sourceRef ? `from [${c.source}](${c.sourceRef})` : `from ${c.source}`);
  if (c.tags) bits.push(c.tags.split(' ').map((tag) => `#${tag}`).join(' '));
  return `- [${c.status === 'done' ? 'x' : ' '}] **c${c.refNo}** ${title} ${who} · ${bits.join(' · ')}`;
}
