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

import { blownHighlightFraction, imageDataOf, toGrayscale } from './cardCapture.js';
import { timings as detectorTimings } from './cardDetector.js';

/** How many captures to keep. See makeRoom for which one falls off. */
const RECORD_LIMIT = 24;

/**
 * Tiers that mean the scanner was satisfied, and the capture is therefore the
 * least interesting thing in a recording. Mirrored from scanService.js.
 */
const SETTLED_TIERS = new Set(['confident']);

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
 * Blown-highlight percentage of a rectified capture, or null if there isn't one.
 *
 * Through imageDataOf, because `entry.card` is a *canvas* — the same shape trap
 * that made hashRectified throw on every capture for weeks. Here it was quieter
 * still: the throw was caught, the field went out as null, and two recorded
 * sessions came back with the column empty.
 */
function glareOf(card) {
  if (!card) return null;
  try {
    const image = imageDataOf(card);
    return Number(
      blownHighlightFraction(toGrayscale(image), image.width, image.height).toFixed(2)
    );
  } catch {
    // Same rule as encode: a record missing one field beats no record.
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
    // What the card rectified to at the camera's own resolution, which is no
    // longer what it was hashed at — captures are warped to a fixed size now.
    // This is the field that says whether a session was shot close or far.
    nativeRectifiedSize: entry.nativeSize || null,
    artHash: entry.artHash || null,
    // What the capture would have hashed to without compositing, and how many
    // frames went into it. Distance from each to the winning candidate is the
    // measurement that says whether the burst pays for itself — see
    // docs/SCAN_DIAGNOSTICS_TESTING.md.
    singleArtHash: entry.singleArtHash || null,
    burst: entry.burst || 1,
    frameHash: entry.frameHash || null,
    hashError: entry.hashError || null,
    // How much of the captured card was a blown-out highlight, as a percentage.
    // Measured here rather than taken from the live metrics because this is the
    // rectified card that was actually hashed, at full size. The shutter's own
    // glare threshold is provisional until a sleeved session's numbers are in
    // hand, and this field is how they get there — see
    // docs/SCAN_DIAGNOSTICS_TESTING.md.
    glare: glareOf(entry.card),
    // The framings offered, by their expansion. Paired with signals.probeIndex
    // from the resolver, this says which one actually won — and across a
    // session, whether the spread is centred where detection really stops.
    probeScales: entry.probes?.map((probe) => probe.scale) || null,
    // Both images: the rectified card is what was hashed, the frame is what it
    // was cut from. Neither alone shows a framing error.
    rectified: encode(entry.card, RECTIFIED_WIDTH),
    frame: encode(context.frame, FRAME_WIDTH),
    resolution: null,
    // The second answer, where the reader came back with something to add. Kept
    // beside the first rather than overwriting it: the pair is the measurement.
    // See attachResolution.
    refinedResolution: null,
    reading: null,
    // Whether this capture was ever handed to the reader. Without it a null
    // `reading` has three different meanings — the reader was off, the art
    // answered so the read was skipped, or the read was still running when the
    // bundle was downloaded — and two recorded sessions were spent guessing
    // between them from timestamps. See readQueued.
    readQueued: false,
  });

  makeRoom();
}

/**
 * Drop back to the limit, giving up a settled capture before an unsettled one.
 *
 * The buffer used to be a plain ring: oldest out, newest in. That is the wrong
 * order for what a recording is for. A 90-card run held only the last 24, and
 * the one card that missed had happened early — so the file arrived with
 * twenty-four cards that had worked perfectly and no trace of the failure,
 * which is the only capture anybody wanted to look at.
 *
 * So the oldest *settled* capture is given up first, and a capture that missed
 * or came back unsure is only dropped once nothing settled is left to drop.
 * A long clean run now keeps a rolling sample of successes plus every failure
 * it saw, which is the shape a recording should have.
 *
 * Tier is only known once the server answers, so a capture still resolving
 * counts as unsettled and is kept. It will usually be settled by the time the
 * next few arrive and become droppable then.
 */
function makeRoom() {
  while (state.records.length > RECORD_LIMIT) {
    const settled = state.records.findIndex(
      (record) => SETTLED_TIERS.has(record.resolution?.tier)
    );
    // Nothing settled to give up — every capture held is a failure, and the
    // oldest goes rather than refusing the newest. A recording that stops
    // recording is worse than one that loses its oldest problem.
    state.records.splice(settled === -1 ? 0 : settled, 1);
  }
}

/**
 * Attach what the server said about a capture already recorded.
 *
 * A capture is resolved twice. The art alone answers in milliseconds and that
 * is what `stage: 'hash'` records; where the reader is on and finds something,
 * the text and the art are resolved together seconds later and that is
 * `stage: 'text'`, which lands in `refinedResolution`.
 *
 * Both are kept because the *difference* between them is the only evidence of
 * what the second signal was worth. Only the first was ever recorded before,
 * which made every capture in every bundle report `signals.text: 0` no matter
 * what OCR had read — the refined resolve simply never reached the record.
 * Diagnostics that cannot see the second signal cannot be used to tune it, and
 * a bundle full of `text: 0` reads as "OCR contributed nothing" when it may
 * only mean "OCR was never asked about, here".
 */
export function attachResolution(id, resolved, { stage = 'hash' } = {}) {
  if (!state.recording) return;

  const record = state.records.find((candidate) => candidate.id === id);
  if (!record) return;

  const shaped = {
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

  if (stage === 'text') record.refinedResolution = shaped;
  else record.resolution = shaped;
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
    // Split, because `elapsedMs` alone is two different measurements wearing
    // one name: a read that had to start the engine carries a ~17MB download
    // inside it. `recognizeMs` on a `wasWarm` read is the per-card cost, and it
    // is the only one of the three that says anything about how fast scanning
    // can go.
    wasWarm: reading.wasWarm ?? null,
    engineMs: reading.engineMs ?? null,
    recognizeMs: reading.recognizeMs ?? null,
    // What tesseract thought of its own read, per field.
    //
    // Recorded rather than acted on. A misread can no longer outrank the art —
    // the ordering in resolveScanFused sees to that — but it would be better
    // still if a bad read did not *look* confident either, and that needs this
    // number to be worth something first. Two recorded reads were pure noise;
    // whether these scores were low for them, or tesseract was cheerfully
    // certain about nonsense, decides whether it can damp a text candidate at
    // all. It is not in the bundle yet, so nobody knows.
    confidence: reading.confidence ?? null,
    raw: reading.raw,
  };
}

/**
 * Note that a capture has been handed to the reader.
 *
 * Recorded when the read is *queued*, not when it finishes, which is the whole
 * point: a capture with `readQueued: true` and `reading: null` was still in the
 * queue when the bundle was written, and one with `readQueued: false` was never
 * asked about. Those look identical otherwise, and telling them apart is the
 * difference between "OCR is slow" and "OCR did not run".
 */
export function noteReadQueued(id) {
  if (!state.recording) return;

  const record = state.records.find((candidate) => candidate.id === id);
  if (record) record.readQueued = true;
}

/**
 * How many held captures did not settle — the ones worth having.
 *
 * Shown beside the count so a long run says whether the recording is holding
 * anything interesting, rather than leaving that to be discovered after the
 * file has been sent. See makeRoom for why these are the ones that survive.
 */
export function heldFailures() {
  return state.records.filter(
    (record) => record.resolution && !SETTLED_TIERS.has(record.resolution.tier)
  ).length;
}

/**
 * How many recorded captures are waiting on a read that has not landed.
 *
 * A read that failed is not waiting — it is finished, badly — so a capture
 * carrying an error is excluded. Counting it would leave the status line and
 * the download warning nagging for the rest of the session about a read that is
 * never coming.
 */
export function pendingReads() {
  return state.records.filter(
    (record) => record.readQueued && !record.reading && !record.error
  ).length;
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
function environment(settings, reader) {
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
    // Whether the reader was switched on at all, and how much of its work was
    // still outstanding when this was written. `enabled: false` explains every
    // null reading in the bundle at a glance; `pending` explains the rest, and
    // says the bundle was taken early rather than that the reads failed.
    reader: {
      enabled: reader?.enabled ?? null,
      warm: reader?.warm ?? null,
      pending: pendingReads(),
    },
    // What detection cost on this device. `rate` is answers per second, and it
    // is the ceiling on how fresh any capture's framing can be — requests are
    // dropped while one is in flight, so a slow round trip means every quad in
    // the session is old, however fast the loop ticks.
    detector: detectorTimings(),
  };
}

/**
 * Build the bundle and hand it to the browser as a download.
 *
 * A data URL rather than a blob URL: the file is a few megabytes at most, this
 * runs once when a person presses a button, and a blob URL would have to be
 * revoked afterwards to avoid holding every bundle of the session in memory.
 */
/**
 * @param setBias  the set tally in force when the bundle was taken. Recorded
 *   because a session came back with the bias plainly firing and no way to tell
 *   whether the sets came from the field somebody typed or from a seed the
 *   session had inferred wrongly — two very different faults.
 */
export function download(settings, reader = null, setBias = null) {
  const bundle = {
    format: 'deck-lotus-scan-diagnostics',
    version: 1,
    environment: { ...environment(settings, reader), setBias },
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
