import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';
import { rigRelay } from './scripts/rig-relay.mjs';

// `npm run phone` sets this. Testing on a phone needs two things a desktop run
// does not: the server has to listen on the LAN, and it has to serve HTTPS —
// browsers refuse getUserMedia on a plain-HTTP origin that is not localhost, so
// over the LAN the camera is simply unavailable without a certificate.
const phone = process.env.VTUBER_PHONE === '1';

// A GitHub project page is served from /<repo>/, not from the root, so every
// asset URL needs that prefix. The workflow passes it in; locally it stays '/'
// so `npm run dev` and a plain `npm run build` are unaffected.
const base = process.env.VTUBER_BASE ?? '/';

// Stamped into the page so a build can be identified from the phone. "Is it
// cached?" should be a question with an answer, not a guess.
const BUILD = process.env.VTUBER_BUILD
  || new Date().toISOString().replace('T', ' ').slice(0, 16);

export default defineConfig({
  base,
  define: { __BUILD__: JSON.stringify(BUILD) },
  // The relay carries tracking from the tab with the camera to the page OBS
  // opens — see scripts/rig-relay.mjs. Dev only: it is a live connection, and
  // a built copy on a static host has no server to hold one.
  plugins: phone ? [rigRelay(), basicSsl()] : [rigRelay()],
  server: {
    host: phone ? true : '127.0.0.1',
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    /* Two pages. The second is what OBS opens: the model and nothing else, no
     * camera and no tracking model in it, so OBS's older embedded browser is
     * never asked to run one beside your encoder. */
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        output: fileURLToPath(new URL('output.html', import.meta.url)),
      },
    },
  },
  // The tracker asks for wasm + a 3.8 MB model; make sure Vite serves them raw.
  assetsInclude: ['**/*.task'],
});
