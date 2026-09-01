import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, open: false },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // The tracker asks for wasm + a 3.8 MB model; make sure Vite serves them raw.
  assetsInclude: ['**/*.task'],
});
