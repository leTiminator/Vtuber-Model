/**
 * Prepares the runtime assets the app needs but that we do not commit to git:
 *
 *   public/mediapipe/wasm/   copied out of node_modules (~22 MB)
 *   public/models/*.task     downloaded from Google's model host (~3.8 MB)
 *
 * Runs automatically on `npm install`. Safe to re-run: existing files of the
 * right size are left alone. Run it again by hand with `npm run assets`.
 */
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Only the SIMD build and its no-SIMD fallback; the "module" variant is unused.
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const MODELS = [
  {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
];

const sizeOf = async (p) => stat(p).then((s) => s.size, () => -1);

async function copyWasm() {
  const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const to = join(root, 'public', 'mediapipe', 'wasm');
  await mkdir(to, { recursive: true });

  for (const name of WASM_FILES) {
    const src = join(from, name);
    const dst = join(to, name);
    const srcSize = await sizeOf(src);
    if (srcSize < 0) {
      throw new Error(`missing ${src} — run \`npm install\` first`);
    }
    if ((await sizeOf(dst)) === srcSize) {
      console.log(`  = ${name} (already current)`);
      continue;
    }
    await copyFile(src, dst);
    console.log(`  + ${name} (${(srcSize / 1e6).toFixed(1)} MB)`);
  }
}

async function downloadModels() {
  const to = join(root, 'public', 'models');
  await mkdir(to, { recursive: true });

  for (const { file, url } of MODELS) {
    const dst = join(to, file);
    if ((await sizeOf(dst)) > 1e6) {
      console.log(`  = ${file} (already downloaded)`);
      continue;
    }
    process.stdout.write(`  ↓ ${file} … `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dst));
    } catch (err) {
      await unlink(dst).catch(() => {});
      throw err;
    }
    console.log(`${((await sizeOf(dst)) / 1e6).toFixed(1)} MB`);
  }
}

try {
  console.log('Preparing VTuber runtime assets…');
  await copyWasm();
  await downloadModels();
  console.log('Done. Start the app with `npm run dev`.');
} catch (err) {
  console.error(`\nCould not prepare assets: ${err.message}`);
  console.error('The app will not track faces until this succeeds. Retry with `npm run assets`.');
  process.exitCode = 1;
}
