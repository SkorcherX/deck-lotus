#!/usr/bin/env node
/**
 * Replay a recorded scan session against the current matcher.
 *
 * A diagnostics bundle carries the frame each capture was cut from and the quad
 * it was cut with, which is everything needed to run the whole match again
 * offline — the same warp, the same hash, the same 112k index, the same fusion.
 * So a change to the probe ladder, the match threshold or the ranking can be
 * measured against real captures in seconds, instead of being guessed at and
 * then shipped to find out.
 *
 * That is the loop the scanner was tuned in. Every number in the scan commits —
 * "1/7 to 5/7", "3/7 to 5/7, none wrong" — came from this, not from a rescan.
 *
 *   node scripts/scan-replay.mjs <bundle.json>
 *   node scripts/scan-replay.mjs <bundle.json> --ladder 0.88,0.92,0.96,1
 *   node scripts/scan-replay.mjs <bundle.json> --sweep 0.84:1.04
 *   node scripts/scan-replay.mjs <bundle.json> --extract out/dir
 *
 * Needs DATABASE_PATH pointing at a database with `printings` populated, since
 * the hash index joins the packed file to it:
 *
 *   DATABASE_PATH=data/deck-lotus-test.db node scripts/scan-replay.mjs ...
 *
 * See docs/SCAN_DIAGNOSTICS_TESTING.md for the whole method, including what the
 * bundle fields mean and how to drive the UI side in a browser.
 */
import fs from 'fs';
import path from 'path';
import jpeg from 'jpeg-js';
import { projectiveMap, rectifiedSize } from '../src/shared/cardGeometry.js';
import { hashRectified } from '../src/shared/cardHash.js';
import * as index from '../src/services/cardHashIndex.js';
import { resolveScanFused } from '../src/services/scanService.js';

/**
 * The capture warp, ported from `warpInto` in cardCapture.js.
 *
 * Duplicated rather than imported because that module reaches for `document` at
 * the top level. `projectiveMap` and `rectifiedSize` are DOM-free and are
 * imported, so the geometry — the part that would actually change an answer if
 * it drifted — stays shared. Keep this sampling identical to the original: it
 * is bilinear, from pixel centres, and anything outside the frame is black
 * rather than clamped.
 */
function warp(source, quad, outWidth, outHeight) {
  const map = projectiveMap(quad);
  const { data: src, width: sw, height: sh } = source;
  const out = new Uint8Array(outWidth * outHeight * 4);

  for (let y = 0; y < outHeight; y++) {
    const v = (y + 0.5) / outHeight;
    for (let x = 0; x < outWidth; x++) {
      const u = (x + 0.5) / outWidth;
      const [fx, fy] = map(u, v);

      const px = fx * sw - 0.5;
      const py = fy * sh - 0.5;
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const tx = px - x0;
      const ty = py - y0;
      const di = (y * outWidth + x) * 4;

      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        out[di + 3] = 255;
        continue;
      }

      const i00 = (y0 * sw + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + sw * 4;
      const i11 = i01 + 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;

      for (let c = 0; c < 3; c++) {
        out[di + c] =
          src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
      }
      out[di + 3] = 255;
    }
  }

  return { data: out, width: outWidth, height: outHeight };
}

/** A quad scaled about its own centre — `expandQuad` from scan.js. */
function scaleQuad(quad, scale) {
  const cx = quad.reduce((total, p) => total + p.x, 0) / 4;
  const cy = quad.reduce((total, p) => total + p.y, 0) / 4;
  return quad.map((p) => ({ x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale }));
}

/** Decode a capture's recorded frame. Returns null where the bundle has none. */
function frameOf(capture) {
  if (typeof capture.frame !== 'string' || !capture.frame.startsWith('data:image')) return null;
  return jpeg.decode(Buffer.from(capture.frame.split(',')[1], 'base64'), { useTArray: true });
}

/** Hash one capture at one framing, exactly as the client would. */
function probeAt(frame, quad, scale) {
  const framed = scaleQuad(quad, scale);
  const size = rectifiedSize(framed, frame.width, frame.height);
  return hashRectified(warp(frame, framed, size.width, size.height));
}

/** Write the rectified card and the frame out as JPEGs, for looking at. */
function extract(bundle, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  bundle.captures.forEach((capture, i) => {
    for (const key of ['rectified', 'frame']) {
      const value = capture[key];
      if (typeof value !== 'string' || !value.startsWith('data:image')) continue;
      fs.writeFileSync(path.join(dir, `cap${i}_${key}.jpg`), Buffer.from(value.split(',')[1], 'base64'));
      written++;
    }
  });
  return written;
}

function parseArgs(argv) {
  const options = { bundle: null, ladder: null, sweep: null, extract: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ladder') options.ladder = argv[++i].split(',').map(Number);
    else if (arg === '--sweep') options.sweep = argv[++i].split(':').map(Number);
    else if (arg === '--extract') options.extract = argv[++i];
    else if (!options.bundle) options.bundle = arg;
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

if (!options.bundle) {
  console.error('usage: node scripts/scan-replay.mjs <bundle.json> [--ladder a,b,c] [--sweep lo:hi] [--extract dir]');
  process.exit(1);
}

const bundle = JSON.parse(fs.readFileSync(options.bundle, 'utf8'));
if (bundle.format !== 'deck-lotus-scan-diagnostics') {
  console.error(`not a scan diagnostics bundle: ${options.bundle}`);
  process.exit(1);
}

if (options.extract) {
  console.log(`extracted ${extract(bundle, options.extract)} images to ${options.extract}`);
}

// The index joins the packed file to `printings`, so it throws outright against
// a database that has never been imported and loads zero rows against an empty
// one. Both mean the same thing to whoever ran this, and neither should arrive
// as a stack trace or, worse, as every capture quietly reporting a miss.
let stats;
try {
  index.load({ quiet: true });
  stats = index.stats();
} catch (error) {
  stats = { joined: 0, error: error.message };
}

if (!stats.joined) {
  console.error(
    'The hash index loaded no references.\n\n' +
    'It joins data/card-hashes.bin to the `printings` table, so DATABASE_PATH has\n' +
    'to point at a database that has had an MTGJSON import run against it:\n\n' +
    '  DATABASE_PATH=data/deck-lotus-test.db node scripts/scan-replay.mjs ...\n' +
    (stats.error ? `\n(${stats.error})\n` : '')
  );
  process.exit(1);
}

const env = bundle.environment || {};
console.log(`bundle    ${path.basename(options.bundle)}`);
console.log(`recorded  ${env.recordedAt}  (${bundle.captures.length} captures)`);
console.log(`reader    ${env.reader ? JSON.stringify(env.reader) : '(not recorded — bundle predates it)'}`);
console.log(`index     ${stats.joined} references\n`);

// The ladder the session itself used, unless one is given to compare against.
const recordedLadder = bundle.captures.find((c) => c.probeScales)?.probeScales || [1];
const ladder = options.ladder || recordedLadder;

if (options.sweep) {
  // One scale at a time, to find where the basin actually is.
  const [lo, hi] = options.sweep;
  console.log(`scale sweep ${lo} to ${hi}, matches per scale\n`);
  const frames = bundle.captures.map(frameOf);
  for (let s = lo; s <= hi + 1e-9; s += 0.02) {
    const scale = +s.toFixed(2);
    const cells = frames.map((frame, i) => {
      if (!frame) return '   -  ';
      const probe = probeAt(frame, bundle.captures[i].quad, scale);
      const match = index.findByArtHash(probe.artHash, probe.frameHash)[0];
      return String(match ? match.artDistance : '-').padStart(6);
    });
    const hits = cells.filter((c) => c.trim() !== '-').length;
    console.log(`${scale.toFixed(2)} ${cells.join('')}   ${hits}/${frames.length}`);
  }
  process.exit(0);
}

console.log(`replaying with ladder [${ladder.join(', ')}]`);
console.log(`(the session recorded [${recordedLadder.join(', ')}])\n`);

let matched = 0;
let confident = 0;
let changed = 0;

for (const [i, capture] of bundle.captures.entries()) {
  const frame = frameOf(capture);
  const wasTop = capture.resolution?.candidates?.[0];
  const wasLabel = wasTop
    ? `${wasTop.name} art=${wasTop.artDistance}`
    : `miss (nearest ${capture.resolution?.signals?.nearest?.artDistance ?? '-'})`;

  if (!frame) {
    console.log(`cap${String(i).padEnd(2)} no frame recorded — was: ${wasLabel}`);
    continue;
  }

  const probes = ladder.map((scale) => probeAt(frame, capture.quad, scale));
  const result = resolveScanFused({
    artHashes: probes.map((p) => p.artHash),
    frameHashes: probes.map((p) => p.frameHash),
    limit: 3,
  });

  const top = result.candidates[0];
  if (top) matched++;
  if (result.tier === 'confident') confident++;

  const nowLabel = top
    ? `${top.name} [${top.setCode} ${top.collectorNumber}] art=${top.artDistance} ${result.tier}`
    : `miss (nearest ${result.signals?.nearest?.artDistance ?? '-'})`;

  const differs = (top?.name || null) !== (wasTop?.name || null);
  if (differs) changed++;

  console.log(
    `cap${String(i).padEnd(2)} ${differs ? '*' : ' '} ${nowLabel}` +
    (differs ? `\n        was: ${wasLabel}` : '')
  );
}

console.log(
  `\n${matched}/${bundle.captures.length} matched, ${confident} confident` +
  (changed ? `, ${changed} differ from what the session recorded (marked *)` : '')
);
