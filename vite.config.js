import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run phone` sets this. Testing on a phone needs two things a desktop run
// does not: the server has to listen on the LAN, and it has to serve HTTPS —
// browsers refuse getUserMedia on a plain-HTTP origin that is not localhost, so
// over the LAN the camera is simply unavailable without a certificate.
const phone = process.env.VTUBER_PHONE === '1';

export default defineConfig({
  plugins: phone ? [basicSsl()] : [],
  server: {
    host: phone ? true : '127.0.0.1',
    port: 5173,
    open: false,
  },
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // The tracker asks for wasm + a 3.8 MB model; make sure Vite serves them raw.
  assetsInclude: ['**/*.task'],
});
