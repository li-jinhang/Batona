import { defineConfig } from 'vite';

export default defineConfig({
  base: '/projects/dsh-link/pwa/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: { entryFileNames: 'assets/app-[hash].js', chunkFileNames: 'assets/chunk-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
