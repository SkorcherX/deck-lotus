/**
 * The geometry a card capture is built on: the card's own proportions, the map
 * from the unit square onto a marked quad, and the size a quad rectifies to.
 *
 * ── Why this is here and not beside the capture code ────────────────────────
 * It started in `client/src/utils/cardCapture.js`, next to the warp that is its
 * main caller, and belongs there by every measure except one: `scripts/` ships
 * in the runtime image and `client/src` does not.
 *
 * `scripts/scan-replay.mjs` replays a recorded scan against the current
 * matcher, and the whole point of that harness is that it runs the *same*
 * geometry the capture ran. Importing it from the client tree resolves fine on
 * a developer's disk and resolves to nothing in the container — the exact
 * failure `src/shared/cardHash.js` exists to have already learned, and which
 * `test/serverImports.test.js` now catches.
 *
 * So: no DOM, no Node built-ins, no imports. Pure arithmetic, callable from the
 * browser, the server and a script. `cardCapture.js` re-exports all three, so
 * nothing that used to import them from there had to change.
 */

// Magic card dimensions: 63mm x 88mm.
export const CARD_ASPECT = 63 / 88;

/**
 * Maps the unit square onto a quad — the standard square-to-quad projective
 * solution. Returns a sampler taking (u, v) in 0..1 across the rectified card
 * and giving back fractional frame coordinates.
 *
 * This direction is the useful one: the warp iterates over destination pixels
 * and asks where each came from, so no source pixel is ever left unwritten.
 */
export function projectiveMap(quad) {
  const [p0, p1, p2, p3] = quad;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;

  let a11, a21, a31, a12, a22, a32, a13, a23;

  if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
    // The quad is a parallelogram, so the mapping is affine and the projective
    // denominator degenerates.
    a11 = p1.x - p0.x;
    a21 = p2.x - p1.x;
    a31 = p0.x;
    a12 = p1.y - p0.y;
    a22 = p2.y - p1.y;
    a32 = p0.y;
    a13 = 0;
    a23 = 0;
  } else {
    const den = dx1 * dy2 - dx2 * dy1;
    a13 = (sx * dy2 - dx2 * sy) / den;
    a23 = (dx1 * sy - sx * dy1) / den;
    a11 = p1.x - p0.x + a13 * p1.x;
    a21 = p3.x - p0.x + a23 * p3.x;
    a31 = p0.x;
    a12 = p1.y - p0.y + a13 * p1.y;
    a22 = p3.y - p0.y + a23 * p3.y;
    a32 = p0.y;
  }

  return (u, v) => {
    const denom = a13 * u + a23 * v + 1;
    return [
      (a11 * u + a21 * v + a31) / denom,
      (a12 * u + a22 * v + a32) / denom,
    ];
  };
}

/**
 * Output size for a rectified capture: tall enough to keep the pixels the
 * camera actually resolved along the card's longest edge, so the warp neither
 * throws detail away nor invents it.
 */
/**
 * Height, in pixels, that a card is rectified to *for hashing*.
 *
 * 680 is not a round number chosen for tidiness — it is the height every
 * reference in `data/card-hashes.bin` was hashed at. `build-card-hashes.mjs`
 * pulls Scryfall's `normal` image, 488x680, and the whole index is that size.
 * Hashing a capture at the same height compares like with like.
 *
 * It also costs nothing to give up the rest. The art hash averages its window
 * down to a 32x32 grid, so beyond a few pixels per cell more resolution changes
 * the answer by almost nothing and the warp by a great deal: the builder
 * measured `normal` against `large` at a mean of 3.9 bits of 256, against a
 * match threshold of 69 — while a phone frame is tens of megabytes and every
 * probe warps it again. Going *below* the reference size is the direction that
 * hurts: `small` (146x204) leaves the art window at 123x90, under four pixels
 * per grid cell, and costs 15.9 bits.
 *
 * And the size is not merely sufficient, it is the right one. Measured on the
 * same pixels hashed at several sizes, the art hash sits 10-12 bits of 256 away
 * from its 680px self at *every* resolution above it — flat, not sloped, which
 * makes it downsampleToGrid's cell boundaries landing on different source
 * pixels rather than detail being lost. Hashing a capture at whatever the
 * camera gave therefore spent ten-odd bits of a 69-bit budget on nothing at
 * all. See test/hashResolution.test.js.
 *
 * The OCR crops are deliberately not cut from this. They are warped out of the
 * source frame at their own scale, where the collector line's dozen pixels are
 * worth every one they can get — see warpRegion.
 */
export const HASH_HEIGHT = 680;

/** The rectified size a capture is hashed at. See HASH_HEIGHT. */
export function hashSize() {
  return { width: Math.round(HASH_HEIGHT * CARD_ASPECT), height: HASH_HEIGHT };
}

export function rectifiedSize(quad, frameWidth, frameHeight, minHeight = 560) {
  const edge = (a, b) =>
    Math.hypot((a.x - b.x) * frameWidth, (a.y - b.y) * frameHeight);
  const height = Math.max(
    minHeight,
    Math.round(Math.max(edge(quad[0], quad[3]), edge(quad[1], quad[2])))
  );
  return { width: Math.round(height * CARD_ASPECT), height };
}
