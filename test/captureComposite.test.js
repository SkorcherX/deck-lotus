/**
 * Compositing a capture from a burst of frames.
 *
 * The claim is narrow and worth pinning: three frames of a still card differ
 * only by noise, so their per-pixel median is closer to the card than any one
 * of them — and closer therefore to the reference the card is matched against.
 *
 * Synthetic, and it has to be said what that does and does not show. Gaussian
 * noise on a clean render is the easy half of what a sleeve does; the haze, the
 * texture of the plastic and the light it scatters are not modelled here at all.
 * What this pins is that the arithmetic moves in the direction claimed and that
 * a burst of one still behaves exactly like an ordinary capture. Whether it
 * earns its shutter lag on real cards is answered by `singleArtHash` in a
 * recorded bundle, not here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianComposite } from '../client/src/utils/cardCapture.js';
import { hashRectified, fromHex, hammingDistance } from '../src/shared/cardHash.js';
import { HASH_HEIGHT, CARD_ASPECT } from '../src/shared/cardGeometry.js';

const WIDTH = Math.round(HASH_HEIGHT * CARD_ASPECT);

/** A deterministic pseudo-random source, so a failure is reproducible. */
function noise(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** A card-ish image: art box over a border, with a couple of hard edges in it. */
function card(seed = 0, amplitude = 0) {
  const random = noise(seed || 1);
  const data = new Uint8ClampedArray(WIDTH * HASH_HEIGHT * 4);

  for (let y = 0; y < HASH_HEIGHT; y++) {
    const v = y / HASH_HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const u = x / WIDTH;

      let level = 30;
      if (u > 0.07 && u < 0.93 && v > 0.1 && v < 0.56) {
        level = 60 + ((u - 0.07) / 0.86) * 150;
        if (Math.hypot((u - 0.5) * 2, (v - 0.33) * 3) < 0.5) level = 220;
      } else if (u > 0.08 && u < 0.92 && v > 0.62 && v < 0.9) {
        level = Math.floor(v * 40) % 2 === 0 ? 40 : 190;
      }

      if (amplitude) level += (random() - 0.5) * amplitude;

      const i = (y * WIDTH + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
      data[i + 3] = 255;
    }
  }

  return { data, width: WIDTH, height: HASH_HEIGHT };
}

const artDistance = (a, b) =>
  hammingDistance(fromHex(hashRectified(a).artHash), fromHex(hashRectified(b).artHash));

test('a burst of one is the capture itself, untouched', () => {
  const single = card(1);
  assert.equal(medianComposite([single]), single);
});

test('two frames are not composited: an even median needs a mean', () => {
  // Deliberate. Averaging the middle pair is the smearing this avoids, so a
  // burst that came back short falls through to the frame it is sure of.
  const first = card(1);
  assert.equal(medianComposite([first, card(2)]), first);
});

test('the median of a noisy burst is closer to the card than one frame is', () => {
  const clean = card(0);
  const frames = [card(11, 90), card(22, 90), card(33, 90)];
  const composite = medianComposite(frames);

  const singles = frames.map((frame) => artDistance(clean, frame));
  const composited = artDistance(clean, composite);

  assert.ok(
    composited <= Math.min(...singles),
    `composite sat at ${composited} against single frames at ${singles.join(', ')}`
  );
});

test('a highlight in one frame of three does not survive the median', () => {
  const clean = card(0);
  const frames = [card(11, 20), card(22, 20), card(33, 20)];

  // A blown patch across the art of exactly one frame — a lamp catching a
  // sleeve as the hand moves, which is the case the minimum was proposed for.
  for (let y = 120; y < 300; y++) {
    for (let x = 80; x < 300; x++) {
      const i = (y * WIDTH + x) * 4;
      frames[1].data[i] = 255;
      frames[1].data[i + 1] = 255;
      frames[1].data[i + 2] = 255;
    }
  }

  const composite = medianComposite(frames);
  assert.ok(
    artDistance(clean, composite) < artDistance(clean, frames[1]),
    'the glared frame must not carry into the composite'
  );
});

test('frames that changed size mid-burst are refused, not blended', () => {
  const first = card(1);
  const odd = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
  assert.equal(medianComposite([first, odd, odd]), first);
});
