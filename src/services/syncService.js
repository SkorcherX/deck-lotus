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

/**
 * When the sync is advertised to begin: 03:00 on Sundays.
 *
 * This is the only place the hour is written down. The cron expression is
 * derived from it by subtracting the warning lead, and so is the line logged
 * at startup - because the cron does *not* fire at the advertised time, it
 * fires WARNING_LEAD_MS before it, and that lead time is the warning users
 * get. Two constants in two files with nothing tying them together was an
 * invariant that existed only in a comment: changing either one alone moved
 * the sync off its advertised hour, or shortened the warning to nothing, and
 * nothing would have said so.
 *
 * test/syncSchedule.test.js asserts the round trip.
 */
export const SYNC_START = { weekday: 0, hour: 3, minute: 0 };

/**
 * The cron expression that fires the *warning*, `leadMs` before `start`.
 *
 * Whole minutes only - cron has no finer resolution - and the subtraction
 * wraps backwards through midnight and into the previous day, which is what a
 * 03:00 Sunday start would need the moment the lead time grew past three
 * hours.
 */
export function warningCronFor(start = SYNC_START, leadMs = WARNING_LEAD_MS) {
  const leadMinutes = Math.round(leadMs / 60000);
  const startOfWeek = ((start.weekday * 24 + start.hour) * 60) + start.minute;
  const minutesInWeek = 7 * 24 * 60;
  const fireAt = ((startOfWeek - leadMinutes) % minutesInWeek + minutesInWeek) % minutesInWeek;

  const minute = fireAt % 60;
  const hour = Math.floor(fireAt / 60) % 24;
  const weekday = Math.floor(fireAt / (24 * 60));

  return `${minute} ${hour} * * ${weekday}`;
}

const SYNC_CRON = warningCronFor();

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

    // scripts/import-mtgjson.js clears and rebuilds `printings`, reassigning
    // every integer id. The card hashes themselves are keyed on uuid and are
    // unaffected — that is why they are — but every printing_id the scanner
    // has cached against them is stale the instant the import finishes, and a
    // scan would resolve to printings that no longer exist. Re-joining is one
    // query, and it has to happen before the app serves another scan.
    try {
      const { refresh: refreshCardHashes } = await import('./cardHashIndex.js');
      refreshCardHashes();
      console.log('✓ Card hash index re-joined to the rebuilt printings');
    } catch (error) {
      console.error('⚠️  Could not re-join the card hash index:', error.message);
    }

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

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function clockFromCron(expression) {
  const [minute, hour, , , weekday] = expression.split(' ');
  return {
    weekday: Number(weekday),
    time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
  };
}

/**
 * Setup weekly sync schedule (begins at the advertised SYNC_START, announced
 * WARNING_LEAD_MS ahead)
 */
export function setupDailySync() {
  cron.schedule(SYNC_CRON, () => {
    console.log('\n⏰ Weekly sync due — warning users first...');
    scheduleSyncWithWarning({ trigger: 'scheduled' });
  }, { timezone: SYNC_TIMEZONE });

  // Both times are read off the same derivation rather than typed out. A log
  // line claiming 3:00 while the cron fired at some other hour would be the
  // most convincing wrong answer in the system — it is the line people check.
  const warning = clockFromCron(SYNC_CRON);
  const start = `${String(SYNC_START.hour).padStart(2, '0')}:${String(SYNC_START.minute).padStart(2, '0')}`;
  const warnDay = warning.weekday === SYNC_START.weekday ? '' : ` on ${DAY_NAMES[warning.weekday]}`;

  console.log(
    `✓ Weekly sync scheduled for ${DAY_NAMES[SYNC_START.weekday]} at ${start} ${SYNC_TIMEZONE}` +
    ` (users warned from ${warning.time}${warnDay})`
  );
}
