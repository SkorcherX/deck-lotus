import { showToast } from '../utils/ui.js';
import {
  CARD_ASPECT,
  DEFAULT_REGIONS,
  DEFAULT_THRESHOLDS,
  analyzeFrame,
  cameraAvailability,
  createAutoCapture,
  cropCard,
  cropRegion,
  guideRect,
  loadImageFile,
} from '../utils/cardCapture.js';

/**
 * Phase 2 of camera scan import: capture only.
 *
 * This page frames a card, decides when it is worth grabbing, and produces the
 * two crops OCR will read. It does not read them — the crops are rendered
 * on screen so the regions and thresholds can be tuned against real cards
 * before any OCR exists.
 */

const STORAGE_KEY = 'scan.captureSettings';

// The analysis canvas is deliberately tiny: every metric is a per-pixel pass
// over it on every frame, and none of them need detail.
const ANALYSIS_HEIGHT = 176;
const ANALYSIS_WIDTH = Math.round(ANALYSIS_HEIGHT * CARD_ASPECT);

// Metrics run well below the video frame rate; nothing here changes fast enough
// to need 60Hz, and the whole point is to leave CPU for OCR later.
const ANALYSIS_INTERVAL_MS = 100;

const MAX_RECENT_CAPTURES = 12;

const state = {
  stream: null,
  rafId: null,
  lastAnalysisAt: 0,
  previousGray: null,
  autoCapture: null,
  autoEnabled: true,
  captures: [],
  settings: loadSettings(),
};

function loadSettings() {
  const fallback = {
    thresholds: { ...DEFAULT_THRESHOLDS },
    regions: {
      title: { ...DEFAULT_REGIONS.title },
      collector: { ...DEFAULT_REGIONS.collector },
    },
  };

  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored) return fallback;
    return {
      thresholds: { ...fallback.thresholds, ...stored.thresholds },
      regions: {
        title: { ...fallback.regions.title, ...stored.regions?.title },
        collector: { ...fallback.regions.collector, ...stored.regions?.collector },
      },
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
      // A collector number is ~3mm tall on the card, so the request asks for as
      // much sensor resolution as the camera will give.
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
  positionGuide();
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

/* ------------------------------------------------------------------- guide */

/**
 * Position the guide overlay in percentages of the video box, so it tracks the
 * rect the analysis actually uses no matter how the video is scaled for
 * display.
 */
function positionGuide() {
  const video = el('scan-video');
  const overlay = el('scan-guide');

  // The guide depends on the frame size, so it can only be placed once the
  // video is running; the region boxes are fractions of the guide and are
  // always worth updating, so tuning them shows an effect before the camera
  // is even started.
  if (overlay && video?.videoWidth) {
    const rect = guideRect(video.videoWidth, video.videoHeight);
    overlay.style.left = `${(rect.x / video.videoWidth) * 100}%`;
    overlay.style.top = `${(rect.y / video.videoHeight) * 100}%`;
    overlay.style.width = `${(rect.width / video.videoWidth) * 100}%`;
    overlay.style.height = `${(rect.height / video.videoHeight) * 100}%`;
  }

  for (const key of ['title', 'collector']) {
    const box = el(`scan-region-${key}`);
    const region = state.settings.regions[key];
    if (!box) continue;
    box.style.left = `${region.x * 100}%`;
    box.style.top = `${region.y * 100}%`;
    box.style.width = `${region.w * 100}%`;
    box.style.height = `${region.h * 100}%`;
  }
}

/* -------------------------------------------------------------------- loop */

function startLoop() {
  const video = el('scan-video');
  const analysis = document.createElement('canvas');
  analysis.width = ANALYSIS_WIDTH;
  analysis.height = ANALYSIS_HEIGHT;
  const ctx = analysis.getContext('2d', { willReadFrequently: true });

  const tick = (timestamp) => {
    state.rafId = requestAnimationFrame(tick);

    if (!video.videoWidth) return;
    if (timestamp - state.lastAnalysisAt < ANALYSIS_INTERVAL_MS) return;
    state.lastAnalysisAt = timestamp;

    const rect = guideRect(video.videoWidth, video.videoHeight);
    ctx.drawImage(
      video,
      rect.x, rect.y, rect.width, rect.height,
      0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT
    );

    const metrics = analyzeFrame(ctx, state.previousGray);
    state.previousGray = metrics.gray;

    const verdict = state.autoCapture.evaluate(metrics);
    renderMetrics(metrics, verdict);

    if (verdict.shouldCapture) {
      if (state.autoEnabled) {
        capture(video, rect, 'auto');
      } else {
        // Auto-capture is off. evaluate() disarms itself whenever it fires, so
        // re-arm immediately — otherwise the readout freezes on a card that was
        // never actually captured.
        state.autoCapture.reset();
      }
    }
  };

  state.rafId = requestAnimationFrame(tick);
}

function renderMetrics(metrics, verdict) {
  const { thresholds } = state.settings;

  setChip('scan-chip-stable', verdict.checks.stable, `Still ${metrics.difference.toFixed(1)}/${thresholds.stability}`);
  setChip('scan-chip-sharp', verdict.checks.sharp, `Focus ${Math.round(metrics.sharpness)}/${thresholds.sharpness}`);
  setChip('scan-chip-filled', verdict.checks.filled, `Card ${metrics.fill.toFixed(1)}/${thresholds.fill}`);

  const streak = el('scan-streak');
  if (streak) {
    streak.textContent = verdict.armed
      ? `${verdict.streak}/${thresholds.streak} good frames`
      : 'Swap the card to arm again';
  }

  const guide = el('scan-guide');
  if (guide) {
    guide.classList.toggle('scan-guide-ready', verdict.streak > 0);
    guide.classList.toggle('scan-guide-disarmed', !verdict.armed);
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
 * Take the crops from any source (live video or an uploaded still) and hand
 * them on. Phase 3 listens for `scan:capture` and does the reading; nothing
 * here interprets the pixels.
 */
function capture(source, rect, trigger) {
  const card = cropCard(source, rect);
  const title = cropRegion(source, rect, state.settings.regions.title);
  const collector = cropRegion(source, rect, state.settings.regions.collector);

  const entry = { id: Date.now() + Math.random(), trigger, card, title, collector, at: new Date() };

  state.captures.unshift(entry);
  state.captures = state.captures.slice(0, MAX_RECENT_CAPTURES);
  state.autoCapture?.disarm();

  renderCapture(entry);
  renderRecent();

  window.dispatchEvent(new CustomEvent('scan:capture', { detail: entry }));
}

function renderCapture(entry) {
  el('scan-empty')?.classList.add('hidden');
  el('scan-result')?.classList.remove('hidden');

  swapCanvas('scan-preview-card', entry.card);
  swapCanvas('scan-preview-title', entry.title);
  swapCanvas('scan-preview-collector', entry.collector);

  const label = el('scan-capture-label');
  if (label) {
    label.textContent = `${entry.trigger === 'auto' ? 'Auto-captured' : entry.trigger === 'upload' ? 'From file' : 'Manual capture'} at ${entry.at.toLocaleTimeString()}`;
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
  if (count) count.textContent = `${state.captures.length} capture${state.captures.length === 1 ? '' : 's'} this session`;
  if (!strip) return;

  strip.innerHTML = '';
  for (const entry of state.captures) {
    const thumb = document.createElement('img');
    // Thumbnails are drawn from the capture we already hold, so nothing is
    // re-encoded at full size and no image ever leaves the browser.
    thumb.src = entry.card.toDataURL('image/jpeg', 0.6);
    thumb.className = 'scan-thumb';
    thumb.title = entry.at.toLocaleTimeString();
    thumb.addEventListener('click', () => renderCapture(entry));
    strip.appendChild(thumb);
  }
}

/* ---------------------------------------------------------------- fallback */

/**
 * Still-image fallback. A tightly cropped card photo is used whole; a looser
 * shot gets the same guide rect the live view uses, which is also how this path
 * doubles as a way to exercise the pipeline with no camera at all.
 */
async function captureFromFile(file) {
  try {
    const image = await loadImageFile(file);
    const aspect = image.width / image.height;
    const rect =
      Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT < 0.1
        ? { x: 0, y: 0, width: image.width, height: image.height }
        : guideRect(image.width, image.height);

    capture(image, rect, 'upload');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

/* ------------------------------------------------------------------ tuning */

const TUNING_FIELDS = [
  ['scan-threshold-stability', 'thresholds', 'stability'],
  ['scan-threshold-sharpness', 'thresholds', 'sharpness'],
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
  const input = el(id);
  const value = parseFloat(input.value);
  if (Number.isNaN(value)) return;

  settingsGroup(path)[key] = value;
  saveSettings();
  state.autoCapture?.setThresholds(state.settings.thresholds);
  positionGuide();
}

/* ------------------------------------------------------------------- setup */

export function setupScan() {
  window.addEventListener('page:scan', () => {
    const availability = cameraAvailability();
    if (!availability.available) showUnsupported(availability.reason);
    syncTuningInputs();
    positionGuide();
    renderRecent();
  });

  // Leaving the page releases the camera — a live webcam indicator on a page
  // the user has navigated away from is alarming, and the stream is not free.
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
    capture(video, guideRect(video.videoWidth, video.videoHeight), 'manual');
  });

  el('scan-auto-toggle')?.addEventListener('change', (e) => {
    state.autoEnabled = e.target.checked;
    state.autoCapture?.reset();
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
    state.settings = {
      thresholds: { ...DEFAULT_THRESHOLDS },
      regions: {
        title: { ...DEFAULT_REGIONS.title },
        collector: { ...DEFAULT_REGIONS.collector },
      },
    };
    saveSettings();
    syncTuningInputs();
    state.autoCapture?.setThresholds(state.settings.thresholds);
    positionGuide();
    showToast('Capture settings reset to defaults', 'success');
  });

  for (const [id, path, key] of TUNING_FIELDS) {
    el(id)?.addEventListener('input', () => applyTuningInput(id, path, key));
  }

  el('scan-video')?.addEventListener('loadedmetadata', positionGuide);
  window.addEventListener('resize', positionGuide);
}
