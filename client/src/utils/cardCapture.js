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
 * Both regions carry margin around the print. A fixed quad cannot follow a card
 * that was laid down a few millimetres off the last one, and measured against
 * real placements that drift put the title text right on the crop edge. Extra
 * blank space costs OCR very little; a clipped glyph costs it the whole field.
 * The title band is the more generous of the two because it is furthest from the
 * corners the quad is anchored to, so placement drift moves it most.
 */
export const DEFAULT_REGIONS = {
  title: { x: 0.045, y: 0.02, w: 0.76, h: 0.12 },
  collector: { x: 0.025, y: 0.845, w: 0.33, h: 0.13 },
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
