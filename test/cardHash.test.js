/**
 * The hash has to be tolerant and discriminating at the same time, and those
 * two pull against each other: a hash loose enough to survive a soft webcam
 * frame is a hash that starts calling different cards the same. These tests pin
 * both ends against synthetic images, so a change to the grid size, the window
 * or the median rule cannot quietly trade one for the other.
 *
 * Synthetic, deliberately — real Scryfall art is checked in the puller's own
 * verification, but that needs the network. This runs anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashRectified,
  hammingDistance,
  fromHex,
  toHex,
  hexToWords,
  hammingWords,
  ART_WINDOW,
  downsampleToGrid,
  ART_HASH_HEX,
  FRAME_HASH_HEX,
} from '../src/shared/cardHash.js';

/** Deterministic noise, so a failure is reproducible rather than a coin flip. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * A stand-in for a card: broad coloured regions with structure at several
 * scales, which is what the low-frequency block actually keys on.
 */
function syntheticCard(seed, width = 244, height = 340) {
  const random = seededRandom(seed);
  const data = new Uint8ClampedArray(width * height * 4);

  // A handful of soft blobs at random places, plus a border, plus fine grain.
  const blobs = Array.from({ length: 6 }, () => ({
    cx: random() * width,
    cy: random() * height,
    r: 20 + random() * 80,
    tone: random() * 255,
  }));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      let value = border ? 20 : 128;

      for (const blob of blobs) {
        const dx = x - blob.cx;
        const dy = y - blob.cy;
        const falloff = Math.exp(-(dx * dx + dy * dy) / (2 * blob.r * blob.r));
        value += (blob.tone - 128) * falloff;
      }

      value += (random() - 0.5) * 6;

      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value;
      data[p + 3] = 255;
    }
  }

  return { data, width, height };
}

/** A 3x3 box blur — the cheapest honest stand-in for a soft focus pull. */
function blur(image, passes = 2) {
  let { data, width, height } = image;

  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint8ClampedArray(data.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = x + dx;
            const sy = y + dy;
            if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
            sum += data[(sy * width + sx) * 4];
            count++;
          }
        }
        const p = (y * width + x) * 4;
        out[p] = out[p + 1] = out[p + 2] = sum / count;
        out[p + 3] = 255;
      }
    }
    data = out;
  }

  return { data, width, height };
}

/** Uniform brightness change, standing in for a differently lit desk. */
function relight(image, gain, offset) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let p = 0; p < data.length; p += 4) {
    const value = image.data[p] * gain + offset;
    data[p] = data[p + 1] = data[p + 2] = value;
    data[p + 3] = 255;
  }
  return { data, width: image.width, height: image.height };
}

/** Nearest-neighbour rescale, standing in for a different capture resolution. */
function rescale(image, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const s = (sy * image.width + sx) * 4;
      const p = (y * width + x) * 4;
      data[p] = image.data[s];
      data[p + 1] = image.data[s + 1];
      data[p + 2] = image.data[s + 2];
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/**
 * Distance as a *fraction* of the hash width, because the two hashes are
 * deliberately different sizes: 255 bits for art, 63 for the frame. Asserting
 * raw bit counts would silently mean two different things depending on which
 * hash was passed in, and would have to be retuned every time a width moved.
 *
 * The bars below come from the measurement in cardHash.js: a same-illustration
 * pair sat at 12.5% and the closest pair of distinct cards at 39.2%.
 */
const distance = (a, b) => hammingDistance(fromHex(a), fromHex(b)) / (a.length * 4);
const pct = (a, b) => `${(distance(a, b) * 100).toFixed(1)}%`;

test('hex round-trips, including hashes with a leading zero byte', () => {
  for (const value of [0n, 1n, 0x00ff00ff00ff00ffn, (1n << 63n) | 1n]) {
    assert.equal(fromHex(toHex(value)), value);
    assert.equal(toHex(value).length, 16);
  }
  // A leading zero byte is the case that catches a missing pad: the hash is
  // fixed-width on the wire and in the packed file, and a short one shifts
  // every field after it.
  assert.equal(toHex(1n, ART_HASH_HEX).length, ART_HASH_HEX);
  assert.throws(() => fromHex('nonsense'));
  assert.throws(() => fromHex(''));
});

test('hamming distance counts differing bits', () => {
  assert.equal(hammingDistance(0n, 0n), 0);
  assert.equal(hammingDistance(0b1011n, 0b0001n), 2);
  assert.equal(hammingDistance(0n, (1n << 64n) - 1n), 64);
});

test('the same card hashes identically, at the declared widths', () => {
  const a = hashRectified(syntheticCard(1));
  const b = hashRectified(syntheticCard(1));
  assert.equal(a.artHash, b.artHash);
  assert.equal(a.frameHash, b.frameHash);
  assert.equal(a.artHash.length, ART_HASH_HEX);
  assert.equal(a.frameHash.length, FRAME_HASH_HEX);
});

test('a canvas is rejected rather than hashed as nothing', () => {
  // The shape that shipped broken: warpQuad in the browser returns a canvas,
  // which carries width and height but no pixel `data`, and the scan page
  // handed it straight to hashRectified. Every capture threw, the throw was
  // swallowed into a hashError nothing rendered, and the scanner quietly ran
  // OCR-only. Rejecting loudly is the contract; the client converts first.
  const canvasLike = { width: 488, height: 680, getContext: () => null };
  assert.throws(() => hashRectified(canvasLike), /ImageData-shaped/);
});

test('word unpacking agrees with the BigInt comparison', () => {
  // The matcher compares in 32-bit words for speed while everything else talks
  // hex; if these two ever disagree the search silently ranks by nonsense.
  const a = hashRectified(syntheticCard(5));
  const b = hashRectified(syntheticCard(6));

  const aWords = hexToWords(a.artHash);
  const bWords = hexToWords(b.artHash);

  assert.equal(
    hammingWords(aWords, 0, bWords, 0, aWords.length),
    hammingDistance(fromHex(a.artHash), fromHex(b.artHash))
  );
});

test('a blurred capture stays close to its sharp reference', () => {
  const sharp = hashRectified(syntheticCard(7));
  const soft = hashRectified(blur(syntheticCard(7), 3));

  // The bar is what a match threshold can safely sit above, not zero — a soft
  // frame is expected to move a few of the weaker coefficients.
  assert.ok(distance(sharp.artHash, soft.artHash) <= 0.12,
    `art moved ${pct(sharp.artHash, soft.artHash)} under blur`);
  assert.ok(distance(sharp.frameHash, soft.frameHash) <= 0.12,
    `frame moved ${pct(sharp.frameHash, soft.frameHash)} under blur`);
});

test('lighting changes do not move the hash', () => {
  const even = hashRectified(syntheticCard(3));
  const lit = hashRectified(relight(syntheticCard(3), 0.75, 40));

  // This is the DC term being excluded, doing its job. A hash that included it
  // would be a light meter and this would fail loudly.
  assert.ok(distance(even.artHash, lit.artHash) <= 0.10,
    `art moved ${pct(even.artHash, lit.artHash)} under relighting`);
});

test('capture resolution does not move the hash', () => {
  const reference = hashRectified(syntheticCard(11, 244, 340));
  const bigCapture = hashRectified(rescale(syntheticCard(11, 244, 340), 976, 1360));

  // The phone shoots at several times Scryfall's thumbnail size; if this drifts,
  // every reference hash in the database is comparing against nothing.
  assert.ok(distance(reference.artHash, bigCapture.artHash) <= 0.10,
    `art moved ${pct(reference.artHash, bigCapture.artHash)} under rescale`);
  assert.ok(distance(reference.frameHash, bigCapture.frameHash) <= 0.10,
    `frame moved ${pct(reference.frameHash, bigCapture.frameHash)} under rescale`);
});

test('different cards are far apart', () => {
  const hashes = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => hashRectified(syntheticCard(seed)));

  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const art = distance(hashes[i].artHash, hashes[j].artHash);
      const frame = distance(hashes[i].frameHash, hashes[j].frameHash);
      // Well clear of the blur and rescale tolerances above; the gap between
      // these two numbers is the whole margin the matcher has to work in.
      assert.ok(art >= 0.25, `cards ${i} and ${j} only ${pct(hashes[i].artHash, hashes[j].artHash)} apart on art`);
      assert.ok(frame >= 0.25, `cards ${i} and ${j} only ${pct(hashes[i].frameHash, hashes[j].frameHash)} apart on frame`);
    }
  }
});

test('the art window ignores the card border, the frame window does not', () => {
  // Two cards sharing one illustration but printed in different borders is the
  // exact case the two-hash split exists for: art must agree, frame must not.
  const card = syntheticCard(21);
  const reborder = { ...card, data: new Uint8ClampedArray(card.data) };

  const borderWidth = Math.floor(card.width * 0.06);
  for (let y = 0; y < card.height; y++) {
    for (let x = 0; x < card.width; x++) {
      const inBorder =
        x < borderWidth || y < borderWidth ||
        x >= card.width - borderWidth || y >= card.height - borderWidth;
      if (!inBorder) continue;
      const p = (y * card.width + x) * 4;
      reborder.data[p] = reborder.data[p + 1] = reborder.data[p + 2] = 235;
    }
  }

  const a = hashRectified(card);
  const b = hashRectified(reborder);

  assert.ok(distance(a.artHash, b.artHash) <= 0.10,
    `art window is seeing the border: moved ${pct(a.artHash, b.artHash)}`);
  assert.ok(distance(a.frameHash, b.frameHash) >= 0.15,
    `frame window is blind to the border: moved only ${pct(a.frameHash, b.frameHash)}`);
});

test('the art window stays inside the card', () => {
  assert.ok(ART_WINDOW.x > 0 && ART_WINDOW.y > 0);
  assert.ok(ART_WINDOW.x + ART_WINDOW.w <= 1);
  assert.ok(ART_WINDOW.y + ART_WINDOW.h <= 1);
});

/**
 * Excluding blown pixels from a cell's average — the sleeve-glare proposal in
 * task 9 of the pipeline plan.
 *
 * Measured and not shipped: across fourteen recorded sessions it matched 93 of
 * 126 captures either way, because the shutter's glare gate means a capture
 * with blown pixels is never taken in the first place. The option stays because
 * it is what lets scripts/hash-variants.mjs measure the real pipeline rather
 * than a copy of it — and because the *next* person to propose this deserves
 * the measurement rather than the idea.
 *
 * What has to hold for it to stay harmless is that it is off by default and
 * that off means byte-identical: every one of the 112,815 references was built
 * through this function, and a change that quietly moved the default would
 * invalidate all of them without a version bump to say so.
 */
test('the glare cut is off by default, and off is byte-identical', () => {
  const card = syntheticCard(11);

  const asShipped = downsampleToGrid(card, ART_WINDOW);
  const spelledOut = downsampleToGrid(card, ART_WINDOW, { glareCut: null });

  assert.deepEqual(Array.from(asShipped), Array.from(spelledOut));
});

test('the glare cut ignores blown pixels, and a wholly blown cell still reads bright', () => {
  const card = syntheticCard(12);
  const blown = { ...card, data: new Uint8ClampedArray(card.data) };

  // A stripe of pure white across the art window, as a specular highlight is:
  // strictly brighter than the print under it.
  const y0 = Math.floor(card.height * 0.2);
  for (let y = y0; y < y0 + 12; y++) {
    for (let x = 0; x < card.width; x++) {
      const p = (y * card.width + x) * 4;
      blown.data[p] = 255;
      blown.data[p + 1] = 255;
      blown.data[p + 2] = 255;
    }
  }

  const clean = downsampleToGrid(card, ART_WINDOW);
  const withGlare = downsampleToGrid(blown, ART_WINDOW);
  const cut = downsampleToGrid(blown, ART_WINDOW, { glareCut: 250 });

  const drift = (a, b) =>
    a.reduce((sum, value, i) => sum + Math.abs(value - b[i]), 0) / a.length;

  assert.ok(
    drift(cut, clean) < drift(withGlare, clean),
    'excluding the blown pixels has to land nearer the unglared grid than including them'
  );

  // A cell with nothing left after the cut falls back to the plain average
  // rather than reading as black. A card can legitimately be white, and the
  // fallback is what stops that being hashed as its opposite.
  const white = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
  const grid = downsampleToGrid(white, ART_WINDOW, { glareCut: 250 });
  assert.ok(grid.every((value) => value > 250), 'a wholly blown cell must not read as black');
});
