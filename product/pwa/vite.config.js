import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: 'public',
  plugins: [{
    name: 'mode-specific-pwa-connect-src',
    transformIndexHtml(html) {
      if (mode !== 'development' && mode !== 'e2e') return html;
      return html.replace(
        "connect-src 'self' wss://117.72.10.87",
        "connect-src 'self' wss://117.72.10.87 ws://127.0.0.1:* ws://localhost:*",
      );
    },
  }],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: { entryFileNames: 'assets/app-[hash].js', chunkFileNames: 'assets/chunk-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
}));
