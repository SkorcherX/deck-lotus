/**
 * Finding the card by its outline, with OpenCV.
 *
 * ── Why this replaced the hand-rolled detector ───────────────────────────────
 * The previous one searched perpendicular to each of a quad's four edges for
 * the strongest intensity step, refined the four fitted lines, and intersected
 * them for corners. It measured beautifully on synthetic frames — edge
 * strengths of 164 to 173, corners within 0.7% of the card — and could not scan
 * a single real card.
 *
 * A diagnostics recording said why. Profiling a real photograph down the middle
 * of the card, the strongest intensity steps are the art window's border and
 * the type line; the card's own top and bottom edges against the desk do not
 * make the top fourteen. Its outline reads 22 to 53 where the synthetic
 * fixtures read 164. Seeded at the card's exact true corners, the refinement
 * still drifted to 3-4% — and the perceptual hash needs about 1%, because a
 * capture framed 2% off sits 92 bits of 256 from its own reference.
 *
 * The mistake was tuning geometry against test data far cleaner than reality,
 * and no amount of tuning fixes it: a per-edge gradient search asks "where is
 * the strongest step near here", and on a real card the honest answer is "the
 * art box".
 *
 * ── What this does instead ──────────────────────────────────────────────────
 * Contours. Threshold the frame into regions, trace their boundaries, and keep
 * the ones that simplify to four corners with a card's proportions. A contour
 * is a closed region's whole boundary, so it cannot be assembled out of four
 * unrelated edges the way the old detector's quads were — the art box traces
 * its own contour, entirely inside the card's, and the two never mix. It also
 * does not care that one border is faint, as long as the region closes.
 *
 * Two thresholdings are tried, because cards fail in opposite directions: a
 * dark-bordered card on a pale desk and a white-bordered card on a dark mat
 * need opposite polarities, and a foil under a lamp needs the adaptive one.
 * Whichever produces the better-scoring card-shaped quad wins.
 */

/**
 * OpenCV arrives as a promise and weighs about 13MB, so it is fetched once, on
 * first use, and never at page load — someone who never opens the scanner never
 * pays for it. Everything here degrades to "no detection" until it resolves,
 * which the caller already handles: no card found means no capture taken.
 */
let cvPromise = null;
let cv = null;

export function isReady() {
  return cv !== null;
}

export async function load() {
  if (cv) return cv;

  if (!cvPromise) {
    // Loaded with a script tag from our own origin rather than imported.
    //
    // It is an emscripten build that reaches for `fs` and `crypto` on its Node
    // path, and the bundler fails outright trying to resolve those for the
    // browser. As a plain file none of that is reachable. It is also 13MB, which
    // has no business inside the main bundle, and the app is self-hosted and
    // expected to work with no internet — so it is staged into public/ at build
    // time by client/scripts/copy-ocr-assets.mjs, exactly as tesseract is.
    cvPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/opencv/opencv.js';
      script.async = true;
      script.onload = () => resolve(window.cv);
      script.onerror = () => reject(new Error('could not fetch /opencv/opencv.js'));
      document.head.appendChild(script);
    })
      // The global is a promise of the runtime, not the runtime: emscripten has
      // to instantiate the wasm before a single call is safe.
      .then((instance) => (instance && typeof instance.then === 'function' ? instance : Promise.resolve(instance)))
      .then((instance) => {
        cv = instance;
        return instance;
      })
      .catch((error) => {
        // cvPromise is left set so this is not retried every frame. The scanner
        // reports no card, which is the honest state and already means "do not
        // capture" everywhere downstream.
        console.error('OpenCV failed to load — card detection is unavailable', error);
        return null;
      });
  }

  return cvPromise;
}

/** Magic card proportions, 63mm x 88mm. Kept local so this module stands alone. */
const CARD_ASPECT = 63 / 88;

/**
 * Order four corners as top-left, top-right, bottom-right, bottom-left.
 *
 * findContours returns them in traversal order starting anywhere and running
 * either way round, and everything downstream — the projective map, the crop
 * regions, the hash's art window — assumes this exact order. Getting it wrong
 * produces a rectified card that is upside down or mirrored, hashes cleanly,
 * and matches nothing.
 *
 * By sum and difference of coordinates rather than by angle: the top-left has
 * the smallest x+y and the top-right the largest x-y, which holds for any
 * rotation short of tipping the card past 45 degrees — and a card at 45 degrees
 * has no meaningful top-left anyway.
 */
function orderCorners(points) {
  const sum = points.map((p) => p.x + p.y);
  const diff = points.map((p) => p.x - p.y);

  const at = (values, pick) => points[values.indexOf(pick(...values))];

  return [
    at(sum, Math.min),
    at(diff, Math.max),
    at(sum, Math.max),
    at(diff, Math.min),
  ];
}

/** Quad area by the shoelace formula, in pixels. */
function quadArea(points) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * How far a quad's proportions are from a card's.
 *
 * Measured on the mean of opposite sides, so honest perspective — a card tilted
 * away from the lens has a genuinely shorter far edge — is not read as the
 * wrong shape.
 */
function aspectError(quad) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2;
  const height = (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2;
  if (height < 1e-6) return Infinity;

  // Both ways up. A card lying on its side is still a card, and rejecting it as
  // the wrong shape would be a strange way to fail.
  const ratio = width / height;
  return Math.min(
    Math.abs(ratio - CARD_ASPECT) / CARD_ASPECT,
    Math.abs(ratio - 1 / CARD_ASPECT) * CARD_ASPECT
  );
}

/** Every four-cornered, convex, card-shaped contour in a binary image. */
function quadsFromBinary(binary, frameArea, options) {
  const { minAreaFraction, maxAreaFraction, maxAspectError, epsilonFraction } = options;

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const found = [];

  try {
    // EXTERNAL: only outermost boundaries. The art window and the text box are
    // holes inside the card's region, and this drops them before they can be
    // considered — the failure mode that dogged the previous detector, removed
    // by construction rather than by scoring against it.
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();

      try {
        const area = cv.contourArea(contour);
        if (area < frameArea * minAreaFraction) continue;
        if (area > frameArea * maxAreaFraction) continue;

        // Simplify the traced boundary to its corners. The tolerance is a
        // fraction of the perimeter rather than a pixel count, so it means the
        // same thing for a card filling the frame and one held further away.
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, epsilonFraction * perimeter, true);

        if (approx.rows !== 4) continue;
        if (!cv.isContourConvex(approx)) continue;

        const points = [];
        for (let p = 0; p < 4; p++) {
          points.push({ x: approx.intAt(p, 0), y: approx.intAt(p, 1) });
        }

        const quad = orderCorners(points);
        const error = aspectError(quad);
        if (error > maxAspectError) continue;

        found.push({ quad, area: quadArea(quad), aspectError: error });
      } finally {
        approx.delete();
        contour.delete();
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }

  return found;
}

/**
 * Find the card in a frame.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} frame  RGBA
 * @returns {{quad: Array<{x,y}>, area: number, aspectError: number,
 *            via: string} | null}
 *   Corners as fractions of the frame, ordered top-left clockwise. Null when no
 *   card is found — which the caller must treat as "do not capture", never as
 *   "use the last one".
 */
export function detectCardContour(frame, options = {}) {
  if (!cv) return null;

  const {
    minAreaFraction = 0.04,
    maxAreaFraction = 0.95,
    maxAspectError = 0.16,
    epsilonFraction = 0.02,
    blur = 5,
  } = options;

  const source = cv.matFromImageData(frame);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const frameArea = frame.width * frame.height;
  const shared = { minAreaFraction, maxAreaFraction, maxAspectError, epsilonFraction };

  let best = null;

  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    // Blur before thresholding: card art is detailed, and without this the
    // illustration fragments into hundreds of little contours that cost time
    // and can only ever be rejected.
    cv.GaussianBlur(gray, blurred, new cv.Size(blur, blur), 0);

    const attempts = [
      // Otsu, both polarities. A single global threshold is the right tool when
      // the card and its background differ in overall brightness, which is the
      // common case on a desk, and it is cheap.
      ['otsu', () => {
        const binary = new cv.Mat();
        cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        return binary;
      }],
      ['otsu-inverted', () => {
        const binary = new cv.Mat();
        cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        return binary;
      }],
      // Canny, closed. Where the card and the desk are of similar brightness a
      // global threshold has nothing to separate, but the border is still a
      // gradient; dilating closes the gaps a faint edge leaves so the region
      // encloses and can be traced.
      ['edges', () => {
        const edges = new cv.Mat();
        const closed = new cv.Mat();
        try {
          cv.Canny(blurred, edges, 40, 120);
          const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
          cv.dilate(edges, closed, kernel);
          kernel.delete();
          return closed.clone();
        } finally {
          edges.delete();
          closed.delete();
        }
      }],
    ];

    for (const [via, build] of attempts) {
      const binary = build();

      try {
        for (const candidate of quadsFromBinary(binary, frameArea, shared)) {
          // Bigger is better, squarer-to-a-card breaks ties. A card's own
          // outline is the largest card-shaped region in the picture; anything
          // larger than maxAreaFraction is the desk or the frame itself, which
          // is what that bound is for.
          const score = candidate.area * (1 - Math.min(1, candidate.aspectError / maxAspectError) * 0.4);
          if (!best || score > best.score) best = { ...candidate, score, via };
        }
      } finally {
        binary.delete();
      }
    }
  } finally {
    source.delete();
    gray.delete();
    blurred.delete();
  }

  if (!best) return null;

  return {
    quad: best.quad.map((p) => ({ x: p.x / frame.width, y: p.y / frame.height })),
    area: best.area / frameArea,
    aspectError: best.aspectError,
    via: best.via,
  };
}
