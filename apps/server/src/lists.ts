import type { Context, Hono } from 'hono';
import {
  KeelError,
  addItems,
  changeItems,
  createList,
  deleteList,
  findList,
  listData,
  listLists,
  listSummary,
  moveItem,
  moveList,
  removeItems,
  resetList,
  setCover,
  updateList,
  type ItemState,
  type Keel,
  type ListFields,
  type ListKind,
  type Target,
  type ViewSort,
} from '@keel/core';
import { failure } from './goals';

// ADR 0005: the owner's API for Lists in the phone app. Every route works on the list
// model in @keel/core, so the phone, the CLI and the browser terminal share one set of
// rules (ADR 0003 guards included). Items are named by id here, not by the CLI's number.
// With login on, these need a Goals or terminal session (see index.ts). JSON field names
// are the same as `keel list ... --json`.

const bad = (c: Context, error: string, field: string | null = null) => c.json({ error, hint: null, field }, 400);

/** The JSON object in a request body, or a 4xx answer. */
async function body(c: Context): Promise<Record<string, unknown> | Response> {
  if (!c.req.header('content-type')?.startsWith('application/json')) return c.text('Expected JSON', 415);
  const value = await c.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad(c, 'Expected a JSON object.');
  return value as Record<string, unknown>;
}

const isResponse = (v: unknown): v is Response => v instanceof Response;

/** A field that must be a string (or null where `nullable`) when it is there. */
function stringField(b: Record<string, unknown>, key: string, nullable = false): string | null | undefined | KeelError {
  const v = b[key];
  if (v === undefined) return undefined;
  if (typeof v === 'string' || (nullable && v === null)) return v;
  return new KeelError(`${key} must be text.`, undefined, key);
}

/** The project a list goes to: `acme/website`, `acme` (its General project), or Personal. */
async function targetOf(keel: Keel, project: unknown): Promise<Target> {
  const k = keel.store;
  if (project === undefined || project === null || project === '' || project === 'personal') return { personal: true };
  if (typeof project !== 'string') throw new KeelError('project must be text, like acme/website.', undefined, 'project');
  const path = project.replace(/^\+/, '').toLowerCase();
  if (path.includes('/')) return { project: await k.projectByPath(path) };
  return { client: await k.requireClient(path, 'Example: acme or acme/website') };
}

export function listRoutes(app: Hono, keel: Keel): void {
  const k = keel.store;
  const view = async (ref: string) => listData(await findList(k, ref));

  // Lists without their items, for the gallery. ?status=active|archived|all, ?q= (name, description, tags), ?tag=, ?project=acme or acme/website.
  app.get('/api/lists', async (c) => {
    const status = c.req.query('status');
    if (status !== undefined && status !== 'active' && status !== 'archived' && status !== 'all') return bad(c, 'status is active, archived or all.', 'status');
    try {
      const scope = c.req.query('project')?.replace(/^\+/, '').toLowerCase();
      let where: { projectId?: string; clientId?: string } = {};
      if (scope) where = scope.includes('/') ? { projectId: (await k.projectByPath(scope)).project.id } : { clientId: (await k.requireClient(scope, 'Example: acme')).id };
      const views = await listLists(k, { status, tag: c.req.query('tag'), query: c.req.query('q'), ...where });
      return c.json({ lists: views.map(listSummary) });
    } catch (e) {
      return failure(c, e);
    }
  });

  // Where a new list can go, for the form: Personal, each client's General project, and each project.
  // Registered before /api/lists/:ref, so "targets" is never read as a list.
  app.get('/api/lists/targets', async (c) => {
    const clients = await k.listClients();
    const projects = (await k.listProjects()).filter((pv) => !pv.project.isDefault);
    return c.json({
      targets: [
        { value: 'personal', label: 'Personal' },
        ...clients.filter((cl) => cl.slug !== 'personal').map((cl) => ({ value: cl.slug, label: `${cl.name} (general)` })),
        ...projects.map((pv) => ({ value: pv.path, label: `${pv.client.name} / ${pv.project.name}` })),
      ],
    });
  });

  app.post('/api/lists', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    try {
      const kind = b.kind === undefined ? 'plain' : b.kind;
      if (kind !== 'plain' && kind !== 'tracked') return bad(c, 'A list is plain or tracked.', 'kind');
      const description = stringField(b, 'description', true);
      if (description instanceof KeelError) throw description;
      const items = b.items === undefined ? [] : b.items;
      if (!Array.isArray(items) || items.some((i) => typeof i !== 'string')) return bad(c, 'items must be a list of text.', 'items');
      if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))) return bad(c, 'tags must be a list of text.', 'tags');
      const created = await createList(k, {
        name: typeof b.name === 'string' ? b.name : '',
        target: await targetOf(keel, b.project),
        kind: kind as ListKind,
        description,
        tags: (b.tags as string[] | undefined) ?? [],
        pinned: b.pinned === true,
        items: items as string[],
      });
      return c.json(listData(created), 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  app.get('/api/lists/:ref', async (c) => {
    try {
      return c.json(await view(c.req.param('ref')));
    } catch (e) {
      return failure(c, e);
    }
  });

  // Changes the list itself: any of name, description, tags, kind, viewSort, pinned, status. Last arrival wins, per field.
  app.patch('/api/lists/:ref', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    try {
      const fields: ListFields & { status?: 'active' | 'archived' } = {};
      const name = stringField(b, 'name');
      const description = stringField(b, 'description', true);
      if (name instanceof KeelError) throw name;
      if (description instanceof KeelError) throw description;
      if (name !== undefined) fields.name = name as string;
      if (description !== undefined) fields.description = description;
      if (b.tags !== undefined) {
        if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string')) return bad(c, 'tags must be a list of text.', 'tags');
        fields.tags = b.tags as string[];
      }
      if (b.kind !== undefined) fields.kind = b.kind as ListKind;
      if (b.viewSort !== undefined) fields.viewSort = b.viewSort as ViewSort;
      if (b.pinned !== undefined) {
        if (typeof b.pinned !== 'boolean') return bad(c, 'pinned is true or false.', 'pinned');
        fields.pinned = b.pinned;
      }
      if (b.status !== undefined) {
        if (b.status !== 'active' && b.status !== 'archived') return bad(c, 'status is active or archived.', 'status');
        fields.status = b.status;
      }
      return c.json(listData(await updateList(k, c.req.param('ref'), fields)));
    } catch (e) {
      return failure(c, e);
    }
  });

  app.delete('/api/lists/:ref', async (c) => {
    try {
      const gone = await deleteList(k, c.req.param('ref'));
      return c.json({ deleted: true, ref: `l${gone.list.refNo}`, items: gone.items.length });
    } catch (e) {
      return failure(c, e);
    }
  });

  // Moves the list to another project: { project: "acme/website" | "acme" | "personal" }.
  app.post('/api/lists/:ref/move', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    try {
      return c.json(listData(await moveList(k, c.req.param('ref'), await targetOf(keel, b.project ?? 'personal'))));
    } catch (e) {
      return failure(c, e);
    }
  });

  // Every item back to open, for a list you use again. { reset: 0 } when there was nothing to do.
  app.post('/api/lists/:ref/reset', async (c) => {
    try {
      const { view: after, reset } = await resetList(k, c.req.param('ref'));
      return c.json({ reset, ...listData(after) });
    } catch (e) {
      return failure(c, e);
    }
  });

  // ---- items ----

  // Adds items at the end: { texts: ["milk", "eggs"] } or { text: "milk" }.
  app.post('/api/lists/:ref/items', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    const texts = Array.isArray(b.texts) ? b.texts : typeof b.text === 'string' ? [b.text] : null;
    if (!texts || texts.some((t) => typeof t !== 'string')) return bad(c, 'Send the items as texts: ["milk", "eggs"].', 'texts');
    try {
      return c.json(listData(await addItems(k, c.req.param('ref'), texts as string[])), 201);
    } catch (e) {
      return failure(c, e);
    }
  });

  // Changes one item: any of text, note, state. A second `done`, or a tap after another device already did it, is a 409 that says when.
  app.patch('/api/lists/:ref/items/:id', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    try {
      const text = stringField(b, 'text');
      const note = stringField(b, 'note', true);
      if (text instanceof KeelError) throw text;
      if (note instanceof KeelError) throw note;
      return c.json(listData(await changeItems(k, c.req.param('ref'), [c.req.param('id')], { text: text ?? undefined, note, state: b.state as ItemState | undefined })));
    } catch (e) {
      return failure(c, e);
    }
  });

  app.delete('/api/lists/:ref/items/:id', async (c) => {
    try {
      return c.json(listData(await removeItems(k, c.req.param('ref'), [c.req.param('id')])));
    } catch (e) {
      return failure(c, e);
    }
  });

  // A drag: { afterId: "<item id>" } puts it after that item, { afterId: null } first. One row is written; the list goes back to manual order.
  app.post('/api/lists/:ref/items/:id/move', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    if (b.afterId !== null && typeof b.afterId !== 'string') return bad(c, 'afterId is an item id, or null for first.', 'afterId');
    try {
      return c.json(listData(await moveItem(k, c.req.param('ref'), c.req.param('id'), b.afterId as string | null)));
    } catch (e) {
      return failure(c, e);
    }
  });

  // ---- covers ----

  // Sets the cover: { kind: "svg" | "png", data: "<svg ...>" | "<base64>", dark?: "..." } (a dark one must be the same kind).
  app.put('/api/lists/:ref/cover', async (c) => {
    const b = await body(c);
    if (isResponse(b)) return b;
    if (b.kind !== 'svg' && b.kind !== 'png') return bad(c, 'kind is svg or png.', 'kind');
    if (typeof b.data !== 'string') return bad(c, 'data is the SVG text, or the PNG as base64.', 'data');
    if (b.dark !== undefined && b.dark !== null && typeof b.dark !== 'string') return bad(c, 'dark is text.', 'dark');
    try {
      const { view: after, totalBytes, overNotice } = await setCover(k, c.req.param('ref'), { kind: b.kind, data: b.data }, typeof b.dark === 'string' ? { kind: b.kind, data: b.dark } : null);
      return c.json({ ...listData(after), coverBytesTotal: totalBytes, overNotice });
    } catch (e) {
      return failure(c, e);
    }
  });

  app.delete('/api/lists/:ref/cover', async (c) => {
    try {
      return c.json(listData((await setCover(k, c.req.param('ref'), null)).view));
    } catch (e) {
      return failure(c, e);
    }
  });

  // The cover itself, for an <img>: ?theme=dark picks the dark one when there is one. 404 when no cover is set (the app shows its placeholder).
  app.get('/api/lists/:ref/cover', async (c) => {
    try {
      const { list } = await findList(k, c.req.param('ref'));
      if (!list.coverKind || !list.cover) return c.json({ error: 'No cover set.', hint: null, field: null }, 404);
      const dark = c.req.query('theme') === 'dark' && list.coverDark;
      const etag = `"${list.updatedAt}-${dark ? 'dark' : 'light'}"`;
      // Shown only as an image: no script can run from it, even if opened on its own.
      const headers: Record<string, string> = {
        'content-type': list.coverKind === 'svg' ? 'image/svg+xml' : 'image/png',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-cache',
        etag,
      };
      if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
      const data = dark ? list.coverDark! : list.cover;
      return c.body(list.coverKind === 'svg' ? Buffer.from(data) : Buffer.from(data, 'base64'), 200, headers);
    } catch (e) {
      return failure(c, e);
    }
  });
}
