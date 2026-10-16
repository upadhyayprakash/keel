import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Goals phone app (ADR 0004). keel serve serves the build at /goals.
// In dev, run `pnpm dev:server` (API on 4242) next to `pnpm dev:goals` (this, on 5174).
export default defineConfig({
  base: '/goals/',
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4242', changeOrigin: true } },
  },
});
