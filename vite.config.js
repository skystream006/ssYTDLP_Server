import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), '');
  const apiTarget = environment.DEV_API_TARGET || `https://localhost:${environment.HTTPS_WEB_PORT || 4000}`;
  const localApi = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(apiTarget).hostname);
  return {
    root: 'frontend',
    plugins: [react()],
    build: {
      outDir: '../public',
      emptyOutDir: true
    },
    server: {
      proxy: { '/api': { target: apiTarget, secure: !localApi } }
    }
  };
});