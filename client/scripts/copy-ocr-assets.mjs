/**
 * Stage the OCR assets into public/ so vite copies them into the build.
 *
 * The app is self-hosted and expected to work offline, so tesseract must never
 * reach for a CDN — every file it loads at runtime is served from our own
 * origin. They are copied from node_modules at build time rather than committed:
 * ~18MB of binaries in git, rewritten on every dependency bump, is a bad trade
 * when npm install already has them.
 *
 * Runs from `predev` and `prebuild`, so the dev server and the Docker image are
 * both covered without a Dockerfile change.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = resolve(here, '..');
const modules = join(clientRoot, 'node_modules');
const target = join(clientRoot, 'public', 'tesseract');
const cvTarget = join(clientRoot, 'public', 'opencv');

// Both LSTM cores ship: we pick between them at runtime by feature-detecting
// SIMD. Letting tesseract choose for itself is not an option offline — it also
// probes for `relaxedsimd` builds that tesseract.js-core does not ship, and a
// 404 with no CDN fallback is a hard failure.
const assets = [
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  // Only the .wasm.js files: they embed the binary rather than fetching the
  // sibling .wasm, verified by hiding those and watching OCR keep working. That
  // is 5.5MB of image size not shipped.
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  // The standard model rather than `best_int`: on crops this small the accuracy
  // difference is slight and the speed difference is not.
  ['@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', 'eng.traineddata.gz'],
];

/**
 * OpenCV, which finds the card in the frame.
 *
 * Staged rather than bundled, and not for size alone: it is an emscripten build
 * that reaches for `fs` and `crypto` on its Node path, and vite fails outright
 * trying to resolve those for the browser. Served as a plain file and loaded
 * with a script tag, none of that is reachable — which is also how tesseract has
 * always been handled here.
 */
const cvAssets = [['@techstark/opencv-js/dist/opencv.js', 'opencv.js']];

mkdirSync(target, { recursive: true });
mkdirSync(cvTarget, { recursive: true });

let copied = 0;
let bytes = 0;
const missing = [];

for (const [from, to, into = target] of [...assets, ...cvAssets.map(([f, t]) => [f, t, cvTarget])]) {
  const source = join(modules, from);
  if (!existsSync(source)) {
    missing.push(from);
    continue;
  }
  copyFileSync(source, join(into, to));
  bytes += statSync(source).size;
  copied++;
}

if (missing.length) {
  console.error('Missing OCR assets — run npm install in client/:');
  for (const name of missing) console.error(`  ${name}`);
  process.exit(1);
}

console.log(`✓ Staged ${copied} OCR assets (${(bytes / 1048576).toFixed(1)}MB) into public/tesseract`);
