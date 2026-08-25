/**
 * The one invariant the weekly sync rests on: the cron fires the *warning*,
 * not the sync, and the gap between them is the warning users get.
 *
 * Those were two constants in two files — `SYNC_CRON` in syncService and
 * `WARNING_LEAD_MS` in maintenanceService — with nothing tying them together
 * except a line in CLAUDE.md saying they "have to move together". They agreed,
 * and nothing made them agree. Change either one alone and the sync quietly
 * moves off its advertised hour, or the warning shrinks to nothing; the failure
 * is invisible until a user's collection empties with no notice, once a week,
 * at three in the morning.
 *
 * The cron is now derived rather than written down. This asserts the round
 * trip: take the expression the app will actually register, add the lead back,
 * and you must land exactly on the advertised start.
 *
 * In test/ rather than test/integration/ because none of it touches SQLite —
 * `npm test` stays fast and dependency-free.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

const { SYNC_START, warningCronFor } = await import('../src/services/syncService.js');
const { WARNING_LEAD_MS } = await import('../src/services/maintenanceService.js');

const MINUTES_IN_WEEK = 7 * 24 * 60;

/** Minutes since Sunday 00:00 that a five-field weekly cron expression fires. */
function weekMinutesOf(expression) {
  const parts = expression.split(' ');
  assert.equal(parts.length, 5, `not a five-field cron expression: "${expression}"`);

  const [minute, hour, dayOfMonth, month, weekday] = parts.map((p) => p.trim());

  // A weekly schedule, or it is not the thing this test is about.
  assert.equal(dayOfMonth, '*');
  assert.equal(month, '*');
  assert.match(weekday, /^[0-6]$/, `weekday must be a single day, got "${weekday}"`);
  assert.match(hour, /^([01]?\d|2[0-3])$/, `hour out of range: "${hour}"`);
  assert.match(minute, /^([0-5]?\d)$/, `minute out of range: "${minute}"`);

  return ((Number(weekday) * 24 + Number(hour)) * 60) + Number(minute);
}

function advertisedWeekMinutes(start = SYNC_START) {
  return ((start.weekday * 24 + start.hour) * 60) + start.minute;
}

describe('the sync warning lands exactly one lead time before the sync', () => {
  test('the registered cron plus the lead is the advertised start', () => {
    const fires = weekMinutesOf(warningCronFor());
    const lands = (fires + WARNING_LEAD_MS / 60000) % MINUTES_IN_WEEK;

    assert.equal(
      lands,
      advertisedWeekMinutes(),
      'the cron fires at a time that does not reach the advertised start when the warning lead is added'
    );
  });

  test('the advertised start is still 03:00 on Sundays', () => {
    // Not decoration: this is the hour written in the README, the startup log
    // and every answer given to "when does it run". Moving it is allowed;
    // moving it by accident is what this catches.
    assert.deepEqual(SYNC_START, { weekday: 0, hour: 3, minute: 0 });
  });

  test('the lead is long enough to be a warning at all', () => {
    // A lead of zero would leave the notice and the blackout arriving
    // together, which is the failure the notice exists to prevent.
    assert.ok(WARNING_LEAD_MS >= 60 * 1000, 'the warning lead is under a minute');
    assert.equal(WARNING_LEAD_MS % 60000, 0, 'cron cannot express a fraction of a minute');
  });

  test('a lead that crosses midnight moves the day back with it', () => {
    // 03:00 Sunday minus four hours is 23:00 Saturday. Subtracting only the
    // clock time would leave the warning firing on Sunday night — eighteen
    // hours after the sync it was meant to announce.
    assert.equal(warningCronFor({ weekday: 0, hour: 3, minute: 0 }, 4 * 60 * 60 * 1000), '0 23 * * 6');
    assert.equal(warningCronFor({ weekday: 0, hour: 3, minute: 0 }, 5 * 60 * 60 * 1000), '0 22 * * 6');
  });

  test('the round trip holds for every start hour and a range of leads', () => {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        for (const leadMs of [60_000, 5 * 60_000, 45 * 60_000, 3 * 60 * 60_000, 26 * 60 * 60_000]) {
          const start = { weekday, hour, minute: 30 };
          const fires = weekMinutesOf(warningCronFor(start, leadMs));
          const lands = (fires + leadMs / 60000) % MINUTES_IN_WEEK;

          assert.equal(
            lands,
            advertisedWeekMinutes(start),
            `lead ${leadMs}ms before ${weekday} ${hour}:30 does not land on the start`
          );
        }
      }
    }
  });
});
