import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getMaintenanceStatus,
  announceScheduledSync,
  markSyncStarted,
  markSyncFinished,
  consumeSyncOutput,
  isMaintenanceActive,
} from '../src/services/maintenanceService.js';

// Lines exactly as scripts/import-mtgjson.js writes them. If that script's
// wording changes, these are what should fail — a progress bar that silently
// stops matching its own job is worse than no progress bar, because the
// stalled-looking one is the thing users panic about.
const OUTPUT = {
  download: 'Downloading from https://mtgjson.com/api/v5/AllPrintings.sqlite.bz2...',
  downloadPct: '\rProgress: 50.00% (240.00 MB)',
  downloadDone: '\n✓ Download complete',
  backup: '  📦 Creating safety backup before sync...',
  clearing: 'Clearing existing MTGJSON data (preserving user data)...',
  printings: 'Importing card printings...',
  prices: 'Importing pricing data...',
  restoreOwned: '\n🔄 Restoring owned cards data...',
  cleanup: '\n🧹 Cleaning up temporary files...',
};

describe('maintenance status', () => {
  beforeEach(() => {
    markSyncFinished();
  });

  test('idle until something is announced', () => {
    const status = getMaintenanceStatus();
    assert.equal(status.state, 'idle');
    assert.equal(isMaintenanceActive(), false);
  });

  test('an announced sync reports when it will start, not how long is left', () => {
    const startsAt = new Date(Date.now() + 5 * 60 * 1000);
    announceScheduledSync(startsAt);

    const status = getMaintenanceStatus();
    assert.equal(status.state, 'scheduled');
    assert.equal(status.startsAt, startsAt.toISOString());
    // The client ticks the countdown down itself, so it needs the server's
    // clock to measure that start time against.
    assert.ok(status.serverTime);
    assert.equal(isMaintenanceActive(), false);
  });

  test('a running sync is what blocks the page', () => {
    markSyncStarted();
    assert.equal(getMaintenanceStatus().state, 'running');
    assert.equal(isMaintenanceActive(), true);
  });

  test('phases advance as the import reports them', () => {
    markSyncStarted();

    consumeSyncOutput(OUTPUT.download);
    assert.equal(getMaintenanceStatus().label, 'Downloading card data');

    consumeSyncOutput(OUTPUT.printings);
    const printings = getMaintenanceStatus();
    assert.equal(printings.label, 'Importing printings');
    assert.equal(printings.percent, 55);

    consumeSyncOutput(OUTPUT.cleanup);
    assert.equal(getMaintenanceStatus().percent, 99);
  });

  test('the phase users most need named is the one restoring their cards', () => {
    markSyncStarted();
    consumeSyncOutput(OUTPUT.clearing);
    assert.equal(getMaintenanceStatus().label, 'Clearing old card data');

    consumeSyncOutput(OUTPUT.restoreOwned);
    assert.equal(getMaintenanceStatus().label, 'Restoring your collection');
  });

  test('the download reports its own progress within its share of the bar', () => {
    markSyncStarted();
    consumeSyncOutput(OUTPUT.download);
    const start = getMaintenanceStatus().percent;

    consumeSyncOutput(OUTPUT.downloadPct);
    const half = getMaintenanceStatus().percent;

    assert.ok(half > start, 'download progress should move the bar');
    assert.ok(half < 25, 'download should not eat into the import phases');
  });

  test('progress never runs backwards', () => {
    markSyncStarted();
    consumeSyncOutput(OUTPUT.prices);
    const prices = getMaintenanceStatus().percent;

    // The script interleaves warnings and counts with its phase lines, and a
    // late mention of an earlier phase must not rewind the bar — a bar that
    // jumps back reads as the job having restarted.
    consumeSyncOutput(OUTPUT.backup);
    assert.equal(getMaintenanceStatus().percent, prices);
  });

  test('finishing clears the block and reports the failure if there was one', () => {
    markSyncStarted();
    markSyncFinished(new Error('exited with code 1'));

    const status = getMaintenanceStatus();
    assert.equal(status.state, 'idle');
    assert.equal(isMaintenanceActive(), false);
    assert.match(status.lastError, /exited with code 1/);
  });

  test('a clean finish leaves no error behind for the next run', () => {
    markSyncStarted();
    markSyncFinished(new Error('boom'));
    markSyncStarted();

    assert.equal(getMaintenanceStatus().lastError, null);
  });
});
