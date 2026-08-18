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
 */
export const DEFAULT_REGIONS = {
  title: { x: 0.055, y: 0.038, w: 0.70, h: 0.075 },
  collector: { x: 0.04, y: 0.865, w: 0.30, h: 0.105 },
};

/**
 * Auto-capture thresholds. Deliberately exposed and tunable — the right values
 * depend on the webcam, and Phase 2 exists partly to find them.
 */
export const DEFAULT_THRESHOLDS = {
  // Mean absolute grayscale difference between frames, 0-255. Below this the
  // card is being held still.
  stability: 3.5,
  // Variance of the Laplacian. Above this the card is in focus.
  sharpness: 120,
  // Mean gradient magnitude in a band just inside the guide border. Above this
  // something card-shaped is filling the guide.
  fill: 12,
  // Consecutive good frames required before firing.
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
export function analyzeFrame(analysisCtx, previousGray) {
  const { width, height } = analysisCtx.canvas;
  const gray = toGrayscale(analysisCtx.getImageData(0, 0, width, height));

  return {
    gray,
    difference: meanAbsoluteDifference(previousGray, gray),
    sharpness: laplacianVariance(gray, width, height),
    fill: borderEdgeEnergy(gray, width, height),
  };
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
      const filled = metrics.fill >= config.fill;

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
