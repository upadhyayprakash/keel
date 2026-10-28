import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { parsePublicUrl, type Keel } from '@keel/core';
import { authRoutes, requireSession, type AuthOptions } from './auth';
import { goalRoutes } from './goals';

export { checkServe, COOKIES } from './auth';
export type { AuthOptions } from './auth';

export interface ServerOptions {
  keel: Keel;
  port: number;
  /** Built browser terminal (apps/web/dist). */
  webDist?: string;
  /** Built Goals app (apps/goals/dist), served at /goals (ADR 0004). */
  goalsDist?: string;
  /** Extra origin allowed to call the API, e.g. the Vite dev server (localhost:5173). */
  devOrigin?: string;
  /** Turns login on (ADR 0002): every API call except /api/auth/* needs a session. */
  auth?: AuthOptions;
  /** Address to listen on. 127.0.0.1 unless `--host`. */
  host?: string;
  /** PEM contents of `--cert` and `--key`, to serve HTTPS directly. */
  tls?: { cert: string; key: string };
}

// Next to the bundle in the published package, or apps/<name>/dist when running from source.
function defaultDist(name: string): string {
  const candidates = [new URL(`./${name}`, import.meta.url), new URL(`../../${name}/dist`, import.meta.url)].map((u) => fileURLToPath(u));
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? candidates[1]!;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function createApp({ keel, port, webDist = defaultDist('web'), goalsDist = defaultDist('goals'), devOrigin, auth, host }: ServerOptions): Hono {
  const app = new Hono();
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...(devOrigin ? [devOrigin] : [])]);
  if (auth?.publicUrl) allowed.add(parsePublicUrl(auth.publicUrl).rpId);
  if (auth && host && host !== '127.0.0.1') allowed.add(`${host}:${port}`);

  // Checking Host stops DNS rebinding; checking Origin stops other websites from
  // sending commands. Without login, that keeps Keel to this machine.
  app.use('*', async (c, next) => {
    if (!allowed.has(c.req.header('host') ?? '')) return c.text('Forbidden', 403);
    const origin = c.req.header('origin');
    if (origin && !allowed.has(origin.replace(/^https?:\/\//, ''))) return c.text('Forbidden', 403);
    await next();
  });

  // With login on, every API call needs a session, whatever address it came from:
  // a tunnel forwards to 127.0.0.1, so the source address proves nothing. Goals
  // routes take a Goals or terminal session; the browser terminal's take a terminal one.
  if (!auth) app.get('/api/auth/state', (c) => c.json({ login: false, passkeys: false, totp: false, signedIn: { goals: false, terminal: false } }));
  if (auth) {
    authRoutes(app, auth);
    const goals = requireSession(auth.store, 'goals');
    const terminal = requireSession(auth.store, 'terminal');
    app.use('/api/*', (c, next) => {
      if (c.req.path.startsWith('/api/auth/')) return next();
      const goalsRoute = c.req.path === '/api/goals' || c.req.path.startsWith('/api/goals/');
      return goalsRoute ? goals(c, next) : terminal(c, next);
    });
  }

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

  goalRoutes(app, keel);
  app.get('/api/complete', async (c) => c.json(await keel.complete(c.req.query('line') ?? '')));

  // A built app's files, or its index.html for any other path inside it (client-side routes).
  const serveDist = (c: Context, dist: string, path: string, notBuilt: string) => {
    const index = join(dist, 'index.html');
    if (!existsSync(index)) return c.html(notBuilt, 503);
    const requested = normalize(join(dist, decodeURIComponent(path)));
    const inside = requested.startsWith(dist + sep);
    const file = inside && existsSync(requested) && statSync(requested).isFile() ? requested : index;
    return c.body(readFileSync(file), 200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  };
  const notBuilt = (what: string) =>
    `<p style="font-family:monospace">${what} is not built yet. Run <b>pnpm build</b>, then <b>keel serve</b> again.</p>`;

  app.get('/goals', (c) => c.redirect('/goals/'));
  app.get('/goals/*', (c) => serveDist(c, goalsDist, c.req.path.slice('/goals'.length), notBuilt('The Goals app')));
  app.get('*', (c) => serveDist(c, webDist, c.req.path, notBuilt('The browser terminal')));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Something went wrong. Details are in the terminal running keel serve.' }, 500);
  });

  return app;
}

export function startServer(opts: ServerOptions): Promise<void> {
  const app = createApp({ ...opts, devOrigin: opts.devOrigin ?? process.env.KEEL_DEV_ORIGIN });
  const hostname = opts.host ?? '127.0.0.1';
  const tls = opts.tls ? { createServer: createHttpsServer, serverOptions: { cert: opts.tls.cert, key: opts.tls.key } } : {};
  return new Promise((resolve) => {
    serve({ fetch: app.fetch, port: opts.port, hostname, ...tls }, () => {
      const local = `${opts.tls ? 'https' : 'http'}://${hostname === '127.0.0.1' ? 'localhost' : hostname}:${opts.port}`;
      if (opts.auth?.publicUrl) console.log(`› keel is running at ${opts.auth.publicUrl}, login on  (here: ${local})  (Ctrl+C to stop)`);
      else console.log(`› keel is running at ${local}${opts.auth ? ', login on' : ''}  (Ctrl+C to stop)`);
      resolve();
    });
  });
}
