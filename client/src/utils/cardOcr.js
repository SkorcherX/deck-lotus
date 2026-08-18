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
 * Grayscale, then threshold against a local mean.
 *
 * A global threshold is the wrong tool for a card under a desk lamp: one end of
 * the crop is often twice as bright as the other, and any single cutoff either
 * loses the dark end or floods the bright one. The local mean comes from an
 * integral image, so the window size costs nothing.
 *
 * @param {HTMLCanvasElement} source  an upscaled region crop
 * @param {{window?: number, offset?: number}} [options]
 *   window — fraction of the crop height to average over
 *   offset — how far below the local mean a pixel must fall to count as ink
 */
export function preprocessForOcr(source, options = {}) {
  const { window: windowFraction = 0.6, offset = 8 } = options;
  const { width, height } = source;

  const ctx = source.getContext('2d');
  const image = ctx.getImageData(0, 0, width, height);
  const gray = new Float64Array(width * height);

  for (let i = 0, p = 0; i < image.data.length; i += 4, p++) {
    gray[p] = image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114;
  }

  // Integral image, one row and column of padding so every window lookup is
  // four array reads with no bounds special-casing.
  const iw = width + 1;
  const integral = new Float64Array(iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }

  const radius = Math.max(4, Math.round((height * windowFraction) / 2));
  const out = ctx.createImageData(width, height);
  let inkCount = 0;

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);

      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];

      const isInk = gray[y * width + x] < sum / area - offset;
      if (isInk) inkCount++;

      const value = isInk ? 0 : 255;
      const di = (y * width + x) * 4;
      out.data[di] = value;
      out.data[di + 1] = value;
      out.data[di + 2] = value;
      out.data[di + 3] = 255;
    }
  }

  // Tesseract expects dark text on a light ground. The collector block is white
  // print on a dark border, which thresholds to the inverse of that, so polarity
  // is decided by which colour is in the minority — ink always is.
  const inverted = inkCount > width * height * 0.5;
  if (inverted) {
    for (let i = 0; i < out.data.length; i += 4) {
      const value = 255 - out.data[i];
      out.data[i] = value;
      out.data[i + 1] = value;
      out.data[i + 2] = value;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(out, 0, 0);
  canvas.dataset.inverted = String(inverted);
  return canvas;
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

  // The block prints "SET • EN", so the token before the language code is the
  // set code. This beats every heuristic based on length: the same line carries
  // the artist's name, and "SIMON" is a longer all-letter token than "WAR".
  const languageAt = tokens.findIndex((t) => LANGUAGE_CODES.has(t));
  if (languageAt > 0 && looksLikeSetCode(tokens[languageAt - 1])) {
    setCode = tokens[languageAt - 1];
  }

  // With no language code read, fall back to the first token of the right shape.
  // A lone rarity letter is excluded by the two-character minimum.
  if (!setCode) {
    setCode = tokens.find(looksLikeSetCode) || null;
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
      const collectorResult = await recognizeRegion(capture.collector, {
        psm: PSM_BLOCK,
        whitelist: COLLECTOR_CHARS,
        // A tighter window than the title: two short lines of small print, where
        // a wide average washes the strokes out.
        preprocess: { window: 0.35, offset: 10 },
      });
      const collector = parseCollectorBlock(
        collectorResult.text,
        wordsOrFallback(collectorResult)
      );

      const titleResult = await recognizeRegion(capture.title, {
        psm: PSM_SINGLE_LINE,
        whitelist: TITLE_CHARS,
        preprocess: { window: 0.8, offset: 8 },
      });
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
