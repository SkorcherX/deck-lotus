/**
 * The glare gate.
 *
 * Two things have to hold at once, and they pull against each other: a lamp
 * reflected off a sleeve has to stop the shutter, and a card that is simply
 * bright — a white border, a Plains, a full-art snow land — must not. The
 * measure that separates them is texture, so these tests pin both ends against
 * synthetic buffers: a clipped plateau counts, printed white with structure in
 * it does not.
 *
 * The threshold itself is provisional (see DEFAULT_THRESHOLDS.glare); what is
 * pinned here is the shape of the measure and the gate around it, so calibrating
 * the number later cannot quietly turn the gate into something else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blownHighlightFraction,
  createAutoCapture,
  DEFAULT_THRESHOLDS,
} from '../client/src/utils/cardCapture.js';

const W = 64;
const H = 64;

function card(fill = 120) {
  return new Uint8ClampedArray(W * H).fill(fill);
}

function patch(gray, x0, y0, size, value) {
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) gray[y * W + x] = value;
  }
  return gray;
}

test('an unlit card reads as no glare at all', () => {
  assert.equal(blownHighlightFraction(card(), W, H), 0);
});

test('a clipped highlight is measured', () => {
  const glare = blownHighlightFraction(patch(card(), 10, 10, 20, 255), W, H);
  assert.ok(glare > 5, `expected a 20x20 blown patch to register, got ${glare}`);
});

test('bright print is not glare: white with texture in it does not count', () => {
  // A white region carrying lettering — every other row broken by ink. Bright
  // enough to clip on its own, but nowhere is it a plateau.
  const gray = card();
  for (let y = 4; y < 60; y++) {
    for (let x = 4; x < 60; x++) gray[y * W + x] = y % 2 === 0 ? 255 : 200;
  }
  assert.equal(blownHighlightFraction(gray, W, H), 0);
});

test('the level is a clipping level, not merely "light"', () => {
  // Printed white photographs short of the sensor's ceiling. It fills the whole
  // card here and still must not read as glare.
  assert.equal(blownHighlightFraction(card(240), W, H), 0);
});

test('the shutter refuses a glared frame and says which check failed', () => {
  const auto = createAutoCapture();
  const good = {
    difference: 0,
    sharpness: DEFAULT_THRESHOLDS.sharpness + 100,
    presence: DEFAULT_THRESHOLDS.presence + 10,
    fill: 100,
    glare: 0,
  };

  for (let i = 0; i < DEFAULT_THRESHOLDS.streak; i++) {
    const verdict = auto.evaluate({ ...good, glare: DEFAULT_THRESHOLDS.glare + 5 });
    assert.equal(verdict.shouldCapture, false);
    assert.equal(verdict.checks.clear, false);
    assert.equal(verdict.streak, 0, 'a glared frame must not build a streak either');
  }

  // The same scene once the card is tilted off the reflection.
  let fired = false;
  for (let i = 0; i < DEFAULT_THRESHOLDS.streak; i++) {
    fired = auto.evaluate(good).shouldCapture;
  }
  assert.equal(fired, true);
});

test('a caller that does not measure glare is unaffected', () => {
  // The gate is newer than the metric. A metrics object from before it must
  // still be able to fire, or every existing path breaks on upgrade.
  const auto = createAutoCapture();
  let fired = false;
  for (let i = 0; i < DEFAULT_THRESHOLDS.streak; i++) {
    const verdict = auto.evaluate({
      difference: 0,
      sharpness: DEFAULT_THRESHOLDS.sharpness + 100,
      presence: DEFAULT_THRESHOLDS.presence + 10,
      fill: 100,
    });
    assert.equal(verdict.checks.clear, true);
    fired = verdict.shouldCapture;
  }
  assert.equal(fired, true);
});
