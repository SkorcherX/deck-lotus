/**
 * Finding the card in the frame.
 *
 * The bar these tests hold detectCard to is not "did it find something roughly
 * card-shaped" — it is an accuracy figure, because accuracy is the whole point.
 * The perceptual hash averages a fixed window of the *rectified* card down to a
 * 32x32 grid, so the window's alignment is the alignment of the card beneath it.
 * Measured against real card art, a capture framed 1% off sat 44 bits of 256
 * from its own reference, and one framed 2% off sat 92 — past the 56-bit match
 * threshold, matching nothing at all.
 *
 * So detection has to land within about one percent of the card's size, and a
 * test that only asserted "a quad came back" would pass on results that cannot
 * scan a single card. CORNER_TOLERANCE is that requirement written down.
 *
 * The frames are synthetic, and deliberately so: a photograph brings lighting,
 * blur and background all at once, and a failure in one is indistinguishable
 * from a failure in another. These isolate the geometry. Real captures are what
 * the diagnostics recorder in the client is for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_ASPECT,
  detectCard,
  quadAspectError,
} from '../client/src/utils/cardCapture.js';

/**
 * How far a detected corner may sit from the true one, as a fraction of the
 * card's height. See the note above: this is the hash's tolerance, not a
 * comfortable margin picked to make the tests pass.
 */
const CORNER_TOLERANCE = 0.015;

const WIDTH = 480;
const HEIGHT = 360;

/**
 * A frame with a card in it: a light card on a darker background, with a couple
 * of interior boxes standing in for the art window and text box.
 *
 * The interior boxes matter more than they look. They are the thing a detector
 * can lock onto by mistake — card-shaped, strongly edged, entirely wrong — and
 * a detector that returns the art box instead of the card produces a beautiful
 * capture of nothing. Every case below carries them.
 */
function frameWithCard({ cx, cy, height, rotation = 0, cardTone = 210, background = 40 }) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);

  // Background, with a little structure so the card is not the only thing in
  // the frame with an edge in it.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const tone = background + ((x >> 5) + (y >> 5)) % 2 * 6;
      data[i] = data[i + 1] = data[i + 2] = tone;
      data[i + 3] = 255;
    }
  }

  const cardHeight = height;
  const cardWidth = height * CARD_ASPECT;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  /** Card-space (u, v) in -0.5..0.5 to frame pixels. */
  const toFrame = (u, v) => ({
    x: cx + (u * cardWidth) * cos - (v * cardHeight) * sin,
    y: cy + (u * cardWidth) * sin + (v * cardHeight) * cos,
  });

  // Painted by walking card space rather than frame space, so a rotated card
  // has no gaps. Oversampled 2x to keep the edges from stair-stepping into a
  // weaker gradient than a real card's.
  const steps = Math.ceil(Math.max(cardWidth, cardHeight) * 2);
  for (let sv = 0; sv <= steps; sv++) {
    const v = sv / steps - 0.5;
    for (let su = 0; su <= steps; su++) {
      const u = su / steps - 0.5;
      const { x, y } = toFrame(u, v);
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || px >= WIDTH || py < 0 || py >= HEIGHT) continue;

      // Art window and text box, in the usual places on a Magic card.
      const inArt = v > -0.39 && v < 0.05 && u > -0.42 && u < 0.42;
      const inText = v > 0.12 && v < 0.42 && u > -0.42 && u < 0.42;
      const tone = inArt ? 90 : inText ? 235 : cardTone;

      const i = (py * WIDTH + px) * 4;
      data[i] = data[i + 1] = data[i + 2] = tone;
      data[i + 3] = 255;
    }
  }

  const corners = [
    toFrame(-0.5, -0.5),
    toFrame(0.5, -0.5),
    toFrame(0.5, 0.5),
    toFrame(-0.5, 0.5),
  ].map((p) => ({ x: p.x / WIDTH, y: p.y / HEIGHT }));

  return { frame: { data, width: WIDTH, height: HEIGHT }, corners };
}

/** Worst corner error, as a fraction of the card's height. */
function cornerError(found, expected, cardHeightFraction) {
  return Math.max(
    ...found.map((corner, i) =>
      Math.hypot(
        (corner.x - expected[i].x) * WIDTH,
        (corner.y - expected[i].y) * HEIGHT
      )
    )
  ) / (cardHeightFraction * HEIGHT);
}

describe('detectCard', () => {
  test('finds a centred card without being told where it is', () => {
    const { frame, corners } = frameWithCard({ cx: 240, cy: 180, height: 300 });

    const found = detectCard(frame);
    assert.ok(found, 'a card filling most of the frame must be found');

    const error = cornerError(found.quad, corners, 300 / HEIGHT);
    assert.ok(
      error <= CORNER_TOLERANCE,
      `corners off by ${(error * 100).toFixed(1)}% of card height, tolerance ${CORNER_TOLERANCE * 100}%`
    );
  });

  test('finds a card held off to one side', () => {
    // The case a marked quad cannot serve: the card is nowhere near the middle
    // of the frame, because it is wherever the hand holding it is.
    const { frame, corners } = frameWithCard({ cx: 150, cy: 165, height: 260 });

    const found = detectCard(frame);
    assert.ok(found, 'an off-centre card must still be found');

    const error = cornerError(found.quad, corners, 260 / HEIGHT);
    assert.ok(error <= CORNER_TOLERANCE, `corners off by ${(error * 100).toFixed(1)}%`);
  });

  test('follows a card that is not square to the frame', () => {
    const { frame, corners } = frameWithCard({ cx: 240, cy: 180, height: 280, rotation: 0.06 });

    const found = detectCard(frame);
    assert.ok(found, 'a slightly turned card must still be found');

    const error = cornerError(found.quad, corners, 280 / HEIGHT);
    assert.ok(error <= CORNER_TOLERANCE, `corners off by ${(error * 100).toFixed(1)}%`);
  });

  test('locks onto the card, not the art window inside it', () => {
    // The art box is card-ish, strongly edged and entirely wrong. A detector
    // that takes it produces a clean capture that matches nothing, which is
    // indistinguishable from a camera problem at the point of use.
    const { frame } = frameWithCard({ cx: 240, cy: 180, height: 300 });

    const found = detectCard(frame);
    assert.ok(found);
    assert.ok(
      found.area > 0.3,
      `detected quad covers only ${(found.area * 100).toFixed(0)}% of the frame — that is an interior box, not the card`
    );
  });

  test('the result is card-shaped, which is what makes it checkable', () => {
    const { frame } = frameWithCard({ cx: 240, cy: 180, height: 300 });
    const found = detectCard(frame);

    assert.ok(found);
    assert.ok(
      quadAspectError(found.quad, WIDTH, HEIGHT) < 0.12,
      'a quad whose proportions are not a card\'s has locked onto something else'
    );
  });

  test('tracks from the previous frame instead of sweeping again', () => {
    // The steady state of a scanning session: a card was found last frame and
    // has drifted a few pixels. Sweeping the whole seed grid ten times a second
    // is tens of milliseconds a frame; refining last frame's answer is one pass.
    const first = frameWithCard({ cx: 240, cy: 180, height: 290 });
    const found = detectCard(first.frame);
    assert.ok(found);
    assert.equal(found.tracked, false);

    const moved = frameWithCard({ cx: 244, cy: 177, height: 290 });
    const tracked = detectCard(moved.frame, { hint: found.quad });

    assert.ok(tracked, 'a card that shifted slightly must still be found');
    assert.equal(tracked.tracked, true, 'and found by tracking, not by sweeping');
    assert.equal(tracked.seeds, 1);

    const error = cornerError(tracked.quad, moved.corners, 290 / HEIGHT);
    assert.ok(
      error <= CORNER_TOLERANCE,
      `tracking must be as accurate as detection, not merely fast — off by ${(error * 100).toFixed(1)}%`
    );
  });

  test('abandons a track that has caught an edge inside the card', () => {
    // Tracking's own failure mode, and the reason it is gated on shape.
    // refineEdge takes the convincing step nearest the guess, so a card that
    // moves *outward* leaves the guess closer to the art box's boundary than to
    // the card's own edge, and that inner step wins. Measured on this frame:
    // three edges on the card, the fourth 16px inside it, converging happily, at
    // 5.7% of card height. It must be thrown away rather than returned.
    const first = frameWithCard({ cx: 240, cy: 180, height: 290 });
    const found = detectCard(first.frame);

    const moved = frameWithCard({ cx: 251, cy: 173, height: 290 });
    const result = detectCard(moved.frame, { hint: found.quad });

    assert.ok(result, 'the sweep must still find the card');
    assert.equal(result.tracked, false, 'the bad track must not be returned');

    const error = cornerError(result.quad, moved.corners, 290 / HEIGHT);
    assert.ok(
      error <= CORNER_TOLERANCE,
      `falling back must restore full accuracy — off by ${(error * 100).toFixed(1)}%`
    );
  });

  test('a hint pointing at nothing falls back to the sweep', () => {
    // Tracking must not become a way to keep returning a stale answer. The card
    // has moved right across the frame; last frame's quad is now over bare
    // background and has to be abandoned rather than refined.
    const { frame, corners } = frameWithCard({ cx: 150, cy: 165, height: 260 });
    const stale = [
      { x: 0.70, y: 0.10 }, { x: 0.95, y: 0.10 },
      { x: 0.95, y: 0.85 }, { x: 0.70, y: 0.85 },
    ];

    const found = detectCard(frame, { hint: stale });
    assert.ok(found, 'the sweep must still find the card');

    const error = cornerError(found.quad, corners, 260 / HEIGHT);
    assert.ok(error <= CORNER_TOLERANCE, `corners off by ${(error * 100).toFixed(1)}%`);
  });

  test('returns nothing rather than a guess when there is no card', () => {
    // Empty desk. The honest answer is null: a capture rectified from a quad
    // that found nothing is a photograph of a table, and it will resolve to
    // some card or other with no way for anyone to tell it apart from a hit.
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i + 1] = data[i + 2] = 40;
      data[i + 3] = 255;
    }

    assert.equal(detectCard({ data, width: WIDTH, height: HEIGHT }), null);
  });
});
