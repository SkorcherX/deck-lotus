/**
 * Tracks the one job that takes the collection away from everybody while it
 * runs: the MTGJSON import. `scripts/import-mtgjson.js` clears `printings`
 * and rebuilds it, so for the minutes in between a logged-in user sees a
 * collection that looks emptied. Nothing is lost — the user tables are backed
 * up and restored by the same script — but a page that says "0 cards" with no
 * explanation reads exactly like data loss, and did.
 *
 * State lives in memory on purpose. It has to be readable precisely when the
 * database is mid-rewrite, so nothing here may touch SQLite.
 */

// Announced before a scheduled sync begins, so anyone mid-edit can finish.
export const WARNING_LEAD_MS = 5 * 60 * 1000;

// Ordered markers from the import script's own output. The percentages are
// rough — the phases are nothing like equal in length — but the bar only has
// to show that something is still moving, which is the thing a user watching
// a blank collection actually needs to know.
const PHASES = [
  { match: 'Downloading from', label: 'Downloading card data', percent: 2 },
  { match: 'Download complete', label: 'Download complete', percent: 25 },
  { match: 'Decompressing file', label: 'Decompressing', percent: 27 },
  { match: 'Creating safety backup', label: 'Backing up your collection', percent: 30 },
  { match: 'Clearing existing MTGJSON data', label: 'Clearing old card data', percent: 34 },
  { match: 'Importing atomic cards', label: 'Importing cards', percent: 40 },
  { match: 'Importing card printings', label: 'Importing printings', percent: 55 },
  { match: 'Importing sets', label: 'Importing sets', percent: 65 },
  { match: 'Importing purchase URLs', label: 'Importing purchase links', percent: 70 },
  { match: 'Importing card rulings', label: 'Importing rulings', percent: 74 },
  { match: 'Importing related cards', label: 'Importing related cards', percent: 78 },
  { match: 'Importing foreign card data', label: 'Importing translations', percent: 82 },
  { match: 'Importing pricing data', label: 'Importing prices', percent: 86 },
  { match: 'Restoring user deck data', label: 'Restoring your decks', percent: 90 },
  { match: 'Restoring owned cards data', label: 'Restoring your collection', percent: 92 },
  { match: 'Restoring owned printings data', label: 'Restoring your collection', percent: 94 },
  { match: 'Restoring trade data', label: 'Restoring your trades', percent: 96 },
  { match: 'Restoring traded-away deck notices', label: 'Restoring your trades', percent: 97 },
  { match: 'Cleaning up temporary files', label: 'Finishing up', percent: 99 },
];

// The download's own percentage, which the script writes as it streams.
const DOWNLOAD_PROGRESS = /Progress:\s*([\d.]+)%/;

let state = 'idle'; // 'idle' | 'scheduled' | 'running'
let startsAt = null; // when a scheduled sync will begin
let startedAt = null;
let finishedAt = null;
let label = null;
let percent = 0;
let lastError = null;
let trigger = null; // 'scheduled' | 'manual'

/**
 * What the client polls. Deliberately small, and deliberately free of
 * anything that would need a database read to answer.
 */
export function getMaintenanceStatus() {
  return {
    state,
    // Sent as an absolute time rather than a countdown so the client can tick
    // it down smoothly between polls instead of jumping every few seconds.
    startsAt: startsAt ? startsAt.toISOString() : null,
    startedAt: startedAt ? startedAt.toISOString() : null,
    finishedAt: finishedAt ? finishedAt.toISOString() : null,
    label,
    percent,
    trigger,
    lastError,
    serverTime: new Date().toISOString(),
  };
}

/** A sync is coming; `startsAt` is when it will actually begin. */
export function announceScheduledSync(startTime, source = 'scheduled') {
  state = 'scheduled';
  startsAt = startTime;
  trigger = source;
  label = 'Card data update starting soon';
  percent = 0;
  lastError = null;
}

export function markSyncStarted(source = 'scheduled') {
  state = 'running';
  startsAt = null;
  startedAt = new Date();
  finishedAt = null;
  trigger = source;
  label = 'Starting card data update';
  percent = 0;
  lastError = null;
}

export function markSyncFinished(error = null) {
  state = 'idle';
  startsAt = null;
  startedAt = null;
  finishedAt = new Date();
  label = error ? 'Card data update failed' : 'Card data update complete';
  percent = error ? percent : 100;
  lastError = error ? String(error.message || error) : null;
}

/**
 * Feeds a chunk of the import script's output through the phase table.
 * Percentages only ever move forwards: the script interleaves its own
 * warnings and counts with the phase lines, and a bar that jumps backwards
 * looks like the job restarted.
 */
export function consumeSyncOutput(chunk) {
  const text = String(chunk);

  const download = text.match(DOWNLOAD_PROGRESS);
  if (download && label === 'Downloading card data') {
    // The download is the first quarter of the bar, and the only phase that
    // reports a real percentage of its own.
    const share = Math.min(parseFloat(download[1]), 100) * 0.23;
    percent = Math.max(percent, Math.round(2 + share));
  }

  for (const phase of PHASES) {
    if (!text.includes(phase.match)) continue;
    if (phase.percent < percent) continue;
    label = phase.label;
    percent = phase.percent;
  }
}

/** True while users should be told to wait rather than shown empty data. */
export function isMaintenanceActive() {
  return state === 'running';
}
