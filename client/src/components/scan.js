import api from '../services/api.js';
import { showToast } from '../utils/ui.js';
import { createCardReader } from '../utils/cardOcr.js';
import {
  CARD_ASPECT,
  DEFAULT_REGIONS,
  DEFAULT_THRESHOLDS,
  analyzeFrame,
  cameraAvailability,
  createAutoCapture,
  defaultQuad,
  frameImageData,
  guideRect,
  loadImageFile,
  quadFromRect,
  rectifiedSize,
  regionOutputSize,
  referenceFrom,
  regionQuad,
  warpQuad,
  warpQuadInto,
  warpRegion,
} from '../utils/cardCapture.js';

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
const SETTINGS_VERSION = 4;

// The analysis buffer is deliberately tiny: every metric is a per-pixel pass
// over it on every frame, and none of them need detail.
const ANALYSIS_HEIGHT = 176;
const ANALYSIS_WIDTH = Math.round(ANALYSIS_HEIGHT * CARD_ASPECT);

// Frames are downscaled before the per-frame warp reads them back. Reading a
// full 1920x1080 frame into JS ten times a second is 8MB a go and pointlessly
// precise for deciding whether a card is sitting still.
const ANALYSIS_SOURCE_WIDTH = 480;

const ANALYSIS_INTERVAL_MS = 100;
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
  ocrEnabled: true,
  // Reads are serialised: one tesseract worker cannot recognise two images at
  // once, and captures can arrive faster than it finishes.
  readQueue: Promise.resolve(),
  settings: loadSettings(),
  // Reused across frames so the loop allocates nothing per tick.
  buffers: { source: null, analysis: null, scratch: null },
};

function freshSettings() {
  return {
    version: SETTINGS_VERSION,
    thresholds: { ...DEFAULT_THRESHOLDS },
    regions: {
      title: { ...DEFAULT_REGIONS.title },
      collector: { ...DEFAULT_REGIONS.collector },
    },
    quad: defaultQuad(),
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

  select.innerHTML = cameras
    .map(
      (camera, index) =>
        `<option value="${camera.deviceId}">${camera.label || `Camera ${index + 1}`}</option>`
    )
    .join('');

  if (previous && cameras.some((c) => c.deviceId === previous)) select.value = previous;
  select.disabled = cameras.length < 2;
}

async function startCamera() {
  const availability = cameraAvailability();
  if (!availability.available) {
    showUnsupported(availability.reason);
    return;
  }

  stopCamera();

  const deviceId = el('scan-camera-select')?.value;
  const constraints = {
    video: {
      // A collector number is ~3mm tall on the card, and at desk distance that
      // is only a few pixels, so ask for every pixel the camera has.
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
    },
    audio: false,
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
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

    // Metrics are measured on the rectified card, not on the raw frame, so a
    // tilted view is judged on the same terms as a flat one.
    state.buffers.scratch = warpQuadInto(
      analysisCtx,
      sourceCtx.getImageData(0, 0, source.width, source.height),
      state.settings.quad,
      state.buffers.scratch
    );

    const metrics = analyzeFrame(analysisCtx, state.previousGray, state.referenceGray);
    state.previousGray = metrics.gray;

    const verdict = state.autoCapture.evaluate(metrics);
    renderMetrics(metrics, verdict);

    if (verdict.shouldCapture) {
      if (state.autoEnabled) {
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
function captureFromVideo(video, trigger) {
  const frame = frameImageData(video, video.videoWidth, video.videoHeight);
  emitCapture(frame, state.settings.quad, video.videoWidth, video.videoHeight, trigger);
}

/**
 * Rectify the card and take the crops, then hand them on. Phase 3 listens for
 * `scan:capture` and does the reading; nothing here interprets the pixels.
 *
 * Each crop is warped from the original frame rather than cut out of the
 * rectified card, so the small print is resampled once instead of twice.
 */
function emitCapture(frame, quad, frameWidth, frameHeight, trigger) {
  const size = rectifiedSize(quad, frameWidth, frameHeight);
  const card = warpQuad(frame, quad, size.width, size.height);

  const cropOf = (region) => {
    const out = regionOutputSize(size, region);
    return warpRegion(frame, quad, region, out.width, out.height);
  };

  const title = cropOf(state.settings.regions.title);
  const collector = cropOf(state.settings.regions.collector);

  const entry = { id: Date.now() + Math.random(), trigger, card, title, collector, at: new Date() };

  state.captures.unshift(entry);
  state.captures = state.captures.slice(0, MAX_RECENT_CAPTURES);
  state.autoCapture?.disarm();

  renderCapture(entry);
  renderRecent();

  window.dispatchEvent(new CustomEvent('scan:capture', { detail: entry }));

  if (state.ocrEnabled) readCapture(entry);
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

async function runRead(entry) {
  setReadStatus('Reading…');

  let reading;
  try {
    reading = await reader().read(entry);
  } catch (error) {
    setReadStatus(`Read failed: ${error.message}`);
    return;
  }

  entry.reading = reading;
  renderReading(entry);

  // A reading with nothing in it cannot be resolved, and asking the server to
  // confirm that is a wasted round trip.
  if (!reading.name && !(reading.setCode && reading.collectorNumber)) {
    setReadStatus(`Nothing readable (${reading.elapsedMs}ms)`);
    return;
  }

  try {
    const resolved = await api.resolveScan({
      name: reading.name,
      setCode: reading.setCode,
      collectorNumber: reading.collectorNumber,
      limit: 5,
    });
    entry.candidates = resolved.candidates;
    renderCandidates(entry);
    setReadStatus(`Read in ${reading.elapsedMs}ms`);
  } catch (error) {
    setReadStatus(`Resolve failed: ${error.message}`);
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

  const label = el('scan-capture-label');
  if (label) {
    const how =
      entry.trigger === 'auto'
        ? 'Auto-captured'
        : entry.trigger === 'upload'
          ? 'From file'
          : 'Manual capture';
    label.textContent = `${how} at ${entry.at.toLocaleTimeString()} — rectified to ${entry.card.width}x${entry.card.height}`;
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
  const strip = el('scan-recent');
  const count = el('scan-count');
  if (count) {
    count.textContent = `${state.captures.length} capture${state.captures.length === 1 ? '' : 's'} this session`;
  }
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

    const quad = quadFromRect(rect, image.width, image.height);
    const frame = frameImageData(image, image.width, image.height);
    emitCapture(frame, quad, image.width, image.height, 'upload');
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
    drawOverlay();
    renderRecent();
    updateReferenceLabel();
  });

  // Leaving the page releases the camera — a live webcam indicator on a page the
  // user has navigated away from is alarming, and the stream is not free.
  window.addEventListener('page:leave', (event) => {
    if (event.detail?.page === 'scan') stopCamera();
  });

  el('scan-start-btn')?.addEventListener('click', startCamera);
  el('scan-stop-btn')?.addEventListener('click', stopCamera);
  el('scan-camera-select')?.addEventListener('change', () => {
    if (state.stream) startCamera();
  });

  el('scan-shutter-btn')?.addEventListener('click', () => {
    const video = el('scan-video');
    if (!video?.videoWidth) {
      showToast('Start the camera first', 'error');
      return;
    }
    captureFromVideo(video, 'manual');
  });

  el('scan-auto-toggle')?.addEventListener('change', (e) => {
    state.autoEnabled = e.target.checked;
    state.autoCapture?.reset();
  });

  el('scan-ocr-toggle')?.addEventListener('change', (e) => {
    state.ocrEnabled = e.target.checked;
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
