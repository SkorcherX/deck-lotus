/**
 * The pixel half of the OCR preprocessing.
 *
 * It moved to src/shared so `scripts/ocr-variants.mjs` could run it in Node
 * against real captures — which is the only reason any of this is testable
 * without a browser, and the reason to keep it that way.
 *
 * What these pin is the thing a shared module has to keep: the shipped path is
 * unchanged, and the option that is off by default really is off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preprocessPixels } from '../src/shared/ocrPreprocess.js';

/**
 * A crop of dark strokes on a mid-grey plate, with an optional bright band
 * across the middle — a specular highlight over printed text, which is what
 * the clip option is for.
 */
function crop({ band = 0, from = 0.4, to = 0.6, width = 90, height = 40 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Vertical strokes every six pixels, three rows in from each edge.
      const isStroke = y > 4 && y < height - 4 && x % 6 < 2;
      let value = isStroke ? 40 : 150;
      if (band && y >= height * from && y < height * to) value = Math.min(255, value + band);

      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = value;
      data[p + 3] = 255;
    }
  }

  return { data, width, height };
}

test('the clip is off by default, and off is byte-identical', () => {
  const image = crop();

  const asShipped = preprocessPixels(image, { window: 0.35 });
  const spelledOut = preprocessPixels(image, { window: 0.35, clip: null });

  assert.deepEqual(Array.from(asShipped.data), Array.from(spelledOut.data));
});

test('clipping barely moves the thresholded result, which is why it did not ship', () => {
  // Task 11 proposed clipping the top of the histogram so a bright band could
  // not drag Sauvola's local mean up and erase the strokes beside it. The
  // premise does not hold strongly here, and this pins the reason rather than
  // the hope: with a band 4% of the crop tall at +100 luma, the glare changes
  // 87 pixels of the binarized output and clipping at the 95th percentile
  // recovers 6 of them. The window is 0.35 of the crop's height, so the top 5%
  // of the histogram is a small part of any mean it computes.
  //
  // Measured against real captures too — 21 of them, three sessions, through
  // scripts/ocr-variants.mjs — where clipping beat the default variant and lost
  // to the two alternatives already in the ladder. See the pipeline plan.
  const clean = crop();
  const glared = crop({ band: 100, from: 0.48, to: 0.52 });

  const differing = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) n++;
    return n;
  };

  const options = { window: 0.35 };
  const cost = differing(preprocessPixels(clean, options), preprocessPixels(glared, options));
  const recovered = cost - differing(
    preprocessPixels(clean, { ...options, clip: 0.95 }),
    preprocessPixels(glared, { ...options, clip: 0.95 })
  );

  assert.ok(cost > 0, 'the fixture has to actually cost something, or it proves nothing');
  assert.ok(recovered >= 0, 'clipping must not make a glared crop differ from a clean one *more*');
  assert.ok(
    recovered < cost / 2,
    `if clipping ever starts recovering most of the loss (${recovered} of ${cost}), re-run ` +
    'scripts/ocr-variants.mjs — the decision not to ship it was made on these numbers'
  );
});

test('a flat crop survives clipping rather than collapsing', () => {
  // Every pixel at one value means the percentile cut *is* that value, so the
  // clip is a no-op — the branch that would divide by a zero span or clamp
  // everything to black.
  const flat = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4).fill(200) };

  const result = preprocessPixels(flat, { window: 0.35, clip: 0.95 });

  assert.equal(result.width, 20);
  assert.ok(
    result.data.every((value, i) => (i % 4 === 3 ? value === 255 : value === result.data[0])),
    'a flat crop must threshold to one tone, not to noise'
  );
});
