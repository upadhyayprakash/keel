import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { Keel } from '@keel/core';

export interface ServerOptions {
  keel: Keel;
  port: number;
  /** Built browser terminal (apps/web/dist). */
  webDist?: string;
  /** Extra origin allowed to call the API, e.g. the Vite dev server (localhost:5173). */
  devOrigin?: string;
}

const DEFAULT_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function createApp({ keel, port, webDist = DEFAULT_DIST, devOrigin }: ServerOptions): Hono {
  const app = new Hono();
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(devOrigin ? [devOrigin] : [])]);

  // v1 has no login, so only this machine may talk to Keel. Checking Host stops
  // DNS rebinding; checking Origin stops other websites from sending commands.
  app.use('*', async (c, next) => {
    if (!allowed.has(c.req.header('host') ?? '')) return c.text('Forbidden', 403);
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) return c.text('Forbidden', 403);
    await next();
  });

  // Both return a RunResult (blocks, plus question and session while a command waits for an answer) and the state.
  app.post('/api/run', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.text('Expected JSON', 415);
    const body = await c.req.json<{ line?: unknown }>().catch(() => ({ line: undefined }));
    const result = await keel.exec(typeof body.line === 'string' ? body.line : '');
    return c.json({ ...result, state: await keel.state() });
  });

  app.post('/api/answer', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.text('Expected JSON', 415);
    const body = await c.req.json<{ session?: unknown; text?: unknown }>().catch(() => ({ session: undefined, text: undefined }));
    if (typeof body.session !== 'string') return c.json({ error: 'Missing session' }, 400);
    const result = await keel.answer(body.session, typeof body.text === 'string' ? body.text : null);
    return c.json({ ...result, state: await keel.state() });
  });

  app.get('/api/state', async (c) => c.json(await keel.state()));
  app.get('/api/complete', async (c) => c.json(await keel.complete(c.req.query('line') ?? '')));

  app.get('*', (c) => {
    const index = join(webDist, 'index.html');
    if (!existsSync(index)) {
      return c.html('<p style="font-family:monospace">The browser terminal is not built yet. Run <b>pnpm build</b>, then <b>keel serve</b> again.</p>', 503);
    }
    const requested = normalize(join(webDist, decodeURIComponent(c.req.path)));
    const inside = requested.startsWith(webDist + sep);
    const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : index;
    return c.body(readFileSync(file), 200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong. Details are in the terminal running keel serve.' }, 500);
  });

  return app;
}

export function startServer(opts: ServerOptions): Promise<void> {
  const app = createApp({ ...opts, devOrigin: opts.devOrigin ?? process.env.KEEL_DEV_ORIGIN });
  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, () => {
      console.log(`› keel is running at http://localhost:${opts.port}  (Ctrl+C to stop)`);
      resolve();
    });
  });
}
