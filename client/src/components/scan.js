import api from '../services/api.js';
import { showToast } from '../utils/ui.js';
import { createCardReader } from '../utils/cardOcr.js';
import {
  CARD_ASPECT,
  DEFAULT_REGIONS,
  DEFAULT_THRESHOLDS,
  HANDHELD_THRESHOLDS,
  analyzeFrame,
  cameraAvailability,
  createAutoCapture,
  defaultQuad,
  frameImageData,
  guideRect,
  imageDataOf,
  loadImageFile,
  quadFromRect,
  rectifiedSize,
  regionOutputSize,
  snapQuadToCard,
  referenceFrom,
  regionQuad,
  warpQuad,
  warpQuadInto,
  warpRegion,
} from '../utils/cardCapture.js';
import { hashRectified } from '../../../src/shared/cardHash.js';
import * as diagnostics from '../utils/scanDiagnostics.js';
import { detectCardContour, isReady as detectorReady, load as loadDetector } from '../utils/cardContour.js';

/**
 * Camera scan: capture, read, resolve.
 *
 * The page frames a card, decides when it is worth grabbing, produces the two
 * crops, reads them with tesseract, and asks the server to resolve the reading
 * into ranked candidates. Committing to inventory is Phase 4 — nothing here
 * writes anything.
 *
 * Framing is a draggable quad rather than a fixed rectangle. On a laptop the
 * camera is on the lid, so the comfortable way to scan is to lay the card on
 * the desk and tilt the lid down at it — which shows the card as a trapezoid.
 * The quad is marked once and every capture is warped back to a true card
 * rectangle before anything is cropped from it.
 */

const STORAGE_KEY = 'scan.captureSettings';

// Bump when the built-in thresholds or regions change. Stored settings otherwise
// win forever, so anyone who had used the page once would keep the old defaults
// and never see a recalibration. The quad survives a bump — it describes the
// user's desk, not our tuning.
// 9: the defaults now depend on whether the camera is hand-held — the
// stability bar a desk webcam was tuned to could never be met by a phone, so a
// stored version-8 profile would leave the shutter permanently unarmed on one.
// 10: the card is found in the frame rather than expected in a marked quad, so
// the thresholds are now measured against the card wherever it is rather than
// against whatever was sitting inside the guide.
const SETTINGS_VERSION = 10;

// The analysis buffer is deliberately tiny: every metric is a per-pixel pass
// over it on every frame, and none of them need detail.
const ANALYSIS_HEIGHT = 176;
const ANALYSIS_WIDTH = Math.round(ANALYSIS_HEIGHT * CARD_ASPECT);

// Frames are downscaled before the per-frame warp reads them back. Reading a
// full 1920x1080 frame into JS ten times a second is 8MB a go and pointlessly
// precise for deciding whether a card is sitting still.
const ANALYSIS_SOURCE_WIDTH = 480;

const ANALYSIS_INTERVAL_MS = 100;

/**
 * Expansions of the detected quad to offer the resolver, as multipliers.
 *
 * 1.0 is what detection found; the rest reach outward past a black border it
 * may have stopped inside. The measured basin on a real bordered card ran from
 * 1.04 to 1.12, so this samples it and keeps the unexpanded framing for cards
 * that have no border to miss.
 */
const EXPANSION_PROBES = [1, 1.04, 1.08, 1.12];

/**
 * Consecutive frames with no card before the shutter re-arms.
 *
 * The shutter used to re-arm on frame difference, which cannot tell a card
 * being swapped from the same card being nudged — so one card sitting under
 * the lens produced row after row of itself. Arming on the card's *absence*
 * says exactly the right thing: a new card has to arrive for a new capture to
 * happen.
 *
 * Debounced rather than instant because detection blinks. A hand crossing the
 * frame, or a moment of blur mid-adjustment, loses the card for a frame or two
 * while it is still sitting there; re-arming on that would put the same card in
 * the list twice. Three frames is about 300ms, comfortably longer than a blink
 * and far shorter than swapping a card.
 */
const ABSENCE_FRAMES_TO_REARM = 3;

const MAX_RECENT_CAPTURES = 12;

const state = {
  stream: null,
  rafId: null,
  lastAnalysisAt: 0,
  previousGray: null,
  referenceGray: null,
  autoCapture: null,
  autoEnabled: true,
  captures: [],
  dragging: null,
  reader: null,
  // Off by default. The reader costs seconds a card and ~17MB of engine on
  // first use, and since the art hash now answers on its own it only has
  // something to add when two printings share an illustration. Opt in from the
  // controls when that matters; leave it off to scan a box.
  ocrEnabled: false,
  // A tone per resolved card, so a box can be scanned without watching the
  // screen. See signalMatch.
  sound: true,
  audio: null,
  // Null until the user picks a camera themselves; see startCamera.
  cameraChoice: null,
  // Reads are serialised: one tesseract worker cannot recognise two images at
  // once, and captures can arrive faster than it finishes.
  readQueue: Promise.resolve(),
  settings: loadSettings(),
  // Reused across frames so the loop allocates nothing per tick.
  buffers: { source: null, analysis: null, scratch: null },
  // Where the card was last seen, fed back in as the next frame's hint, and
  // null whenever detection loses it. Never a fallback: a stale quad is how a
  // capture comes out legible and matches nothing.
  detected: null,
  // The shutter fires once per card. It is held after a capture until the card
  // leaves the frame, which is what makes flipping through a stack produce one
  // row each rather than a pile of the card that happened to sit still longest.
  awaitingNewCard: false,
  absentFrames: 0,
  // The last card accepted, and whether the frame has emptied since. Together
  // they separate "the shutter fired twice at one card" from "there are two
  // copies of this card in the stack", which look identical otherwise.
  lastCardId: null,
  sawAbsence: true,
};

/**
 * Is this a camera someone is holding?
 *
 * A coarse pointer is the closest thing the browser will say to "phone", and
 * the distinction genuinely changes what good defaults are: a phone is held
 * over the card and moves, a webcam is fixed and the card moves. Both the
 * capture thresholds and whether to chase the card's edges every frame follow
 * from which one it is, so this is asked once and both follow.
 *
 * Only a default. Everything it picks is in the tuning panel and overridable.
 */
function looksHandheld() {
  try {
    return window.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

function freshSettings() {
  const handheld = looksHandheld();

  return {
    version: SETTINGS_VERSION,
    thresholds: { ...(handheld ? HANDHELD_THRESHOLDS : DEFAULT_THRESHOLDS) },
    regions: {
      title: { ...DEFAULT_REGIONS.title },
      collector: { ...DEFAULT_REGIONS.collector },
    },
    quad: defaultQuad(),
    // Off for a fixed camera, on for a hand-held one — and the reason is the
    // same finding read twice.
    //
    // Snapping was measured against a quad a person had aligned by eye on a
    // desk setup, and it lost: it moved 39px onto the shadow the card casts on
    // cloth and dragged the collector crop off the top line. A person aiming at
    // the print beats an edge detector guessing between nearby steps.
    //
    // But that comparison only exists because the card and the camera both
    // stayed put, so one careful alignment held all session. Hold the camera
    // and there is no aligned quad to defend: the card is somewhere new in the
    // frame every capture, and a fixed guide is wrong for all of them. Chasing
    // the edges is not better than a good manual quad — it is better than the
    // stale one that is the only alternative here. Which is also the answer to
    // the "fiddly to position" complaint: nothing to position.
    snapEnabled: handheld,

    // Find the card in the frame rather than expecting it in a marked quad.
    // On by default and for everyone, hand-held or not: the quad it replaces
    // is only correct while the card and the camera both stay put, and the
    // penalty for it being slightly wrong is total rather than gradual — the
    // hash tolerates about 1% of framing error before a capture matches
    // nothing at all. Left as a setting because a fixed desk rig with a
    // carefully marked quad is genuinely the more accurate arrangement, and
    // because a detector that cannot see the card has to have an off switch.
    detectEnabled: true,
  };
}

function loadSettings() {
  const fallback = freshSettings();

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return fallback;

    // Tuning from an older version is discarded rather than merged: it was
    // calibrated against different defaults, and silently keeping half of it is
    // worse than starting from the current ones.
    const stale = stored.version !== SETTINGS_VERSION;

    return {
      version: SETTINGS_VERSION,
      thresholds: stale ? fallback.thresholds : { ...fallback.thresholds, ...stored.thresholds },
      regions: stale
        ? fallback.regions
        : {
            title: { ...fallback.regions.title, ...stored.regions?.title },
            collector: { ...fallback.regions.collector, ...stored.regions?.collector },
          },
      // A quad only means anything with all four corners, so a partial one is
      // discarded rather than merged into something misshapen.
      quad:
        Array.isArray(stored.quad) && stored.quad.length === 4
          ? stored.quad.map((p) => ({ x: p.x, y: p.y }))
          : fallback.quad,
      snapEnabled: stored.snapEnabled === true,
      // Defaults on: only an explicit false turns it off, so a profile stored
      // before this existed gains it rather than being stuck without it.
      detectEnabled: stored.detectEnabled !== false,
    };
  } catch {
    return fallback;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    // A full or blocked localStorage is not worth interrupting a scan session.
  }
}

function el(id) {
  return document.getElementById(id);
}

/* ------------------------------------------------------------------ camera */

async function populateCameraList() {
  const select = el('scan-camera-select');
  if (!select) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((d) => d.kind === 'videoinput');
  const previous = select.value;

  // An empty <select> collapses to a sliver — 21px on the page whose entire
  // premise is picking the right camera. Say what happened instead.
  select.innerHTML = cameras.length
    ? cameras
        .map(
          (camera, index) =>
            `<option value="${camera.deviceId}">${camera.label || `Camera ${index + 1}`}</option>`
        )
        .join('')
    : '<option value="">No camera found</option>';

  if (previous && cameras.some((c) => c.deviceId === previous)) select.value = previous;
  select.disabled = cameras.length < 2;
}

/**
 * Point the picker at the camera actually in use and report its resolution.
 *
 * The resolution is worth surfacing rather than assuming: what a camera returns
 * for a 4K request varies enormously, and on small print it is the number that
 * decides whether anything is readable at all.
 */
function reflectActiveCamera() {
  const track = state.stream?.getVideoTracks?.()[0];
  if (!track) return;

  const settings = track.getSettings?.() || {};
  const select = el('scan-camera-select');
  if (select && settings.deviceId) select.value = settings.deviceId;

  const readout = el('scan-resolution');
  if (readout) {
    readout.textContent = settings.width
      ? `${settings.width}x${settings.height}`
      : '';
  }
}

async function startCamera() {
  // Start fetching the detector alongside the camera rather than waiting for
  // it. It is 13MB and the camera takes a moment to come up anyway, so the two
  // overlap; until it lands, detection reports no card and nothing is captured,
  // which the status line says out loud.
  loadDetector().then(() => renderDetection(state.detected));

  const availability = cameraAvailability();
  if (!availability.available) {
    showUnsupported(availability.reason);
    return;
  }

  stopCamera();

  // Only honour an explicit choice. Reading the select back would pin whatever
  // happened to be listed first, and on a phone that is the selfie camera —
  // so the second session would come up facing the wrong way.
  const constraints = {
    video: {
      // A collector number is ~3mm tall on the card, so ask for every pixel the
      // camera has and let it cap itself. `ideal` is best-effort, so a 1080p
      // webcam simply returns 1080p.
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      ...(state.cameraChoice
        ? { deviceId: { exact: state.cameraChoice } }
        : { facingMode: { ideal: 'environment' } }),
    },
    audio: false,
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    setUpTorch(state.stream);
  } catch (error) {
    showToast(`Camera unavailable: ${error.message}`, 'error');
    return;
  }

  const video = el('scan-video');
  video.srcObject = state.stream;
  await video.play();

  // Device labels are blank until permission has been granted, so the list is
  // only worth filling in after the stream exists.
  await populateCameraList();
  reflectActiveCamera();

  el('scan-stage').classList.remove('hidden');
  el('scan-start-btn').classList.add('hidden');
  el('scan-stop-btn').classList.remove('hidden');

  state.autoCapture = createAutoCapture(state.settings.thresholds);
  state.previousGray = null;
  state.referenceGray = null;
  updateReferenceLabel();
  drawOverlay();
  startLoop();
}

function stopCamera() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  const video = el('scan-video');
  if (video) video.srcObject = null;

  el('scan-start-btn')?.classList.remove('hidden');
  el('scan-stop-btn')?.classList.add('hidden');
  state.previousGray = null;
}

function showUnsupported(reason) {
  const notice = el('scan-unsupported');
  if (!notice) return;
  el('scan-unsupported-reason').textContent = reason;
  notice.classList.remove('hidden');
  el('scan-start-btn')?.setAttribute('disabled', 'disabled');
}

/* ----------------------------------------------------------------- overlay */

/**
 * Draw the quad, the crop regions and the drag handles over the video.
 *
 * The polygons live in an SVG with a 0-100 viewBox and no aspect preservation,
 * so fractional frame coordinates become percentages of the video box whatever
 * shape it is displayed at. The handles are separate absolutely-positioned
 * elements, because that same non-uniform scaling would squash a circle.
 */
function drawOverlay() {
  const quad = state.settings.quad;
  const points = (pts) => pts.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');

  const cardPoly = el('scan-quad-card');
  if (cardPoly) cardPoly.setAttribute('points', points(quad));

  for (const key of ['title', 'collector']) {
    const poly = el(`scan-quad-${key}`);
    if (poly) poly.setAttribute('points', points(regionQuad(quad, state.settings.regions[key])));
  }

  quad.forEach((corner, index) => {
    const handle = el(`scan-handle-${index}`);
    if (!handle) return;
    handle.style.left = `${corner.x * 100}%`;
    handle.style.top = `${corner.y * 100}%`;
  });
}

function beginDrag(event, index) {
  event.preventDefault();
  state.dragging = index;
  event.target.setPointerCapture?.(event.pointerId);
}

function moveDrag(event) {
  if (state.dragging === null) return;
  const box = el('scan-stage').getBoundingClientRect();

  const clamp = (v) => Math.min(1, Math.max(0, v));
  state.settings.quad[state.dragging] = {
    x: clamp((event.clientX - box.left) / box.width),
    y: clamp((event.clientY - box.top) / box.height),
  };

  drawOverlay();
}

function endDrag() {
  if (state.dragging === null) return;
  state.dragging = null;
  saveSettings();
  // The quad decides which patch of desk "empty" described, so a reference taken
  // through the old quad no longer means anything.
  if (state.referenceGray) {
    state.referenceGray = null;
    updateReferenceLabel();
    showToast('Guide moved — mark the empty desk again', 'info');
  }
}

/* -------------------------------------------------------------------- loop */

function startLoop() {
  const video = el('scan-video');

  const source = document.createElement('canvas');
  const sourceCtx = source.getContext('2d', { willReadFrequently: true });
  const analysis = document.createElement('canvas');
  analysis.width = ANALYSIS_WIDTH;
  analysis.height = ANALYSIS_HEIGHT;
  const analysisCtx = analysis.getContext('2d', { willReadFrequently: true });
  state.buffers = { source: sourceCtx, analysis: analysisCtx, scratch: null };

  const tick = (timestamp) => {
    state.rafId = requestAnimationFrame(tick);

    if (!video.videoWidth) return;
    if (timestamp - state.lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
    state.lastAnalysisAt = timestamp;

    if (source.width !== ANALYSIS_SOURCE_WIDTH) {
      source.width = ANALYSIS_SOURCE_WIDTH;
      source.height = Math.round((ANALYSIS_SOURCE_WIDTH * video.videoHeight) / video.videoWidth);
    }
    sourceCtx.drawImage(video, 0, 0, source.width, source.height);

    const sourceFrame = sourceCtx.getImageData(0, 0, source.width, source.height);

    // Find the card, every frame. The marked quad describes a desk; a hand-held
    // card is wherever the hand is, and the hash tolerates about 1% of framing
    // error before the art window walks off the illustration. Tracking from the
    // last frame keeps this to one refinement in the steady state — see
    // detectCard, which falls back to a full sweep the moment tracking is not
    // clearly on the card.
    if (state.settings.detectEnabled) {
      // Contours, not per-edge gradient search. The frame profile of a real
      // capture put the art window's border and the type line well above the
      // card's own outline, so searching for the strongest step near an edge
      // reliably found the wrong one — see cardContour.js.
      state.detected = detectorReady() ? detectCardContour(sourceFrame) : null;
      renderDetection(state.detected);
    } else {
      state.detected = null;
    }

    // Metrics are measured on the rectified card, not on the raw frame, so a
    // tilted view is judged on the same terms as a flat one — and on the card
    // that was actually found rather than on the guide it was expected in.
    const framing = state.detected?.quad || state.settings.quad;

    state.buffers.scratch = warpQuadInto(
      analysisCtx,
      sourceFrame,
      framing,
      state.buffers.scratch
    );

    const metrics = analyzeFrame(analysisCtx, state.previousGray, state.referenceGray);
    state.previousGray = metrics.gray;

    const verdict = state.autoCapture.evaluate(metrics);
    renderMetrics(metrics, verdict);

    // No card, no capture. Firing on the marked quad because detection came up
    // empty is precisely how a session fills with legible photographs of a
    // table that match nothing — the failure this detection exists to end.
    if (state.settings.detectEnabled && !state.detected) {
      state.absentFrames++;

      // Long enough to be a card leaving rather than detection blinking.
      if (state.absentFrames >= ABSENCE_FRAMES_TO_REARM) {
        state.awaitingNewCard = false;
        state.sawAbsence = true;
      }

      state.autoCapture.reset();
      return;
    }

    state.absentFrames = 0;

    // A card is in frame, but it is the one already captured — nothing has left
    // since. The stability and focus tests below would happily fire on it again.
    if (state.awaitingNewCard) {
      state.autoCapture.reset();
      return;
    }

    if (verdict.shouldCapture) {
      if (state.autoEnabled) {
        state.awaitingNewCard = true;
        captureFromVideo(video, 'auto');
      } else {
        // evaluate() disarms itself whenever it fires, so re-arm immediately —
        // otherwise the readout freezes on a card that was never captured.
        state.autoCapture.reset();
      }
    }
  };

  state.rafId = requestAnimationFrame(tick);
}

function renderMetrics(metrics, verdict) {
  const { thresholds } = state.settings;

  setChip(
    'scan-chip-stable',
    verdict.checks.stable,
    `Still ${metrics.difference.toFixed(1)}/${thresholds.stability}`
  );
  setChip(
    'scan-chip-sharp',
    verdict.checks.sharp,
    `Focus ${Math.round(metrics.sharpness)}/${thresholds.sharpness}`
  );
  setChip(
    'scan-chip-filled',
    verdict.checks.filled,
    Number.isFinite(metrics.presence)
      ? `Card ${metrics.presence.toFixed(1)}/${thresholds.presence}`
      : `Edges ${metrics.fill.toFixed(1)}/${thresholds.fill}`
  );

  const streak = el('scan-streak');
  if (streak) {
    streak.textContent = verdict.armed
      ? `${verdict.streak}/${thresholds.streak} good frames`
      : 'Swap the card to arm again';
  }

  const overlay = el('scan-overlay');
  if (overlay) {
    overlay.classList.toggle('scan-overlay-ready', verdict.streak > 0);
    overlay.classList.toggle('scan-overlay-disarmed', !verdict.armed);
  }
}

function setChip(id, ok, label) {
  const chip = el(id);
  if (!chip) return;
  chip.textContent = label;
  chip.classList.toggle('scan-chip-ok', ok);
}

/* ----------------------------------------------------------------- capture */

/**
 * Rectify the quad out of the live frame at full resolution, then crop.
 *
 * The frame is read at native size here — once per capture, not per frame — so
 * the card keeps every pixel the camera resolved.
 */
// Edge snapping runs on a downscaled copy of the frame. A card edge is a
// hundred-pixel-long step; finding it does not need 4K, and converting a full
// 4K frame to a float buffer would cost ~66MB on a phone for no benefit.
const SNAP_SOURCE_WIDTH = 960;

/**
 * Refine the marked quad onto the card actually in frame.
 *
 * Returns the marked quad unchanged when the card cannot be found — a bad snap
 * would crop the table, which is worse than a slightly loose crop.
 */
function snapQuad(source, frameWidth, frameHeight) {
  // Automatic detection, where it has found something. The live loop has
  // already run it on this frame and left the answer in state.detected; using
  // that rather than detecting again keeps the capture framed exactly as the
  // overlay showed it, which is the framing the user agreed to by holding still.
  if (state.settings.detectEnabled && state.detected) {
    return {
      quad: state.detected.quad,
      snap: {
        detected: true,
        via: state.detected.via,
        area: Number(state.detected.area.toFixed(3)),
        aspectError: Number(state.detected.aspectError.toFixed(3)),
      },
    };
  }

  if (!state.settings.snapEnabled) return { quad: state.settings.quad, snap: null };

  const width = Math.min(SNAP_SOURCE_WIDTH, frameWidth);
  const height = Math.round((width / frameWidth) * frameHeight);
  const small = frameImageData(source, width, height);

  const snapped = snapQuadToCard(small, state.settings.quad);
  return snapped
    ? { quad: snapped.quad, snap: { moved: Math.round(snapped.moved), strength: Math.round(snapped.strength) } }
    : { quad: state.settings.quad, snap: null };
}

function captureFromVideo(video, trigger) {
  const { quad, snap } = snapQuad(video, video.videoWidth, video.videoHeight);
  const frame = frameImageData(video, video.videoWidth, video.videoHeight);
  emitCapture(frame, quad, video.videoWidth, video.videoHeight, trigger, snap);
}

/**
 * Rectify the card and take the crops, then hand them on. Phase 3 listens for
 * `scan:capture` and does the reading; nothing here interprets the pixels.
 *
 * Each crop is warped from the original frame rather than cut out of the
 * rectified card, so the small print is resampled once instead of twice.
 */
/** A quad scaled about its own centre. */
function expandQuad(quad, scale) {
  const cx = quad.reduce((total, p) => total + p.x, 0) / 4;
  const cy = quad.reduce((total, p) => total + p.y, 0) / 4;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  }));
}

function emitCapture(frame, quad, frameWidth, frameHeight, trigger, snap = null) {
  const size = rectifiedSize(quad, frameWidth, frameHeight);
  const card = warpQuad(frame, quad, size.width, size.height);

  const cropOf = (region) => {
    const out = regionOutputSize(size, region);
    return warpRegion(frame, quad, region, out.width, out.height);
  };

  const title = cropOf(state.settings.regions.title);
  const collector = cropOf(state.settings.regions.collector);

  const entry = {
    id: Date.now() + Math.random(),
    trigger,
    card,
    title,
    collector,
    quad,
    snap,
    at: new Date(),
  };

  // Hash the rectified card immediately, while it is already in hand. This is
  // the scanner's second opinion and it is cheap — about a millisecond — where
  // the OCR that follows is seconds, so it never belongs behind the read queue.
  // It also has to happen here rather than in the reader: the hash is compared
  // against references built from whole rectified cards, and the reader only
  // ever sees the two small crops.
  //
  // Read back through imageDataOf: warpQuad returns a *canvas*, and the shared
  // hash takes the ImageData shape. Passing the canvas straight in threw on
  // every single capture, silently — the catch below turned it into a
  // hashError nothing displayed, so the scanner ran OCR-only and looked merely
  // inaccurate rather than broken. That is why the error is now shown.
  try {
    Object.assign(entry, hashRectified(imageDataOf(card)));

    // And the same card at a few expansions, because where detection stopped is
    // not knowable from the picture. Contours lock onto whichever border
    // boundary held the most contrast, which on a bordered card is usually the
    // printed frame's inner edge — while every reference is a whole card,
    // black border included. Measured on a real capture, the detected framing
    // sat 86 bits from its own reference and the same capture expanded 8% sat
    // at 30, with everything from 4% to 12% matching. Sending the spread costs
    // a millisecond each here and one index pass each on the server; guessing a
    // single expansion would be right for bordered cards and wrong for the
    // borderless and full-art ones.
    entry.probes = EXPANSION_PROBES.map((scale) => {
      const grown = expandQuad(quad, scale);
      const size = rectifiedSize(grown, frameWidth, frameHeight);
      const probe = hashRectified(imageDataOf(warpQuad(frame, grown, size.width, size.height)));
      return { scale, ...probe };
    });
  } catch (error) {
    // A capture that cannot be hashed is still a capture worth reading. The
    // resolver treats a missing hash as "no second signal" and says so.
    entry.hashError = error.message;
  }

  state.captures.unshift(entry);
  state.captures = state.captures.slice(0, MAX_RECENT_CAPTURES);
  state.autoCapture?.disarm();

  // Recorded before anything is resolved, so a capture that never comes back
  // still leaves a trace. The frame goes in beside the rectified card because a
  // framing fault is only visible in the two together.
  diagnostics.recordCapture(entry, { frame });
  renderRecordingStatus();

  flashShutter();
  renderCapture(entry);
  renderRecent();

  window.dispatchEvent(new CustomEvent('scan:capture', { detail: entry }));

  // Resolve on the art alone, now, before anything is read. This is the whole
  // shape of the scanner: the hash is ~1ms to compute and 1.7ms to search
  // against all 112k references, where OCR is seconds. Resolving behind the
  // reader made every card cost a tesseract pass and made auto-capture look
  // broken — the shutter would fire again long before the previous card's
  // answer arrived, so the queue filled with cards nobody had seen resolved.
  resolveCapture(entry);

  // The reader is now a refinement that lands late and never blocks. It only
  // earns its seconds when the art has named a card but not a printing, so
  // that is the only case it runs in unattended.
  if (state.ocrEnabled) readCapture(entry);
}

/**
 * Draw where the card is being seen, live.
 *
 * Drawn on the same polygon the marked guide uses, so with detection on the
 * overlay stops being a target to line the card up against and becomes a report
 * of what was found. That distinction is the point: when it is not on the card,
 * you can see that it is not on the card, rather than discovering it later in a
 * session of captures that matched nothing.
 */
function renderDetection(detection) {
  const outline = el('scan-quad-card');
  if (outline) {
    outline.setAttribute(
      'points',
      detection ? detection.quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ') : ''
    );
    outline.classList.toggle('scan-quad-found', !!detection);
  }

  // The handles mark a quad by hand; with detection on there is nothing to drag.
  for (let i = 0; i < 4; i++) {
    el(`scan-handle-${i}`)?.classList.toggle('hidden', true);
  }

  const status = el('scan-detect-status');
  if (status) {
    status.textContent = detection
      ? 'Card found'
      : detectorReady()
        ? 'No card in frame'
        : 'Loading card detector…';
    status.classList.toggle('scan-detect-found', !!detection);
  }
}

/**
 * Show the quad a capture was actually taken from, over the live view.
 *
 * Only drawn when it differs from the marked one, so in the normal case the
 * overlay stays as the user set it.
 */
function drawUsedQuad(quad, moved) {
  const outline = el('scan-quad-used');
  if (!outline) return;

  if (!moved) {
    outline.setAttribute('points', '');
    return;
  }

  outline.setAttribute('points', quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' '));
}

/* --------------------------------------------------------------- read/resolve */

function reader() {
  if (!state.reader) {
    state.reader = createCardReader({
      onProgress: (message) => {
        // The first read downloads ~17MB of engine and language data from our own
        // origin. That is worth narrating; the per-card work afterwards is not.
        if (message.status && !state.reader?.ready) {
          setReadStatus(`${message.status.replace(/_/g, ' ')}${
            message.progress ? ` ${Math.round(message.progress * 100)}%` : ''
          }`);
        }
      },
    });
  }
  return state.reader;
}

/**
 * Read one capture and resolve it.
 *
 * Reads are serialised through the queue below rather than run per capture: a
 * continuous scan session can produce captures faster than tesseract finishes,
 * and a second recognize() on the same worker while one is in flight throws.
 */
async function readCapture(entry) {
  state.readQueue = state.readQueue.then(() => runRead(entry)).catch(() => {});
  return state.readQueue;
}

/**
 * Resolve a capture from its art hash alone, immediately.
 *
 * No queue and no worker: this is one fetch, and the server answers it from an
 * in-memory search that takes under two milliseconds. A card that the art names
 * unambiguously is done here, and the session collapses it out of review
 * without the reader ever being asked.
 */
async function resolveCapture(entry) {
  if (!entry.artHash) {
    // Nothing to go on until the reader speaks. Left resolving rather than
    // failed, because an OCR pass may still be coming.
    if (!state.ocrEnabled) {
      window.dispatchEvent(new CustomEvent('scan:read-failed', {
        detail: { id: entry.id, message: entry.hashError || 'the art did not hash' },
      }));
    }
    return;
  }

  try {
    const probes = entry.probes?.length
      ? entry.probes
      : [{ artHash: entry.artHash, frameHash: entry.frameHash }];

    const resolved = await api.resolveScanProbes({
      artHashes: probes.map((p) => p.artHash),
      frameHashes: probes.map((p) => p.frameHash),
      limit: 25,
    });

    entry.candidates = resolved.candidates;
    entry.tier = resolved.tier || null;
    renderCandidates(entry);

    const best = resolved.candidates?.[0];

    // The same card, twice, with the frame never having emptied in between.
    //
    // Arming on absence should make this impossible, and mostly does — but
    // detection blinks, and a blink long enough to re-arm puts one physical
    // card in the review list twice. The identity is the check the geometry
    // cannot make: two copies of a card scanned one after the other are a
    // genuine pair and the frame empties between them, while a card that never
    // left and came back with the same name is one card counted twice.
    //
    // Only ever applied to automatic captures. Pressing the shutter at a card
    // already scanned is an explicit instruction, and a second copy held up
    // deliberately has to be able to say so.
    if (
      entry.trigger === 'auto' &&
      best &&
      !state.sawAbsence &&
      state.lastCardId !== null &&
      best.cardId === state.lastCardId
    ) {
      setReadStatus(`${best.name} — already scanned, skipped`);
      window.dispatchEvent(new CustomEvent('scan:duplicate', { detail: { id: entry.id } }));
      return;
    }

    if (best) {
      state.lastCardId = best.cardId;
      state.sawAbsence = false;
    }
    const near = resolved.signals?.nearest;
    const won = resolved.signals?.probeIndex;
    const wonScale = Number.isInteger(won) && entry.probes?.[won]
      ? ` ×${entry.probes[won].scale}`
      : '';
    setReadStatus(
      best
        ? `${best.name} — ${best.setCode} ${best.collectorNumber || ''} (art${wonScale})`
        : near
          ? `No match — nearest ${near.artDistance}/${near.bits} bits (needs ≤${near.matchWithin})`
          : 'No art match'
    );
    renderLiveMatch(best || null);
    diagnostics.attachResolution(entry.id, resolved);
    signalMatch(resolved.tier);

    window.dispatchEvent(new CustomEvent('scan:resolved', {
      detail: {
        id: entry.id,
        reading: null,
        tier: resolved.tier,
        candidates: resolved.candidates,
        signals: resolved.signals,
      },
    }));
  } catch (error) {
    setReadStatus(`Match failed: ${error.message}`);
    renderLiveMatch(null);
    diagnostics.attachFailure(entry.id, error.message);
    window.dispatchEvent(new CustomEvent('scan:read-failed', {
      detail: { id: entry.id, message: error.message },
    }));
  }
}

/** Keep the recording controls honest about what is actually being held. */
function renderRecordingStatus() {
  const status = el('scan-record-status');
  const button = el('scan-record-download');
  const held = diagnostics.count();

  if (button) button.disabled = held === 0;
  if (!status) return;

  status.textContent = diagnostics.isRecording()
    ? held
      ? `Recording — ${held} capture${held === 1 ? '' : 's'} held.`
      : 'Recording — scan a card.'
    : held
      ? `Stopped — ${held} capture${held === 1 ? '' : 's'} still held.`
      : 'Off — captures are not being kept.';
}

/**
 * One frame of white over the video, on capture.
 *
 * The beep says a card was taken; this says *which frame* it came from. Moving
 * cards quickly, that is the difference between trusting the count and stopping
 * to check it. Restarting the animation needs the class off, a reflow read, then
 * on — otherwise a second capture within the animation does nothing visible.
 */
function flashShutter() {
  const flash = el('scan-flash');
  if (!flash) return;
  flash.classList.remove('is-firing');
  void flash.offsetWidth;
  flash.classList.add('is-firing');
}

/** The match, over the picture. Cleared when a capture resolves to nothing. */
function renderLiveMatch(candidate) {
  const live = el('scan-live');
  if (!live) return;

  live.classList.toggle('hidden', !candidate);
  if (!candidate) return;

  el('scan-live-name').textContent = candidate.name;
  el('scan-live-print').textContent =
    `${candidate.setCode} ${candidate.collectorNumber || ''}`.trim();
}

/**
 * A short tone per card, pitched by how the match went.
 *
 * The point of scanning a box is that you are looking at the cards, not at the
 * screen. A rising note means it is filed and you can move on; a lower one means
 * this card will be waiting in review. Built from an oscillator rather than an
 * asset so it costs nothing to ship and works offline.
 */
function signalMatch(tier) {
  if (!state.sound) return;

  try {
    state.audio = state.audio || new (window.AudioContext || window.webkitAudioContext)();
    const context = state.audio;
    if (context.state === 'suspended') context.resume();

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = tier === 'confident' ? 1320 : 440;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.13);
  } catch {
    // A missing or blocked AudioContext is not worth failing a scan over.
  }
}

async function runRead(entry) {
  setReadStatus('Reading…');

  let reading;
  try {
    reading = await reader().read(entry);
  } catch (error) {
    setReadStatus(`Read failed: ${error.message}`);
    window.dispatchEvent(new CustomEvent('scan:read-failed', {
      detail: { id: entry.id, message: error.message },
    }));
    return;
  }

  entry.reading = reading;
  diagnostics.attachReading(entry.id, reading);
  renderReading(entry);

  // An unreadable card is not a dead end any more. A pre-2015 card has no
  // collector block printed on it at all, and a glared-out one reads as though
  // it has none either — but the art still hashed, and the hash alone is enough
  // to name the card and offer its printings. Only a capture with neither
  // signal is genuinely nothing.
  const readable = reading.name || (reading.setCode && reading.collectorNumber);
  if (!readable && !entry.artHash) {
    setReadStatus(`Nothing readable (${reading.elapsedMs}ms)`);
    window.dispatchEvent(new CustomEvent('scan:read-failed', {
      detail: { id: entry.id, message: 'nothing readable and the art did not hash' },
    }));
    return;
  }

  // The art has already answered and the reader found nothing to add. Re-asking
  // the server with the same hash and no text would return the same list and
  // overwrite a good answer with an identical one, so stop here.
  if (!readable) {
    setReadStatus(`Read added nothing (${reading.elapsedMs}ms)`);
    return;
  }

  try {
    const resolved = await api.resolveScan({
      name: reading.name,
      setCode: reading.setCode,
      collectorNumber: reading.collectorNumber,
      artHash: entry.artHash,
      frameHash: entry.frameHash,
      // Enough for the review table's printing picker to be a real choice. The
      // tuning panel below only ever showed the top few, but the session's
      // picker is how a reprint gets corrected, and five is not a list of
      // printings — it is the beginning of one.
      limit: 25,
    });

    entry.candidates = resolved.candidates;
    entry.tier = resolved.tier || null;
    renderCandidates(entry);
    setReadStatus(`Refined by text in ${reading.elapsedMs}ms`);

    // The session listens for this. Kept as an event rather than a direct call
    // so the scan page stays the thing that captures and reads, and knows
    // nothing about queues, review tables or destinations.
    window.dispatchEvent(new CustomEvent('scan:resolved', {
      detail: {
        id: entry.id,
        reading,
        tier: resolved.tier,
        candidates: resolved.candidates,
        signals: resolved.signals,
      },
    }));
  } catch (error) {
    setReadStatus(`Resolve failed: ${error.message}`);
    window.dispatchEvent(new CustomEvent('scan:read-failed', {
      detail: { id: entry.id, message: error.message },
    }));
  }
}

/**
 * Offer the torch, where the camera has one.
 *
 * Worth a control of its own because even light is the biggest lever on OCR
 * accuracy after resolution — ahead of any threshold in the tuning panel. A
 * card held under a room light picks up a bright band across the collector
 * block from whatever is above it, and that band is exactly what the reader
 * loses the set code to. The torch flattens it.
 *
 * Feature-detected rather than assumed: `torch` is a non-standard track
 * capability, absent on desktop and on iOS Safari, so the button only appears
 * where pressing it would do something.
 */
function setUpTorch(stream) {
  const button = el('scan-torch');
  if (!button) return;

  const track = stream?.getVideoTracks?.()[0];
  const capabilities = track?.getCapabilities?.();

  if (!track || !capabilities || !('torch' in capabilities)) {
    button.classList.add('hidden');
    state.torchTrack = null;
    return;
  }

  state.torchTrack = track;
  state.torchOn = false;
  button.classList.remove('hidden');
  button.textContent = 'Torch off';
}

async function toggleTorch() {
  if (!state.torchTrack) return;

  const button = el('scan-torch');
  const next = !state.torchOn;

  try {
    await state.torchTrack.applyConstraints({ advanced: [{ torch: next }] });
    state.torchOn = next;
    if (button) button.textContent = next ? 'Torch on' : 'Torch off';
  } catch (error) {
    if (button) button.textContent = 'Torch unavailable';
  }
}

function setReadStatus(text) {
  const el_ = el('scan-read-status');
  if (el_) el_.textContent = text;
}

function renderReading(entry) {
  const reading = entry.reading;
  el('scan-reading')?.classList.remove('hidden');

  const field = (id, value, confidence) => {
    const node = el(id);
    if (!node) return;
    node.innerHTML = value
      ? `<strong>${value}</strong> <span class="scan-confidence">${Math.round(confidence * 100)}%</span>`
      : '<span class="scan-unread">not read</span>';
  };

  field('scan-read-name', reading.name, reading.confidence.name);
  field('scan-read-set', reading.setCode, reading.confidence.setCode);
  field('scan-read-collector', reading.collectorNumber, reading.confidence.collectorNumber);

  const raw = el('scan-read-raw');
  if (raw) {
    raw.textContent = `title: ${JSON.stringify(reading.raw.title)}  collector: ${JSON.stringify(reading.raw.collector)}`;
  }

  // Show what the engine actually saw, which is the only way to tell a bad crop
  // from a bad threshold.
  swapCanvas('scan-preview-title-ocr', reading.images.title);
  swapCanvas('scan-preview-collector-ocr', reading.images.collector);
}

function renderCandidates(entry) {
  const list = el('scan-candidates');
  if (!list) return;

  const candidates = entry.candidates || [];
  if (!candidates.length) {
    list.innerHTML = '<div class="scan-unread">No candidates matched this reading</div>';
    return;
  }

  list.innerHTML = candidates
    .map(
      (c, index) => `
      <div class="scan-candidate${index === 0 ? ' scan-candidate-top' : ''}">
        <span class="scan-candidate-name">${c.name}</span>
        <span class="scan-candidate-print">${c.setCode} ${c.collectorNumber || ''}</span>
        <span class="scan-confidence">${Math.round(c.confidence * 100)}%</span>
      </div>`
    )
    .join('');
}

function renderCapture(entry) {
  el('scan-empty')?.classList.add('hidden');
  el('scan-result')?.classList.remove('hidden');

  swapCanvas('scan-preview-card', entry.card);
  swapCanvas('scan-preview-title', entry.title);
  swapCanvas('scan-preview-collector', entry.collector);

  const snapLabel = el('scan-snap-status');
  if (snapLabel) {
    if (!state.settings.snapEnabled) snapLabel.textContent = 'read from the guide as marked';
    else if (entry.snap) snapLabel.textContent = `snapped ${entry.snap.moved}px from the marked guide`;
    else snapLabel.textContent = 'card edges not found — used the marked guide';
  }

  // Draw where the crops were actually taken from. Without this the overlay
  // shows the marked quad while the reader used a snapped one, which is exactly
  // how a snap that moved 39px in the wrong direction went unnoticed.
  drawUsedQuad(entry.quad, !!entry.snap);

  const label = el('scan-capture-label');
  if (label) {
    const how =
      entry.trigger === 'auto'
        ? 'Auto-captured'
        : entry.trigger === 'upload'
          ? 'From file'
          : 'Manual capture';
    // The hash state is part of the label because its absence is invisible
    // otherwise: a capture that failed to hash still reads, still resolves and
    // still lists candidates — just from one signal instead of two.
    const hash = entry.hashError
      ? ` — art hash FAILED: ${entry.hashError}`
      : entry.artHash
        ? ` — art hash ${entry.artHash.slice(0, 8)}…`
        : ' — not hashed';
    label.textContent = `${how} at ${entry.at.toLocaleTimeString()} — rectified to ${entry.card.width}x${entry.card.height}${hash}`;
  }
}

function swapCanvas(containerId, canvas) {
  const container = el(containerId);
  if (!container) return;
  container.innerHTML = '';
  canvas.classList.add('scan-canvas');
  container.appendChild(canvas);
}

function renderRecent() {
  // The count is the session's to write, not this ring buffer's: state.captures
  // is capped at MAX_RECENT_CAPTURES so the page can hold thumbnails, and once
  // that number moved into the action bar as the session's headline it would
  // have stuck at 12 through a hundred-card box. See renderSummary in
  // scanSession.js, which counts rows.
  const strip = el('scan-recent');
  if (!strip) return;

  strip.innerHTML = '';
  for (const entry of state.captures) {
    const thumb = document.createElement('img');
    // Thumbnails come from the capture we already hold, so nothing is re-encoded
    // at full size and no image ever leaves the browser.
    thumb.src = entry.card.toDataURL('image/jpeg', 0.6);
    thumb.className = 'scan-thumb';
    thumb.title = entry.at.toLocaleTimeString();
    thumb.addEventListener('click', () => {
      renderCapture(entry);
      if (entry.reading) renderReading(entry);
      if (entry.candidates) renderCandidates(entry);
    });
    strip.appendChild(thumb);
  }
}

/* ---------------------------------------------------------------- fallback */

/**
 * Still-image fallback. A tightly cropped card photo is used whole; a looser
 * shot gets the same card-shaped box in the middle. Either way it goes through
 * the warp, which is a no-op for a rectangle — so this path exercises the whole
 * pipeline with no camera at all.
 */
async function captureFromFile(file) {
  try {
    const image = await loadImageFile(file);
    const aspect = image.width / image.height;
    const rect =
      Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT < 0.1
        ? { x: 0, y: 0, width: image.width, height: image.height }
        : guideRect(image.width, image.height);

    const guess = quadFromRect(rect, image.width, image.height);
    const previous = state.settings.quad;
    state.settings.quad = guess;
    const { quad, snap } = snapQuad(image, image.width, image.height);
    state.settings.quad = previous;

    const frame = frameImageData(image, image.width, image.height);
    emitCapture(frame, quad, image.width, image.height, 'upload', snap);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/* --------------------------------------------------------------- reference */

/**
 * Remember what the empty desk looks like through the quad.
 *
 * Absolute edge energy cannot tell a busy desk from a card: measured on a real
 * webcam, an empty desk scored 18.7 against a card's 19.7, and the fixed guide
 * happily auto-captured an empty room twelve times. Differencing against a
 * reference of the same patch of desk separates them properly.
 */
function markEmpty() {
  if (!state.buffers.analysis || !state.stream) {
    showToast('Start the camera first', 'error');
    return;
  }
  state.referenceGray = referenceFrom(state.buffers.analysis);
  state.autoCapture?.reset();
  updateReferenceLabel();
  showToast('Empty desk marked — a card is now detected by difference', 'success');
}

function clearReference() {
  state.referenceGray = null;
  state.autoCapture?.reset();
  updateReferenceLabel();
}

function updateReferenceLabel() {
  const text = el('scan-mark-empty')?.querySelector('.btn-text');
  if (text) text.textContent = state.referenceGray ? 'Re-mark empty' : 'Mark empty desk';
  el('scan-clear-reference')?.classList.toggle('hidden', !state.referenceGray);
}

/* ------------------------------------------------------------------ tuning */

const TUNING_FIELDS = [
  ['scan-threshold-stability', 'thresholds', 'stability'],
  ['scan-threshold-sharpness', 'thresholds', 'sharpness'],
  ['scan-threshold-presence', 'thresholds', 'presence'],
  ['scan-threshold-fill', 'thresholds', 'fill'],
  ['scan-threshold-streak', 'thresholds', 'streak'],
  ['scan-title-x', 'regions.title', 'x'],
  ['scan-title-y', 'regions.title', 'y'],
  ['scan-title-w', 'regions.title', 'w'],
  ['scan-title-h', 'regions.title', 'h'],
  ['scan-collector-x', 'regions.collector', 'x'],
  ['scan-collector-y', 'regions.collector', 'y'],
  ['scan-collector-w', 'regions.collector', 'w'],
  ['scan-collector-h', 'regions.collector', 'h'],
];

function settingsGroup(path) {
  return path.split('.').reduce((node, key) => node[key], state.settings);
}

function syncTuningInputs() {
  for (const [id, path, key] of TUNING_FIELDS) {
    const input = el(id);
    if (input) input.value = settingsGroup(path)[key];
  }
}

function applyTuningInput(id, path, key) {
  const value = parseFloat(el(id).value);
  if (Number.isNaN(value)) return;

  settingsGroup(path)[key] = value;
  saveSettings();
  state.autoCapture?.setThresholds(state.settings.thresholds);
  drawOverlay();
}

/* ------------------------------------------------------------------- setup */

export function setupScan() {
  window.addEventListener('page:scan', () => {
    const availability = cameraAvailability();
    if (!availability.available) showUnsupported(availability.reason);
    syncTuningInputs();
    const snapToggle = el('scan-snap-toggle');
    if (snapToggle) snapToggle.checked = state.settings.snapEnabled;
    const detectToggle = el('scan-detect-toggle');
    if (detectToggle) detectToggle.checked = state.settings.detectEnabled;
    drawOverlay();
    renderRecent();
    updateReferenceLabel();
  });

  // Leaving the page releases the camera — a live webcam indicator on a page the
  // user has navigated away from is alarming, and the stream is not free.
  window.addEventListener('page:leave', (event) => {
    if (event.detail?.page === 'scan') stopCamera();
  });

  // Reviewing stops the camera. See the dispatch in scanSession.js for why.
  window.addEventListener('scan:review-opened', () => {
    if (state.stream) stopCamera();
  });

  el('scan-start-btn')?.addEventListener('click', startCamera);
  el('scan-stop-btn')?.addEventListener('click', stopCamera);
  el('scan-camera-select')?.addEventListener('change', (e) => {
    state.cameraChoice = e.target.value;
    if (state.stream) startCamera();
  });

  el('scan-torch')?.addEventListener('click', toggleTorch);

  /**
   * Capture this card again, deliberately.
   *
   * The automatic shutter fires once per card and will not fire again until one
   * leaves the frame, which is what stops a stack producing rows of whichever
   * card sat still longest. That leaves one thing it cannot do: a second copy of
   * a card, held up straight after the first, looks exactly like the same card
   * still sitting there. This is how you say otherwise — and it is a manual
   * capture, so the identity check in resolveCapture stands aside for it.
   */
  function captureAgain() {
    const video = el('scan-video');
    if (!video?.videoWidth) {
      showToast('Start the camera first', 'error');
      return;
    }
    captureFromVideo(video, 'manual');
  }

  el('scan-shutter-btn')?.addEventListener('click', captureAgain);

  // Tapping the picture does the same, because on a phone the picture is what
  // is under your thumb and the button is not.
  el('scan-stage')?.addEventListener('click', (event) => {
    // Not while dragging a corner of the marked guide.
    if (event.target.classList?.contains('scan-handle')) return;
    if (!state.stream) return;
    captureAgain();
  });

  el('scan-auto-toggle')?.addEventListener('change', (e) => {
    state.autoEnabled = e.target.checked;
    state.autoCapture?.reset();
  });

  el('scan-detect-toggle')?.addEventListener('change', (e) => {
    state.settings.detectEnabled = e.target.checked;
    saveSettings();
    // Drop the tracked quad and the overlay together: leaving either behind
    // shows a card that is no longer being looked for.
    state.detected = null;
    if (!state.settings.detectEnabled) {
      renderDetection(null);
      el('scan-detect-status').textContent = 'Using the marked guide';
      drawOverlay();
      for (let i = 0; i < 4; i++) el(`scan-handle-${i}`)?.classList.remove('hidden');
    }
  });

  el('scan-record-toggle')?.addEventListener('change', (e) => {
    diagnostics.setRecording(e.target.checked);
    renderRecordingStatus();
  });

  el('scan-record-download')?.addEventListener('click', () => {
    // The settings go in with it: thresholds and crop regions are the
    // difference between a capture that was going to work and one that never
    // could, and a bundle that does not say which produced it can only be
    // guessed at.
    const { captures, bytes } = diagnostics.download(state.settings);
    showToast(`Saved ${captures} capture${captures === 1 ? '' : 's'} (${Math.round(bytes / 1024)}KB)`, 'success');
  });

  el('scan-sound-toggle')?.addEventListener('change', (e) => {
    state.sound = e.target.checked;
  });

  el('scan-ocr-toggle')?.addEventListener('change', (e) => {
    state.ocrEnabled = e.target.checked;
  });

  el('scan-snap-toggle')?.addEventListener('change', (e) => {
    state.settings.snapEnabled = e.target.checked;
    saveSettings();
  });

  el('scan-reread-btn')?.addEventListener('click', () => {
    const latest = state.captures[0];
    if (!latest) {
      showToast('Nothing captured yet', 'error');
      return;
    }
    readCapture(latest);
  });

  el('scan-mark-empty')?.addEventListener('click', markEmpty);
  el('scan-clear-reference')?.addEventListener('click', clearReference);

  el('scan-reset-guide')?.addEventListener('click', () => {
    const video = el('scan-video');
    state.settings.quad = defaultQuad(video?.videoWidth || 1920, video?.videoHeight || 1080);
    saveSettings();
    clearReference();
    drawOverlay();
  });

  el('scan-file-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) captureFromFile(file);
    // Reset so the same file can be picked twice in a row while tuning.
    e.target.value = '';
  });

  el('scan-clear-btn')?.addEventListener('click', () => {
    state.captures = [];
    renderRecent();
    el('scan-result')?.classList.add('hidden');
    el('scan-empty')?.classList.remove('hidden');
  });

  el('scan-reset-tuning')?.addEventListener('click', () => {
    // Resetting thresholds and regions must not throw away a quad dragged onto a
    // real card; the guide has its own reset.
    const quad = state.settings.quad;
    state.settings = freshSettings();
    state.settings.quad = quad;
    saveSettings();
    syncTuningInputs();
    state.autoCapture?.setThresholds(state.settings.thresholds);
    drawOverlay();
    showToast('Thresholds and regions reset to defaults', 'success');
  });

  for (const [id, path, key] of TUNING_FIELDS) {
    el(id)?.addEventListener('input', () => applyTuningInput(id, path, key));
  }

  for (let i = 0; i < 4; i++) {
    el(`scan-handle-${i}`)?.addEventListener('pointerdown', (e) => beginDrag(e, i));
  }
  window.addEventListener('pointermove', moveDrag);
  window.addEventListener('pointerup', endDrag);

  el('scan-video')?.addEventListener('loadedmetadata', drawOverlay);
  window.addEventListener('resize', drawOverlay);
}
