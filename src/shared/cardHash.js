/**
 * Perceptual hashes of a rectified card.
 *
 * This is the second, independent opinion about what a scanned card is. OCR
 * reads the collector block and answers *which printing*, exactly, when it can
 * read it at all; a perceptual hash compares the picture and answers *which
 * card*, tolerantly, even through glare and blur — and works on pre-2015 cards,
 * which carry no printed set code for OCR to find. The two fail in uncorrelated
 * ways, which is the entire reason for having both.
 *
 * Two hashes, because they disambiguate different things:
 *
 * - `artHash` covers the illustration window. Art is shared across reprints, so
 *   this is deliberately the *low* precision one: it matches every printing of
 *   the same card, which is exactly the shortlist the OCR then picks from.
 * - `frameHash` covers the whole card, so it also sees the border, the frame
 *   treatment and the set symbol. That is what separates two printings sharing
 *   one illustration — the failure tmikonen's write-up calls out as the hard
 *   ceiling on hashing alone.
 *
 * ── The load-bearing constraint ──────────────────────────────────────────────
 * This module is imported by BOTH the browser (hashing a phone capture) and the
 * server — `cardHashIndex.js` at runtime, `scripts/build-card-hashes.mjs` when
 * building the reference. It must stay that way. A reference hash and a capture
 * hash are only comparable if the exact same arithmetic produced them, down to
 * the rounding; a second "equivalent" implementation on one side would drift and
 * nothing would match, with no error to point at. So: no DOM, no Node built-ins,
 * no imports at all. Input is the ImageData *shape* (`{ data, width, height }`,
 * RGBA), which a canvas gives for free and which Node can fabricate from a
 * decoded JPEG.
 *
 * ── Why it lives in src/shared and not in the client ─────────────────────────
 * It started in `client/src/utils/`, beside the capture code that was its first
 * caller, and that broke the container on the first deploy: the runtime image
 * copies `src`, `scripts` and the *built* `client/dist`, never `client/src`, so
 * the server's import resolved to nothing and the app would not boot. Local
 * tests and a dev server could not have caught it — the file is right there on
 * a developer's disk.
 *
 * The direction is the real point, though. The browser resolves this at build
 * time, when the whole repo is present, so the client may reach into the server
 * tree; the server resolves it at runtime inside an image that deliberately does
 * not ship client sources, so it must never reach the other way. Shared code
 * between the two belongs on the server's side of that line.
 *
 * Both sides must also feed in the same thing: a full card rectified to its own
 * borders. The browser gets that from `warpQuad` in cardCapture.js; the script
 * gets it from Scryfall, whose card images are already exactly that (488x680,
 * aspect 0.7176 against the card's 63/88 = 0.7159 — under a pixel of skew at
 * these sizes, and irrelevant once averaged into a 32x32 grid).
 */

/** Side of the grid the DCT runs on. */
const GRID = 32;

/**
 * Side of the retained low-frequency block, per hash. The two are different
 * widths because they are asked to do different jobs, and the widths were
 * measured rather than picked.
 *
 * Against real Scryfall art — a known same-illustration pair (Lightning Bolt in
 * 2X2 and M10) against the closest of 30 distinct cards from DMU/WAR/NEO:
 *
 *    63 bits (8x8) : same art  9.5%,  closest different 28.6%  → 19.0pp margin
 *   143 bits (12x12): same art  8.4%,  closest different 35.0%  → 26.6pp margin
 *   255 bits (16x16): same art 12.5%,  closest different 39.2%  → 26.7pp margin
 *
 * The art hash takes 16x16. Doubling the margin costs 24 bytes a row and buys
 * the headroom a real photograph spends on glare, white balance and a hand-held
 * angle — none of which is in the numbers above, because both sides there were
 * clean scans. 12x12 measures the same but does not land on a word boundary.
 *
 * The frame hash stays at 8x8. It is a weak signal by nature — at this scale
 * every card is "dark border, art blob, text block", and two *different* cards
 * measured only 16-18 bits apart — so it is never a primary match, only a
 * tiebreaker between printings the art hash has already shortlisted. 63 bits is
 * ample for ordering a handful of candidates, and widening it would imply a
 * confidence it does not have.
 */
const ART_BLOCK = 16;
const FRAME_BLOCK = 8;

/**
 * The illustration window, as fractions of the card.
 *
 * Cut generously rather than tightly to the modern frame. The window does not
 * need to be *the* art box — it needs to be the same region on a capture as on
 * the reference, and to be dominated by illustration rather than by border. A
 * tight box would be right for one frame generation and wrong for the six
 * others; a generous one includes a sliver of frame on every card and costs
 * nothing, because that sliver is present on both sides of the comparison.
 */
export const ART_WINDOW = { x: 0.08, y: 0.11, w: 0.84, h: 0.44 };

/**
 * Cosine table for the 32-point DCT-II. Built once: the browser hashes a card
 * per capture and the puller hashes 110k of them, so neither wants this in the
 * inner loop.
 */
const COS = (() => {
  const table = new Float64Array(GRID * GRID);
  for (let u = 0; u < GRID; u++) {
    for (let x = 0; x < GRID; x++) {
      table[u * GRID + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * GRID));
    }
  }
  return table;
})();

/**
 * Area-average an RGBA region down to a GRID x GRID grayscale grid.
 *
 * Averaging over the whole source box, rather than sampling points from it, is
 * what makes the hash survive a soft webcam frame: a blurred card and a sharp
 * one average to nearly the same grid, while point sampling would chase the
 * noise. It also makes the result independent of the source resolution, so a
 * 12MP phone capture and a 488px Scryfall thumbnail land on comparable grids.
 */
function downsampleToGrid(image, window) {
  const { data, width, height } = image;

  const x0 = Math.max(0, Math.floor(window.x * width));
  const y0 = Math.max(0, Math.floor(window.y * height));
  const x1 = Math.min(width, Math.ceil((window.x + window.w) * width));
  const y1 = Math.min(height, Math.ceil((window.y + window.h) * height));

  const boxWidth = Math.max(1, x1 - x0);
  const boxHeight = Math.max(1, y1 - y0);

  const grid = new Float64Array(GRID * GRID);

  for (let gy = 0; gy < GRID; gy++) {
    // Cell bounds in source pixels. Rounded outward by at least one pixel so a
    // source smaller than the grid still contributes to every cell instead of
    // leaving holes.
    const sy0 = y0 + Math.floor((gy * boxHeight) / GRID);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((gy + 1) * boxHeight) / GRID));

    for (let gx = 0; gx < GRID; gx++) {
      const sx0 = x0 + Math.floor((gx * boxWidth) / GRID);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((gx + 1) * boxWidth) / GRID));

      let sum = 0;
      let count = 0;

      for (let sy = sy0; sy < sy1 && sy < height; sy++) {
        let p = (sy * width + sx0) * 4;
        for (let sx = sx0; sx < sx1 && sx < width; sx++, p += 4) {
          // Rec. 601 luma, matching toGrayscale in cardCapture.js.
          sum += data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114;
          count++;
        }
      }

      grid[gy * GRID + gx] = count ? sum / count : 0;
    }
  }

  return grid;
}

/** Separable 2-D DCT-II. Rows then columns; only the scale is dropped, as the
 * hash compares coefficients against each other and never against a constant. */
function dct2d(grid) {
  const rows = new Float64Array(GRID * GRID);

  for (let y = 0; y < GRID; y++) {
    for (let u = 0; u < GRID; u++) {
      let sum = 0;
      for (let x = 0; x < GRID; x++) {
        sum += grid[y * GRID + x] * COS[u * GRID + x];
      }
      rows[y * GRID + u] = sum;
    }
  }

  const out = new Float64Array(GRID * GRID);

  for (let u = 0; u < GRID; u++) {
    for (let v = 0; v < GRID; v++) {
      let sum = 0;
      for (let y = 0; y < GRID; y++) {
        sum += rows[y * GRID + u] * COS[v * GRID + y];
      }
      out[v * GRID + u] = sum;
    }
  }

  return out;
}

/**
 * Sign the low-frequency block against its own median.
 *
 * The DC term is excluded because it is just the mean brightness of the region,
 * which is the one thing a desk lamp changes wholesale — including it would make
 * the hash a light meter. Against the *median* rather than the mean, so a single
 * blown-out highlight cannot drag the threshold past half the other coefficients.
 */
function signBlock(coefficients, block) {
  const values = [];
  for (let v = 0; v < block; v++) {
    for (let u = 0; u < block; u++) {
      if (u === 0 && v === 0) continue;
      values.push(coefficients[v * GRID + u]);
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  // One bit per coefficient, then a single trailing zero so the result lands on
  // a whole number of bytes: 63 -> 64 bits, 255 -> 256 bits.
  let bits = 0n;
  for (const value of values) {
    bits = (bits << 1n) | (value > median ? 1n : 0n);
  }
  return bits << 1n;
}

/** Hex width, in characters, of a hash from a block of this side. */
function hexWidth(block) {
  return (block * block) / 4;
}

/** A hash as lowercase hex — the wire and storage form. 16 chars for the frame
 * hash, 64 for the art hash. */
export function toHex(bits, width = 16) {
  return bits.toString(16).padStart(width, '0');
}

/** Inverse of toHex. Tolerates the `0x` form and rejects anything else. */
export function fromHex(hex) {
  if (typeof hex !== 'string' || !/^(0x)?[0-9a-f]{1,64}$/i.test(hex)) {
    throw new Error(`Not a hash: ${hex}`);
  }
  return BigInt(hex.startsWith('0x') || hex.startsWith('0X') ? hex : `0x${hex}`);
}

/** ART_HASH_HEX / FRAME_HASH_HEX: the exact hex widths the two hashes produce.
 * Anything reading the packed file or the database column checks against these
 * rather than assuming, since the two are deliberately different sizes. */
export const ART_HASH_HEX = hexWidth(ART_BLOCK);
export const FRAME_HASH_HEX = hexWidth(FRAME_BLOCK);
export const ART_HASH_BYTES = ART_HASH_HEX / 2;
export const FRAME_HASH_BYTES = FRAME_HASH_HEX / 2;

/**
 * Bits differing between two hashes. The whole comparison budget for a scan:
 * ~110k of these per capture, so it stays a popcount and nothing more.
 *
 * Counted 16 bits at a time through a nibble table. BigInt is the honest type
 * for a 64-bit value in JS, but it is slow enough that the naive
 * shift-once-per-bit loop shows up across 110k rows; converting to two 32-bit
 * halves once and counting those keeps a full-database search in single-digit
 * milliseconds.
 */
const NIBBLE_BITS = Uint8Array.from({ length: 16 }, (_, i) =>
  (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1)
);

export function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x) {
    count += NIBBLE_BITS[Number(x & 0xfn)];
    x >>= 4n;
  }
  return count;
}

/**
 * Hash one rectified card.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 *        A full card, rectified to its own borders, RGBA.
 * @returns {{artHash: string, frameHash: string}} 16-hex-character hashes.
 */
export function hashRectified(image) {
  if (!image || !image.data || !image.width || !image.height) {
    throw new Error('hashRectified needs an ImageData-shaped { data, width, height }');
  }

  const whole = { x: 0, y: 0, w: 1, h: 1 };

  return {
    artHash: toHex(signBlock(dct2d(downsampleToGrid(image, ART_WINDOW)), ART_BLOCK), ART_HASH_HEX),
    frameHash: toHex(signBlock(dct2d(downsampleToGrid(image, whole)), FRAME_BLOCK), FRAME_HASH_HEX),
  };
}

/**
 * Unpack a hex hash into 32-bit words, most significant first.
 *
 * The matcher compares one capture against every row in the database. Doing
 * that in BigInt allocates a new arbitrary-precision value per row and per
 * shift, which is what turns a few milliseconds into a few hundred; unpacked
 * into plain 32-bit words once, the same search is integer work in a flat
 * typed array. See hammingWords.
 */
export function hexToWords(hex, target = null, offset = 0) {
  const words = target || new Uint32Array(hex.length / 8);
  for (let i = 0; i < hex.length / 8; i++) {
    words[offset + i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  }
  return words;
}

/** Bits set in a 32-bit word — the standard SWAR popcount, no table, no branch. */
function popcount32(value) {
  let x = value - ((value >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/**
 * Hamming distance between two hashes held as 32-bit words.
 *
 * `length` words starting at `aOffset` in `a` against `bOffset` in `b`, so the
 * database side can be one flat Uint32Array of every row rather than 112k
 * separate arrays.
 */
export function hammingWords(a, aOffset, b, bOffset, length) {
  let count = 0;
  for (let i = 0; i < length; i++) {
    count += popcount32(a[aOffset + i] ^ b[bOffset + i]);
  }
  return count;
}
