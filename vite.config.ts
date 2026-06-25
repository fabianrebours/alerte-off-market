import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Front React servi par Vite en dev (port 5173), build statique dans dist/web.
// L'API Express tourne sur PORT (8787 par défaut) ; on proxy /api et /desinscription.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/desinscription': { target: API_TARGET, changeOrigin: true },
    },
  },
});
