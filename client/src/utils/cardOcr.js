import { createWorker } from 'tesseract.js';

/**
 * Reading the two crops a capture produces.
 *
 * Everything runs client-side: no card image is ever uploaded, and every asset
 * tesseract loads is served from our own origin, because the app is self-hosted
 * and expected to work with no internet at all.
 *
 * The parsing half is deliberately separate from the recognition half and takes
 * plain text, so it can be tested without a WASM engine or a camera.
 */

const ASSET_BASE = '/tesseract';

// Page segmentation modes. The crops are known shapes, so telling tesseract what
// to expect is worth more here than any amount of preprocessing: the title band
// is one line, the collector block is a small paragraph of two.
const PSM_SINGLE_LINE = '7';
const PSM_BLOCK = '6';

// Constraining the character set per region is the single biggest accuracy lever
// available. A collector block cannot contain a letter that is not a set code, a
// rarity or a language, so the whitelist says so.
const TITLE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ,.'-/";
// The space is not optional: a whitelist that omits it cannot emit one, and
// "DMU EN" comes back as "DMUEN" with the set code fused to the language.
const COLLECTOR_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/* ';

/** Rarity letters printed after the collector number. Never a set code. */
const RARITY_LETTERS = new Set(['C', 'U', 'R', 'M', 'S', 'T', 'L', 'P', 'B']);

/** Language codes printed on the second line. Never a set code either. */
const LANGUAGE_CODES = new Set(['EN', 'DE', 'FR', 'IT', 'ES', 'JA', 'JP', 'KO', 'PT', 'RU', 'ZH', 'CS', 'CT']);

/**
 * Does this browser have WebAssembly SIMD?
 *
 * We choose the core file ourselves rather than letting tesseract probe, because
 * its probe also asks for `relaxedsimd` builds that tesseract.js-core does not
 * ship — harmless with a CDN fallback, a hard failure without one.
 */
export function simdSupported() {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ])
    );
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------- preprocessing */

/**
 * Grayscale, denoise, then threshold with Sauvola's method.
 *
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
 *
 * @param {HTMLCanvasElement} source  an upscaled region crop
 * @param {object} [options]
 *   window   — fraction of the crop height to average over
 *   k        — Sauvola sensitivity; lower keeps more ink on low-contrast plates
 *   denoise  — smooth over a 3x3 window first, to stop sensor grain thresholding
 *              into speckle that OCR reads as punctuation
 *   grayscale — skip thresholding and hand tesseract contrast-stretched grey,
 *              letting its own binarizer decide
 *   invert   — force the polarity rather than inferring it
 */
export function preprocessForOcr(source, options = {}) {
  const {
    window: windowFraction = 0.6,
    k = 0.18,
    denoise = true,
    grayscale = false,
    invert = null,
  } = options;

  const { width, height } = source;
  const ctx = source.getContext('2d');
  const image = ctx.getImageData(0, 0, width, height);

  let gray = new Float64Array(width * height);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    gray[p] = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
  }

  if (denoise) gray = boxBlur(gray, width, height);

  const out = ctx.createImageData(width, height);

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
      out.data[di] = out.data[di + 1] = out.data[di + 2] = value;
      out.data[di + 3] = 255;
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
      out.data[di] = out.data[di + 1] = out.data[di + 2] = value;
      out.data[di + 3] = 255;
    }

    // Tesseract expects dark text on a light ground. The collector block is
    // white print on a dark border, which thresholds to the inverse of that, so
    // polarity is decided by which tone is in the minority — ink always is.
    const inverted = invert === null ? inkCount > width * height * 0.5 : invert;
    if (inverted) {
      for (let i = 0; i < out.data.length; i += 4) {
        const value = 255 - out.data[i];
        out.data[i] = out.data[i + 1] = out.data[i + 2] = value;
      }
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return canvas;
}

function meanOf(values) {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

/** 3x3 mean. Sensor grain on a dark card otherwise thresholds into speckle. */
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

/* ----------------------------------------------------------------- parsing */

/** Mean confidence of the words a field was read from, as 0..1. */
function meanConfidence(words) {
  const scores = (words || []).map((w) => w.confidence).filter((c) => typeof c === 'number');
  if (!scores.length) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length / 100;
}

/**
 * Pull a card name out of the title band.
 *
 * OCR on a single line of a serif face at this size mostly errs on punctuation
 * and stray marks from the frame, so the cleanup is conservative: collapse
 * whitespace, drop characters no card name uses, and leave the rest for the
 * resolver's fuzzy match to sort out.
 */
export function parseTitle(text, words) {
  const cleaned = (text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^A-Za-z0-9 ,.'\-\/]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A single stray character is noise, not a name.
  if (cleaned.length < 3) return { name: null, confidence: 0 };

  return { name: cleaned, confidence: meanConfidence(words) };
}

/**
 * Pull the collector number and set code out of the collector block.
 *
 * The block is two lines that look like `0123/281 R` and `DMU • EN Artist Name`,
 * but which parts survive OCR varies wildly, so this works by classifying
 * tokens rather than by matching a fixed shape.
 */
export function parseCollectorBlock(text, words) {
  const raw = (text || '').toUpperCase();
  const tokens = raw.split(/[^A-Z0-9/*★]+/).filter(Boolean);

  let collectorNumber = null;
  let setCode = null;

  // The number first: a slashed pair is unambiguous, and the part before the
  // slash is the collector number. Failing that, the longest run of digits.
  for (const token of tokens) {
    // Either half can pick up the trailing rarity letter, depending on where the
    // spacing lands: "0107/281 M" is often read as "0107/281M".
    const slashed = token.match(/^(\d+[A-Z★*]?)\/(\d+)[A-Z★*]?$/);
    if (slashed) {
      collectorNumber = slashed[1];
      break;
    }
  }
  if (!collectorNumber) {
    // Printed order is number then set total, so when the slash is lost the
    // first multi-digit token is the number rather than the longest one.
    const numeric = tokens.filter((t) => /^\d{2,}[A-Z★*]?$/.test(t));
    if (numeric.length) collectorNumber = numeric[0];
  }

  // Then the set code. Set codes can lead with a digit (4ED) and can contain
  // them (M21), so the shape is 2-4 characters with at least one letter and not
  // all digits — which would be the collector number or the set total.
  const looksLikeSetCode = (t) =>
    /^[A-Z0-9]{2,4}$/.test(t) && /[A-Z]/.test(t) && !LANGUAGE_CODES.has(t);

  // The block prints "SET • EN", so the set code is the token before the
  // language code. This beats every heuristic based on length: the same line
  // carries the artist's name, and "SIMON" is a longer all-letter token than
  // "WAR".
  //
  // The search walks backwards rather than checking only the immediate
  // neighbour, because the bullet between them often survives OCR as a stray
  // token. Measured on a real capture reading "JR SNC 2 EN MATTEO BA", the
  // bullet came through as "2" and the correct "SNC" sat one place further
  // back.
  const languageAt = tokens.findIndex((t) => LANGUAGE_CODES.has(t));
  if (languageAt > 0) {
    for (let i = languageAt - 1; i >= 0 && i >= languageAt - 3; i--) {
      if (looksLikeSetCode(tokens[i])) {
        setCode = tokens[i];
        break;
      }
    }
  }

  // With no language code read, position cannot be trusted at all: leading junk
  // is common (that capture began with a spurious "JR") and the artist's name
  // trails behind ("BA"). Length is the better signal — the overwhelming
  // majority of printed set codes are three characters, and two-character
  // tokens are usually debris from the rarity letter or an initial.
  if (!setCode) {
    const shaped = tokens.filter(looksLikeSetCode);
    for (const length of [3, 4, 2]) {
      const match = shaped.find((t) => t.length === length);
      if (match) {
        setCode = match;
        break;
      }
    }
  }

  // Last resort: spacing on this line is small and frequently lost altogether,
  // fusing everything into one run like "DMUENCRR". The language code is the
  // anchor — whatever precedes it is the set code.
  if (!setCode) {
    for (const token of tokens) {
      if (token.length < 4) continue;
      for (const language of LANGUAGE_CODES) {
        const at = token.indexOf(language);
        if (at >= 2 && at <= 4) {
          const candidate = token.slice(0, at);
          if (looksLikeSetCode(candidate)) {
            setCode = candidate;
            break;
          }
        }
      }
      if (setCode) break;
    }
  }

  // Score each field from the word it was actually read from. Averaging the whole
  // block instead drags a good field down with the junk beside it: the artist
  // name shares this line, and "M P" read at 20% should not make a clean "ICE"
  // look like a coin flip.
  const confidenceFor = (value) => {
    if (!value) return 0;
    const needle = value.toUpperCase();
    const match = (words || []).find((w) =>
      (w.text || '').toUpperCase().replace(/\s+/g, '').includes(needle)
    );
    return match ? (match.confidence || 0) / 100 : meanConfidence(words);
  };

  return {
    collectorNumber,
    setCode,
    collectorConfidence: confidenceFor(collectorNumber),
    setConfidence: confidenceFor(setCode),
    // Kept as the block-level score, for callers that want one number for the
    // whole read rather than one per field.
    confidence: collectorNumber && setCode ? meanConfidence(words) : meanConfidence(words) * 0.6,
    tokens,
  };
}

/** Short label for a preprocessing variant, for the diagnostics panel. */
function describeVariant(preprocess = {}) {
  if (preprocess.grayscale) return 'grayscale';
  if (preprocess.k !== undefined && preprocess.k <= 0.1) return 'low-contrast';
  return 'default';
}

/* ------------------------------------------------------------------ reader */

/**
 * A tesseract worker plus the per-region settings, created once and reused.
 *
 * The first call downloads ~17MB of engine and language data from our own
 * origin, so creation is lazy and reports progress — a scan session should not
 * pay that cost until it actually reads something.
 */
export function createCardReader({ onProgress } = {}) {
  let worker = null;
  let starting = null;

  async function ensureWorker() {
    if (worker) return worker;
    if (starting) return starting;

    const core = simdSupported()
      ? `${ASSET_BASE}/tesseract-core-simd-lstm.wasm.js`
      : `${ASSET_BASE}/tesseract-core-lstm.wasm.js`;

    starting = createWorker('eng', 1, {
      workerPath: `${ASSET_BASE}/worker.min.js`,
      corePath: core,
      langPath: ASSET_BASE,
      gzip: true,
      logger: (message) => onProgress?.(message),
    }).then((created) => {
      worker = created;
      starting = null;
      return worker;
    });

    return starting;
  }

  async function recognizeRegion(canvas, { psm, whitelist, preprocess }) {
    const engine = await ensureWorker();
    const image = preprocess ? preprocessForOcr(canvas, preprocess) : canvas;

    await engine.setParameters({
      tessedit_pageseg_mode: psm,
      tessedit_char_whitelist: whitelist,
    });

    // Words only come back when blocks are requested, and their confidences are
    // what per-field scoring is built on.
    const { data } = await engine.recognize(image, {}, { text: true, blocks: true });

    const words = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          words.push(...(line.words || []));
        }
      }
    }

    return {
      text: data.text || '',
      words,
      // Some builds return no block tree at all; the whole-image confidence is a
      // coarser but always-present stand-in.
      fallbackConfidence: typeof data.confidence === 'number' ? data.confidence : 0,
      preprocessed: image,
    };
  }

  /**
   * Try preprocessing variants until one is clearly good enough, and keep the
   * best.
   *
   * A single fixed pipeline cannot serve both a white card and a black one: the
   * settings that pull dark text off a dark plate over-ink a light one. Rather
   * than guess per card, read with the default, and only if that scores poorly
   * spend more time on the alternatives. Good cards still cost one pass.
   */
  async function readBest(canvas, { psm, whitelist, variants, score }) {
    let best = null;

    for (const preprocess of variants) {
      const result = await recognizeRegion(canvas, { psm, whitelist, preprocess });
      const value = score(result);

      if (!best || value > best.value) best = { result, value, preprocess };
      // Good enough to stop paying for further attempts.
      if (best.value >= 0.9) break;
    }

    return best;
  }

  /** Word confidences when available, otherwise one synthetic whole-image score. */
  function wordsOrFallback(result) {
    if (result.words.length) return result.words;
    return result.fallbackConfidence ? [{ confidence: result.fallbackConfidence }] : [];
  }

  return {
    /**
     * Read one capture.
     *
     * @param {{title: HTMLCanvasElement, collector: HTMLCanvasElement}} capture
     * @returns {Promise<{name, setCode, collectorNumber, confidence, raw, images}>}
     */
    async read(capture) {
      const started = performance.now();

      // The collector block is read first: it is the higher-signal field, and on
      // a modern card it alone resolves the printing.
      const collectorAttempt = await readBest(capture.collector, {
        psm: PSM_BLOCK,
        whitelist: COLLECTOR_CHARS,
        // A tighter window than the title: two short lines of small print, where
        // a wide average washes the strokes out.
        variants: [
          { window: 0.35 },
          { window: 0.35, k: 0.08 },
          { window: 0.35, grayscale: true },
        ],
        score: (result) => {
          const parsed = parseCollectorBlock(result.text, wordsOrFallback(result));
          // A collector block is judged on whether it yielded fields, not on how
          // confident tesseract felt about the artist's initials.
          return (parsed.collectorNumber ? 0.5 : 0) + (parsed.setCode ? 0.5 : 0);
        },
      });
      const collectorResult = collectorAttempt.result;
      const collector = parseCollectorBlock(
        collectorResult.text,
        wordsOrFallback(collectorResult)
      );

      const titleAttempt = await readBest(capture.title, {
        psm: PSM_SINGLE_LINE,
        whitelist: TITLE_CHARS,
        variants: [
          { window: 0.8 },
          { window: 0.8, k: 0.08 },
          { window: 0.8, grayscale: true },
        ],
        score: (result) => {
          const parsed = parseTitle(result.text, wordsOrFallback(result));
          return parsed.name ? parsed.confidence : 0;
        },
      });
      const titleResult = titleAttempt.result;
      const title = parseTitle(titleResult.text, wordsOrFallback(titleResult));

      return {
        name: title.name,
        setCode: collector.setCode,
        collectorNumber: collector.collectorNumber,
        confidence: {
          name: Math.round(title.confidence * 100) / 100,
          setCode: Math.round(collector.setConfidence * 100) / 100,
          collectorNumber: Math.round(collector.collectorConfidence * 100) / 100,
          block: Math.round(collector.confidence * 100) / 100,
        },
        raw: {
          title: titleResult.text.trim(),
          collector: collectorResult.text.trim(),
          tokens: collector.tokens,
        },
        images: {
          title: titleResult.preprocessed,
          collector: collectorResult.preprocessed,
        },
        elapsedMs: Math.round(performance.now() - started),
        // Which preprocessing actually won, so the tuning panel can show whether
        // a card needed the low-contrast path.
        strategy: {
          title: describeVariant(titleAttempt.preprocess),
          collector: describeVariant(collectorAttempt.preprocess),
        },
      };
    },

    async terminate() {
      if (worker) {
        await worker.terminate();
        worker = null;
      }
    },

    get ready() {
      return !!worker;
    },
  };
}
