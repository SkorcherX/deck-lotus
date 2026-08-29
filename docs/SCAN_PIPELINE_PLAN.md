# Scan pipeline — speed and glare plan

Working plan from a review of the scan pipeline (`client/src/components/scan.js`,
`scanSession.js`, `client/src/utils/cardContour.js`, `cardCapture.js`,
`cardOcr.js`, `src/shared/cardHash.js`). Tasks are ordered so each one can be
picked up on its own in a later session. Tick them off here as they land.

## Prerequisite — a replay harness (do this first)

The review assumed one exists. It does not: `client/src/utils/scanDiagnostics.js`
records captures and `download()` writes a bundle, but nothing reads a bundle
back. Every accuracy task below ("verify offline against a recorded bundle")
is unverifiable until this exists, and hash-arithmetic changes must not be
trusted without it — see the comparability warning in `src/shared/cardHash.js`.

- [ ] **0. Bundle replay tool.** A script (`scripts/replay-scan-bundle.mjs`)
      that takes an exported diagnostics bundle and re-runs hashing + server
      search over the stored frames, printing per-capture: matched name, hash
      distance, and which framing probe won. Baseline the current bundles
      before changing anything, so every later task has a before/after.
- [ ] **0b. Record reference bundles.** At minimum: bare cards, sleeved cards
      under a lamp (glare), foils, and one 4K-camera session. These are the
      fixtures for tasks 1–5 and 6–10.

## Speed

Today's ceiling is roughly 1.3 cards/s and it is structural: analysis runs at
10fps (`ANALYSIS_INTERVAL_MS = 100`), a capture needs a 3–4 frame streak, and
re-arming needs 3 absent frames (`ABSENCE_FRAMES_TO_REARM`) or 2 changed
(`NEW_CARD_FRAMES`) — ~500–700ms per card before any real work.

- [ ] **1. Hash probes at a fixed modest resolution.** `captureFromVideo` reads
      the full native frame and rectifies the card plus five framing probes at
      native size, but `hashRectified` averages down to a 32×32 grid — hashing
      a 4K rectification buys nothing. Rectify hash inputs to ~512px tall
      regardless of camera resolution; keep native only for the OCR crops and
      the diagnostics frame. Smallest change with the biggest per-capture win.
      *Verify:* replay must produce identical matches at a fraction of the time.
- [ ] **2. Raise the analysis rate to 20fps.** The gates are frame counts, so
      halving `ANALYSIS_INTERVAL_MS` roughly halves per-card latency with no
      retuning — but only if per-tick work fits in 50ms, which depends on 3/4.
      Do after them.
- [ ] **3. Move detection and analysis hashing into a Web Worker.** Transfer the
      downscaled `ImageData` to a worker running OpenCV; the main thread only
      draws the overlay from the last result. Decouples preview from detection
      cost and stops GC pauses reading as "motion" in the stillness metric.
- [ ] **4. ROI tracking that `scan.js:221` already claims exists.** The comment
      says the last quad is "fed back in as the next frame's hint";
      `detectCardContour` takes no hint. Either implement it — when
      `state.detected` exists, detect on a padded crop around the last quad and
      skip the Canny attempt, falling back to the full sweep when the card is
      lost — or fix the comment. Implementing is the large steady-state win.
- [ ] **5. Fix the detector's overshoot rather than probing around it.**
      `FRAMING_PROBES = [0.92, 0.94, 0.96, 0.98, 1]` exists because detection
      overshoots. Likely cause: the Canny attempt dilates with a 5×5 kernel and
      never erodes (`cardContour.js:344`), inflating the external contour ~2px
      per side. Try a morphological close (dilate then erode) and replay. If the
      basin re-centres on 1.0, cut probes from five to three — fewer client
      warps *and* fewer server index passes per capture.
- [ ] **6. Say in the UI that 2/s is the art-hash path.** OCR is seconds per
      card and correctly deferred; optionally cap `readBest` at two variants
      when the queue is deep.

## Sleeve glare

Glare is a specular highlight: saturated pixels that break contour detection,
flip hash bits across whole grid cells, and blank the collector block for OCR.

- [ ] **7. Glare chip + shutter gate (do first).** Add a cheap glare metric to
      the per-frame metrics in `cardCapture.js` — fraction of pixels above ~250
      luma inside the detected quad — surface it as a fourth chip beside
      Still/Focus/Card, and refuse auto-capture while it is over threshold. A
      person tilting the card 5° beats any software correction, but only if told
      *now* rather than after a failed match. Also worth noting that the torch
      usually makes sleeve glare worse.
- [ ] **8. Multi-frame min-composite at capture.** The shutter already waits for
      3–4 still frames and `recentQuads` holds their framings. Rectify the last
      N and take a per-pixel minimum (or median) before hashing: highlights are
      strictly brighter than the print beneath, and hand tremor guarantees the
      patch moves. *Verify:* replay against the sleeved bundle.
- [ ] **9. Glare-aware hashing.** In `downsampleToGrid`, exclude near-saturated
      pixels from each cell's average, falling back to the full average when a
      cell is entirely blown. This is shared-module arithmetic — reference
      hashes are built by `scripts/build-card-hashes.mjs` from clean scans, so
      it must be validated with the replay harness across *all* bundles before
      it is trusted, and it may require a hash-version bump.
- [ ] **10. Add the adaptive-threshold attempt the header promises.**
      `cardContour.js:34` says "a foil under a lamp needs the adaptive one", but
      the attempts are Otsu, inverted Otsu and Canny — there is no
      `cv.adaptiveThreshold`. A glare stripe splits the card's region under a
      global threshold; adaptive is the tool for it. Add as a fourth attempt, or
      replace one Otsu polarity to keep the per-frame budget flat.
- [ ] **11. Highlight-clipping OCR variant.** Clamp above the 95th percentile
      before Sauvola so a bright band does not drag the local mean up and erase
      the strokes beside it. Low priority — OCR is off the hot path.
- [ ] **12. Docs: hardware footnote.** For a fixed rig, linear polarizing film
      over the lens plus a cross-polarized light kills sleeve glare outright.

## Tidy-ups

- [ ] **13.** The `via: 'edges'` path clones `closed` and deletes the original in
      its `finally` (`cardContour.js:340–349`) — an extra full-frame copy every
      tick. Return `closed` and delete only `edges`. Fold into task 4 or 5.

## Suggested order

0 → 0b → 7 (glare chip) → 1 (probe resolution) → 5 (+13) → 4 → 3 → 2 → 8 → 9 →
10 → 11 → 6 → 12.

Tasks 7 and 1 are small and self-contained and are the natural first sessions;
everything after 3 assumes the worker exists.
