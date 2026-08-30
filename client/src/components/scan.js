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
  hashSize,
  imageDataOf,
  loadImageFile,
  medianComposite,
  motionFrameFor,
  quadFromRect,
  rectifiedSize,
  regionOutputSize,
  snapQuadToCard,
  trimMotionHistory,
  referenceFrom,
  regionQuad,
  warpQuad,
  warpQuadInto,
  warpRegion,
} from '../utils/cardCapture.js';
import { hashRectified, fromHex, hammingDistance } from '../../../src/shared/cardHash.js';
import * as diagnostics from '../utils/scanDiagnostics.js';
import * as localIndex from '../utils/localIndex.js';
import {
  detect as requestDetection,
  isReady as detectorReady,
  latest as latestDetection,
  load as loadDetector,
  detectNow,
  reset as resetDetection,
  timings as detectorTimings,
} from '../utils/cardDetector.js';

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
// 11: stillness is measured on a fixed framing again, so it no longer reads the
// detector's own jitter as motion. Anyone who met that jitter the only way it
// could be met — by raising stability past it, which is how it was found — is
// carrying a threshold around 15 that would now wave through real movement.
// 12: analysis runs at 20fps rather than 10. Stillness is unaffected — it is
// measured over a fixed 100ms window either way — but `streak` is a frame
// count, so a stored 4 now means 200ms of settle where it used to mean 400.
// Anyone who raised it to hold a wobbly hand would find it doing half the job.
const SETTINGS_VERSION = 12;

// The analysis buffer is deliberately tiny: every metric is a per-pixel pass
// over it on every frame, and none of them need detail.
const ANALYSIS_HEIGHT = 176;
const ANALYSIS_WIDTH = Math.round(ANALYSIS_HEIGHT * CARD_ASPECT);

// Frames are downscaled before the per-frame warp reads them back. Reading a
// full 1920x1080 frame into JS ten times a second is 8MB a go and pointlessly
// precise for deciding whether a card is sitting still.
const ANALYSIS_SOURCE_WIDTH = 480;

/**
 * How often the loop analyses a frame.
 *
 * 50ms rather than the 100 it ran at for most of this page's life. Every gate
 * downstream is counted in frames, so halving the interval halves the wall
 * time a card has to be held — which is most of what stood between the scanner
 * and the two cards a second it advertises.
 *
 * What made that affordable was moving detection into a worker: a tick used to
 * carry a 4-8ms contour sweep and now carries a 0.04ms request. What made it
 * *safe* is STABILITY_WINDOW_MS below — the one metric that would otherwise
 * have changed meaning silently.
 */
const ANALYSIS_INTERVAL_MS = 50;

/**
 * The span of time stillness is judged over, regardless of how often frames are
 * analysed.
 *
 * `difference` is the mean absolute change between two frames, and it carries
 * two things at once: the card's movement, which grows with the gap between
 * them, and the sensor's noise, which does not. Comparing consecutive frames at
 * 50ms apart would therefore have halved the movement while leaving the noise
 * where it was, and a stability bar of 9.0 — measured at 100ms — would have
 * quietly started admitting twice the motion it was set for.
 *
 * Neither raw nor rescaled numbers fix that, because the two components scale
 * differently. Comparing against the frame from a fixed time ago does: both
 * halves keep exactly the meaning they were measured with, and the thresholds
 * carry over untouched from the sessions that set them.
 */
const STABILITY_WINDOW_MS = 100;

/**
 * Framings of the detected quad to offer the resolver, as multipliers.
 *
 * 1.0 is what detection found; the rest pull *inward*. That direction is the
 * opposite of what this list held before, and the change is measured rather
 * than reasoned: the old ladder reached outward on the theory that contours
 * stop at a black border's inner edge, and across three recorded sessions no
 * outward probe ever won a single capture.
 *
 * Replayed offline — the recorded frames, warped through this same quad at
 * every scale from 0.88 to 1.13, hashed, and compared against each card's own
 * Scryfall reference — every scale above 1.0 was worse than 1.0 for all seven
 * cards, monotonically, and the basin sat entirely below it:
 *
 *      scale   0.92  0.94  0.96  0.98  1.00  1.04  1.08  1.12
 *      matched  2/7   2/7   4/7   3/7   1/7   0/7   0/7   0/7
 *
 * So detection is overshooting the card, not stopping short of it. The ladder
 * now spans that basin evenly, and 1.0 stays on the end deliberately: the seven
 * cards behind these numbers are one set, all bordered, and a borderless or
 * full-art card has no reason to share their optimum. Dropping the framing
 * detection actually found, on that evidence, would be fitting the sample.
 *
 * Five probes rather than four because the cost is trivial next to what it
 * buys — one warp and hash each on the client, one 1.7ms index pass each on the
 * server — and the fifth is the one keeping 1.0 without giving up a rung of the
 * basin. Against that sample the ladder took 1/7 to 5/7.
 *
 * ── Then sleeves widened it ─────────────────────────────────────────────────
 * Two later sessions — the same nine sleeved cards in the same order, one at a
 * desk and one in better kitchen light — put the basin much lower and much
 * further apart than seven bare cards had. Sweeping 0.84 to 1.08 across all
 * eighteen captures, the per-capture optimum ranged from 0.84 to 1.00, with a
 * cluster of cards wanting 0.86-0.90 that the old ladder could not reach at
 * all. Above 1.00 nothing matched in either session, which is the one thing
 * both samples agree on completely.
 *
 * That is what a sleeve does: detection finds the sleeve's outline, not the
 * card's, so the framing it reports is larger by the sleeve's margin and the
 * correction needed is bigger than a bare card's. It is also, most likely, the
 * answer to the 3/11 sleeved run recorded earlier and never explained.
 *
 * Same five rungs, spread wider, measured by replay against both sessions:
 *
 *      ladder                        desk   kitchen
 *      0.92 0.94 0.96 0.98 1.00      4/9      4/9      (the old one)
 *      0.86 0.90 0.94 0.98           6/9      7/9
 *      0.86 0.89 0.92 0.95 0.98      7/9      7/9
 *      0.84 0.87 0.90 0.93 0.96      7/9      7/9
 *      0.84 0.88 0.92 0.96 1.00      8/9      7/9
 *      0.84 0.88 0.92 0.96 0.98 1.00 8/9      7/9      (a sixth rung buys nothing)
 *
 * So: same cost, nearly double the matches. 1.0 still holds the end for the
 * reason it always did, and the spacing is deliberately even rather than fitted
 * to where these eighteen captures happened to land — two samples of one card
 * pool each is not enough to earn a bespoke ladder.
 *
 * What it does not fix: nothing in either session reached `confident`. The best
 * art distance was 46 of a 41-bit strong threshold, so a sleeved card is still
 * every-card-confirmed even when it matches. That cost is the sleeve itself,
 * not the framing, and it is still open.
 *
 * The two bare cards that needed more than a uniform scale still do: no single
 * multiplier brings Stalactite Dagger or Safewright Cavalry under threshold,
 * their best being 66 against a budget of 56. That is the anisotropy the
 * detector itself has to fix.
 */
const FRAMING_PROBES = [0.84, 0.88, 0.92, 0.96, 1];

/**
 * The one tier that means "nothing left to decide", mirrored from
 * scanService.js the same way scanSession.js mirrors the full set. Named here
 * because two decisions turn on it — whether the match chimes, and whether the
 * reader is asked at all — and a bare string in both is one typo from a session
 * that silently reads every card.
 */
const CONFIDENT_TIER = 'confident';

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
 * the list twice. About 300ms, comfortably longer than a blink and far shorter
 * than swapping a card.
 *
 * Counted from a duration rather than written as a frame count, because 300ms
 * is the thing that was measured and the analysis rate has changed once
 * already. The same reasoning applies to NEW_CARD_FRAMES; it does not apply to
 * the capture streak, which is deliberately allowed to shorten — see
 * DEFAULT_THRESHOLDS.streak.
 */
const ABSENCE_MS_TO_REARM = 300;
const ABSENCE_FRAMES_TO_REARM = Math.max(2, Math.round(ABSENCE_MS_TO_REARM / ANALYSIS_INTERVAL_MS));

/**
 * How different the card in frame must look before it counts as a new one, in
 * bits of the 256-bit art hash taken from the analysis buffer.
 *
 * Absence is not the only way a card is replaced. A funnel or chute — a Card
 * Slinger and the like — drops each card onto the last, so the scanning zone is
 * never empty and a shutter waiting for it to empty fires once and then never
 * again. What changes there is not presence but content.
 *
 * Measured on three real captures reduced to analysis size: the same card
 * jittered by a pixel of detection wobble moved 20-34 bits, and two genuinely
 * different cards sat 112-130 apart. 80 has better than twice the margin either
 * way, and two consecutive frames must agree before it counts — a single frame
 * over the line is far more likely to be a hand passing through than a card.
 */
const NEW_CARD_BITS = 80;
const NEW_CARD_MS = 200;
const NEW_CARD_FRAMES = Math.max(2, Math.round(NEW_CARD_MS / ANALYSIS_INTERVAL_MS));

/**
 * How many recent detections a capture is framed from.
 *
 * Detection runs fresh on every frame and lands a little differently each time
 * — re-detecting one motionless photograph twelve times with fresh sensor noise
 * moved corners by 0.41-0.71% of card width. A capture used the single frame the
 * shutter happened to fire on, so it inherited that whole spread.
 *
 * The mean of several detections does not: independent noise averages down by
 * the square root of the count, so four frames roughly halves it. Four because
 * that is what the shutter already waits for — `streak` frames of stillness —
 * so at the moment of capture there are four recent quads in hand and this uses
 * the ones the gates already accepted rather than asking for new ones.
 *
 * Deliberately a *variance* reduction and nothing else. An earlier attempt to
 * improve corner accuracy by fitting the card's edges was measured and dropped:
 * it cut jitter three- to eightfold and moved the sum of art distances by
 * nothing, because it also introduced a bias — extrapolating a straight fit
 * into a corner over an edge that turned out to be bowed. Averaging changes no
 * model and can introduce no such bias; it can only ever reduce spread.
 */
const FRAMES_AVERAGED = 4;

/**
 * How old a detection may be and still be averaged into a capture's framing.
 *
 * The run and the shutter used to span the same window by coincidence: four
 * detections at one per analysis frame was 400ms, and so was a streak of four.
 * Neither of those is true any more. Detection answers on the worker's own
 * schedule, and the streak is counted in 50ms ticks, so a run of four can now
 * reach back twice as far as the settle the shutter waited for — averaging in
 * framings from while the card was still being put down.
 *
 * A recorded session showed it: four captures of nine fell back to a single
 * frame because the run no longer agreed with itself, against one of nine
 * before. The quads were not noisier, they were older.
 *
 * 300ms is longer than any plausible settle and shorter than a card being
 * placed, and it is a duration rather than a count for the same reason the
 * absence gate is.
 */
const QUAD_AGE_MS = 300;

/**
 * How far apart two detections may sit and still be averaged, as a fraction of
 * card width.
 *
 * The mean of two framings of the same still card is a better answer than
 * either. The mean of a framing before a card moved and one after is a quad
 * over neither. This is the line between them: 4% is far outside the 0.4-0.7%
 * that noise produces and far inside the movement of a card being swapped.
 */
const AVERAGE_AGREEMENT = 0.04;

const MAX_RECENT_CAPTURES = 12;

const state = {
  stream: null,
  rafId: null,
  lastAnalysisAt: 0,
  // Recent motion buffers with the time each was taken, newest last. Stillness
  // compares against the one closest to STABILITY_WINDOW_MS old rather than the
  // frame before, so the number means the same thing at any analysis rate.
  motionHistory: [],
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
  // True while the scanner's assets are still downloading. The shutter is
  // refused and the stage is covered for the duration; see preflight.
  preflighting: false,
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
  // capture comes out legible and matches nothing. The hint only ever narrows
  // where detection looks — it is not blended into the answer.
  detected: null,
  // The detection the run last took, by identity. Detection answers on its own
  // schedule, so this is what separates "a new answer arrived" from "the same
  // answer read twice" — see the tick.
  // Sets this session has resolved unambiguously, counted. Ties between
  // printings of one card are ordered by it — see rememberSet.
  setTally: new Map(),
  rememberedDetection: null,
  // True while a capture's burst of frames is being gathered. See
  // captureFromVideo: the disarm that stops a second shutter lives in
  // emitCapture, which is now a couple of frames after the trigger.
  capturing: false,
  // The last few detections, newest last, cleared the moment the card is lost.
  // A capture is framed from their mean rather than from the single frame the
  // shutter fired on — see FRAMES_AVERAGED.
  recentQuads: [],
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
  // What the last captured card looked like, and how many frames running have
  // looked unlike it. See NEW_CARD_BITS.
  capturedSignature: null,
  changedFrames: 0,
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
  // overlap; until it lands, detection reports no card and nothing is captured.
  //
  // Narrated over the stage while it runs. The overlap is what makes this worth
  // saying out loud: the camera comes up first and the picture looks live and
  // ready long before anything can be found in it, which is an invitation to
  // start feeding cards that will not be seen. See showPreflight.
  preflight();

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
  state.motionHistory = [];
  state.referenceGray = null;
  updateReferenceLabel();
  drawOverlay();
  startLoop();
}

function stopCamera() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;

  // The detector keeps its last answer across a stop, and a session that opened
  // with it would start out believing a card was already under the lens. The
  // worker itself stays up: it holds 13MB of instantiated wasm that the next
  // start would otherwise download again.
  resetDetection();
  state.detected = null;
  state.rememberedDetection = null;
  state.recentQuads = [];

  // The download carries on in the background — it is cached on the module and
  // the next start will find it done — but the scrim belongs to a running
  // camera, and leaving it over a stopped one would strand the stage behind it.
  hidePreflight();

  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  const video = el('scan-video');
  if (video) video.srcObject = null;

  el('scan-start-btn')?.classList.remove('hidden');
  el('scan-stop-btn')?.classList.add('hidden');
  state.motionHistory = [];
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
 * Turn frame fractions into overlay percentages, through however the video is
 * actually being displayed.
 *
 * Every quad in this file is in *frame* coordinates — fractions of the camera's
 * own pixels — and the overlay SVG spans the stage with a 0-100 viewBox. Those
 * are the same thing only while the video fills the stage exactly, which is
 * true on a desktop, where `.scan-stage video` is `height: auto` and the stage
 * takes the video's shape.
 *
 * On a phone it is not. The scanning layout gives the stage a fixed height so
 * the action bar stays reachable, and the video is `object-fit: cover` inside
 * it — scaled up and cropped. Drawing a frame fraction straight onto the stage
 * then puts it wherever the crop happens to have moved that part of the
 * picture: a card filling most of the frame was outlined across its own art
 * box, which reads as the detector having locked onto the artwork.
 *
 * Nothing but the drawing was ever wrong. Detection, the capture warp and the
 * crops all work from `video.videoWidth/videoHeight`, so they never saw the
 * displayed box at all.
 *
 * Reproduces `cover`: scale by whichever axis needs more, centre the overflow,
 * then express the result as a percentage of the stage.
 */
function overlayPoints(quad) {
  const video = el('scan-video');
  const svg = el('scan-quad-card')?.ownerSVGElement;

  const boxWidth = svg?.clientWidth || 0;
  const boxHeight = svg?.clientHeight || 0;
  const videoWidth = video?.videoWidth || 0;
  const videoHeight = video?.videoHeight || 0;

  // Before the first frame, or on a layout where the video fills the stage,
  // the fractions are already the percentages.
  if (!boxWidth || !boxHeight || !videoWidth || !videoHeight) {
    return quad.map((p) => `${p.x * 100},${p.y * 100}`).join(' ');
  }

  const scale = Math.max(boxWidth / videoWidth, boxHeight / videoHeight);
  const shownWidth = videoWidth * scale;
  const shownHeight = videoHeight * scale;
  const offsetX = (boxWidth - shownWidth) / 2;
  const offsetY = (boxHeight - shownHeight) / 2;

  return quad
    .map((p) => {
      const x = ((offsetX + p.x * shownWidth) / boxWidth) * 100;
      const y = ((offsetY + p.y * shownHeight) / boxHeight) * 100;
      return `${x},${y}`;
    })
    .join(' ');
}

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

  const cardPoly = el('scan-quad-card');
  if (cardPoly) cardPoly.setAttribute('points', overlayPoints(quad));

  for (const key of ['title', 'collector']) {
    const poly = el(`scan-quad-${key}`);
    if (poly) {
      poly.setAttribute('points', overlayPoints(regionQuad(quad, state.settings.regions[key])));
    }
  }

  // The handles are positioned elements rather than SVG, so they take the same
  // mapping one point at a time.
  quad.forEach((corner, index) => {
    const handle = el(`scan-handle-${index}`);
    if (!handle) return;
    const [x, y] = overlayPoints([corner]).split(',');
    handle.style.left = `${x}%`;
    handle.style.top = `${y}%`;
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

  // A second buffer of the same size, cut from the *marked* guide rather than
  // from whatever detection found this frame. Stillness is measured here; see
  // the note on analyzeFrame for why it cannot be measured on the other one.
  const motion = document.createElement('canvas');
  motion.width = ANALYSIS_WIDTH;
  motion.height = ANALYSIS_HEIGHT;
  const motionCtx = motion.getContext('2d', { willReadFrequently: true });

  state.buffers = {
    source: sourceCtx,
    analysis: analysisCtx,
    motion: motionCtx,
    scratch: null,
    motionScratch: null,
  };

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
    // error before the art window walks off the illustration. The last quad
    // goes back in as this frame's hint, which keeps the steady state to two
    // threshold passes over a window instead of three over the whole frame —
    // see detectCardContour, which sweeps the frame anyway the moment tracking
    // comes up empty.
    if (state.settings.detectEnabled) {
      // Contours, not per-edge gradient search. The frame profile of a real
      // capture put the art window's border and the type line well above the
      // card's own outline, so searching for the strongest step near an edge
      // reliably found the wrong one — see cardContour.js.
      //
      // Asked for, not waited on: the answer lands a tick later and the loop
      // reads whatever the last one was. See cardDetector.js for why that is no
      // staler than the arrangement it replaced, and why a device that cannot
      // keep up detects less often rather than falling further behind.
      requestDetection(sourceFrame, state.detected?.quad || null);
      state.detected = detectorReady() ? latestDetection() : null;

      // Only *new* detections join the run. Detection is asynchronous now, so a
      // tick that arrives before the next answer reads the same one again, and
      // pushing it would fill the run with copies of a single measurement.
      //
      // That would quietly undo what the averaging is for. Four independent
      // detections of a still card cut the corner spread 1.87x — the noise is
      // what averages out. Four copies of one detection average to that
      // detection, with the spread of a single frame and the appearance of a
      // run, which is worse than not averaging because `snap.averaged` would
      // report 4 and a recording would show nothing wrong.
      if (state.detected !== state.rememberedDetection) {
        state.rememberedDetection = state.detected;
        rememberDetection(state.detected, timestamp);
      }
      renderDetection(state.detected);
    } else {
      state.detected = null;
      state.recentQuads = [];
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

    // The same frame through the marked guide, which does not move. Only the
    // stillness check reads this; everything else stays on the card as found.
    state.buffers.motionScratch = warpQuadInto(
      motionCtx,
      sourceFrame,
      state.settings.quad,
      state.buffers.motionScratch
    );

    const metrics = analyzeFrame(
      analysisCtx,
      motionFrameFor(state.motionHistory, timestamp, STABILITY_WINDOW_MS),
      state.referenceGray,
      motionCtx
    );
    rememberMotion(metrics.motionGray, timestamp);

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

    // A card is in frame, and one has already been captured. Two things can
    // mean it is a different card: the frame emptied in between (handled
    // above), or what is in frame stopped looking like what was captured —
    // which is what happens when a chute drops the next card onto the last and
    // the frame never empties at all.
    if (state.awaitingNewCard) {
      if (looksLikeANewCard(state.buffers.scratch)) {
        state.changedFrames++;

        if (state.changedFrames >= NEW_CARD_FRAMES) {
          state.awaitingNewCard = false;
          state.changedFrames = 0;
          // Deliberately NOT sawAbsence. Absence is proof of a fresh
          // presentation; a change in appearance is only evidence, so the
          // identity check in resolveCapture stays armed to catch the case
          // where this fired on the same card after all.
        }
      } else {
        state.changedFrames = 0;
      }

      if (state.awaitingNewCard) {
        state.autoCapture.reset();
        return;
      }
    }

    if (verdict.shouldCapture) {
      if (state.autoEnabled) {
        state.awaitingNewCard = true;
        rememberCapturedFrame();
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

  // Fourth chip, and the only one that is bad when high. The wording says what
  // to do about it rather than naming the metric, because the fix is physical:
  // a five-degree tilt clears sleeve glare that nothing downstream can.
  setChip(
    'scan-chip-glare',
    verdict.checks.clear !== false,
    verdict.checks.clear === false
      ? `Glare ${metrics.glare.toFixed(1)}% — tilt the card`
      : `Glare ${metrics.glare.toFixed(1)}/${thresholds.glare}%`
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
/**
 * Keep the detection, or forget the run if the card is gone.
 *
 * Cleared rather than aged out when detection comes up empty: a run of quads
 * spanning a gap describes two different presentations of the card, and their
 * mean describes neither.
 */
/** Keep the motion buffers the stillness window still needs. See cardCapture. */
function rememberMotion(gray, at) {
  state.motionHistory.push({ gray, at });
  trimMotionHistory(state.motionHistory, at, STABILITY_WINDOW_MS);
}

function rememberDetection(detection, at = performance.now()) {
  if (!detection) {
    state.recentQuads = [];
    return;
  }

  state.recentQuads.push({ quad: detection.quad, at });
  if (state.recentQuads.length > FRAMES_AVERAGED) state.recentQuads.shift();
}

/**
 * The framings recent enough to describe the card as it is now.
 *
 * Applied when a capture is framed rather than when a detection is stored: a
 * quad that is too old to average is still the best answer the overlay has, and
 * dropping it early would blank the outline whenever detection ran slow.
 */
function freshQuads(now = performance.now()) {
  return state.recentQuads.filter((entry) => now - entry.at <= QUAD_AGE_MS).map((e) => e.quad);
}

/** Mean card width across a run of quads, for judging agreement in card terms. */
function meanCardWidth(quads) {
  const widths = quads.map((q) =>
    (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2
  );
  return widths.reduce((a, b) => a + b, 0) / widths.length;
}

/**
 * The mean of the recent detections, where they agree closely enough to have a
 * meaningful mean.
 *
 * Returns null rather than a blend when any corner in the run sits further than
 * AVERAGE_AGREEMENT from the mean — the card moved mid-run, and the newest
 * detection alone is then the honest answer. Falling back to the latest, not to
 * the oldest or to a partial average, because the newest is the one the overlay
 * was showing when the shutter fired.
 */
function averagedQuad(quads) {
  if (quads.length < 2) return null;

  const mean = [0, 1, 2, 3].map((corner) => ({
    x: quads.reduce((total, q) => total + q[corner].x, 0) / quads.length,
    y: quads.reduce((total, q) => total + q[corner].y, 0) / quads.length,
  }));

  const limit = meanCardWidth(quads) * AVERAGE_AGREEMENT;
  for (const q of quads) {
    for (let corner = 0; corner < 4; corner++) {
      if (Math.hypot(q[corner].x - mean[corner].x, q[corner].y - mean[corner].y) > limit) return null;
    }
  }

  return mean;
}

function snapQuad(source, frameWidth, frameHeight) {
  // Automatic detection, where it has found something. The live loop has
  // already run it on this frame and left the answer in state.detected; using
  // that rather than detecting again keeps the capture framed exactly as the
  // overlay showed it, which is the framing the user agreed to by holding still.
  if (state.settings.detectEnabled && state.detected) {
    // Framed from the mean of the recent detections rather than from this one
    // frame, which is what takes the detector's own noise out of the framing.
    // See FRAMES_AVERAGED. Null when the run does not agree — the card moved
    // mid-run — and the latest detection stands.
    const fresh = freshQuads();
    const averaged = averagedQuad(fresh);
    return {
      quad: averaged || state.detected.quad,
      snap: {
        detected: true,
        via: state.detected.via,
        area: Number(state.detected.area.toFixed(3)),
        aspectError: Number(state.detected.aspectError.toFixed(3)),
        // How many detections went into the framing. One means the run
        // disagreed and this is a single frame after all, which is worth being
        // able to see in a recording rather than inferring.
        //
        // `runLength` is beside it because those are two different failures
        // wearing one number: a run of four that disagreed says the card moved,
        // while a run of two says detection did not answer often enough to
        // build one — which is a thing that can happen now that it answers
        // asynchronously, and which nothing else in a bundle would show.
        averaged: averaged ? fresh.length : 1,
        // Held detections, before the age filter. A runLength of four against
        // an `averaged` of one now means the run genuinely disagreed; before
        // the filter it could also have meant the run was simply too old.
        runLength: state.recentQuads.length,
        // How many of them were recent enough to use. Below runLength means
        // detection is answering slower than the shutter settles.
        freshLength: fresh.length,
        // How old the framing this capture was actually cut with is, in
        // milliseconds. The one number that says whether a capture describes
        // where the card is or where it was.
        quadAgeMs: state.recentQuads.length
          ? Math.round(performance.now() - state.recentQuads[state.recentQuads.length - 1].at)
          : null,
        // Whether the framing came from the captured frame or from the live
        // loop's last answer. 'live' means detection could not answer in time.
        quadSource: 'live',
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

/**
 * How many frames a capture is composited from. See medianComposite.
 *
 * Odd, and small. Three frames at 30fps is about 66ms of extra shutter lag on a
 * card that has already been still for four analysis frames — short enough that
 * the framing measured before the burst still describes the card at the end of
 * it, which is the assumption the whole thing rests on. Five would halve the
 * noise again and double that assumption's exposure.
 *
 * Set to 1 to turn compositing off entirely; everything downstream is written
 * to treat a burst of one as an ordinary capture, and the diagnostics record
 * both hashes either way.
 *
 * ── And it is 1, because a session said so ──────────────────────────────────
 * Nine cards, every capture carrying both hashes. Distance to the winning
 * candidate's reference, composite against the first frame alone:
 *
 *      54/52  76/74  82/82  88/86  84/86  98/102  84/82  108/108  106/104
 *
 * Worse or equal in seven of the nine. The premise was that hand tremor
 * guarantees a highlight moves between frames — and it does, but it moves the
 * *card* with it. Over the 66ms of a burst a hand-held card shifts by more than
 * the framing tolerance, so the median composites misaligned frames and softens
 * exactly the detail the hash reads. Compositing pays when the camera is fixed,
 * which is precisely the case where tremor is not there to move the glare.
 *
 * It was also dear: the median alone measured 402ms over a 12MP frame, before
 * the three full-resolution reads that feed it. That is most of a card's budget
 * spent making the answer slightly worse.
 *
 * Kept rather than deleted because the machinery is cheap to hold and the case
 * it was built for is real — a fixed rig under a lamp, where the frames align
 * and the glare does not. medianComposite is tested; this is one number.
 */
const CAPTURE_BURST = 1;

/** The next frame the camera paints, or a rendered frame where that is all we get. */
function nextVideoFrame(video) {
  return new Promise((resolve) => {
    // requestVideoFrameCallback fires on a *new* frame from the camera; rAF
    // fires on a repaint, which may hand back the same frame twice. Compositing
    // duplicates would be honest but pointless work, so the real thing is used
    // wherever it exists.
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => resolve());
    } else {
      requestAnimationFrame(() => resolve());
    }
  });
}

async function captureFromVideo(video, trigger) {
  const started = performance.now();
  // Held across the burst. The analysis loop keeps running while this awaits,
  // and without this a second shutter could fire into the middle of it — the
  // disarm that normally prevents that lives in emitCapture, which is now two
  // frames away.
  if (state.capturing) return;
  state.capturing = true;

  try {
    // The detection request goes first and is awaited last. Reading a 12MP
    // frame out of the video takes a few hundred milliseconds and detection's
    // round trip is another ~240; done in sequence that is most of a second
    // between the shutter and anything happening, and they have no need of each
    // other until the end.
    const framing = captureQuad(video);
    const frames = [frameImageData(video, video.videoWidth, video.videoHeight)];
    const { quad, snap } = await framing;

    for (let i = 1; i < CAPTURE_BURST; i++) {
      await nextVideoFrame(video);
      // The camera can stop mid-burst. Whatever arrived is still a capture.
      if (!video.videoWidth || !state.stream) break;
      frames.push(frameImageData(video, video.videoWidth, video.videoHeight));
    }

    emitCapture(frames, quad, video.videoWidth, video.videoHeight, trigger, snap, started);
  } finally {
    state.capturing = false;
  }
}

/**
 * The framing to cut a capture with: detected on the captured frame itself.
 *
 * The live loop's quad is the wrong tool here, and a recorded session put a
 * number on how wrong. Detection answers about 3.6 times a second on a phone
 * — 281ms mean, 865ms worst — so by the time the shutter fires the newest quad
 * is 180 to 460ms old. The shutter fires *because* the card has been still for
 * four frames, which means the stale quad can predate the very stillness that
 * triggered the capture: it describes the card as it was being put down.
 *
 * Detecting on the capture's own frame costs one round trip, once per card, and
 * removes that error entirely. Everything downstream — five framing probes,
 * both OCR crops — is cut with a quad that describes this photograph and no
 * other.
 *
 * Falls back to the live framing when detection cannot answer: the whole point
 * of the fallback is that a capture framed a little late still beats no capture.
 */
async function captureQuad(video) {
  const live = snapQuad(video, video.videoWidth, video.videoHeight);
  if (!state.settings.detectEnabled) return live;

  // Downscaled to the size detection works at, and hinted with where the card
  // just was — so this is a tracked refinement of a known position rather than
  // a full sweep, which is the difference between one round trip and three.
  const analysisFrame = frameImageData(video, ANALYSIS_SOURCE_WIDTH, Math.round(
    (ANALYSIS_SOURCE_WIDTH * video.videoHeight) / video.videoWidth
  ));

  const detected = await detectNow(analysisFrame, state.detected?.quad || null);
  if (!detected) return live;

  return {
    quad: detected.quad,
    snap: {
      ...live.snap,
      detected: true,
      via: detected.via,
      area: Number(detected.area.toFixed(3)),
      aspectError: Number(detected.aspectError.toFixed(3)),
      // Detected on the captured frame, so there is nothing to average and
      // nothing stale to report. The live-loop fields stay in the record for
      // comparison — see quadAgeMs, which should now read 0.
      quadSource: 'capture',
      quadAgeMs: 0,
    },
  };
}

/**
 * Rectify the card and take the crops, then hand them on. Phase 3 listens for
 * `scan:capture` and does the reading; nothing here interprets the pixels.
 *
 * Each crop is warped from the original frame rather than cut out of the
 * rectified card, so the small print is resampled once instead of twice.
 */
/**
 * Does the analysis buffer look unlike the card that was last captured?
 *
 * Hashes the small rectified buffer the loop already produces — about a third
 * of a millisecond — rather than anything at capture resolution. It is only
 * being asked to tell one card from another, which is a far coarser question
 * than telling which printing a card is.
 */
function looksLikeANewCard(analysisFrame) {
  if (!analysisFrame || !state.capturedSignature) return false;

  try {
    const now = fromHex(hashRectified(analysisFrame).artHash);
    return hammingDistance(now, state.capturedSignature) > NEW_CARD_BITS;
  } catch {
    // A buffer that will not hash tells us nothing either way, and claiming a
    // new card on it would capture the same one twice.
    return false;
  }
}

/**
 * How much a set named by hand counts for, against sets the session inferred.
 *
 * Above any plausible tally, because it is better evidence — but a number
 * rather than an override, so it stays the same kind of thing as the rest and
 * cannot reach past the rules in applySetBias.
 */
const SET_HINT_WEIGHT = 100;

/**
 * The sets this session has already been sure about, and how often.
 *
 * Only unambiguous resolutions count — a capture where the art matched exactly
 * one printing of its card, so the set is a measurement rather than a guess.
 * Cards unique to one printing are what seed it, and in a precon there are
 * always a few: two of the nine cards in the recorded ECC session were
 * ECC-only, which is enough to order every reprint behind them.
 *
 * Deliberately not fed by ambiguous resolutions. Tallying whichever printing
 * happened to lead would make the first arbitrary answer the second one's
 * evidence, and a session could talk itself into a set it never saw.
 */
function rememberSet(resolved) {
  // `confident` is the bar, not merely "one printing matched". The two are
  // different claims and the difference matters here: a capture can match
  // exactly one printing at 54 bits of a 77-bit budget, which is a lone answer
  // rather than a good one, and a session that seeds itself from one of those
  // spends the rest of its captures ordering ties toward a set it never saw.
  //
  // That is not hypothetical. The first recorded session with biasing seeded
  // itself from a single 54-bit match on INR — a set nowhere near the table —
  // and then biased seven more cards toward it. `confident` requires a strong
  // art match *and* a single printing, which is exactly the evidence a seed
  // should be made of.
  if (!resolved || resolved.tier !== CONFIDENT_TIER) return;
  if (resolved.signals?.printingsOfBest !== 1) return;

  const set = resolved.candidates?.[0]?.setCode;
  if (!set) return;

  state.setTally.set(set, (state.setTally.get(set) || 0) + 1);
}

/**
 * The tally in the shape the resolver takes, or null before anything is sure.
 *
 * A set named by hand goes in weighted above anything the session worked out
 * for itself. It is better evidence than the tally: somebody looking at the box
 * knows what is in it, where the tally is inferring from the two or three cards
 * that happened to be unique to one printing — and a recorded session showed
 * exactly how fragile that inference is, when both of a precon's unique cards
 * missed and the bias never fired at all.
 *
 * It still only orders ties. Naming a set does not make the art agree with it.
 */
function setTally() {
  const named = el('scan-set-hint')?.value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!named && !state.setTally.size) return null;

  const tally = Object.fromEntries(state.setTally);
  if (named) tally[named] = (tally[named] || 0) + SET_HINT_WEIGHT;
  return tally;
}

/** Remember what was in frame at the moment of a capture. See looksLikeANewCard. */
function rememberCapturedFrame() {
  try {
    state.capturedSignature = state.buffers.scratch
      ? fromHex(hashRectified(state.buffers.scratch).artHash)
      : null;
  } catch {
    state.capturedSignature = null;
  }
  state.changedFrames = 0;
}

/** A quad scaled about its own centre. */
function expandQuad(quad, scale) {
  const cx = quad.reduce((total, p) => total + p.x, 0) / 4;
  const cy = quad.reduce((total, p) => total + p.y, 0) / 4;
  return quad.map((p) => ({
    x: cx + (p.x - cx) * scale,
    y: cy + (p.y - cy) * scale,
  }));
}

function emitCapture(frames, quad, frameWidth, frameHeight, trigger, snap = null, started = null) {
  // One photograph, made of however many the shutter managed to take. Every
  // warp below — the card, the five framing probes, both OCR crops — is cut
  // from this rather than from any single frame, which is the cheap way round:
  // one pass over the source instead of one per crop.
  const burst = Array.isArray(frames) ? frames : [frames];
  const frame = medianComposite(burst);
  // Two sizes, and the difference between them is most of what a capture costs.
  //
  // `size` is the card at the resolution the camera actually gave it, and the
  // OCR crops are cut at that scale because small text needs every pixel.
  // `hashed` is a fixed 680 tall, the size every reference was hashed at, and
  // it is what the card and all five framing probes are warped to. A 4K frame
  // rectifies to a card of some two thousand pixels tall, six warps of it per
  // capture on the main thread, all so that hashRectified can average the
  // result down to a 32x32 grid — see HASH_HEIGHT for the measurements saying
  // the extra pixels do not change the answer.
  const size = rectifiedSize(quad, frameWidth, frameHeight);
  const hashed = hashSize();
  const card = warpQuad(frame, quad, hashed.width, hashed.height);

  /**
   * The reader's crops, cut when the reader asks for them and not before.
   *
   * They are the two most expensive warps a capture does — cut from the source
   * frame at three times their size on the card, because the collector line is
   * a dozen pixels tall and OCR needs every one. On a 12MP frame that is around
   * two million destination pixels, and with the reader switched off, which is
   * the default, every one of them was thrown away unread.
   *
   * Memoised rather than merely deferred: the preview panel draws them too, and
   * a capture that is read *and* looked at should still only cut them once.
   */
  let crops = null;
  const cropsOf = () => {
    if (crops) return crops;
    const cropOf = (region) => {
      const out = regionOutputSize(size, region);
      return warpRegion(frame, quad, region, out.width, out.height);
    };
    crops = {
      title: cropOf(state.settings.regions.title),
      collector: cropOf(state.settings.regions.collector),
    };
    return crops;
  };

  const entry = {
    id: Date.now() + Math.random(),
    trigger,
    card,
    // Getters, so every existing reader of entry.title / entry.collector keeps
    // working and only the ones that actually look pay for the warp.
    get title() {
      return cropsOf().title;
    },
    get collector() {
      return cropsOf().collector;
    },
    quad,
    snap,
    // What the camera gave, kept because `card` no longer says it: the rectified
    // card is a fixed size now, so the only remaining record of how many pixels
    // were actually on the card is this. A session that matches badly at arm's
    // length and well up close is invisible without it.
    nativeSize: size,
    // Where the time between the shutter and the answer goes. Recorded because
    // "make the notification faster" could not be measured at all otherwise —
    // the bundle knew when a capture happened and never how long it took to
    // become a verdict. `shutterMs` covers framing and the frame reads,
    // `hashMs` the rectify-and-hash of the card and its five probes, and
    // `resolveMs` the round trip to the matcher.
    timings: { shutterMs: started === null ? null : Math.round(performance.now() - started) },
    // How many frames the shutter actually managed to composite. Fewer than
    // CAPTURE_BURST means the camera stopped mid-burst.
    burst: burst.length,
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

    // And the same card at a few framings, because where detection stopped is
    // not knowable from the picture. Contours lock onto whichever boundary held
    // the most contrast, and how far that sits from the card's true edge varies
    // with the light — while every reference is a whole card, cut exactly to
    // its borders. Sending the spread costs a warp and a hash each here and one
    // index pass each on the server; guessing a single framing would be right
    // for one lighting setup and wrong for the next. See FRAMING_PROBES for
    // which way the ladder points and why it was turned around.
    const hashStarted = performance.now();
    entry.probes = FRAMING_PROBES.map((scale) => {
      const framed = expandQuad(quad, scale);
      const probe = hashRectified(
        imageDataOf(warpQuad(frame, framed, hashed.width, hashed.height))
      );
      return { scale, ...probe };
    });
    entry.timings.hashMs = Math.round(performance.now() - hashStarted);

    // The same card cut from the first frame alone, hashed and kept but never
    // sent. It is the control for compositing: without it a bundle says how
    // well the composite did and nothing about whether the burst was worth
    // taking, and the honest way to find that out is to carry both numbers on
    // every capture rather than to reason about it.
    if (burst.length > 1) {
      entry.singleArtHash = hashRectified(
        imageDataOf(warpQuad(burst[0], quad, hashed.width, hashed.height))
      ).artHash;
    }
  } catch (error) {
    // A capture that cannot be hashed is still a capture worth reading. The
    // resolver treats a missing hash as "no second signal" and says so.
    entry.hashError = error.message;
  }

  entry.timings.emitMs = started === null ? null : Math.round(performance.now() - started);

  state.captures.unshift(entry);
  state.captures = state.captures.slice(0, MAX_RECENT_CAPTURES);
  state.autoCapture?.disarm();

  // The flash goes first, before anything that takes real time.
  //
  // Its whole job is to say *which frame* was taken, and it can only do that if
  // it lands with the shutter. It used to fire after diagnostics.recordCapture,
  // which JPEG-encodes the rectified card and the whole frame on the main
  // thread — two encodes standing between the shutter and its own confirmation.
  // Over a long recorded run the delay was noticeable enough to read as the
  // scanner slowing down, when what was slowing was the acknowledgement.
  flashShutter();
  renderCapture(entry);
  renderRecent();

  // Recorded before anything is resolved, so a capture that never comes back
  // still leaves a trace. The frame goes in beside the rectified card because a
  // framing fault is only visible in the two together.
  diagnostics.recordCapture(entry, { frame });
  renderRecordingStatus();

  window.dispatchEvent(new CustomEvent('scan:capture', { detail: entry }));

  // Resolve on the art alone, now, before anything is read. This is the whole
  // shape of the scanner: the hash is ~1ms to compute and 1.7ms to search
  // against all 112k references, where OCR is seconds. Resolving behind the
  // reader made every card cost a tesseract pass and made auto-capture look
  // broken — the shutter would fire again long before the previous card's
  // answer arrived, so the queue filled with cards nobody had seen resolved.
  // The reader is a refinement that lands late and never blocks, and it is
  // started from inside resolveCapture rather than here — see readIfUnresolved.
  // Queueing it beside the resolve, as this did, read every card whether the
  // art had already answered or not.
  resolveCapture(entry);
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
    outline.setAttribute('points', detection ? overlayPoints(detection.quad) : '');
    outline.classList.toggle('scan-quad-found', !!detection);
  }

  // The crop boxes move with the card too.
  //
  // They used to be drawn once, against the *marked guide*, and never redrawn —
  // so they sat still while the outline tracked the card. On a chute that feeds
  // cards onto a rising stack the card drifts steadily away from the guide, and
  // the boxes were last seen visibly off the print by the end of a 90-card run.
  //
  // Only ever a lie in the overlay: the crops themselves are cut in
  // emitCapture with `warpRegion(frame, quad, ...)` against the quad the
  // capture was actually framed from, so the reader always had the right
  // pixels. But an overlay that reports where the reader is looking is worth
  // nothing if it reports somewhere else, and it is the only thing anyone has
  // to judge the crop regions by.
  // Drawn only while the reader is on. They mark where the reader looks, so
  // with nothing reading they are two dashed boxes over the card saying nothing
  // — and they sit right on top of the outline that does have something to say.
  const showRegions = detection && state.ocrEnabled;
  for (const key of ['title', 'collector']) {
    const poly = el(`scan-quad-${key}`);
    if (!poly) continue;
    poly.setAttribute(
      'points',
      showRegions ? overlayPoints(regionQuad(detection.quad, state.settings.regions[key])) : ''
    );
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
 * Load what the scanner needs, over a scrim, before any of it is usable.
 *
 * Two assets, both large, both fetched on first use rather than at page load so
 * that someone who never opens the scanner never pays for them: the OpenCV
 * detector at ~13MB, always, and tesseract's engine and language data at ~17MB
 * only where the reader is switched on.
 *
 * The problem this exists for is not the wait, it is what the wait looks like.
 * The camera comes up in a second or so and the picture is live and convincing
 * while detection still finds nothing, so cards get placed and passed under a
 * scanner that is not yet listening — and the failure is silent, because "no
 * card found" is also what an empty frame looks like. A small status line
 * saying "Loading card detector…" was already there and was plainly not enough.
 *
 * The reader is deliberately *not* preloaded when it is switched off. It is
 * 17MB that most sessions never need, and pulling it up front to make the
 * progress bar look thorough would be a real cost for a cosmetic gain.
 */
async function preflight() {
  const needsReader = state.ocrEnabled && !state.reader?.ready;

  // Nothing to wait for — a camera restarted in the same session, with both
  // assets already in memory. Putting the scrim up to take it down again a
  // frame later would be a flash of "not ready" on a scanner that is.
  if (detectorReady() && !needsReader) return;

  if (!detectorReady()) {
    showPreflight('Downloading the card detector…', null);
    await loadDetector({
      onProgress: ({ loaded, total, progress }) => {
        showPreflight(
          total
            ? `Downloading the card detector… ${formatMB(loaded)} of ${formatMB(total)}`
            : 'Downloading the card detector…',
          progress
        );
      },
    });
  }

  // Reported separately rather than folded into one bar. They are different
  // sizes and only one of them always runs, so a single combined percentage
  // would mean something different from session to session.
  if (needsReader) await preflightReader();

  hidePreflight();
  renderDetection(state.detected);
}

/**
 * Bring the reader up while the scrim is still showing.
 *
 * Tesseract reports progress as named stages rather than bytes, so the label is
 * its own wording tidied up. Failure is swallowed: the reader is a refinement,
 * and a scanner that will not start because the *optional* half of it could not
 * download would be a worse outcome than one that scans on the art alone.
 */
async function preflightReader() {
  showPreflight('Downloading the card reader…', null);
  try {
    await reader().warmUp((message) => {
      if (!message?.status) return;
      showPreflight(
        `Card reader: ${message.status.replace(/_/g, ' ')}`,
        typeof message.progress === 'number' ? message.progress : null
      );
    });
  } catch (error) {
    console.error('The card reader could not be loaded', error);
    showToast('Card reader unavailable — scanning on the art alone', 'error');
  }
}

/**
 * Time matching this session's captures on the device instead of the server.
 *
 * The spike behind docs/ON_DEVICE_MATCHING.md. Two numbers matter and only one
 * of them can be got from a desktop: how long a *phone* takes to search 112,815
 * references five times, and whether it lands on the same answer the server
 * gave — which is checkable here because every capture already carries what the
 * server said.
 *
 * Uses the session's own captures rather than synthetic hashes. A benchmark
 * over made-up data would measure the loop and not the question.
 */
async function benchLocalMatching() {
  const status = el('scan-bench-status');
  const say = (text) => {
    if (status) status.textContent = text;
  };

  const captures = state.captures.filter((entry) => entry.probes?.length);
  if (!captures.length) {
    say('Scan a few cards first — this measures matching them, not a synthetic hash.');
    return;
  }

  try {
    say('Downloading the index…');
    const count = await localIndex.load(() => api.fetchHashIndex());
    const { bytes, loadMs } = localIndex.stats();

    // Warm the loop before timing it: the first search of a 4.5MB typed array
    // pays for cache misses that no later one does, and reporting that as the
    // cost would overstate it on exactly the device we care about.
    localIndex.searchProbes(captures[0].probes);

    const times = [];
    let agreed = 0;
    let compared = 0;

    for (const entry of captures) {
      const started = performance.now();
      const { matches } = localIndex.searchProbes(entry.probes);
      times.push(performance.now() - started);

      const server = entry.candidates?.[0]?.uuid;
      if (server) {
        compared++;
        if (matches[0]?.uuid === server) agreed++;
      }
    }

    const mean = times.reduce((sum, ms) => sum + ms, 0) / times.length;
    const line =
      `${(bytes / 1048576).toFixed(1)}MB / ${count} refs in ${loadMs}ms · ` +
      `match ${mean.toFixed(0)}ms mean, ${Math.max(...times).toFixed(0)}ms worst ` +
      `(${captures.length} captures × ${captures[0].probes.length} probes) · ` +
      `agreed with server on ${agreed}/${compared}`;

    say(line);
    console.log('[local matching]', line);
  } catch (error) {
    say(`Local matching failed: ${error.message}`);
  }
}

/** Bytes as megabytes, for a download nobody needs to the byte. */
function formatMB(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

/**
 * Put the scrim up, or update it.
 *
 * `progress` null means "no honest percentage available" — an asset the server
 * sent without a Content-Length, or a stage tesseract does not quantify — and
 * the bar sweeps rather than inventing a number.
 */
function showPreflight(what, progress) {
  state.preflighting = true;
  el('scan-preflight')?.classList.remove('hidden');
  setCaptureEnabled(false);

  const label = el('scan-preflight-what');
  if (label) label.textContent = what;

  const bar = el('scan-preflight-bar');
  if (!bar) return;

  const known = typeof progress === 'number' && Number.isFinite(progress);
  bar.classList.toggle('is-indeterminate', !known);
  bar.style.width = known ? `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` : '';
}

function hidePreflight() {
  state.preflighting = false;
  el('scan-preflight')?.classList.add('hidden');
  setCaptureEnabled(true);
}

/**
 * Grey the two ways to take a capture while the scanner is not ready.
 *
 * The scrim covers the picture but not the action bar below it, so without this
 * the shutter still looks pressable and pressing it only produces a toast. Both
 * routes are disabled, not just the shutter: a still image goes through the
 * same detector, and picking one early rectifies it against the marked guide
 * rather than the card.
 */
function setCaptureEnabled(enabled) {
  const shutter = el('scan-shutter-btn');
  if (shutter) shutter.disabled = !enabled;

  // A label wrapping a hidden input, so there is no `disabled` to set on the
  // control you can see. Disabling the input is what actually stops the picker
  // opening; the class is what says so.
  const fileInput = el('scan-file-input');
  if (fileInput) fileInput.disabled = !enabled;
  el('scan-file-label')?.classList.toggle('is-disabled', !enabled);
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

  outline.setAttribute('points', overlayPoints(quad));
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
  // Marked as the read is queued rather than as it completes. A recorded
  // capture that says it was queued and carries no reading is one the bundle
  // was taken ahead of; one that says it was never queued was never asked.
  diagnostics.noteReadQueued(entry.id);
  // Redrawn here as well as when a read lands, or the count only ever ticks
  // downward and never appears in the first place — the capture is recorded and
  // the status drawn before the resolve that decides whether to read at all.
  renderRecordingStatus();
  state.readQueue = state.readQueue.then(() => runRead(entry)).catch(() => {});
  return state.readQueue;
}

/**
 * Queue a read, but only where the art did not already settle the capture.
 *
 * The reader has always been described as earning its seconds only when the art
 * has named a card but not a printing. It was not actually gated on anything:
 * every capture was queued, `confident` ones included, so a session paid a full
 * OCR pass to re-confirm answers that had no alternative.
 *
 * That is affordable at one card every few seconds and is not at the pace this
 * is built for. The scan loop's budget is the art hash — about a millisecond to
 * compute and under two to search all 112k references — while a read is six
 * `recognize()` passes over two crops. Queue one of those per card and the
 * queue grows without bound, and every read in it is behind cards the operator
 * finished with long ago.
 *
 * `confident` is the only tier that means "nothing left to decide", so it is
 * the only one skipped. `pick-printing` is the case the reader is *for* — the
 * art knows the card and only the collector block can say which printing — and
 * `unsure` and `conflict` both still need whatever a second opinion can add.
 */
function readIfUnresolved(entry, tier) {
  if (!state.ocrEnabled) return;
  if (tier === CONFIDENT_TIER) return;
  readCapture(entry);
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
    if (state.ocrEnabled) readCapture(entry);
    else {
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

    const resolveStarted = performance.now();
    const resolved = await api.resolveScanProbes({
      artHashes: probes.map((p) => p.artHash),
      frameHashes: probes.map((p) => p.frameHash),
      setBias: setTally(),
      limit: 25,
    });

    if (entry.timings) entry.timings.resolveMs = Math.round(performance.now() - resolveStarted);

    rememberSet(resolved);

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
    // The name first, and marked settled when it is. A tier of `unsure` is a
    // verdict about the *printing*, and reading it as doubt about the card is
    // what made every scan of a reprint look like a failed one.
    setReadStatus(
      best
        ? `${best.name}${resolved.signals?.nameCertain ? ' ✓' : ''} — ${best.setCode} ${
            best.collectorNumber || ''
          }${resolved.signals?.nameCertain && resolved.tier !== CONFIDENT_TIER ? ' (choosing printing)' : ''} (art${wonScale})`
        : near
          ? `No match — nearest ${near.artDistance}/${near.bits} bits (needs ≤${near.matchWithin})`
          : 'No art match'
    );
    renderLiveMatch(best || null);
    // A miss gets a pulse of its own: renderLiveMatch(null) clears the panel and
    // would otherwise leave nothing at all to see, which reads as the scanner
    // still thinking.
    if (!best) pulseOverlay('miss');
    diagnostics.attachResolution(entry.id, resolved);
    signalMatch(resolved);

    window.dispatchEvent(new CustomEvent('scan:resolved', {
      detail: {
        id: entry.id,
        reading: null,
        tier: resolved.tier,
        candidates: resolved.candidates,
        signals: resolved.signals,
      },
    }));

    readIfUnresolved(entry, resolved.tier);
  } catch (error) {
    setReadStatus(`Match failed: ${error.message}`);
    renderLiveMatch(null);
    pulseOverlay('miss');
    diagnostics.attachFailure(entry.id, error.message);

    // The art's answer never arrived, so there is nothing for the reader to be
    // redundant with. This is exactly the case it exists for.
    if (state.ocrEnabled) readCapture(entry);
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

  // Reads outstanding, so the moment a bundle is worth taking is visible rather
  // than guessed at. A read is tens of seconds and the captures are a few
  // seconds apart, so the queue routinely outlives the scanning.
  const pending = diagnostics.pendingReads();
  const waiting = pending ? ` ${pending} still being read.` : '';

  // Whether the recording is holding anything worth looking at. A long clean
  // run is a file nobody needs; the one card that missed is the whole point,
  // and the buffer now keeps it — see makeRoom in scanDiagnostics.
  const failures = diagnostics.heldFailures();
  const kept = failures ? ` ${failures} unmatched.` : '';

  status.textContent = diagnostics.isRecording()
    ? held
      ? `Recording — ${held} capture${held === 1 ? '' : 's'} held.${kept}${waiting}`
      : 'Recording — scan a card.'
    : held
      ? `Stopped — ${held} capture${held === 1 ? '' : 's'} still held.${kept}${waiting}`
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
/**
 * Price bands, and the outline colour each one paints the card.
 *
 * The point is to spot the card worth stopping for while looking at the cards
 * rather than at the screen — so the bands are coarse and the cheapest one is
 * deliberately unmarked. Colouring everything would mean colour carried no
 * information: most of a bulk box is under a pound, and an outline on all of it
 * is just the outline.
 *
 * Ordered high to low and matched on the first threshold met, so a new band only
 * ever has to be inserted in the right place.
 */
const PRICE_BANDS = [
  { min: 20, band: 'purple' },
  { min: 10, band: 'blue' },
  { min: 5, band: 'green' },
  { min: 1, band: 'yellow' },
  // Everything else, including a card with no price at all. It used to be the
  // absence of a band, which made the commonest outcome in a precon box —
  // a card worth pennies — look exactly like a card that had not resolved yet.
  // The colour says what it is worth; that there is a colour at all says the
  // scanner is done with it, and that is the half somebody feeding cards
  // actually needs.
  { min: -Infinity, band: 'grey' },
];

/** Which band a price falls in. Never null: see the last entry in PRICE_BANDS. */
function priceBand(price) {
  const value = typeof price === 'number' && Number.isFinite(price) ? price : 0;
  return PRICE_BANDS.find((entry) => value >= entry.min)?.band || 'grey';
}

/** A price as it goes on screen. Null prices say so rather than showing $0.00. */
function formatPrice(price) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return 'no price';
  return `$${price.toFixed(2)}`;
}

function renderLiveMatch(candidate) {
  const live = el('scan-live');
  if (!live) return;

  live.classList.toggle('hidden', !candidate);

  // The outline is painted whether or not the panel is showing, and cleared
  // when the match goes away — an outline still coloured from the last card is
  // worse than no colour at all, because it is a claim about this one.
  const overlay = el('scan-overlay');
  const band = candidate ? priceBand(candidate.price) : null;
  if (overlay) {
    for (const entry of PRICE_BANDS) {
      overlay.classList.toggle(`scan-price-${entry.band}`, band === entry.band);
    }
  }

  if (candidate) pulseOverlay(band);

  if (!candidate) return;

  el('scan-live-name').textContent = candidate.name;

  el('scan-live-print').textContent =
    `${candidate.setCode} ${candidate.collectorNumber || ''}`.trim();

  const price = el('scan-live-price');
  if (price) {
    price.textContent = formatPrice(candidate.price);
    price.className = `scan-live-price${band ? ` scan-live-price-${band}` : ''}`;
  }
}

/**
 * Flash the outline round the card once, in the colour of the answer.
 *
 * The scanner is faster than the person feeding it, and the person is watching
 * the cards rather than the screen — so the thing that decides throughput is
 * how quickly they can tell the last card is done. Text changing in a panel is
 * not it: it arrives after the shutter flash, which is white and draws the eye
 * away, and it has to be read.
 *
 * A pulse of colour round the window they are already looking at says two
 * things at once and neither has to be read: it is finished, and this is
 * roughly what it is worth. A miss pulses too, in red — knowing a card needs
 * feeding again is worth as much as knowing it landed.
 *
 * Restarted rather than queued: two cards in quick succession should give two
 * pulses, and the second one wins. Removing the class and forcing a reflow
 * before re-adding it is what makes an animation replay.
 */
function pulseOverlay(band) {
  // Both halves of the viewfinder: the outline round the card, and the panel
  // that names it. They are read at different moments — the outline in the
  // corner of the eye while the cards are being watched, the panel when the eye
  // comes up — so firing only one of them is a cue that can be missed by
  // looking at the wrong half of your own screen.
  pulseElement(el('scan-overlay'), 'scan-overlay-pulse', band);
  pulseElement(el('scan-live'), 'scan-live-pulse', band);
}

/** Restart one element's pulse. See pulseOverlay. */
function pulseElement(node, className, band) {
  if (!node) return;

  node.classList.remove(className);
  // Reading a layout property flushes the removal, so the animation restarts
  // rather than being coalesced away as no change at all.
  void node.offsetWidth;
  node.dataset.pulse = band || 'miss';
  node.classList.add(className);
}

/**
 * A short tone per card, pitched by how the match went.
 *
 * The point of scanning a box is that you are looking at the cards, not at the
 * screen. A rising note means it is filed and you can move on; a lower one means
 * this card will be waiting in review. Built from an oscillator rather than an
 * asset so it costs nothing to ship and works offline.
 */
/**
 * @param resolved  the whole verdict, not just its tier: the tone answers "can
 *   I move on", and the honest answer to that is the *name* being settled. A
 *   reprint that will need its printing picked at review time is still a card
 *   the scanner has identified, and sounding the same note for it as for a card
 *   it could not read at all was telling somebody to stop when they need not.
 */
function signalMatch(resolved) {
  if (!state.sound) return;

  const settled = resolved?.tier === CONFIDENT_TIER || resolved?.signals?.nameCertain;

  try {
    state.audio = state.audio || new (window.AudioContext || window.webkitAudioContext)();
    const context = state.audio;
    if (context.state === 'suspended') context.resume();

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = settled ? 1320 : 440;
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
    // The only path out of here that never reaches attachReading, so it is also
    // the only one that would leave the capture counted as still being read for
    // the rest of the session — and the download warning nagging about a read
    // that is never coming.
    diagnostics.attachFailure(entry.id, `read failed: ${error.message}`);
    renderRecordingStatus();
    window.dispatchEvent(new CustomEvent('scan:read-failed', {
      detail: { id: entry.id, message: error.message },
    }));
    return;
  }

  entry.reading = reading;
  diagnostics.attachReading(entry.id, reading);
  // One fewer read outstanding, which the status line counts down so the point
  // at which a bundle is complete is visible rather than timed by hand.
  renderRecordingStatus();
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
    const probes = entry.probes?.length
      ? entry.probes
      : [{ artHash: entry.artHash, frameHash: entry.frameHash }];

    const resolved = await api.resolveScanProbes({
      // The same ladder the first pass used. Re-asking with the unexpanded hash
      // alone is how a reading that misfired came to *replace* a correct art
      // answer: at scale 1.0 the art matches nothing on a sleeved card, and an
      // unopposed misread is a wrong card with a confident-looking row.
      artHashes: probes.map((p) => p.artHash),
      frameHashes: probes.map((p) => p.frameHash),
      name: reading.name,
      setCode: reading.setCode,
      collectorNumber: reading.collectorNumber,
      setBias: setTally(),
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

    // Recorded as its own stage, beside the art-only answer rather than over
    // it. What the reader was worth is the difference between the two, and
    // without this the bundle only ever showed the first pass — every capture
    // reporting no text signal however well the collector block had read.
    diagnostics.attachResolution(entry.id, resolved, { stage: 'text' });

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

  // The two reader crops are only shown when something is going to read them.
  // With the reader off they are two pictures of print nobody is looking at,
  // sitting above the card that was actually identified — and they invite the
  // reasonable but wrong conclusion that the scanner is reading the text.
  //
  // Not cut either, now, which is a change: they used to be warped on every
  // capture on the grounds that the reader would want them the moment the
  // toggle went on and that the recording carried them. The recording carries
  // the rectified card and the frame, not these; and the toggle path re-reads
  // through the same getter, which cuts them then. They are the two most
  // expensive warps a capture does — three times their size on the card, off a
  // 12MP frame — and with the reader off, which is the default, every one was
  // thrown away unread.
  if (state.ocrEnabled) {
    swapCanvas('scan-preview-title', entry.title);
    swapCanvas('scan-preview-collector', entry.collector);
  }
  el('scan-crop-title')?.classList.toggle('hidden', !state.ocrEnabled);
  el('scan-crop-collector')?.classList.toggle('hidden', !state.ocrEnabled);

  const snapLabel = el('scan-snap-status');
  if (snapLabel) {
    // Two different things can have framed this capture and they report
    // different fields. Detection returns which thresholding found the card and
    // how many frames were averaged; the older edge-snap returns how far it
    // moved the marked guide. Reading `moved` off a detection put the word
    // "undefined" in the one line that says whether the framing can be trusted.
    if (entry.snap?.detected) {
      const averaged = entry.snap.averaged > 1 ? `, ${entry.snap.averaged} frames averaged` : '';
      snapLabel.textContent = `card found by ${entry.snap.via}${averaged}`;
    } else if (entry.snap && Number.isFinite(entry.snap.moved)) {
      snapLabel.textContent = `snapped ${entry.snap.moved}px from the marked guide`;
    } else if (!state.settings.snapEnabled && !state.settings.detectEnabled) {
      snapLabel.textContent = 'read from the guide as marked';
    } else {
      snapLabel.textContent = 'card edges not found — used the marked guide';
    }
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
    emitCapture([frame], quad, image.width, image.height, 'upload', snap);
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
  ['scan-threshold-glare', 'thresholds', 'glare'],
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
    // Refused rather than queued while the detector is still downloading. A
    // capture taken now would be cut from the marked guide instead of the card
    // and would match nothing, which is indistinguishable from a bad scan and
    // teaches exactly the wrong lesson about the shutter.
    if (state.preflighting) {
      showToast('Still preparing the scanner', 'error');
      return;
    }
    // A deliberate capture holds the automatic shutter just as an automatic one
    // does, and resets what "the card already captured" looks like. Otherwise
    // the auto shutter fires on the same card a moment later and the tap that
    // asked for one more copy quietly produces two.
    state.awaitingNewCard = true;
    rememberCapturedFrame();
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
    // A bundle taken while reads are still running is missing exactly the part
    // someone turned the reader on to see, and it looks complete — two recorded
    // sessions were downloaded ten seconds after the last capture and spent
    // arguing about whether OCR had run at all. Asked rather than blocked: a
    // bundle wanted for a framing fault does not care about the reader.
    const pending = diagnostics.pendingReads();
    if (pending) {
      const ok = window.confirm(
        pending === 1
          ? '1 card is still being read, and its text will be missing from the bundle.'
            + '\n\nWait for it to finish, or download now anyway?'
          : `${pending} cards are still being read, and their text will be missing from the bundle.`
            + '\n\nWait for them to finish, or download now anyway?'
      );
      if (!ok) return;
    }

    // The settings go in with it: thresholds and crop regions are the
    // difference between a capture that was going to work and one that never
    // could, and a bundle that does not say which produced it can only be
    // guessed at. The reader's state goes in for the same reason — see the
    // note on environment().
    const { captures, bytes } = diagnostics.download(
      state.settings,
      {
        enabled: state.ocrEnabled,
        warm: !!state.reader?.ready,
      },
      setTally()
    );
    showToast(`Saved ${captures} capture${captures === 1 ? '' : 's'} (${Math.round(bytes / 1024)}KB)`, 'success');
  });

  el('scan-bench-local')?.addEventListener('click', benchLocalMatching);

  el('scan-sound-toggle')?.addEventListener('change', (e) => {
    state.sound = e.target.checked;
  });

  el('scan-ocr-toggle')?.addEventListener('change', (e) => {
    state.ocrEnabled = e.target.checked;

    // The reader's crops appear and disappear with it, rather than at the next
    // capture — a toggle that does nothing until you scan again reads as broken.
    el('scan-crop-title')?.classList.toggle('hidden', !state.ocrEnabled);
    el('scan-crop-collector')?.classList.toggle('hidden', !state.ocrEnabled);

    // Switched on mid-session, the ~17MB it needs has still never been fetched.
    // Pulled now, behind the same scrim the detector uses, rather than silently
    // inside whichever card happens to be read first — which is what made the
    // first read of a session measure 24.6 seconds and look like the card's
    // fault. Only while the camera is running: flipping the toggle on a stopped
    // scanner is a preference, not a request to download anything.
    if (state.ocrEnabled && state.stream && !state.reader?.ready) {
      preflightReader().finally(hidePreflight);
    }
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
