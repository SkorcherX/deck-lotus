/**
 * The pixel half of the OCR preprocessing: grayscale, denoise, threshold.
 *
 * Split out of `client/src/utils/cardOcr.js` for the same reason `cardHash.js`
 * and `scanFusion.js` live here — so it can be run somewhere other than a
 * browser. `scripts/ocr-variants.mjs` measures a proposed variant against real
 * captures in Node, and it can only be trusted if it is measuring *this* code
 * rather than a copy of it that has since drifted.
 *
 * Canvas-free by construction: it takes and returns raw RGBA. The wrapper in
 * cardOcr.js is the part that knows about canvases.
 *
 * ── Why Sauvola ─────────────────────────────────────────────────────────────
 * The obvious approach — threshold each pixel against its local mean minus a
 * fixed offset — works on a white or gold card and destroys a black or green
 * one. Those frames print dark text on a dark plate, so the strokes sit only a
 * few grey levels below their surroundings and a fixed offset misses them
 * entirely; measured on a dark card, the name came back as
 * "olare ec 2 Ih 4 z Ls . alypse".
 *
 * Sauvola scales the threshold by the local standard deviation instead:
 *
 *   t = mean * (1 + k * (stddev / R - 1))
 *
 * Where contrast is low the deviation is small, the threshold drops toward the
 * mean, and faint strokes still register. Both the mean and the deviation come
 * from integral images, so the window size costs nothing.
 */

/**
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 * @param {object} [options]
 *   window   — fraction of the crop height to average over
 *   k        — Sauvola sensitivity; lower keeps more ink on low-contrast plates
 *   denoise  — smooth over a 3x3 window first, to stop sensor grain thresholding
 *              into speckle that OCR reads as punctuation
 *   grayscale — skip thresholding and hand tesseract contrast-stretched grey,
 *              letting its own binarizer decide
 *   invert   — force the polarity rather than inferring it
 *   clip     — percentile (0..1) above which luma is clamped before anything
 *              else; see clipHighlights
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function preprocessPixels(image, options = {}) {
  const {
    window: windowFraction = 0.6,
    k = 0.18,
    denoise = true,
    grayscale = false,
    invert = null,
    clip = null,
  } = options;

  const { data, width, height } = image;

  let gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  }

  if (clip !== null) clipHighlights(gray, clip);
  if (denoise) gray = boxBlur(gray, width, height);

  const out = new Uint8ClampedArray(width * height * 4);

  if (grayscale) {
    // Stretch to the full range and let tesseract binarize. Its own thresholding
    // is well tuned, and on some frames beating it to the punch only loses
    // information.
    let min = 255;
    let max = 0;
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] < min) min = gray[i];
      if (gray[i] > max) max = gray[i];
    }
    const span = Math.max(1, max - min);
    const dark = meanOf(gray) < 128;

    for (let p = 0; p < gray.length; p++) {
      let value = ((gray[p] - min) / span) * 255;
      // Light text on a dark plate is inverted so tesseract always sees dark on
      // light, which is what it is trained for.
      if (invert === null ? dark : invert) value = 255 - value;
      const di = p * 4;
      out[di] = out[di + 1] = out[di + 2] = value;
      out[di + 3] = 255;
    }
  } else {
    const { mean, deviation } = localStatistics(gray, width, height, windowFraction);
    let inkCount = 0;

    for (let p = 0; p < gray.length; p++) {
      // R is the dynamic range of the deviation; 128 is Sauvola's own value.
      const threshold = mean[p] * (1 + k * (deviation[p] / 128 - 1));
      const isInk = gray[p] < threshold;
      if (isInk) inkCount++;
      const value = isInk ? 0 : 255;
      const di = p * 4;
      out[di] = out[di + 1] = out[di + 2] = value;
      out[di + 3] = 255;
    }

    // Tesseract expects dark text on a light ground. The collector block is
    // white print on a dark border, which thresholds to the inverse of that, so
    // polarity is decided by which tone is in the minority — ink always is.
    const inverted = invert === null ? inkCount > width * height * 0.5 : invert;
    if (inverted) {
      for (let i = 0; i < out.length; i += 4) {
        const value = 255 - out[i];
        out[i] = out[i + 1] = out[i + 2] = value;
      }
    }
  }

  return { data: out, width, height };
}

/**
 * Clamp everything above a percentile down to it, in place.
 *
 * For a bright band across the collector block. Sauvola thresholds against the
 * local *mean*, so a highlight inside the window drags the mean up and takes
 * the strokes beside it with it — the ink stops being darker than its
 * neighbourhood and stops being ink. Clipping the top of the histogram first
 * puts a ceiling on how far the highlight can move the mean, and it does not
 * touch the strokes at all: they are at the bottom of the histogram, and the
 * clip only ever lowers values above the cut.
 *
 * A percentile rather than a fixed level, because the crop's own exposure
 * decides what "bright" means, and a fixed 250 does nothing to a band that
 * saturates at 230.
 */
function clipHighlights(gray, percentile) {
  // Histogram rather than a sort: the crop is tens of thousands of pixels, this
  // runs per variant per read, and a 256-bin count answers the same question.
  const bins = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) bins[Math.max(0, Math.min(255, gray[i] | 0))]++;

  const target = gray.length * percentile;
  let seen = 0;
  let cut = 255;
  for (let bin = 0; bin < 256; bin++) {
    seen += bins[bin];
    if (seen >= target) {
      cut = bin;
      break;
    }
  }

  for (let i = 0; i < gray.length; i++) {
    if (gray[i] > cut) gray[i] = cut;
  }
}

function meanOf(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

function boxBlur(gray, width, height) {
  const out = new Float64Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          sum += gray[yy * width + xx];
          count++;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * Local mean and standard deviation over a square window, from integral images
 * of the values and of their squares.
 */
function localStatistics(gray, width, height, windowFraction) {
  const iw = width + 1;
  const sums = new Float64Array(iw * (height + 1));
  const squares = new Float64Array(iw * (height + 1));

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    let rowSquare = 0;
    for (let x = 0; x < width; x++) {
      const value = gray[y * width + x];
      rowSum += value;
      rowSquare += value * value;
      sums[(y + 1) * iw + (x + 1)] = sums[y * iw + (x + 1)] + rowSum;
      squares[(y + 1) * iw + (x + 1)] = squares[y * iw + (x + 1)] + rowSquare;
    }
  }

  const radius = Math.max(4, Math.round((height * windowFraction) / 2));
  const mean = new Float64Array(gray.length);
  const deviation = new Float64Array(gray.length);

  const window = (table, x0, y0, x1, y1) =>
    table[(y1 + 1) * iw + (x1 + 1)] -
    table[y0 * iw + (x1 + 1)] -
    table[(y1 + 1) * iw + x0] +
    table[y0 * iw + x0];

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);

      const sum = window(sums, x0, y0, x1, y1);
      const square = window(squares, x0, y0, x1, y1);
      const m = sum / area;
      const p = y * width + x;
      mean[p] = m;
      // Clamped because floating-point cancellation can push a flat window
      // fractionally below zero.
      deviation[p] = Math.sqrt(Math.max(0, square / area - m * m));
    }
  }

  return { mean, deviation };
}
