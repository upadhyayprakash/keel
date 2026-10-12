import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A shared file or server database means test files must not run at the same time.
    fileParallelism: !process.env.KEEL_TEST_DB_URL,
  },
});
