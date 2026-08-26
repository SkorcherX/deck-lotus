/**
 * Recording what a scan actually saw, so it can be looked at afterwards.
 *
 * This exists because of how the scanner's worst bugs were found. The art hash
 * threw on every capture for weeks — the throw was caught, stored in a field
 * nothing rendered, and the scanner quietly ran on one signal while looking
 * merely inaccurate. Later, cards that photographed perfectly matched nothing,
 * and the cause turned out to be roughly a millimetre of framing error, which
 * no amount of looking at the photograph would ever have shown.
 *
 * Both were invisible from the outside and both were obvious the moment the
 * numbers were in hand. What the scanner needs is not more logging in the
 * console — it is a file you can send somebody.
 *
 * ── What goes in, and what does not ─────────────────────────────────────────
 * The bundle carries the rectified card and the frame it was cut from, because
 * a framing fault can only be seen by comparing the two. It carries the hashes
 * and the distances the server came back with, because those are what actually
 * decided the answer. It does not carry anything about the account: no user,
 * no session token, no collection. A scan is a photograph of a card on a table,
 * and that is all this should ever be able to leak.
 *
 * Recording is off unless asked for. Holding a dozen JPEGs is fine; holding a
 * hundred-card session's worth is not, which is why RECORD_LIMIT exists and why
 * the oldest fall off the end rather than the newest being refused — the
 * interesting capture is nearly always the one that just went wrong.
 */

/** How many captures to keep. Oldest fall off; see the note above. */
const RECORD_LIMIT = 24;

/** Long edge of the images stored in the bundle, in pixels. */
const RECTIFIED_WIDTH = 488;
const FRAME_WIDTH = 720;

const state = {
  recording: false,
  records: [],
  startedAt: null,
};

/** Whether captures are being recorded right now. */
export function isRecording() {
  return state.recording;
}

/** How many captures are held. Shown on the download button. */
export function count() {
  return state.records.length;
}

export function setRecording(on) {
  state.recording = !!on;
  if (state.recording && !state.startedAt) state.startedAt = new Date().toISOString();
  return state.recording;
}

export function clear() {
  state.records = [];
  state.startedAt = null;
}

/**
 * A canvas or ImageData as a JPEG data URL, scaled to a given width.
 *
 * Quality 0.8 rather than the 0.6 the thumbnail strip uses: this image is going
 * to be re-hashed and measured on the other end, and compression artefacts at
 * the low end move the hash. That defeats the point of recording it.
 */
function encode(source, targetWidth) {
  if (!source) return null;

  try {
    let from = source;

    // ImageData has no toDataURL of its own, so it goes via a canvas first.
    if (!source.getContext) {
      const full = document.createElement('canvas');
      full.width = source.width;
      full.height = source.height;
      full.getContext('2d').putImageData(source, 0, 0);
      from = full;
    }

    const scale = Math.min(1, targetWidth / from.width);
    const out = document.createElement('canvas');
    out.width = Math.round(from.width * scale);
    out.height = Math.round(from.height * scale);

    const context = out.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(from, 0, 0, out.width, out.height);

    return out.toDataURL('image/jpeg', 0.8);
  } catch {
    // A record without an image is still worth having — the hashes and the
    // distances are in it. Failing the whole capture over an encode would be
    // the same mistake the hashError field made.
    return null;
  }
}

/**
 * Record a capture, at the moment it is taken.
 *
 * Called before anything is resolved, so the record exists even if the resolve
 * never comes back. attachResolution fills in the rest.
 */
export function recordCapture(entry, context = {}) {
  if (!state.recording) return;

  state.records.push({
    id: entry.id,
    at: entry.at instanceof Date ? entry.at.toISOString() : String(entry.at),
    trigger: entry.trigger,
    // The quad the capture was actually cut from, and how far the snap moved it
    // off the marked one. A framing fault lives here.
    quad: entry.quad,
    snap: entry.snap,
    rectifiedSize: entry.card ? { width: entry.card.width, height: entry.card.height } : null,
    artHash: entry.artHash || null,
    frameHash: entry.frameHash || null,
    hashError: entry.hashError || null,
    // Both images: the rectified card is what was hashed, the frame is what it
    // was cut from. Neither alone shows a framing error.
    rectified: encode(entry.card, RECTIFIED_WIDTH),
    frame: encode(context.frame, FRAME_WIDTH),
    resolution: null,
    reading: null,
  });

  while (state.records.length > RECORD_LIMIT) state.records.shift();
}

/** Attach what the server said about a capture already recorded. */
export function attachResolution(id, resolved) {
  if (!state.recording) return;

  const record = state.records.find((candidate) => candidate.id === id);
  if (!record) return;

  record.resolution = {
    tier: resolved.tier || null,
    // signals carries `nearest` on a miss — the distance to the closest
    // reference in the whole set. On a bundle full of misses that one number is
    // the difference between a framing problem and a wrong-picture problem.
    signals: resolved.signals || null,
    // The distances are the whole point — a miss with the nearest reference at
    // 90 bits is a different fault from one with nothing within threshold.
    candidates: (resolved.candidates || []).slice(0, 5).map((candidate) => ({
      name: candidate.name,
      setCode: candidate.setCode,
      collectorNumber: candidate.collectorNumber,
      printingId: candidate.printingId,
      confidence: candidate.confidence,
      artDistance: candidate.artDistance ?? null,
      frameDistance: candidate.frameDistance ?? null,
      matchedBy: candidate.matchedBy || null,
    })),
  };
}

/** Attach an OCR reading, where the reader was on. */
export function attachReading(id, reading) {
  if (!state.recording) return;

  const record = state.records.find((candidate) => candidate.id === id);
  if (!record || !reading) return;

  record.reading = {
    name: reading.name,
    setCode: reading.setCode,
    collectorNumber: reading.collectorNumber,
    elapsedMs: reading.elapsedMs,
    raw: reading.raw,
  };
}

/** Note a capture that never resolved, and why. */
export function attachFailure(id, message) {
  if (!state.recording) return;

  const record = state.records.find((candidate) => candidate.id === id);
  if (record) record.error = message;
}

/**
 * What the capture pipeline was configured as.
 *
 * Recorded once per bundle rather than per capture. Thresholds and crop regions
 * are the difference between a capture that was going to work and one that
 * never could, and a bundle that does not say which settings produced it can
 * only be guessed at.
 */
function environment(settings) {
  return {
    recordedAt: state.startedAt,
    downloadedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    screen: {
      width: window.screen?.width ?? null,
      height: window.screen?.height ?? null,
      dpr: window.devicePixelRatio ?? null,
    },
    settings: settings || null,
  };
}

/**
 * Build the bundle and hand it to the browser as a download.
 *
 * A data URL rather than a blob URL: the file is a few megabytes at most, this
 * runs once when a person presses a button, and a blob URL would have to be
 * revoked afterwards to avoid holding every bundle of the session in memory.
 */
export function download(settings) {
  const bundle = {
    format: 'deck-lotus-scan-diagnostics',
    version: 1,
    environment: environment(settings),
    captures: state.records,
  };

  const json = JSON.stringify(bundle);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `scan-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Freed on the next tick rather than immediately: revoking before the browser
  // has started the download cancels it in some builds.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return { captures: state.records.length, bytes: json.length };
}
