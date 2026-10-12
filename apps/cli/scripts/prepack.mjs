// npm only packs files inside this folder, so bring in the license and check the build exists.
import { copyFileSync, existsSync } from 'node:fs';

copyFileSync('../../LICENSE', 'LICENSE');
for (const file of ['dist/keel.js', 'dist/drizzle/meta/_journal.json', 'dist/web/index.html']) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}. Run pnpm build from the repo root first.`);
    process.exit(1);
  }
}
