import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev, run `pnpm dev:server` (API on 4242) next to `pnpm dev:web` (this, on 5173).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4242', changeOrigin: true } },
  },
});
