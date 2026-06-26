import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heaviest dependencies into their own long-lived chunks.
        // Three.js (only the Landing scene needs it) and Firebase dominated the
        // two >500kB bundles; isolating them keeps the app shell small and lets
        // each big lib cache independently across deploys.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/three/') || id.includes('/three@')) return 'three';
          if (id.includes('firebase') || id.includes('@firebase')) return 'firebase';
          if (id.includes('@radix-ui')) return 'radix';
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router') ||
            id.includes('/scheduler/')
          )
            return 'react';
          return 'vendor';
        },
      },
    },
  },
});
