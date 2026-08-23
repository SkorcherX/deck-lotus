import api from '../services/api.js';
import { showToast } from '../utils/ui.js';

// While nothing is happening this is pure background noise, so it ticks
// slowly. Once an update is announced or running it matters a great deal to
// whoever is watching, so it speeds up.
const IDLE_POLL_MS = 30000;
const ACTIVE_POLL_MS = 4000;

// The point at which the warning stops being informational and starts being
// "save what you are doing".
const URGENT_MS = 60 * 1000;

let pollTimer = null;
let countdownTimer = null;
let lastState = 'idle';
// Offset between this browser's clock and the server's, so a countdown does
// not read as an hour out on a machine whose clock has drifted.
let clockOffsetMs = 0;
let startsAtMs = null;

/**
 * One-off read, for code that needs to know before the watcher is running —
 * chiefly startup, which has to tell "your session expired" apart from "the
 * database is mid-rebuild". Returns null if the server cannot be reached.
 */
export async function fetchMaintenanceStatus() {
  try {
    return await api.getMaintenanceStatus();
  } catch (error) {
    return null;
  }
}

export function setupMaintenanceWatch() {
  if (pollTimer) return;
  poll();
}

export function stopMaintenanceWatch() {
  clearTimeout(pollTimer);
  clearInterval(countdownTimer);
  pollTimer = null;
  countdownTimer = null;
  hideBanner();
  hideOverlay();
}

async function poll() {
  let status = null;

  try {
    status = await api.getMaintenanceStatus();
  } catch (error) {
    // A failed poll is not worth showing anyone. If the server is mid-import
    // and briefly unreachable the overlay already on screen is still the
    // right thing to be showing, and if it is genuinely down every other
    // request will say so far more loudly.
  }

  if (status) applyStatus(status);

  pollTimer = setTimeout(poll, activePoll(status) ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

function activePoll(status) {
  return status && (status.state === 'scheduled' || status.state === 'running');
}

function applyStatus(status) {
  if (status.serverTime) {
    clockOffsetMs = new Date(status.serverTime).getTime() - Date.now();
  }

  if (status.state === 'scheduled') {
    startsAtMs = status.startsAt ? new Date(status.startsAt).getTime() : null;
    hideOverlay();
    showBanner();
    startCountdown();
  } else if (status.state === 'running') {
    startsAtMs = null;
    stopCountdown();
    hideBanner();
    showOverlay(status);
  } else {
    startsAtMs = null;
    stopCountdown();
    hideBanner();
    hideOverlay();

    // Coming out the far side of an update: the page is showing data read
    // before the rebuild, so tell the user it is over and reload what they
    // are looking at rather than leaving them on a stale — possibly empty —
    // view of their own collection.
    if (lastState === 'running') {
      if (status.lastError) {
        showToast('Card data update failed — see the server log', 'error');
      } else {
        showToast('Card data updated. Your collection is back.', 'success');
      }
      refreshCurrentPage();
      // For anyone held at startup because the database was mid-rebuild.
      window.dispatchEvent(new CustomEvent('maintenance:finished'));
    }
  }

  lastState = status.state;
}

// Re-runs whatever the current page loads on entry. Every page sets its data
// up from a `page:<name>` event, so replaying it is the same work a fresh
// navigation would do, without a full reload losing the user's place.
function refreshCurrentPage() {
  const visible = document.querySelector('.page:not(.hidden)');
  if (!visible || !visible.id) return;

  const name = visible.id.replace(/-page$/, '');
  window.dispatchEvent(new CustomEvent(`page:${name}`));
}

/* ---------------------------------------------------------------- warning */

function showBanner() {
  const banner = document.getElementById('maintenance-banner');
  if (banner) banner.classList.remove('hidden');
}

function hideBanner() {
  const banner = document.getElementById('maintenance-banner');
  if (banner) banner.classList.add('hidden');
}

function startCountdown() {
  if (countdownTimer) return;
  renderCountdown();
  countdownTimer = setInterval(renderCountdown, 1000);
}

function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

function renderCountdown() {
  const banner = document.getElementById('maintenance-banner');
  const text = document.getElementById('maintenance-banner-text');
  if (!banner || !text || startsAtMs === null) return;

  const remaining = Math.max(0, startsAtMs - (Date.now() + clockOffsetMs));
  const urgent = remaining <= URGENT_MS;
  banner.classList.toggle('urgent', urgent);

  const total = Math.ceil(remaining / 1000);
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  const clock = `${mins}:${secs}`;

  text.innerHTML = remaining <= 0
    ? '<strong>Card data update starting now.</strong> Your collection will be unavailable for a few minutes.'
    : `<strong>Card data update in ${clock}.</strong> Your collection will be unavailable for a few minutes while it runs — finish any edits now. Nothing will be lost.`;
}

/* --------------------------------------------------------------- running */

function showOverlay(status) {
  const overlay = document.getElementById('maintenance-overlay');
  if (!overlay) return;

  overlay.classList.remove('hidden');
  // Nothing behind the overlay is safe to touch while the card tables are
  // being rebuilt, so the page underneath is taken out of the tab order too
  // rather than only being covered up.
  document.body.classList.add('maintenance-locked');

  const percent = Math.max(0, Math.min(Number(status.percent) || 0, 100));
  const bar = document.getElementById('maintenance-progress-bar');
  if (bar) {
    bar.style.width = `${percent}%`;
    bar.parentElement?.setAttribute('aria-valuenow', String(percent));
  }

  const label = document.getElementById('maintenance-overlay-label');
  if (label) label.textContent = status.label || 'Working...';

  const pct = document.getElementById('maintenance-overlay-percent');
  if (pct) pct.textContent = `${percent}%`;

  const elapsed = document.getElementById('maintenance-overlay-elapsed');
  if (elapsed && status.startedAt) {
    const secs = Math.max(0, Math.round((Date.now() + clockOffsetMs - new Date(status.startedAt).getTime()) / 1000));
    const mins = Math.floor(secs / 60);
    elapsed.textContent = mins > 0
      ? `Running for ${mins} min ${secs % 60}s`
      : `Running for ${secs}s`;
  }
}

function hideOverlay() {
  const overlay = document.getElementById('maintenance-overlay');
  if (overlay) overlay.classList.add('hidden');
  document.body.classList.remove('maintenance-locked');
}
