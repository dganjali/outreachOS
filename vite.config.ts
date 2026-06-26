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
        // Only split out heavy *leaf* libraries — ones the app imports but that
        // never import app/vendor code back, so isolating them can't create a
        // cross-chunk circular dependency. (A broader split that separated
        // react/vendor produced a "Cannot access 'b' before initialization" TDZ
        // crash at runtime — black screen. Don't reintroduce that.) Three.js is
        // Landing-only and dominated that route's bundle; Firebase is the next
        // largest. Everything else stays on Vite's safe default chunking.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('/three/') || id.includes('/three@')) return 'three';
          if (id.includes('/firebase/') || id.includes('/@firebase/')) return 'firebase';
        },
      },
    },
  },
});
