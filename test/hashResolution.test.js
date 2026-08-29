/**
 * Hashing a capture at a fixed size rather than at the camera's.
 *
 * A 4K frame rectifies to a card some two thousand pixels tall, and a capture
 * warps it six times — once for the card, five more for the framing ladder —
 * before hashRectified averages every one of them down to a 32x32 grid. So the
 * pixels beyond the grid's reach buy nothing and cost a great deal.
 *
 * Measuring it turned up something the speed argument did not predict. The
 * disagreement between a card hashed at 2100px and the same pixels hashed at
 * 680 is not a resolution ramp — it is flat: 12 bits at 2100, 12 at 1800, 10 at
 * 1400, 10 at 900, 0 at 680. That is not lost detail. It is downsampleToGrid's
 * cell boundaries falling on different source pixels at different sizes, and it
 * means the penalty was never about how good the camera was.
 *
 * Which turns this from a speed change into an accuracy one as well. Every
 * reference in the index was hashed at 680; a capture hashed at the camera's
 * own size therefore paid ten-odd bits of a 69-bit budget for nothing, and
 * hashing at the reference size pays none of it.
 *
 * These tests pin both halves: the size is the reference size, and no camera
 * resolution moves the hash further than the bound measured here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRectified, fromHex, hammingDistance } from '../src/shared/cardHash.js';
import { hashSize, HASH_HEIGHT, CARD_ASPECT } from '../src/shared/cardGeometry.js';

/**
 * A card-ish image at a given height: a dark frame, a bright art box with a
 * gradient and a few shapes in it, and a text block below. Rendered from
 * fractional coordinates, so the same picture comes out at any resolution —
 * which is what makes the two hashes comparable at all.
 */
function syntheticCard(height) {
  const width = Math.round(height * CARD_ASPECT);
  const data = new Uint8ClampedArray(width * height * 4);

  const put = (x, y, r, g, b) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;

      // Border.
      let r = 26;
      let g = 24;
      let b = 22;

      // Art box, roughly where ART_WINDOW looks.
      if (u > 0.07 && u < 0.93 && v > 0.1 && v < 0.56) {
        const across = (u - 0.07) / 0.86;
        const down = (v - 0.1) / 0.46;
        r = 40 + across * 180;
        g = 90 + down * 120;
        b = 150 - across * 90;

        // Something with edges in it, so the DCT has more than a ramp to bite
        // on — a flat gradient would agree at any resolution trivially.
        const ring = Math.hypot(across - 0.45, down - 0.5);
        if (ring > 0.18 && ring < 0.24) {
          r = 250;
          g = 245;
          b = 210;
        }
        if (across > 0.6 && across < 0.72 && down > 0.2 && down < 0.8) {
          r = 20;
          g = 30;
          b = 40;
        }
      }

      // Text block.
      if (u > 0.08 && u < 0.92 && v > 0.62 && v < 0.9) {
        const line = Math.floor(((v - 0.62) / 0.28) * 9);
        const ink = line % 2 === 0 && u < 0.86;
        r = ink ? 30 : 205;
        g = ink ? 28 : 198;
        b = ink ? 26 : 180;
      }

      put(x, y, r, g, b);
    }
  }

  return { data, width, height };
}

test('the hash size is the size the references were built at', () => {
  // build-card-hashes.mjs pulls Scryfall `normal`, which is 488x680. Drifting
  // off it is the one change here that would silently cost accuracy.
  assert.equal(HASH_HEIGHT, 680);
  const size = hashSize();
  assert.equal(size.height, 680);
  assert.ok(Math.abs(size.width - 488) <= 2, `expected ~488 wide, got ${size.width}`);
});


/**
 * Area-average an image down to a given height — a box filter, which is what
 * both a lens and a downscaling warp do to detail too fine to carry.
 *
 * The two sizes have to come from the *same* pixels for the comparison to mean
 * anything. Rendering the card twice instead would compare two samplings of
 * hard synthetic edges, and measure aliasing that a photograph of a real card
 * does not have.
 */
function downscale(image, height) {
  const width = Math.round(height * CARD_ASPECT);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * image.height) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * image.height) / height));

    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * image.width) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * image.width) / width));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
          n++;
        }
      }

      const i = (y * width + x) * 4;
      data[i] = r / n;
      data[i + 1] = g / n;
      data[i + 2] = b / n;
      data[i + 3] = 255;
    }
  }

  return { data, width, height };
}

/** Bits between two hashes of the same picture at two sizes. */
function drift(a, b) {
  return hammingDistance(fromHex(a.artHash), fromHex(b.artHash));
}

test('hashing at the camera’s own size costs bits the fixed size does not', () => {
  const shot = syntheticCard(2100);
  const native = hashRectified(shot);
  const fixed = hashRectified(downscale(shot, HASH_HEIGHT));

  // The same picture, hashed at the size the references were built at and at a
  // phone's. Measured at 12 bits of 256 — small against a 69-bit match
  // threshold, but a quarter of the way to the 41-bit strong threshold that
  // decides whether a card needs review. This is the toll the change removes.
  const art = drift(native, fixed);
  assert.ok(art > 0, 'a native-size hash used to differ; if it no longer does, this is moot');
  assert.ok(art <= 16, `resolution now moves the art hash ${art} bits, was 12`);

  // The frame hash averages the whole card rather than a window, so its cells
  // are big enough that boundaries land in the same place either way.
  assert.equal(
    hammingDistance(fromHex(native.frameHash), fromHex(fixed.frameHash)),
    0
  );
});

test('no camera resolution moves the hash further than that', () => {
  const shot = syntheticCard(2100);
  const fixed = hashRectified(downscale(shot, HASH_HEIGHT));

  // Flat rather than sloped, which is the point: this is grid quantisation, not
  // detail. A resolution that suddenly cost far more would mean the downsampler
  // had started behaving differently at some size.
  for (const height of [1800, 1400, 900]) {
    const art = drift(fixed, hashRectified(downscale(shot, height)));
    assert.ok(art <= 16, `art hash moved ${art} bits at ${height}px`);
  }
});

test('going below the reference size is the direction that costs', () => {
  // Not a rule the code enforces — a guard on the reasoning behind 680. Scryfall
  // `small` is 204 tall, which leaves the art window under four pixels per grid
  // cell, and the hash builder measured 15.9 bits mean against `normal` for that
  // reason. If a thumbnail ever stops drifting, the case for 680 rather than
  // something cheaper is worth reopening.
  const shot = syntheticCard(2100);
  const fixed = hashRectified(downscale(shot, HASH_HEIGHT));
  const tiny = hashRectified(downscale(shot, 204));

  assert.ok(drift(fixed, tiny) > 12, 'a thumbnail-sized hash should drift further');
  assert.ok(
    hammingDistance(fromHex(fixed.frameHash), fromHex(tiny.frameHash)) > 0,
    'and should move the frame hash too, where the fixed size does not'
  );
});
