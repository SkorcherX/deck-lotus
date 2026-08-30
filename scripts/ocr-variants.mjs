#!/usr/bin/env node
/**
 * What a change to the OCR preprocessing would be worth, measured before making
 * one.
 *
 * The sibling of `scripts/hash-variants.mjs`, for the other signal. A recorded
 * session carries the rectified card and, where the reader was on, what the
 * reader made of it — so a proposed variant can be run over the same crops and
 * scored against what actually came back, rather than argued about.
 *
 * The crops are cut here the way `cardCapture.cropRegion` cuts them, from the
 * bundle's own `settings.regions`, and preprocessed by the *real*
 * `preprocessPixels` from src/shared. The engine is tesseract.js, the same one
 * the browser runs, driven with the same page-segmentation modes and
 * whitelists. What this cannot reproduce is the browser's exact upscale filter,
 * so absolute rates here are a little below the phone's; compare variants
 * against each other, never a number here against a number in a bundle.
 *
 * Usage:
 *   node scripts/ocr-variants.mjs <bundle.json> [more.json ...] [--field collector|title]
 *
 * Ground truth comes from the bundle: a capture's art-hash resolution names the
 * card, and that is an independent signal from the reader being measured.
 * Captures whose art did not resolve are skipped rather than guessed at.
 */
import fs from 'fs';
import jpeg from 'jpeg-js';
import { createRequire } from 'module';
import { preprocessPixels } from '../src/shared/ocrPreprocess.js';

const require = createRequire(import.meta.url);
const { createWorker, PSM } = require('../client/node_modules/tesseract.js');

const TITLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',-// ";
const COLLECTOR_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/* ';

/**
 * The variants to compare, per field.
 *
 * The first three are what ships. `clip` is the proposal in task 11 of the
 * pipeline plan: clamp the top of the histogram before Sauvola, so a bright
 * band cannot drag the local mean up and erase the strokes beside it.
 */
const VARIANTS = {
  collector: [
    ['default', { window: 0.35 }],
    ['low-contrast', { window: 0.35, k: 0.08 }],
    ['grayscale', { window: 0.35, grayscale: true }],
    ['clip 0.95', { window: 0.35, clip: 0.95 }],
    ['clip 0.90', { window: 0.35, clip: 0.9 }],
    ['clip 0.95 + low-contrast', { window: 0.35, k: 0.08, clip: 0.95 }],
  ],
  title: [
    ['default', { window: 0.8 }],
    ['low-contrast', { window: 0.8, k: 0.08 }],
    ['grayscale', { window: 0.8, grayscale: true }],
    ['clip 0.95', { window: 0.8, clip: 0.95 }],
    ['clip 0.90', { window: 0.8, clip: 0.9 }],
    ['clip 0.95 + low-contrast', { window: 0.8, k: 0.08, clip: 0.95 }],
  ],
};

/** Nearest-neighbour crop and upscale, as cropRegion does with a canvas. */
function cropRegion(image, region, scale = 3) {
  const x0 = Math.round(region.x * image.width);
  const y0 = Math.round(region.y * image.height);
  const w = Math.round(region.w * image.width);
  const h = Math.round(region.h * image.height);

  const width = w * scale;
  const height = h * scale;
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, y0 + Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, x0 + Math.floor(x / scale));
      const src = (sy * image.width + sx) * 4;
      const dst = (y * width + x) * 4;
      data[dst] = image.data[src];
      data[dst + 1] = image.data[src + 1];
      data[dst + 2] = image.data[src + 2];
      data[dst + 3] = 255;
    }
  }

  return { data, width, height };
}

/** Tesseract takes an encoded image, so the processed pixels go back to JPEG. */
const encode = (image) =>
  jpeg.encode({ data: Buffer.from(image.data), width: image.width, height: image.height }, 100).data;

/** Did the read find the set code and collector number the art already named? */
function scoreCollector(text, truth) {
  const upper = text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  const number = String(truth.collectorNumber || '').replace(/^0+/, '');
  const gotSet = truth.setCode ? upper.includes(truth.setCode.toUpperCase()) : false;
  const gotNumber = number
    ? new RegExp(`(^| )0*${number}( |$)`).test(upper)
    : false;
  return (gotSet ? 0.5 : 0) + (gotNumber ? 0.5 : 0);
}

/** Did the read find the name? Loosely — a missing apostrophe is not a failure. */
function scoreTitle(text, truth) {
  const flatten = (value) => value.toLowerCase().replace(/[^a-z]+/g, '');
  const name = flatten(truth.name || '');
  if (!name) return 0;
  const read = flatten(text);
  if (read.includes(name)) return 1;
  // Partial credit for the first word, which is usually enough for the fused
  // resolver to rank the right card once the art has shortlisted it.
  const first = flatten((truth.name || '').split(/\s+/)[0] || '');
  return first.length > 3 && read.includes(first) ? 0.5 : 0;
}

const args = process.argv.slice(2);
const fieldArg = args.indexOf('--field');
const field = fieldArg >= 0 ? args[fieldArg + 1] : 'collector';
const bundles = args.filter((a) => a.endsWith('.json'));

if (!bundles.length) {
  console.error('usage: node scripts/ocr-variants.mjs <bundle.json> [...] [--field collector|title]');
  process.exit(1);
}

// Every capture that has both a rectified image and an art answer to be judged
// against, gathered before the engine starts so the run reports its own size.
const cases = [];
for (const file of bundles) {
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const regions = bundle.environment?.settings?.regions;
  if (!regions) continue;

  for (const capture of bundle.captures || []) {
    const best = capture.resolution?.candidates?.[0];
    if (!best || typeof capture.rectified !== 'string') continue;

    cases.push({
      session: file.replace(/^.*[\\/]/, '').slice(17, 33),
      image: jpeg.decode(Buffer.from(capture.rectified.split(',')[1], 'base64'), { useTArray: true }),
      region: regions[field],
      truth: best,
    });
  }
}

if (!cases.length) {
  console.error('no captures with both a rectified image and an art match');
  process.exit(1);
}

console.log(`${cases.length} captures from ${bundles.length} bundles, field: ${field}\n`);

const worker = await createWorker('eng');
await worker.setParameters({
  tessedit_pageseg_mode: field === 'collector' ? PSM.SINGLE_BLOCK : PSM.SINGLE_LINE,
  tessedit_char_whitelist: field === 'collector' ? COLLECTOR_CHARS : TITLE_CHARS,
});

const score = field === 'collector' ? scoreCollector : scoreTitle;

console.log('variant                     score   full   none    ms');

for (const [name, options] of VARIANTS[field]) {
  let total = 0;
  let full = 0;
  let none = 0;
  const started = Date.now();

  for (const item of cases) {
    const processed = preprocessPixels(cropRegion(item.image, item.region), options);
    const { data } = await worker.recognize(Buffer.from(encode(processed)));
    const value = score(data.text, item.truth);
    total += value;
    if (value === 1) full++;
    if (value === 0) none++;
  }

  console.log(
    name.padEnd(26),
    (total / cases.length).toFixed(3).padStart(5),
    String(full).padStart(6),
    String(none).padStart(6),
    String(Math.round((Date.now() - started) / cases.length)).padStart(5)
  );
}

await worker.terminate();
