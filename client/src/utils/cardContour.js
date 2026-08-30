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
 * Three thresholdings are tried, because cards fail in different directions: a
 * dark-bordered card on a pale desk and a white-bordered card on a dark mat
 * need opposite polarities of Otsu, and a card the same brightness as the desk
 * needs the gradient instead. Whichever produces the better-scoring card-shaped
 * quad wins.
 *
 * ── There is no adaptive attempt, and that is now a measurement ──────────────
 * This header used to end "and a foil under a lamp needs the adaptive one",
 * describing a fourth attempt that was never written. It was built and measured
 * in client/lab/contour-lab.html, against a glare stripe drawn across a card of
 * known corners, and it does not earn its place:
 *
 *   - It does not answer the case it was proposed for. On a dark card with a
 *     specular band across it, `cv.adaptiveThreshold` found nothing at all, at
 *     every block size and constant tried.
 *   - It is worse where the others already work: +3.57% of card width against
 *     Otsu's -0.40% on a pale card, at its own best parameters. A 2% framing
 *     error puts a capture 92 bits of 256 from its reference.
 *   - It cannot be added safely anyway. The attempts are scored by area, so a
 *     looser threshold wins by being looser — added as a fourth pass at its
 *     default parameters it *took* scenes Otsu had right and framed them 9.51%
 *     too large.
 *   - It costs. Three attempts run in ~3.8ms on the lab's frames; four ran in
 *     ~12.6ms, and detection already answers only 3.6 times a second on a phone.
 *
 * What it would have needed is not a parameter: a fallback that runs only when
 * the others fail would never fire, because on those scenes they do not fail,
 * they succeed at the wrong thing — see the note on the art box in
 * docs/SCAN_PIPELINE_PLAN.md.
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

/** Where the runtime is staged. See the note in load() about the script tag. */
const CV_URL = '/opencv/opencv.js';

/**
 * Fetch the runtime, reporting bytes as they arrive, and hand back a URL a
 * script tag can run.
 *
 * The plain `<script src>` below cannot say how far along it is — there is no
 * progress event on a script tag — and on a phone 13MB is long enough that a
 * silent wait reads as a broken page. People put a card under the lens and
 * wonder why nothing happens. Streaming the response instead gives real byte
 * counts, and the finished bytes become a blob the script tag runs exactly as
 * it would have run the URL.
 *
 * Safe here specifically because this build is self-contained: it names no
 * sibling `.wasm` to fetch, so nothing inside it resolves a path relative to
 * its own URL and a blob: origin changes nothing. A build that did would have
 * to keep the direct URL and give up the progress.
 *
 * Returns null rather than throwing if anything about the streaming path is
 * unavailable — no `Content-Length`, no readable stream, a failed fetch — and
 * the caller falls back to loading the URL directly. Progress is a convenience;
 * it must never be the reason the scanner does not start.
 */
async function fetchWithProgress(onProgress) {
  try {
    const response = await fetch(CV_URL);
    if (!response.ok || !response.body) return null;

    // X-Uncompressed-Length first: the response is gzipped, which strips
    // Content-Length, and `fetch` hands back decompressed bytes anyway — so the
    // size on disk is both the only number available and the right one to count
    // against. See setUncompressedLength in src/server.js.
    const total =
      Number(response.headers.get('X-Uncompressed-Length')) ||
      Number(response.headers.get('Content-Length')) ||
      0;
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      // Indeterminate where the server did not say how big it is, rather than
      // a fabricated percentage that sticks or runs past 100.
      onProgress?.({ loaded, total, progress: total ? loaded / total : null });
    }

    return URL.createObjectURL(new Blob(chunks, { type: 'text/javascript' }));
  } catch {
    return null;
  }
}

/**
 * Load the detector, optionally reporting download progress.
 *
 * `onProgress` is only ever called for the first caller to ask — the load
 * happens once and later callers join the same promise, by which point the
 * bytes are already in. Callers wanting to know whether they are early should
 * check isReady() first.
 */
export async function load({ onProgress = null } = {}) {
  if (cv) return cv;

  if (!cvPromise) {
    // In a worker there is no document to hang a script tag on. The runtime is
    // imported instead — and it survives that, which is not obvious: it is a
    // UMD file, and its last branch assigns `globalThis.cv` for shells with
    // neither `window` nor `importScripts`, which is exactly a module worker.
    // Module scope would swallow a plain `var cv`; an explicit assignment to
    // globalThis comes through.
    //
    // The blob keeps the progress reporting: 13MB is long enough that a silent
    // wait reads as a broken scanner, in a worker no less than on the page.
    // @vite-ignore keeps the bundler from trying to follow a runtime URL into
    // an emscripten build it cannot resolve — the same reason the page loads it
    // through a tag rather than importing it.
    if (typeof document === 'undefined') {
      cvPromise = fetchWithProgress(onProgress)
        .then(async (objectUrl) => {
          await import(/* @vite-ignore */ objectUrl || CV_URL);
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return globalThis.cv;
        })
        .then(instantiate)
        .catch(reportLoadFailure);

      return cvPromise;
    }

    // Loaded with a script tag from our own origin rather than imported.
    //
    // It is an emscripten build that reaches for `fs` and `crypto` on its Node
    // path, and the bundler fails outright trying to resolve those for the
    // browser. As a plain file none of that is reachable. It is also 13MB, which
    // has no business inside the main bundle, and the app is self-hosted and
    // expected to work with no internet — so it is staged into public/ at build
    // time by client/scripts/copy-ocr-assets.mjs, exactly as tesseract is.
    cvPromise = fetchWithProgress(onProgress)
      .then((objectUrl) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = objectUrl || CV_URL;
        script.async = true;
        script.onload = () => {
          // Only after the script has run: revoking earlier can pull the source
          // out from under a parse still in progress.
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          resolve(window.cv);
        };
        script.onerror = () => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          reject(new Error(`could not fetch ${CV_URL}`));
        };
        document.head.appendChild(script);
      }))
      .then(instantiate)
      .catch(reportLoadFailure);
  }

  return cvPromise;
}

/**
 * The global is a promise of the runtime, not the runtime: emscripten has to
 * instantiate the wasm before a single call is safe.
 */
function instantiate(instance) {
  return Promise.resolve(instance).then((ready) => {
    cv = ready;
    return ready;
  });
}

/**
 * cvPromise is left set by the caller so a failure is not retried every frame.
 * The scanner reports no card, which is the honest state and already means "do
 * not capture" everywhere downstream.
 */
function reportLoadFailure(error) {
  console.error('OpenCV failed to load — card detection is unavailable', error);
  return null;
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

/** Whether any corner sits on the boundary of a width x height image. */
function touchesEdge(quad, width, height, slack = 1) {
  return quad.some(
    (p) => p.x <= slack || p.y <= slack || p.x >= width - 1 - slack || p.y >= height - 1 - slack
  );
}

/**
 * Every four-cornered, convex, card-shaped contour in a binary image.
 *
 * `frameArea` is always the *whole* frame's area, even when the binary is a
 * tracked crop of it: the area bounds say how much of the picture a card may
 * occupy, and rescaling them to the crop would reject the card for filling the
 * window drawn around it.
 */
function quadsFromBinary(binary, frameArea, options) {
  const { minAreaFraction, maxAreaFraction, maxAspectError, epsilonFraction, cropped = false } =
    options;

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

        // A contour running along the edge of a tracked crop is not a card, it
        // is the crop: the card carried on past the window, and what closed the
        // region was the boundary of the search. Taking it would hand back a
        // quad shaped by the padding rather than by the card, and tracking
        // would then walk the framing further off with every frame.
        if (cropped && touchesEdge(quad, binary.cols, binary.rows)) continue;

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
 * The window to search when the last frame found a card, in pixels.
 *
 * Padded by a share of the card's own size rather than a fixed number of
 * pixels, so it means the same thing for a card filling the frame and one held
 * further away. It has to be generous: a card whose true border falls outside
 * this window has its contour closed by the window instead, which is the one
 * way tracking can quietly change the answer. quadsFromBinary throws those out
 * — see the `cropped` check — and this padding is what stops that happening in
 * the first place.
 */
function trackedBounds(hint, frame, padding) {
  const xs = hint.map((p) => p.x * frame.width);
  const ys = hint.map((p) => p.y * frame.height);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);

  const padX = (x1 - x0) * padding;
  const padY = (y1 - y0) * padding;

  const left = Math.max(0, Math.floor(x0 - padX));
  const top = Math.max(0, Math.floor(y0 - padY));
  const right = Math.min(frame.width, Math.ceil(x1 + padX));
  const bottom = Math.min(frame.height, Math.ceil(y1 + padY));

  if (right - left < 16 || bottom - top < 16) return null;
  return new cv.Rect(left, top, right - left, bottom - top);
}

/**
 * Find the card in a frame.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} frame  RGBA
 * @param {{hint?: Array<{x,y}>}} options
 *   `hint` is the quad the previous frame found, in frame fractions. Given one,
 *   the search runs inside a padded window around it and skips the Canny
 *   attempt — a card that was there 100ms ago is still there, and its region
 *   separates by brightness inside a window that is mostly card. The full sweep
 *   runs anyway the moment the tracked one finds nothing, so a hint can only
 *   cost a frame, never lose the card.
 *
 *   The thing to be afraid of here is not speed but drift: a hint that moves
 *   the answer even slightly would walk the framing further off every frame,
 *   and a capture taken on the tenth would be cut somewhere the card never was.
 *   Measured in client/lab/contour-lab.html, feeding each answer back in as the
 *   next frame's hint for sixty frames, the quad moved at most 1px in total and
 *   was never lost. A single tracked frame agrees with a cold sweep to within
 *   1px, at 1.3-2.3ms against 3.7-8.1ms. A hint aimed at the wrong corner, and
 *   one whose window cuts through the card, both come back identical to the
 *   cold answer — the first because tracking finds nothing and sweeps, the
 *   second because a contour closed by the window is thrown out.
 * @returns {{quad: Array<{x,y}>, area: number, aspectError: number,
 *            via: string, tracked: boolean} | null}
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
    hint = null,
    hintPadding = 0.16,
  } = options;

  const source = cv.matFromImageData(frame);
  const window = hint && hint.length === 4 ? trackedBounds(hint, frame, hintPadding) : null;
  // A view, not a copy: every pass below then runs over the window's pixels
  // instead of the frame's, which is where the saving is.
  const searched = window ? source.roi(window) : source;
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const frameArea = frame.width * frame.height;
  const shared = {
    minAreaFraction,
    maxAreaFraction,
    maxAspectError,
    epsilonFraction,
    cropped: !!window,
  };

  let best = null;

  try {
    cv.cvtColor(searched, gray, cv.COLOR_RGBA2GRAY);
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
      // gradient; bridging the gaps a faint edge leaves is what lets the region
      // enclose and be traced.
      //
      // Closed, not merely dilated. A bare dilate bridges the gaps and then
      // leaves the edge line two pixels fatter in every direction, and the
      // contour traced around it is the *outside* of that fattened line — so
      // every quad this attempt produced sat a couple of pixels outside the
      // card it found. That is a uniform outward bias, and the framing ladder
      // has been carrying it: FRAMING_PROBES exists because captures match
      // best when pulled *inward*, its basin sitting at 0.92-0.98 rather than
      // on the framing detection actually reported. Eroding back by the same
      // kernel keeps the bridges — a gap filled by dilation is narrower than
      // the kernel and does not reopen — and puts the boundary back where the
      // gradient was.
      //
      // Measured in client/lab/contour-lab.html, which draws a card at known
      // corners and asks how far the detected quad sits outside them. Dilate
      // alone: +2.09px, +1.19% of card width, identical across three contrasts
      // and unmoved by noise or blur — a constant, exactly as a fixed kernel
      // predicts. Closed: -0.70px, -0.40%, which is the same figure the Otsu
      // attempts give and therefore the detector's own floor rather than
      // anything this path adds.
      //
      // A 2% framing error puts a capture 92 bits of 256 from its reference, so
      // 1.19% is a real share of the budget. It is not the whole of the ladder's
      // basin, though: FRAMING_PROBES is centred nearer 0.95 than 0.99, so
      // something else is still pulling outward on real cards. Do not narrow
      // the ladder on the strength of this — it wants a recorded session and
      // `scripts/scan-replay.mjs --sweep`.
      ['edges', () => {
        const edges = new cv.Mat();
        try {
          cv.Canny(blurred, edges, 40, 120);
          const closed = new cv.Mat();
          const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
          cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
          kernel.delete();
          // Returned directly rather than cloned: the clone was a whole extra
          // frame-sized copy per tick, and the caller deletes what it is given.
          return closed;
        } finally {
          edges.delete();
        }
      }],
    ];

    for (const [via, build] of attempts) {
      // Tracking skips the Canny attempt. It is the dearest of the three — a
      // gradient pass and a morphological close over every pixel — and it is
      // there for the case a global threshold cannot split the card from the
      // desk. Inside a window that is mostly card, that case has gone: the
      // histogram is bimodal by construction. If both Otsu polarities come up
      // empty the full sweep runs below anyway, Canny included.
      if (window && via === 'edges') continue;

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
    // The roi() view borrows the source's pixels and still owns a header.
    if (searched !== source) searched.delete();
    source.delete();
    gray.delete();
    blurred.delete();
  }

  // Tracking found nothing, so the card has moved, left, or was never where the
  // hint said. Sweep the whole frame before giving up — one wasted pass on the
  // frame a card arrives or departs on, against a tracked pass on all the rest.
  if (!best && window) {
    return detectCardContour(frame, { ...options, hint: null });
  }

  if (!best) return null;

  return {
    // Back into frame coordinates: the quad was found in the window's pixels.
    quad: best.quad.map((p) => ({
      x: (p.x + (window ? window.x : 0)) / frame.width,
      y: (p.y + (window ? window.y : 0)) / frame.height,
    })),
    area: best.area / frameArea,
    aspectError: best.aspectError,
    via: best.via,
    tracked: !!window,
  };
}
