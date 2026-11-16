import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const daemon = `http://127.0.0.1:${process.env.JOGGER_PORT ?? 4317}`;

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.JOGGER_DEV_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': { target: daemon },
      '/ws': { target: daemon, ws: true },
    },
  },
});
