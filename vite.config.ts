import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  base: '',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(rootDir, 'popup.html'),
        sidepanel: resolve(rootDir, 'sidepanel.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
