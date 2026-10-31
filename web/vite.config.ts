import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    // 允许通过 Cloudflare Tunnel 的临时域名访问（*.trycloudflare.com）
    allowedHosts: true,
    proxy: {
      '/v1': { target: 'http://localhost:5174', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1600 },
});
