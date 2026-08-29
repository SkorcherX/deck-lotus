/**
 * The scanner's view of card detection, wherever it actually runs.
 *
 * Detection moved into a worker (cardDetect.worker.js) because it was the one
 * thing in the preview loop long enough to be felt: on the main thread it
 * competes with the video and the overlay, and a tick that runs long is read
 * downstream as the card moving, since stillness is the difference between one
 * frame and the last.
 *
 * Two things follow from that, and they are the whole design here:
 *
 * 1. **The answer is asynchronous, so callers read the last one.** `detect` does
 *    not return a quad, it asks for one. `latest()` is what the loop draws and
 *    measures from, and it is at most one tick — 100ms — behind the picture.
 *    That is not a new class of staleness: detection has always run on the
 *    downscaled analysis frame while a capture reads a fresh full-resolution
 *    one, and captures are framed from a mean of recent quads rather than from
 *    a single detection.
 *
 * 2. **Frames are dropped, never queued.** With one request in flight at a time
 *    a slow device simply detects less often. A queue would let latency grow
 *    without bound and answer with quads describing where the card used to be,
 *    which is the one failure that produces a legible capture matching nothing.
 *
 * The worker is not required. Where one cannot be constructed — an environment
 * without module workers, a CSP that forbids them, a test harness — everything
 * falls back to detecting inline on the calling thread, and the only difference
 * a caller sees is that `detect` resolves before it returns.
 */
import { detectCardContour, isReady as inlineReady, load as loadInline } from './cardContour.js';

/** How many round trips the rolling latency figures are taken over. */
const TIMING_WINDOW = 32;

const state = {
  worker: null,
  /** null until we have tried, then true (worker) or false (inline). */
  usingWorker: null,
  ready: false,
  loading: null,
  pending: 0,
  nextId: 1,
  latest: null,
  onProgress: null,
  // When the in-flight request was posted, and the last few round trips.
  //
  // This exists because a recorded session showed every capture framed from a
  // detection more than 300ms old — on a loop asking twenty times a second,
  // against 3.84ms for the same detection measured inline on a desktop. A quad
  // that old describes where the card was, not where it is, and nothing else in
  // a bundle would have said so. Guessing at the cause is what this is here to
  // stop.
  sentAt: 0,
  timings: [],
};

function startWorker() {
  try {
    // Vite rewrites this URL at build time; a bare path would not survive
    // hashing. A module worker, because a classic one cannot carry the imports
    // this worker needs in dev — Vite only bundles those for a production
    // build, and the dev server serves the file as it is written. The OpenCV
    // runtime loads fine either way; see the worker branch of cardContour.load.
    return new Worker(new URL('../workers/cardDetect.worker.js', import.meta.url), {
      type: 'module',
    });
  } catch (error) {
    console.warn('card detection worker unavailable, running inline', error);
    return null;
  }
}

/** Whether detection can answer at all yet. */
export function isReady() {
  return state.usingWorker === false ? inlineReady() : state.ready;
}

/** The most recent detection, or null. Never a stale quad: see reset(). */
export function latest() {
  return state.latest;
}

/**
 * Forget where the card was.
 *
 * Called when the camera stops, so a session cannot open with the quad the last
 * one ended on — a stale quad is how a capture comes out legible and matches
 * nothing.
 */
export function reset() {
  state.latest = null;
}

/** Load the detector, reporting download progress as it arrives. */
export function load({ onProgress = null } = {}) {
  if (state.loading) return state.loading;

  const worker = startWorker();

  if (!worker) {
    state.usingWorker = false;
    state.loading = loadInline({ onProgress }).then((cv) => {
      state.ready = !!cv;
      return state.ready;
    });
    return state.loading;
  }

  state.worker = worker;
  state.usingWorker = true;
  state.onProgress = onProgress;

  state.loading = new Promise((resolve) => {
    worker.onmessage = (event) => {
      const message = event.data || {};

      if (message.type === 'progress') {
        state.onProgress?.(message.progress);
        return;
      }

      if (message.type === 'ready' || message.type === 'failed') {
        state.ready = message.type === 'ready';
        resolve(state.ready);
        return;
      }

      if (message.type === 'detected') {
        state.pending--;
        if (state.sentAt) {
          state.timings.push(performance.now() - state.sentAt);
          if (state.timings.length > TIMING_WINDOW) state.timings.shift();
        }
        // Only the newest request may set the answer. A late reply from a
        // request that was already superseded describes an older frame.
        if (message.id === state.nextId - 1) state.latest = message.result;
      }
    };

    worker.onerror = (error) => {
      console.error('card detection worker failed', error);
      state.ready = false;
      resolve(false);
    };

    worker.postMessage({ type: 'load' });
  });

  return state.loading;
}

/**
 * Ask for a detection on this frame. Returns immediately.
 *
 * `frame` is copied, not transferred: the caller warps the same buffer for its
 * own metrics on the very next line, and a transferred buffer would be detached
 * out from under it. At the analysis size that copy is a few hundred kilobytes
 * ten times a second, which costs far less than the pass it is buying.
 */
export function detect(frame, hint = null) {
  if (state.usingWorker === false) {
    state.latest = inlineReady() ? detectCardContour(frame, { hint }) : null;
    return;
  }

  if (!state.worker || !state.ready) return;

  // One in flight. A device that cannot keep up detects less often rather than
  // falling further behind on every frame.
  if (state.pending > 0) return;

  state.pending++;
  state.sentAt = performance.now();
  state.worker.postMessage({
    type: 'detect',
    id: state.nextId++,
    frame: { data: frame.data, width: frame.width, height: frame.height },
    hint,
  });
}

/**
 * What detection is costing, in the shape a bundle can carry.
 *
 * `mean` and `max` are round trips in milliseconds; `rate` is how often an
 * answer actually arrives, which is the number that decides how stale a
 * capture's framing can be — requests are dropped while one is in flight, so
 * the rate is one over the round trip rather than the loop's tick rate.
 */
export function timings() {
  if (!state.timings.length) return { samples: 0, mean: null, max: null, rate: null, worker: state.usingWorker };

  const total = state.timings.reduce((sum, ms) => sum + ms, 0);
  const mean = total / state.timings.length;
  return {
    samples: state.timings.length,
    mean: Math.round(mean * 10) / 10,
    max: Math.round(Math.max(...state.timings) * 10) / 10,
    rate: Math.round((1000 / mean) * 10) / 10,
    worker: state.usingWorker,
  };
}

/** Stop the worker. The next load() starts a fresh one. */
export function stop() {
  state.worker?.terminate();
  state.worker = null;
  state.usingWorker = null;
  state.ready = false;
  state.loading = null;
  state.pending = 0;
  state.latest = null;
}
