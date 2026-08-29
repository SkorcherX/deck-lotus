/**
 * Capture pipeline for camera card scanning.
 *
 * Everything here is pure canvas/pixel work with no DOM wiring, so the same
 * functions serve the live video loop, the still-image upload fallback, and
 * (later) the OCR step, which needs exactly the same crops.
 */

// The card's proportions, the square-to-quad map and the rectified output size
// live in src/shared/cardGeometry.js now, and are re-exported here so every
// existing caller keeps importing them from the module it always did.
//
// They moved because `scripts/` ships in the container and `client/src` does
// not, and the replay harness needs the very same geometry the capture uses —
// the same direction rule that puts cardHash.js in src/shared. See
// test/serverImports.test.js.
export {
  CARD_ASPECT,
  projectiveMap,
  rectifiedSize,
  hashSize,
  HASH_HEIGHT,
} from '../../../src/shared/cardGeometry.js';
import { CARD_ASPECT, projectiveMap, rectifiedSize } from '../../../src/shared/cardGeometry.js';

/**
 * Crop regions, expressed as fractions of the card rectangle — not of the
 * frame. A card framed in the guide always puts these in the same place
 * regardless of camera resolution or how the guide is sized.
 *
 * The title band stops well short of the right edge to keep the mana cost out
 * of the crop; the mana symbols are the main source of junk characters in an
 * OCR'd name.
 *
 * The regions are cut generously and then trimmed to their content by the
 * reader, rather than being sized to the print exactly. Sizing them exactly
 * makes them hostage to the alignment beneath: the collector block is about 7%
 * of a card's height, so a couple of percent of drift moves the crop off the
 * print, and a real capture lost the collector number that way while keeping
 * the set line. Generous plus content-aware beats precise plus brittle, and
 * trimming to the print also keeps the card face above the black border out of
 * the crop, which is what forced one polarity decision to serve two polarities.
 */
export const DEFAULT_REGIONS = {
  title: { x: 0.045, y: 0.015, w: 0.74, h: 0.115 },
  collector: { x: 0.025, y: 0.855, w: 0.33, h: 0.135 },
};

/**
 * Auto-capture thresholds. Deliberately exposed and tunable — the right values
 * depend on the webcam, and Phase 2 exists partly to find them.
 */
export const DEFAULT_THRESHOLDS = {
  // Mean absolute grayscale difference between frames, 0-255. Below this the
  // card is being held still. A card resting on a desk measured 0.5-0.7, so this
  // is loose enough for a hand-held card and still rejects the moment of
  // placing one.
  stability: 2.0,
  // Variance of the Laplacian. Above this the card is in focus. Measured on a
  // laptop webcam: 117-122 while a hand was moving in the frame, 538 with the
  // card settled, so this sits between the two rather than at the blur floor.
  sharpness: 250,
  // Mean gradient magnitude in a band just inside the guide border. Above this
  // something card-shaped is filling the guide. Only used when no empty-desk
  // reference has been marked — an absolute edge measure cannot tell a busy
  // desk from a card, so it is the weaker of the two tests.
  fill: 12,
  // Mean absolute difference from the marked empty-desk reference. Above this,
  // something is lying in the quad. This is what desk mode actually uses.
  // Measured: 2.1 for an empty desk against its own reference (sensor noise) and
  // 73.9 with a card. Kept nearer the noise floor than the card value so a dark
  // card on a dark desk, which differs far less, still registers.
  presence: 12,
  // Percentage of the rectified card that is blown-out white. Above this a
  // specular highlight — sleeve glare, a lamp reflected off a foil — is sitting
  // on the art, and the capture is worth refusing: the same patch that hides
  // the print flips whole cells of the perceptual hash and blanks the collector
  // block for the reader. Tilting the card five degrees kills it outright,
  // which is the whole reason this is surfaced as a chip rather than silently
  // corrected.
  //
  // PROVISIONAL. Every other number here was measured; this one has yet to be,
  // because no recorded session carries the metric. It is deliberately lenient
  // so a bright card is not refused before the number is calibrated — see
  // blownHighlightFraction for why a white border does not count toward it, and
  // docs/SCAN_DIAGNOSTICS_TESTING.md for how to settle it against a bundle.
  glare: 6,
  // Consecutive good frames required before firing — 3 at the analysis interval
  // is roughly 300ms of settle, which caught one capture per card across a
  // swap-three-cards run with nothing fired mid-placement.
  streak: 3,
};

/**
 * Thresholds for a hand-held camera — a phone over the card rather than a
 * webcam over a desk.
 *
 * DEFAULT_THRESHOLDS were measured with the card lying still on a desk and the
 * camera bolted to a laptop lid: a resting card moved 0.5-0.7, so a stability
 * bar of 2.0 was loose. Held in a hand, nothing is ever that still — a steady
 * grip is several units of frame-to-frame difference and a bar of 2.0 simply
 * never trips, so the shutter never fires and the page looks broken.
 *
 * The compensation is to lean on sharpness instead, and harder than the desk
 * profile does. A phone autofocuses, so its frames are decisively sharp or
 * decisively soft in a way a fixed-focus webcam's never are — which makes
 * focus the more honest "is this frame worth keeping" test once stillness
 * stops being informative.
 */
export const HANDHELD_THRESHOLDS = {
  ...DEFAULT_THRESHOLDS,
  stability: 9.0,
  sharpness: 320,
  // One more frame of agreement, because the looser stability bar admits
  // frames the desk profile would have rejected outright.
  streak: (DEFAULT_THRESHOLDS.streak || 3) + 1,
};


/**
 * The guide rectangle: the largest card-shaped box that fits inside the frame
 * at `fill` of the limiting dimension, centred.
 */
export function guideRect(frameWidth, frameHeight, fill = 0.72) {
  let height = frameHeight * fill;
  let width = height * CARD_ASPECT;

  if (width > frameWidth * 0.92) {
    width = frameWidth * 0.92;
    height = width / CARD_ASPECT;
  }

  return {
    x: Math.round((frameWidth - width) / 2),
    y: Math.round((frameHeight - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Convert a region given in card fractions into pixels inside a card rect. */
export function regionToPixels(cardRect, region) {
  return {
    x: Math.round(cardRect.x + region.x * cardRect.width),
    y: Math.round(cardRect.y + region.y * cardRect.height),
    width: Math.max(1, Math.round(region.w * cardRect.width)),
    height: Math.max(1, Math.round(region.h * cardRect.height)),
  };
}

/**
 * Crop a region out of any drawable source, scaled up.
 *
 * OCR wants more pixels than the camera gives for a 3mm-tall collector line, so
 * the crop is upscaled here rather than at OCR time — the browser's smoothing
 * on a single draw is better than repeated resampling later.
 */
export function cropRegion(source, cardRect, region, scale = 3) {
  const px = regionToPixels(cardRect, region);
  const canvas = document.createElement('canvas');
  canvas.width = px.width * scale;
  canvas.height = px.height * scale;

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    source,
    px.x, px.y, px.width, px.height,
    0, 0, canvas.width, canvas.height
  );

  return canvas;
}

/** Copy the guide rectangle out of a source at full resolution. */
export function cropCard(source, cardRect) {
  const canvas = document.createElement('canvas');
  canvas.width = cardRect.width;
  canvas.height = cardRect.height;
  canvas
    .getContext('2d')
    .drawImage(
      source,
      cardRect.x, cardRect.y, cardRect.width, cardRect.height,
      0, 0, cardRect.width, cardRect.height
    );
  return canvas;
}

/* ==========================================================================
   Quad framing and perspective correction

   A laptop camera lives on the lid, so the comfortable way to scan is to lay
   the card flat on the desk and tilt the lid down at it. That view is a
   trapezoid, not a rectangle: a card-shaped guide cannot frame it, and a
   rectangular crop of it slices diagonally through the text.

   The fix is to mark the card's four corners once — it stays in the same spot
   on the desk all session — and warp that quad back to a true 63x88 rectangle.
   Every crop region downstream then applies to a rectified card and needs no
   knowledge of the camera angle at all.
   ========================================================================== */

/**
 * Corners are fractions of the frame, ordered top-left, top-right,
 * bottom-right, bottom-left. Fractions rather than pixels so a quad survives a
 * change of camera resolution.
 */
export function quadFromRect(rect, frameWidth, frameHeight) {
  const left = rect.x / frameWidth;
  const right = (rect.x + rect.width) / frameWidth;
  const top = rect.y / frameHeight;
  const bottom = (rect.y + rect.height) / frameHeight;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

/** The starting quad: the same card-shaped box the fixed guide used to be. */
export function defaultQuad(frameWidth = 1920, frameHeight = 1080) {
  return quadFromRect(guideRect(frameWidth, frameHeight), frameWidth, frameHeight);
}


/** Where a crop region's corners fall in the frame, for drawing the overlay. */
export function regionQuad(quad, region) {
  const map = projectiveMap(quad);
  const corners = [
    [region.x, region.y],
    [region.x + region.w, region.y],
    [region.x + region.w, region.y + region.h],
    [region.x, region.y + region.h],
  ];
  return corners.map(([u, v]) => {
    const [x, y] = map(u, v);
    return { x, y };
  });
}

/**
 * Rectify a quad of `source` into a canvas of the true card shape.
 *
 * Sampling is bilinear: at desk distance the card is a few hundred pixels tall,
 * and nearest-neighbour on text that small produces exactly the broken strokes
 * OCR reads as punctuation.
 */
export function warpQuad(sourceImageData, quad, outWidth, outHeight) {
  const out = document.createElement('canvas');
  out.width = outWidth;
  out.height = outHeight;
  const ctx = out.getContext('2d');
  const dst = ctx.createImageData(outWidth, outHeight);
  warpInto(dst, sourceImageData, quad);
  ctx.putImageData(dst, 0, 0);
  return out;
}

/**
 * Warp straight into an existing ImageData and context.
 *
 * The live loop rectifies every analysed frame, so it reuses one buffer rather
 * than allocating a canvas ten times a second.
 */
export function warpQuadInto(ctx, sourceImageData, quad, scratch) {
  const { width, height } = ctx.canvas;
  const dst = scratch && scratch.width === width ? scratch : ctx.createImageData(width, height);
  warpInto(dst, sourceImageData, quad);
  ctx.putImageData(dst, 0, 0);
  return dst;
}

/** The sampling loop itself — see warpQuad for what it is for. */
function warpInto(dst, sourceImageData, quad) {
  const map = projectiveMap(quad);
  const { data: src, width: sw, height: sh } = sourceImageData;
  const outWidth = dst.width;
  const outHeight = dst.height;

  for (let y = 0; y < outHeight; y++) {
    // Sample from pixel centres, so the output is not shifted half a pixel.
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

      // Anything the quad puts outside the frame is black rather than clamped,
      // so a corner dragged off-screen looks wrong instead of smearing an edge
      // pixel into something that resembles print.
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sw || y0 + 1 >= sh) {
        dst.data[di + 3] = 255;
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
        dst.data[di + c] =
          src[i00 + c] * w00 + src[i10 + c] * w10 + src[i01 + c] * w01 + src[i11 + c] * w11;
      }
      dst.data[di + 3] = 255;
    }
  }
}

/* ==========================================================================
   Snapping the quad to the card

   A quad marked by hand is a good guess, never an exact one — especially on a
   phone, where the handles are smaller than a fingertip. Cards then land a few
   millimetres off it, and because every crop is a fraction of the quad, a small
   misalignment walks the collector crop clean off the print. Measured on a real
   capture: the crop began at the type line and the collector text was half out
   of frame at the bottom.

   So the marked quad is treated as a starting guess and refined against the
   card's actual edges before each capture. Starting from a good guess is what
   makes this robust without any general-purpose vision: each edge only has to
   be found within a narrow band of where it already is.
   ========================================================================== */

/** Bilinear sample of a grayscale buffer at fractional pixel coordinates. */
function sampleGray(gray, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const i = y0 * width + x0;
  return (
    gray[i] * (1 - tx) * (1 - ty) +
    gray[i + 1] * tx * (1 - ty) +
    gray[i + width] * (1 - tx) * ty +
    gray[i + width + 1] * tx * ty
  );
}

/** Median of an array, used throughout for its indifference to outliers. */
function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Find one edge of the card near where the guess says it should be.
 *
 * Samples along the guessed edge and, at each sample, scans perpendicular for
 * the strongest intensity step — the card's border against the surface. The
 * offsets are then fitted as a straight line in the edge's own frame
 * (`offset = a + b·t`), which lets the refined edge translate, rotate and
 * change length rather than merely shift.
 */
function push_point(points, t, candidate) {
  points.push({ t, offset: candidate.d, strength: candidate.strength });
}

function refineEdge(gray, width, height, from, to, searchRadius, minStrength, samples = 15) {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const length = Math.hypot(ex, ey);
  if (length < 1e-6) return null;

  // Unit normal to the edge.
  const nx = -ey / length;
  const ny = ex / length;

  const points = [];

  for (let i = 0; i < samples; i++) {
    // Skip the ends: corners are where two edges disagree, and rounded card
    // corners have no clean step at all.
    const t = 0.15 + (0.7 * i) / (samples - 1);
    const px = from.x + ex * t;
    const py = from.y + ey * t;

    // Collect every step across the search window, then choose among them.
    const candidates = [];
    let strongest = 0;

    for (let d = -searchRadius; d <= searchRadius; d += 1) {
      const ax = px + nx * (d - 1);
      const ay = py + ny * (d - 1);
      const bx = px + nx * (d + 1);
      const by = py + ny * (d + 1);

      const before = sampleGray(gray, width, height, ax, ay);
      const after = sampleGray(gray, width, height, bx, by);
      if (before === null || after === null) continue;

      const strength = Math.abs(after - before);
      candidates.push({ d, strength });
      if (strength > strongest) strongest = strength;
    }

    // Take the convincing step nearest to where the guess put the edge.
    //
    // Neither "strongest" nor "outermost" works. Strongest snaps to the inside
    // of the card's black border, which is a far more pronounced transition than
    // card-against-table. Outermost overshoots the other way, onto the soft
    // shadow a card casts on cloth — measured on a real capture, a quad the user
    // had aligned by eye moved 39px and dragged the collector crop off the top
    // line and onto the tablecloth.
    //
    // A marked quad is a person's aim, and it is usually good. Refining to the
    // nearest real edge keeps that aim and only corrects it, so the snap can
    // improve a placement but never run away from one.
    //
    // "Convincing" is an absolute floor rather than a fraction of the strongest
    // step: against a border transition eight times its size, the card's true
    // outer edge would never clear a relative bar.
    const qualifying = candidates.filter((c) => c.strength >= minStrength);
    const nearest = qualifying.length
      ? qualifying.reduce((best, c) => (Math.abs(c.d) < Math.abs(best.d) ? c : best))
      : null;

    if (nearest) push_point(points, t, nearest);
  }

  if (points.length < 6) return null;

  // Discard samples whose offset disagrees with the consensus — a finger, a
  // shadow or the edge of the card underneath will each produce a few.
  const offsets = points.map((p) => p.offset);
  const centre = median(offsets);
  const spread = Math.max(2, 1.5 * median(offsets.map((o) => Math.abs(o - centre))));
  const kept = points.filter((p) => Math.abs(p.offset - centre) <= spread);

  if (kept.length < 5) return null;

  // Least squares of offset against t, weighted by edge strength.
  let sw = 0;
  let st = 0;
  let so = 0;
  let stt = 0;
  let sto = 0;
  for (const point of kept) {
    const w = point.strength;
    sw += w;
    st += w * point.t;
    so += w * point.offset;
    stt += w * point.t * point.t;
    sto += w * point.t * point.offset;
  }

  const denominator = sw * stt - st * st;
  let a;
  let b;
  if (Math.abs(denominator) < 1e-9) {
    a = so / sw;
    b = 0;
  } else {
    b = (sw * sto - st * so) / denominator;
    a = (so - b * st) / sw;
  }

  return {
    from: { x: from.x + nx * a, y: from.y + ny * a },
    to: { x: to.x + nx * (a + b), y: to.y + ny * (a + b) },
    strength: median(kept.map((p) => p.strength)),
    shift: a,
  };
}

/** Where two lines cross, or null if they are parallel. */
function lineIntersection(p1, p2, p3, p4) {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;

  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-12) return null;

  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denominator;
  return { x: p1.x + d1x * t, y: p1.y + d1y * t };
}

/**
 * Refine a guessed quad onto the card actually in frame.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} frame
 * @param {Array<{x: number, y: number}>} quad  corners as fractions of the frame
 * @param {{searchFraction?: number, minStrength?: number}} [options]
 *   searchFraction — how far to look for each edge, as a fraction of the card's
 *     smaller dimension. Deliberately small: this corrects a good guess rather
 *     than searching the frame, and a wide search finds the table edge instead.
 *   minStrength — how pronounced the intensity step must be to be believed.
 * @returns {{quad: Array, strength: number, moved: number} | null}
 *   null when the card cannot be found, in which case the caller keeps the
 *   marked quad rather than trusting a bad fit.
 */
function snapOnce(gray, width, height, quad, searchFraction, minStrength) {

  // Work in pixels: the search radius is a physical distance, not a fraction.
  const pixels = quad.map((c) => ({ x: c.x * width, y: c.y * height }));
  const side = (a, b) => Math.hypot(pixels[a].x - pixels[b].x, pixels[a].y - pixels[b].y);
  const shortSide = Math.min((side(0, 1) + side(3, 2)) / 2, (side(0, 3) + side(1, 2)) / 2);
  const searchRadius = Math.max(4, Math.round(shortSide * searchFraction));

  // Edges in order: top, right, bottom, left.
  const edges = [
    refineEdge(gray, width, height, pixels[0], pixels[1], searchRadius, minStrength),
    refineEdge(gray, width, height, pixels[1], pixels[2], searchRadius, minStrength),
    refineEdge(gray, width, height, pixels[2], pixels[3], searchRadius, minStrength),
    refineEdge(gray, width, height, pixels[3], pixels[0], searchRadius, minStrength),
  ];

  if (edges.some((edge) => edge === null)) return null;

  const strengths = edges.map((edge) => edge.strength);
  const strength = median(strengths);
  if (strength < minStrength) return null;

  // Corners are where consecutive refined edges meet, which is what lets the
  // quad rotate and resize instead of only shifting.
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const previous = edges[(i + 3) % 4];
    const current = edges[i];
    const point = lineIntersection(previous.from, previous.to, current.from, current.to);
    if (!point) return null;
    corners.push({ x: point.x / width, y: point.y / height });
  }

  const moved = Math.max(
    ...corners.map((c, i) => Math.hypot((c.x - quad[i].x) * width, (c.y - quad[i].y) * height))
  );

  return { quad: corners, strength, strengths, moved };
}

/**
 * How far the quad's proportions are from a Magic card's, as a ratio.
 *
 * The card is 63x88mm and nothing else, so this is free ground truth: a snapped
 * quad with the wrong proportions has locked onto something that is not the
 * card — the stack underneath it, a shadow, the edge of the mat. Measured from
 * a real capture, an over-large quad pushed the collector crop clean off the
 * bottom of the print while every edge still looked individually plausible.
 *
 * Perspective makes this approximate, so the tolerance is generous; it is there
 * to catch gross failures, not to police a few degrees of tilt.
 */
export function quadAspectError(quad, frameWidth, frameHeight) {
  const distance = (a, b) =>
    Math.hypot((a.x - b.x) * frameWidth, (a.y - b.y) * frameHeight);

  const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  if (height < 1e-6) return Infinity;

  return Math.abs(width / height - CARD_ASPECT) / CARD_ASPECT;
}

/**
 * Refine a guessed quad onto the card actually in frame.
 *
 * Runs the refinement repeatedly. One pass can only move each edge as far as it
 * searches, so a quad marked 10% too large — easy to do with fingertip-sized
 * handles on a phone — cannot reach the card in a single step. Each pass starts
 * from the last, so the quad walks in and converges.
 *
 * @returns {{quad: Array, strength: number, moved: number, passes: number} | null}
 *   null when the card cannot be found or the result is not card-shaped, in
 *   which case the caller keeps the marked quad rather than trusting a bad fit.
 */
export function snapQuadToCard(frame, quad, options = {}) {
  // minStrength is both the floor for believing an individual edge step and the
  // bar the fitted edges must clear overall.
  const {
    searchFraction = 0.06,
    minStrength = 10,
    passes = 4,
    maxAspectError = 0.12,
    // How far the first pass reaches, as a multiple of searchFraction. The
    // default corrects a quad a person aimed by eye, where a faint step nearby
    // is still likely to be the right one. Raise it only with something
    // downstream that checks the result: a wider reach admits more wrong edges.
    firstReach = 2.5,
  } = options;
  const { width, height } = frame;

  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < frame.data.length; i += 4, p++) {
    gray[p] = frame.data[i] * 0.299 + frame.data[i + 1] * 0.587 + frame.data[i + 2] * 0.114;
  }

  let current = quad;
  let strength = 0;
  let strengths = null;
  let used = 0;
  let converged = false;

  for (let pass = 0; pass < passes; pass++) {
    // Coarse to fine. The first pass searches wide, because a quad marked well
    // outside the card cannot be corrected by a window that never reaches it —
    // measured on a phone, a quad 10% too large left the card beyond a 6%
    // search and the snap simply found nothing. Later passes narrow, so the
    // result settles on the card's edge rather than drifting to whatever else
    // is within reach.
    const reach = pass === 0 ? searchFraction * firstReach : searchFraction;
    const result = snapOnce(gray, width, height, current, reach, minStrength);
    if (!result) break;

    current = result.quad;
    strength = result.strength;
    strengths = result.strengths;
    used = pass + 1;

    // Settled: further passes would only chase noise. Distinct from running out
    // of passes or from a pass failing outright, both of which leave the quad
    // wherever it had got to — see `converged` in the return, which is what lets
    // a caller tell "this is the card's edge" from "this is where I gave up".
    if (result.moved < 1) {
      converged = true;
      break;
    }
  }

  if (used === 0) return null;

  // The card's known proportions are the check on all of this.
  if (quadAspectError(current, width, height) > maxAspectError) return null;

  const moved = Math.max(
    ...current.map((c, i) => Math.hypot((c.x - quad[i].x) * width, (c.y - quad[i].y) * height))
  );

  return { quad: current, strength, strengths, moved, passes: used, converged };
}

/*
 * The seeded edge-search detector that used to live here has gone.
 *
 * It refined a quad by searching perpendicular to each edge for the strongest
 * intensity step, and it measured beautifully against synthetic frames. On a
 * real photograph it could not scan a single card: profiling one showed the art
 * window's border and the type line well above the card's own outline, so
 * "strongest step near this edge" reliably answered with the art box. Seeded at
 * a card's exact true corners it still drifted to 3-4%, where the hash needs
 * about 1%. See client/src/utils/cardContour.js, which finds closed regions
 * instead and cannot assemble a quad out of four unrelated edges.
 *
 * snapQuadToCard above stays: it is still what refines a quad someone marked by
 * hand for a fixed camera over a desk, which is the job it was always good at.
 */

/**
 * Warp one crop region straight out of the source frame.
 *
 * The obvious route — rectify the whole card, then crop and upscale that —
 * resamples every pixel twice, and the collector line is only a dozen or so
 * pixels tall before either pass. Restricting the card's projective map to a
 * region is itself a projective map, fully determined by the region's four
 * corner images, so the region can be sampled from the original pixels in one
 * step at whatever size OCR wants.
 */
export function warpRegion(sourceImageData, quad, region, outWidth, outHeight) {
  return warpQuad(sourceImageData, regionQuad(quad, region), outWidth, outHeight);
}

/**
 * Output size for a region crop: its size on the rectified card, scaled up for
 * OCR. Small text needs the pixels, and here they cost one resampling rather
 * than two.
 */
export function regionOutputSize(cardSize, region, scale = 3) {
  return {
    width: Math.max(8, Math.round(cardSize.width * region.w * scale)),
    height: Math.max(8, Math.round(cardSize.height * region.h * scale)),
  };
}


/** Full-resolution pixels of a frame, for a capture-time warp. */
export function frameImageData(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * Read a rectified canvas back as ImageData.
 *
 * warpQuad hands back a canvas, because every other consumer draws it. The
 * hash is the exception: it is shared with the server and the build script, so
 * it takes the ImageData *shape* and knows nothing about the DOM. Converting
 * here rather than teaching the shared module about canvases keeps that
 * boundary — see the load-bearing constraint in src/shared/cardHash.js.
 */
export function imageDataOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Grayscale bytes from an ImageData. Luma weights rather than a plain average —
 * card frames and text are usually low-saturation, and luma keeps the contrast
 * between them that a flat average washes out.
 */
export function toGrayscale(imageData) {
  const { data, width, height } = imageData;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return gray;
}

/** Mean absolute difference between two equally sized grayscale buffers. */
export function meanAbsoluteDifference(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Variance of the 4-neighbour Laplacian — the standard cheap focus measure. A
 * blurred frame has little high-frequency energy, so the response is flat and
 * its variance small.
 */
export function laplacianVariance(gray, width, height) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const value =
        4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += value;
      sumSq += value * value;
      count++;
    }
  }

  if (count === 0) return 0;
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

/**
 * Mean gradient magnitude in a band just inside the guide border.
 *
 * A card filling the guide puts its printed border and edge right there, which
 * is a lot of gradient; an empty guide looking at a desk is nearly flat. This
 * is what stands in for card detection — cheaper and, with a fixed guide,
 * nearly as useful as finding the quad.
 */
export function borderEdgeEnergy(gray, width, height, bandFraction = 0.12) {
  const bandX = Math.max(2, Math.round(width * bandFraction));
  const bandY = Math.max(2, Math.round(height * bandFraction));

  let sum = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    const nearTopOrBottom = y < bandY || y >= height - bandY;
    for (let x = 1; x < width - 1; x++) {
      const inBand = nearTopOrBottom || x < bandX || x >= width - bandX;
      if (!inBand) continue;
      const i = y * width + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + width] - gray[i - width];
      sum += Math.abs(gx) + Math.abs(gy);
      count++;
    }
  }

  return count === 0 ? 0 : sum / count;
}

/**
 * Per-frame measurements for the guide area.
 *
 * `previousGray` comes from the caller so the analysis canvas can stay a single
 * reused buffer; returns the current buffer for the next call.
 *
 * ── Why motion is measured somewhere else ───────────────────────────────────
 * `motionCtx` is a *second* buffer, cut from a framing that does not move
 * between frames, and it exists because measuring stillness on the rectified
 * card does not measure stillness.
 *
 * Sharpness and fill are rightly measured on the card as found: a tilted view
 * should be judged on the same terms as a flat one, which is what rectifying
 * first buys. Difference is not like them. It compares one frame against the
 * last, so it needs the same region sampled twice — and the detected quad is
 * re-found every frame and lands a little differently each time. Rectifying
 * through it shifts the whole buffer, and the difference reads that shift as
 * the card moving.
 *
 * Measured by replaying recorded frames through this warp at analysis size,
 * with the card physically motionless on a desk:
 *
 *     corner jitter   0.5%   1.0%   1.9%   3.0%
 *     difference       3.5    6.5   11-13  15-18
 *
 * against a default stability bar of 2.0, and 9.0 for a hand-held camera. The
 * jitter actually present measured 1.9% of card width, so a still card scored
 * 11-13 and neither bar could ever be met — auto-capture simply never fired
 * with detection on, and the only way to get it to fire was to raise the
 * threshold past the detector's own noise floor, which also raises it past any
 * real motion worth waiting out.
 *
 * A fixed framing has no such floor. It does not need to be *on* the card, only
 * to be the same region every frame, so the marked guide serves.
 */
/**
 * Fraction of the card that is a blown-out specular highlight, as a percentage.
 *
 * Not simply "pixels above 250". A card's own print reaches white — a white
 * border, a Plains, the text box — and counting that would refuse the brightest
 * cards in the game for a fault they do not have. What separates glare from
 * white ink is that glare is *clipped*: the sensor has run out of headroom, so
 * the patch is a plateau with no texture in it, while white ink still carries
 * the grain, edges and lettering printed on it.
 *
 * So a pixel counts only when its four neighbours are saturated too. That one
 * test drops white borders, glyph edges and speckle — anything with structure
 * still in it — and keeps the interior of a real highlight, which is exactly
 * the region that destroys hash cells and OCR strokes.
 */
export function blownHighlightFraction(gray, width, height, level = 250) {
  let blown = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      count++;
      if (
        gray[i] >= level &&
        gray[i - 1] >= level &&
        gray[i + 1] >= level &&
        gray[i - width] >= level &&
        gray[i + width] >= level
      ) {
        blown++;
      }
    }
  }

  return count ? (blown / count) * 100 : 0;
}

export function analyzeFrame(analysisCtx, previousGray, referenceGray = null, motionCtx = null) {
  const { width, height } = analysisCtx.canvas;
  const gray = toGrayscale(analysisCtx.getImageData(0, 0, width, height));

  // Falls back to the rectified buffer when no fixed one is offered, so a
  // caller that does not detect at all — the marked-guide path, where the
  // framing is already fixed — behaves exactly as before.
  const motionGray = motionCtx
    ? toGrayscale(motionCtx.getImageData(0, 0, motionCtx.canvas.width, motionCtx.canvas.height))
    : gray;

  return {
    gray,
    motionGray,
    difference: meanAbsoluteDifference(previousGray, motionGray),
    sharpness: laplacianVariance(gray, width, height),
    fill: borderEdgeEnergy(gray, width, height),
    // Measured on the rectified card, so it is glare *on the card* rather than
    // a bright desk beside it.
    glare: blownHighlightFraction(gray, width, height),
    // Infinity, not zero, when there is no reference: with nothing to compare
    // against, presence must not be the thing that blocks a capture.
    presence: referenceGray ? meanAbsoluteDifference(referenceGray, gray) : Infinity,
  };
}

/** Grayscale of the current analysis buffer, to keep as an empty-desk reference. */
export function referenceFrom(analysisCtx) {
  const { width, height } = analysisCtx.canvas;
  return toGrayscale(analysisCtx.getImageData(0, 0, width, height));
}

/**
 * Decides when a frame is worth capturing.
 *
 * Beyond "still, sharp and filled for a few frames", it enforces that the scene
 * actually changed since the last capture before arming again. Without that a
 * card left sitting in the guide is captured over and over, which is exactly
 * what a continuous scan queue must not do.
 */
export function createAutoCapture(thresholds = {}) {
  const config = { ...DEFAULT_THRESHOLDS, ...thresholds };
  let streak = 0;
  let armed = true;

  return {
    get config() {
      return config;
    },

    setThresholds(next) {
      Object.assign(config, next);
    },

    /** Called after a capture: nothing fires again until the card is swapped. */
    disarm() {
      armed = false;
      streak = 0;
    },

    reset() {
      armed = true;
      streak = 0;
    },

    /**
     * @returns {{shouldCapture: boolean, armed: boolean, streak: number,
     *            checks: {stable: boolean, sharp: boolean, filled: boolean,
     *                     clear: boolean}}}
     */
    evaluate(metrics) {
      const stable = metrics.difference <= config.stability;
      const sharp = metrics.sharpness >= config.sharpness;
      // With an empty-desk reference marked, presence is the real test and the
      // absolute edge measure is redundant; without one, fall back to it.
      const filled = Number.isFinite(metrics.presence)
        ? metrics.presence >= config.presence
        : metrics.fill >= config.fill;
      // A frame with a highlight burnt into the art is refused rather than
      // captured and matched against nothing. Undefined on a caller that does
      // not measure it reads as clear: this gate is newer than the metric, and
      // nothing should start failing for not having been updated.
      const clear = !Number.isFinite(metrics.glare) || metrics.glare <= config.glare;

      if (!armed) {
        // Re-arm once the view changes enough to be a different card, or the
        // guide is cleared entirely.
        if (metrics.difference > config.stability * 3 || !filled) armed = true;
        return {
          shouldCapture: false,
          armed,
          streak: 0,
          checks: { stable, sharp, filled, clear },
        };
      }

      if (stable && sharp && filled && clear) {
        streak++;
      } else {
        streak = 0;
      }

      const shouldCapture = streak >= config.streak;
      if (shouldCapture) {
        armed = false;
        streak = 0;
      }

      return { shouldCapture, armed, streak, checks: { stable, sharp, filled, clear } };
    },
  };
}

/**
 * Whether the browser will hand over a camera at all.
 *
 * Over plain HTTP on a LAN address `navigator.mediaDevices` is undefined —
 * there is no permission prompt to click through, so this has to be reported as
 * a page-level condition rather than caught as a getUserMedia failure.
 */
export function cameraAvailability() {
  if (!window.isSecureContext) {
    return {
      available: false,
      reason:
        'The camera needs a secure context. Open the app over HTTPS (the tunnel hostname) rather than the LAN address.',
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return { available: false, reason: 'This browser does not expose a camera API.' };
  }
  return { available: true, reason: null };
}

/** Load a File into an <img> ready to be cropped, for the upload fallback. */
export function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      // The object URL is only needed until the bitmap is decoded.
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image'));
    };
    image.src = url;
  });
}
