import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Keel, renderText } from '@keel/core';
import { ansiPaint, argvToLine, banner, resolveTheme, useColor } from './terminal';

const VERSION = '0.1.0';

function databaseUrl(): string {
  const url = process.env.KEEL_DB_URL || `file:${join(homedir(), '.keel', 'keel.db')}`;
  if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
  return url;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const url = databaseUrl();
  const keel = await Keel.open({ url, authToken: process.env.KEEL_DB_TOKEN || undefined });

  try {
    if (args[0] === 'serve') {
      const { startServer } = await import('@keel/server');
      const portArg = args.indexOf('--port');
      const port = Number(portArg >= 0 ? args[portArg + 1] : process.env.KEEL_PORT || 4242);
      await startServer({ keel, port });
      return new Promise<number>(() => {}); // runs until Ctrl+C
    }

    const state = await keel.state();
    const color = useColor(process.env, Boolean(process.stdout.isTTY)) && !args.includes('--json');
    const paint = color ? ansiPaint(resolveTheme(process.env, state.theme)) : undefined;

    if (args.length === 0) {
      process.stdout.write(banner(paint ?? ((t) => t), VERSION, url.startsWith('file:') ? 'local' : 'remote') + '\n');
      return 0;
    }

    const blocks = await keel.run(argvToLine(args));
    process.stdout.write(renderText(blocks, paint) + '\n');
    return blocks.some((b) => b.kind === 'status' && b.level === 'error') ? 1 : 0;
  } finally {
    if (args[0] !== 'serve') keel.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
