import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolveHttpPort } from '@clash-sentinel/shared';

export default defineConfig({
  base: process.env.CLASH_SENTINEL_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${resolveHttpPort(process.env.CLASH_SENTINEL_PORT)}`,
    },
  },
});
