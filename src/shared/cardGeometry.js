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
export function rectifiedSize(quad, frameWidth, frameHeight, minHeight = 560) {
  const edge = (a, b) =>
    Math.hypot((a.x - b.x) * frameWidth, (a.y - b.y) * frameHeight);
  const height = Math.max(
    minHeight,
    Math.round(Math.max(edge(quad[0], quad[3]), edge(quad[1], quad[2])))
  );
  return { width: Math.round(height * CARD_ASPECT), height };
}
