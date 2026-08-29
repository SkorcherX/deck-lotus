/**
 * Stillness over a fixed window, not between whatever two frames arrived.
 *
 * `difference` is the mean absolute change between two frames, and it carries
 * two things that scale differently: the card's movement, which grows with the
 * gap between them, and the sensor's noise, which does not. Every stability
 * threshold in the app was measured at a 100ms gap, so when the analysis rate
 * doubled the gap had to stay where it was — otherwise a bar of 9.0 starts
 * admitting twice the motion it was set for, silently, on every device.
 *
 * These pin the selection arithmetic. What they cannot pin is the number
 * itself; that came from a session with a card lying still on a desk, and it is
 * recorded against DEFAULT_THRESHOLDS.stability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFrameFor, trimMotionHistory } from '../client/src/utils/cardCapture.js';

const WINDOW = 100;

/** A history of frames every `step` ms, each buffer tagged so it is identifiable. */
function history(count, step, start = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    gray: `frame@${start + i * step}`,
    at: start + i * step,
  }));
}

test('nothing is compared against until a frame is old enough', () => {
  const frames = history(2, 50);
  // 50ms of history against a 100ms window: the honest answer is "not yet",
  // and analyzeFrame turns a null into Infinity, which holds the shutter.
  assert.equal(motionFrameFor(frames, 1050, WINDOW), null);
});

test('the frame chosen is the newest one at least a window old', () => {
  const frames = history(5, 50); // 1000, 1050, 1100, 1150, 1200
  assert.equal(motionFrameFor(frames, 1200, WINDOW), 'frame@1100');
  assert.equal(motionFrameFor(frames, 1150, WINDOW), 'frame@1050');
});

test('a frame exactly a window old counts', () => {
  const frames = history(3, 50);
  assert.equal(motionFrameFor(frames, 1100, WINDOW), 'frame@1000');
});

test('the gap compared over holds at 10fps and at 20fps alike', () => {
  // The whole point: the same wall-clock span whatever the tick rate. A slow
  // device that skipped a tick gets the nearest frame past the window rather
  // than a shorter gap, which is the safe direction — it can only over-report
  // movement, never wave it through.
  const slow = history(4, 100);
  const fast = history(7, 50);

  const slowGap = 1300 - 1200;
  assert.equal(motionFrameFor(slow, 1300, WINDOW), 'frame@1200');
  assert.ok(slowGap >= WINDOW);

  assert.equal(motionFrameFor(fast, 1300, WINDOW), 'frame@1200');
});

test('history is trimmed to what the window still needs', () => {
  const frames = history(8, 50);
  trimMotionHistory(frames, 1350, WINDOW);

  // Everything newer than the chosen frame has to survive, or the next tick
  // has nothing to pick.
  assert.ok(frames.length >= 2 && frames.length <= 4, `kept ${frames.length}`);
  assert.equal(motionFrameFor(frames, 1350, WINDOW), 'frame@1250');
  assert.equal(frames[frames.length - 1].at, 1350);
});

test('trimming never empties the history below a comparable pair', () => {
  const frames = history(3, 1000); // every entry is far past the window
  trimMotionHistory(frames, 5000, WINDOW);
  assert.ok(frames.length >= 2);
  assert.ok(motionFrameFor(frames, 5000, WINDOW));
});
