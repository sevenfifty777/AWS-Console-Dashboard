import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser app lives in web/ and is built into dist/public, next to the bundled server.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4780', changeOrigin: true },
    },
  },
});
