import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cron from 'node-cron';
import {
  WARNING_LEAD_MS,
  announceScheduledSync,
  markSyncStarted,
  markSyncFinished,
  consumeSyncOutput,
} from './maintenanceService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// The sync begins at 03:00 on Sundays. The cron fires WARNING_LEAD_MS earlier
// so users get told before their collection disappears out from under them.
const SYNC_CRON = '55 2 * * 0';

// node-cron reads bare cron expressions in the process's own timezone, which
// in a container with no TZ set is UTC — so "Sundays at 3 AM" fired at 8 PM
// Saturday for anyone on the US west coast. Naming the zone explicitly means
// the schedule says what it means wherever the container runs.
const SYNC_TIMEZONE = process.env.SYNC_TIMEZONE || process.env.TZ || 'UTC';

let isRunning = false;
let lastRun = null;
let pendingSyncTimer = null;

/**
 * Run the MTGJSON import/update
 */
export async function runSync({ trigger = 'manual' } = {}) {
  if (isRunning) {
    throw new Error('Sync already in progress');
  }

  try {
    isRunning = true;
    markSyncStarted(trigger);
    console.log('\n🔄 Starting MTGJSON sync...');

    const scriptPath = join(__dirname, '../../scripts/import-mtgjson.js');

    // spawn, not execSync: execSync blocks Node's single event loop thread for
    // the whole import (a multi-minute download + bulk insert), which freezes
    // every other request across every user for as long as it runs. spawn
    // starts a real child process and lets the loop keep serving requests
    // while we asynchronously wait for it to finish.
    //
    // Always use FORCE_REIMPORT=true for syncs to preserve user data while updating MTGJSON data
    await new Promise((resolve, reject) => {
      // Piped rather than inherited so the import's own progress lines can be
      // read on their way past and turned into something a waiting user can
      // watch. They are still written to the server log unchanged.
      const child = spawn('node', [scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_REIMPORT: 'true' }
      });

      child.stdout.on('data', (chunk) => {
        process.stdout.write(chunk);
        consumeSyncOutput(chunk);
      });

      child.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Sync process exited with code ${code}`));
      });
    });

    lastRun = new Date();
    markSyncFinished();
    console.log('✓ Sync completed successfully');

    return { success: true, lastRun };
  } catch (error) {
    markSyncFinished(error);
    console.error('✗ Sync failed:', error.message);
    throw error;
  } finally {
    isRunning = false;
  }
}

/**
 * Get sync status
 */
export function getSyncStatus() {
  return {
    isRunning,
    lastRun
  };
}

/**
 * Announces a sync, waits out the warning period, then runs it. Users see a
 * countdown for the whole lead time rather than the collection simply
 * vanishing mid-session.
 */
export function scheduleSyncWithWarning({ leadMs = WARNING_LEAD_MS, trigger = 'scheduled' } = {}) {
  if (isRunning || pendingSyncTimer) {
    return { scheduled: false, reason: 'A sync is already running or pending' };
  }

  const startsAt = new Date(Date.now() + leadMs);
  announceScheduledSync(startsAt, trigger);
  console.log(`\n⏳ MTGJSON sync announced — starting at ${startsAt.toISOString()}`);

  pendingSyncTimer = setTimeout(async () => {
    pendingSyncTimer = null;
    try {
      await runSync({ trigger });
    } catch (error) {
      console.error('Scheduled sync failed:', error.message);
    }
  }, leadMs);

  return { scheduled: true, startsAt };
}

/**
 * Setup weekly sync schedule (begins at 3 AM every Sunday, announced five
 * minutes ahead)
 */
export function setupDailySync() {
  cron.schedule(SYNC_CRON, () => {
    console.log('\n⏰ Weekly sync due — warning users first...');
    scheduleSyncWithWarning({ trigger: 'scheduled' });
  }, { timezone: SYNC_TIMEZONE });

  console.log(
    `✓ Weekly sync scheduled for Sundays at 3:00 AM ${SYNC_TIMEZONE}` +
    ` (users warned from 2:55 AM)`
  );
}
