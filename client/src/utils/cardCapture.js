/**
 * Capture pipeline for camera card scanning.
 *
 * Everything here is pure canvas/pixel work with no DOM wiring, so the same
 * functions serve the live video loop, the still-image upload fallback, and
 * (later) the OCR step, which needs exactly the same crops.
 */

// Magic card dimensions: 63mm x 88mm.
export const CARD_ASPECT = 63 / 88;

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
    // default corrects a quad a person aimed by eye. detectCard raises it,
    // because its seeds are a coarse grid rather than an aim and the card can
    // sit well outside the nearest one — measured on a real frame, the closest
    // seed's right edge was 36px from the card against a 31px reach, and the
    // card was simply never found. A wider reach admits more wrong edges, which
    // is why detectCard measures the support of the quad it ends up with rather
    // than trusting that the refinement landed somewhere sensible.
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

/**
 * Where to start looking for the card, as centred rectangles across the frame.
 *
 * Scales are fractions of the frame's height; offsets nudge the seed off centre
 * so a card held to one side is still reached. Deliberately coarse — each seed
 * is refined over several passes with a wide first reach, so seeds only have to
 * land near enough for the card's edges to be inside that reach, not on it.
 */
function detectionSeeds(frameWidth, frameHeight, scales, offsets) {
  const seeds = [];

  for (const scale of scales) {
    const height = frameHeight * scale;
    const width = height * CARD_ASPECT;

    // A seed wider than the frame cannot be refined onto anything; its edges
    // start outside the image where there is nothing to fit to.
    if (width > frameWidth * 0.98) continue;

    for (const [dx, dy] of offsets) {
      const cx = frameWidth / 2 + dx * frameWidth;
      const cy = frameHeight / 2 + dy * frameHeight;
      const halfW = width / 2;
      const halfH = height / 2;

      if (cx - halfW < 0 || cx + halfW > frameWidth) continue;
      if (cy - halfH < 0 || cy + halfH > frameHeight) continue;

      seeds.push([
        { x: (cx - halfW) / frameWidth, y: (cy - halfH) / frameHeight },
        { x: (cx + halfW) / frameWidth, y: (cy - halfH) / frameHeight },
        { x: (cx + halfW) / frameWidth, y: (cy + halfH) / frameHeight },
        { x: (cx - halfW) / frameWidth, y: (cy + halfH) / frameHeight },
      ]);
    }
  }

  return seeds;
}

/**
 * Measure the intensity step across each of a quad's four edges.
 *
 * Deliberately a fresh measurement of a finished quad, not the strengths that
 * fall out of the refinement. Those describe the *last pass's* fit, not the
 * result: measured on this frame, a quad refined to within 0.8% of the card
 * reported edge strengths of 164, 49, 164 and 33, while the same quad measured
 * directly reads its four real edges. Gating on the carried-over numbers throws
 * away good detections and keeps bad ones, which is worse than not gating.
 *
 * Sampled along the middle of each edge, skipping the ends: corners are where
 * two edges disagree, and a card's rounded ones have no clean step at all.
 */
function measureQuadEdges(gray, width, height, quad, samples = 13, span = 2) {
  const at = (x, y) => sampleGray(gray, width, height, x, y);
  const out = [];

  for (let e = 0; e < 4; e++) {
    const from = { x: quad[e].x * width, y: quad[e].y * height };
    const to = { x: quad[(e + 1) % 4].x * width, y: quad[(e + 1) % 4].y * height };

    const ex = to.x - from.x;
    const ey = to.y - from.y;
    const length = Math.hypot(ex, ey);
    if (length < 1e-6) return null;

    const nx = -ey / length;
    const ny = ex / length;

    const steps = [];
    for (let i = 0; i < samples; i++) {
      const t = 0.2 + (0.6 * i) / (samples - 1);
      const px = from.x + ex * t;
      const py = from.y + ey * t;

      const inside = at(px + nx * span, py + ny * span);
      const outside = at(px - nx * span, py - ny * span);
      if (inside === null || outside === null) continue;

      steps.push(Math.abs(inside - outside));
    }

    if (!steps.length) return null;
    out.push(median(steps));
  }

  return out;
}

/**
 * Are these four edges plausibly one card's outline?
 *
 * A card's border is a single transition — card against table — seen four
 * times, so the four fitted edges should be of comparable strength. Four
 * *individually* convincing edges are not the same claim: measured live against
 * a card on a patterned surface, detection took its top from the card, its left
 * from the art window's boundary, its right from a background tile edge and its
 * bottom from the text box, every one of them a real step, and the errors so
 * nearly cancelled that the result was within 7% of a card's proportions and
 * passed every other check. The corners were 10% of the card out of place, and
 * at 1% nothing matches.
 *
 * Proportion rather than an absolute floor, because the transition's size
 * depends entirely on the card and what it is lying on: a white border on a
 * dark mat is a step of 170, a dark border on a wooden table might be 25, and
 * a rule that admitted the second would admit almost anything in the first.
 */
function edgesAgree(strengths, ratio) {
  if (!strengths || strengths.length !== 4) return true;

  const sorted = [...strengths].sort((a, b) => a - b);
  const strongest = sorted[3];
  if (strongest <= 0) return false;

  return sorted[0] >= strongest * ratio;
}

/** A quad's area as a fraction of the frame, by the shoelace formula. */
function quadArea(quad) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * Find the card in the frame, without being told roughly where it is.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * snapQuadToCard refines a guess, and for a webcam pointed at a desk the guess
 * is good: the quad is marked once and the card is placed inside it. Hand-held,
 * the guess is worthless — the card is wherever your hand is — and the cost of
 * being slightly wrong is total. The perceptual hash tolerates about 1% of
 * framing error before the art window walks off the illustration: measured, a
 * 2% shift takes a capture from 0 bits to 92 of 256, which is past the match
 * threshold entirely. A card can photograph perfectly and match nothing.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * By seeding the existing refinement from a spread of plausible positions and
 * keeping whichever result the frame supports best, rather than by writing a
 * second, independent geometry. The refinement already fits each edge by
 * weighted least squares, intersects the fitted lines for the corners — so it
 * can rotate and resize, not merely shift — and rejects a result whose
 * proportions are not a card's. All of that is worth reusing; what it lacked
 * was somewhere to start.
 *
 * Candidates are scored on edge strength and on how much of the frame they
 * fill, and penalised for departing from the card's aspect. Area matters
 * because the failure it guards against is a confident lock onto part of the
 * card — the art box, the text box — which is card-shaped, well-supported by
 * edges, and completely wrong.
 *
 * Returns null rather than a best-effort quad. A capture rectified from the
 * wrong quad is worse than no capture: it produces a legible photograph that
 * matches nothing, which is the failure this whole function exists to end.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} frame
 * @returns {{quad: Array, strength: number, area: number, score: number,
 *            aspectError: number, seeds: number} | null}
 */
export function detectCard(frame, options = {}) {
  const {
    scales = [0.95, 0.8, 0.65, 0.5],
    offsets = [
      [0, 0],
      [-0.18, 0], [0.18, 0], [0, -0.15], [0, 0.15],
      [-0.18, -0.15], [0.18, -0.15], [-0.18, 0.15], [0.18, 0.15],
    ],
    minArea = 0.06,
    maxAspectError = 0.12,
    // Higher than snapQuadToCard's own floor. That one is correcting a quad a
    // person aimed by eye, so a faint edge is still likely the right one; this
    // is choosing between candidates all over the frame, where a faint edge is
    // far more likely to be furniture.
    minStrength = 18,
    // Reach far on the first pass of each seed. See firstReach in
    // snapQuadToCard for why this is safe here and not there.
    firstReach = 6,
    hint = null,
    maxAreaDrift = 0.12,
    // How weak the faintest of the four edges may be against the strongest.
    // 0.25 rather than something tighter because a *correct* detection is not
    // as even as it sounds: measured on a card whose horizontal edges read 164,
    // the vertical ones read 51 and 85 while the quad itself was 0.73% out. So
    // this catches a quad assembled from unrelated edges and nothing finer —
    // the real work against those is done by minStrength and by polishing.
    edgeAgreement = 0.25,
  } = options;

  const { width, height } = frame;

  // One grayscale pass for every measurement below. snapQuadToCard builds its
  // own internally per call, which is right for a single refinement and would
  // be dozens of redundant passes across a sweep.
  const gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < frame.data.length; i += 4, p++) {
    gray[p] = frame.data[i] * 0.299 + frame.data[i + 1] * 0.587 + frame.data[i + 2] * 0.114;
  }

  const supported = (quad) => {
    const edges = measureQuadEdges(gray, width, height, quad);
    if (!edges) return null;
    const sorted = [...edges].sort((a, b) => a - b);
    // The weakest edge is the claim being tested. Three good edges and one on
    // nothing is not a card outline, however convincing the three are.
    return { edges, weakest: sorted[0], median: (sorted[1] + sorted[2]) / 2 };
  };

  // Detect once, then track. The sweep below is dozens of refinements and costs
  // tens of milliseconds, which is affordable to *find* a card and not
  // affordable ten times a second to keep watching one. So a caller holding the
  // last frame's quad passes it as a hint: the card has moved a little, the old
  // quad is an excellent guess, and one refinement settles it. The sweep is what
  // happens when that fails — a new card, or the first frame of a session.
  if (hint) {
    const tracked = snapQuadToCard(frame, hint, { minStrength, maxAspectError });
    // A track is held to a tighter shape test than the sweep, and this is the
    // load-bearing part of tracking rather than a nicety.
    //
    // refineEdge takes the convincing step *nearest to where the guess put the
    // edge* — the right rule for correcting a marked quad, and the reason a
    // track can go wrong when the card moves outward: the guess is then nearer
    // to the art box's boundary than to the card's own edge, and that inner step
    // wins. Measured, a card that had moved eleven pixels tracked with three
    // edges on the card and the fourth 16px inside it, converging happily, at
    // 5.7% of card height where the sweep on the same frame reached 0.65%.
    //
    // What gives it away is the shape. Three card edges and one interior edge is
    // not card-shaped, and the aspect error trebled — so a track has to be much
    // closer to 63x88 than the sweep's gross-failure gate, or it is discarded
    // and the sweep runs. Otherwise tracking degrades a session the longer it
    // holds on, which is worse than never tracking at all.
    const trackSupport = tracked && tracked.converged ? supported(tracked.quad) : null;

    if (tracked && trackSupport
        && trackSupport.weakest >= minStrength
        && edgesAgree(trackSupport.edges, edgeAgreement)
        && quadAspectError(tracked.quad, width, height) <= maxAspectError / 3) {
      const area = quadArea(tracked.quad);
      const hintArea = quadArea(hint);

      // And the area must not have jumped. Shape alone cannot catch this: the
      // art window and the text box together are very nearly card-shaped, so a
      // track that slips inside the card's border shrinks in both directions at
      // once and stays within a fraction of a percent of 63x88. Measured live,
      // exactly that happened — a quad 8% short in height and 8% narrow, aspect
      // error 0.24%, corners 9.5% of card height out of place.
      //
      // What it cannot fake is continuity. At ten frames a second a real card
      // changes size gradually; slipping onto an inner edge is a step change.
      // So the comparison is against the quad this track came from, not against
      // any absolute size.
      const drifted = hintArea > 0 && Math.abs(area - hintArea) / hintArea > maxAreaDrift;

      if (area >= minArea && !drifted) {
        return {
          ...tracked,
          area,
          aspectError: quadAspectError(tracked.quad, width, height),
          score: tracked.strength * Math.sqrt(area),
          seeds: 1,
          tracked: true,
        };
      }
    }
  }

  const seeds = detectionSeeds(width, height, scales, offsets);
  if (!seeds.length) return null;

  let best = null;

  for (const seed of seeds) {
    const snapped = snapQuadToCard(frame, seed, { minStrength, maxAspectError, firstReach });
    if (!snapped) continue;

    const area = quadArea(snapped.quad);
    if (area < minArea) continue;

    const support = supported(snapped.quad);
    if (!support) continue;

    const aspectError = quadAspectError(snapped.quad, width, height);

    // Strength says the edges are real; area says they are the card's outline
    // rather than a box drawn on its face. The aspect term is a multiplier
    // rather than another gate — snapQuadToCard has already rejected anything
    // grossly wrong, and this only settles ties between survivors.
    // Scored on the weakest edge rather than the median or the mean. A quad
    // with three edges on the card and one on a background seam scores as the
    // seam, which is what it is; averaging would let the three carry it.
    const score = support.weakest * Math.sqrt(area) * (1 - Math.min(1, aspectError / maxAspectError) * 0.5);

    if (!best || score > best.score) {
      best = { ...snapped, area, aspectError, score };
    }
  }

  if (!best) return null;

  // Polish, then judge.
  //
  // The seed grid is coarse in scale — it has to be, since every seed costs a
  // full refinement — so the winning candidate is usually converged from a seed
  // that was 10% out. That leaves edges fitted partly to the card and partly to
  // whatever else was in the search band, which shows up as wildly uneven edge
  // strengths: measured, 164, 51, 164, 85 on a card whose four edges all read
  // 164-170 when refined from a correct seed.
  //
  // So the sweep's job is only to get close, and the strict tests are applied to
  // a second refinement seeded on its answer rather than to the answer itself.
  // Judging the sweep's raw output directly means either rejecting good cards or
  // accepting quads assembled from four different edges.
  const polished = snapQuadToCard(frame, best.quad, { minStrength, maxAspectError });
  if (!polished) return null;

  const area = quadArea(polished.quad);
  if (area < minArea) return null;

  const support = supported(polished.quad);
  if (!support) return null;
  if (support.weakest < minStrength) return null;
  if (!edgesAgree(support.edges, edgeAgreement)) return null;

  return {
    ...polished,
    strengths: support.edges,
    strength: support.median,
    area,
    aspectError: quadAspectError(polished.quad, width, height),
    score: support.weakest * Math.sqrt(area),
    seeds: seeds.length,
    tracked: false,
  };
}

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
 */
export function analyzeFrame(analysisCtx, previousGray, referenceGray = null) {
  const { width, height } = analysisCtx.canvas;
  const gray = toGrayscale(analysisCtx.getImageData(0, 0, width, height));

  return {
    gray,
    difference: meanAbsoluteDifference(previousGray, gray),
    sharpness: laplacianVariance(gray, width, height),
    fill: borderEdgeEnergy(gray, width, height),
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
     *            checks: {stable: boolean, sharp: boolean, filled: boolean}}}
     */
    evaluate(metrics) {
      const stable = metrics.difference <= config.stability;
      const sharp = metrics.sharpness >= config.sharpness;
      // With an empty-desk reference marked, presence is the real test and the
      // absolute edge measure is redundant; without one, fall back to it.
      const filled = Number.isFinite(metrics.presence)
        ? metrics.presence >= config.presence
        : metrics.fill >= config.fill;

      if (!armed) {
        // Re-arm once the view changes enough to be a different card, or the
        // guide is cleared entirely.
        if (metrics.difference > config.stability * 3 || !filled) armed = true;
        return { shouldCapture: false, armed, streak: 0, checks: { stable, sharp, filled } };
      }

      if (stable && sharp && filled) {
        streak++;
      } else {
        streak = 0;
      }

      const shouldCapture = streak >= config.streak;
      if (shouldCapture) {
        armed = false;
        streak = 0;
      }

      return { shouldCapture, armed, streak, checks: { stable, sharp, filled } };
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
