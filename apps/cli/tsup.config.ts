import { cpSync, existsSync } from 'node:fs';
import { defineConfig } from 'tsup';

// One ESM bundle for npm. Keel's own packages are bundled in; third-party
// dependencies stay external (libSQL ships native binaries per platform).
// Migrations and the built browser terminal are copied next to the bundle,
// where core and server look for them first.
export default defineConfig({
  entry: { keel: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@keel\//],
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    if (!existsSync('../web/dist/index.html')) throw new Error('Build the browser terminal first: pnpm --filter @keel/web build');
    cpSync('../../packages/core/drizzle', 'dist/drizzle', { recursive: true });
    cpSync('../web/dist', 'dist/web', { recursive: true });
  },
});
