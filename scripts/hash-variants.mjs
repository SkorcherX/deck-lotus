#!/usr/bin/env node
/**
 * What a change to the art hash would cost, measured before making it.
 *
 * `src/shared/cardHash.js` is the one module both ends of the matcher share, and
 * changing its arithmetic means rebuilding all 112k references and bumping a
 * version. So a proposed change is measured here first, against every recorded
 * session, on three questions at once:
 *
 *   1. does it match more captures to the card that was actually on the table,
 *   2. does it bring *different cards* closer together, and
 *   3. what does it do to the cards it was not aimed at.
 *
 * A variant that answers the first well and the second badly is not an
 * improvement, it is a looser threshold wearing a disguise.
 *
 * The steps come from cardHash.js rather than a copy, so a variant is the real
 * pipeline with one filter inserted between the grid and the DCT.
 *
 * Usage:
 *   node scripts/hash-variants.mjs <shots-dir> <refs-dir> [--ladder a,b,c]
 *
 * `shots-dir` holds one directory per session of `capN_rectified.jpg` files as
 * written by `scan-replay.mjs --extract`; `refs-dir` holds one image per card
 * named `0_Card_Name.jpg`, numbered in capture order. See
 * docs/SCAN_DIAGNOSTICS_TESTING.md.
 */
import fs from 'fs';
import path from 'path';
import jpeg from 'jpeg-js';
import {
  GRID,
  ART_BLOCK,
  ART_WINDOW,
  downsampleToGrid,
  dct2d,
  signBlock,
  hammingDistance,
} from '../src/shared/cardHash.js';

/** Box blur over the grid, radius r, edges clamped. */
function blur(grid, r) {
  const out = new Float64Array(GRID * GRID);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const sy = Math.min(GRID - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const sx = Math.min(GRID - 1, Math.max(0, x + dx));
          sum += grid[sy * GRID + sx];
          n++;
        }
      }
      out[y * GRID + x] = sum / n;
    }
  }
  return out;
}

/** The grid minus a blurred copy: smooth shading out, structure kept. */
function highPass(grid, radius) {
  const low = blur(grid, radius);
  const out = new Float64Array(GRID * GRID);
  for (let i = 0; i < out.length; i++) out[i] = grid[i] - low[i];
  return out;
}

/** High-pass, then divide by local spread, so shading cannot alter contrast. */
function localNorm(grid, radius) {
  const diff = highPass(grid, radius);
  const energy = new Float64Array(GRID * GRID);
  for (let i = 0; i < energy.length; i++) energy[i] = diff[i] * diff[i];
  const spread = blur(energy, radius);

  const out = new Float64Array(GRID * GRID);
  for (let i = 0; i < out.length; i++) out[i] = diff[i] / (Math.sqrt(spread[i]) + 1);
  return out;
}

/**
 * Each variant is a grid builder and a filter over the grid.
 *
 * Two stages because the proposals live at two different points. A high-pass
 * runs between the grid and the DCT; excluding blown pixels from a cell's
 * average happens while the grid is *being built* and cannot be expressed as a
 * filter over one. `downsampleToGrid` takes `glareCut` for exactly this, so
 * both stages are still the real pipeline rather than a copy of it.
 */
const identity = (grid) => grid;
const plain = (image) => downsampleToGrid(image, ART_WINDOW);
const glareAware = (cut) => (image) => downsampleToGrid(image, ART_WINDOW, { glareCut: cut });

const VARIANTS = {
  baseline: [plain, identity],
  'high-pass r1': [plain, (grid) => highPass(grid, 1)],
  'high-pass r2': [plain, (grid) => highPass(grid, 2)],
  'high-pass r4': [plain, (grid) => highPass(grid, 4)],
  'local-norm r2': [plain, (grid) => localNorm(grid, 2)],
  'local-norm r4': [plain, (grid) => localNorm(grid, 4)],
  'glare-cut 250': [glareAware(250), identity],
  'glare-cut 240': [glareAware(240), identity],
  'glare-cut 230': [glareAware(230), identity],
  // The two together, since they are aimed at the same failure from opposite
  // ends: one drops the highlight's pixels, the other drops the shading the
  // highlight leaves behind.
  'glare-cut 240 + high-pass r2': [glareAware(240), (grid) => highPass(grid, 2)],
};

const hashUnder = (image, variant) => {
  const [grid, filter] = VARIANTS[variant];
  return signBlock(dct2d(filter(grid(image))), ART_BLOCK);
};

/**
 * A centred sub-rectangle of a rectified card — a framing probe, once the card
 * is already straightened. Hashing a recorded capture at 1.0 alone measures the
 * detector's overshoot rather than the variant, which is a mistake worth not
 * repeating: it made every non-foil card look 40 bits worse than it is.
 */
function cropScaled(image, scale) {
  if (scale >= 1) return image;
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const x0 = Math.round((image.width - w) / 2);
  const y0 = Math.round((image.height - h) / 2);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * image.width + x0) * 4;
    data.set(image.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { data, width: w, height: h };
}

const decode = (file) => jpeg.decode(fs.readFileSync(file), { useTArray: true });

const args = process.argv.slice(2);
const shotsDir = args[0];
const refsDir = args[1];
const ladderArg = args.indexOf('--ladder');
const ladder = ladderArg >= 0 ? args[ladderArg + 1].split(',').map(Number) : [0.84, 0.88, 0.92, 0.96, 1];

if (!shotsDir || !refsDir) {
  console.error('usage: node scripts/hash-variants.mjs <shots-dir> <refs-dir> [--ladder a,b,c]');
  process.exit(1);
}

// References in capture order, which is the deck's order and not an
// alphabetical one — so the files carry it: `0_Name.jpg`, `1_Name.jpg`. Sorting
// by name instead silently pairs every capture with the wrong card and reports
// a flat 0 matched, which is at least a loud way to be wrong.
const refFiles = fs
  .readdirSync(refsDir)
  .filter((f) => /^\d+_.*\.jpg$/.test(f))
  .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

if (!refFiles.length) {
  console.error(`no references in ${refsDir} — expected files named 0_Card_Name.jpg`);
  process.exit(1);
}
const shotDirs = fs.readdirSync(shotsDir).map((d) => path.join(shotsDir, d)).filter((d) => fs.statSync(d).isDirectory());

console.log(`${shotDirs.length} sessions, ${refFiles.length} references, ladder [${ladder.join(', ')}]\n`);
console.log('variant                        matched  strong   mean   nearest wrong card');

for (const variant of Object.keys(VARIANTS)) {
  const refs = refFiles.map((f) => hashUnder(decode(path.join(refsDir, f)), variant));

  const distances = [];
  const perCard = refs.map(() => []);
  for (const dir of shotDirs) {
    for (let cap = 0; cap < refs.length; cap++) {
      const file = path.join(dir, `cap${cap}_rectified.jpg`);
      if (!fs.existsSync(file)) continue;
      const image = decode(file);
      let best = Infinity;
      for (const scale of ladder) {
        const d = hammingDistance(hashUnder(cropScaled(image, scale), variant), refs[cap]);
        if (d < best) best = d;
      }
      distances.push(best);
      perCard[cap].push(best);
    }
  }

  // How near the nearest *different* card sits, over the references themselves.
  let nearestWrong = Infinity;
  for (let a = 0; a < refs.length; a++) {
    for (let b = 0; b < refs.length; b++) {
      if (a === b) continue;
      const d = hammingDistance(refs[a], refs[b]);
      if (d < nearestWrong) nearestWrong = d;
    }
  }

  const mean = distances.reduce((s, x) => s + x, 0) / distances.length;
  console.log(
    variant.padEnd(30),
    String(distances.filter((d) => d <= 77).length).padStart(3) + '/' + distances.length,
    String(distances.filter((d) => d <= 41).length).padStart(6),
    mean.toFixed(1).padStart(7),
    String(nearestWrong).padStart(15)
  );

  // Per card as well as in aggregate: a variant aimed at one kind of card has
  // to be checked against the cards it was not aimed at, and an average hides
  // exactly that.
  if (process.argv.includes('--per-card')) {
    for (let cap = 0; cap < refs.length; cap++) {
      const forCard = perCard[cap];
      if (!forCard?.length) continue;
      const cardMean = forCard.reduce((s, x) => s + x, 0) / forCard.length;
      console.log(
        `    ${refFiles[cap].replace(/^\d+_/, '').replace(/\.jpg$/, '').replace(/_/g, ' ').padEnd(24)}`,
        `mean ${cardMean.toFixed(1).padStart(6)}  matched ${forCard.filter((d) => d <= 77).length}/${forCard.length}`
      );
    }
  }
}
