# Scan pipeline — speed and glare plan

Working plan from a review of the scan pipeline (`client/src/components/scan.js`,
`scanSession.js`, `client/src/utils/cardContour.js`, `cardCapture.js`,
`cardOcr.js`, `src/shared/cardHash.js`). Tasks are ordered so each one can be
picked up on its own in a later session. Tick them off here as they land.

## Before starting — the harness already exists

`scripts/scan-replay.mjs` re-runs the real pipeline (same warp, same
`hashRectified`, same index, same `resolveScanFused`) over a recorded
diagnostics bundle, with `--ladder` to A/B a probe ladder, `--sweep lo:hi` to
find the basin, and `--extract DIR` for the images. Read
[SCAN_DIAGNOSTICS_TESTING.md](SCAN_DIAGNOSTICS_TESTING.md) first — it documents
the bundle format, ground truth via Scryfall, the browser-side camera stub, and
the pitfalls. Every "verify offline" below means that script.

```bash
DATABASE_PATH=data/deck-lotus-test.db node scripts/scan-replay.mjs <bundle.json>
```

Two limits that shape the tasks:

- **Replay cannot judge capture resolution.** A bundle's `frame` is stored at
  720px wide; the phone captured ~11MP. Replayed distances are for comparing
  changes against each other, not absolutes — so task 1 needs its own check
  (below), not a replay A/B.
- **One variable at a time.** The one sleeved run scored 3/11 but also changed
  card set, so nothing can be concluded from it. The glare work (tasks 7-10)
  needs the test the doc already names: the same cards, sleeved and unsleeved,
  in the same box and the same light.

## Speed

Today's ceiling is roughly 1.3 cards/s and it is structural: analysis runs at
10fps (`ANALYSIS_INTERVAL_MS = 100`), a capture needs a 3–4 frame streak, and
re-arming needs 3 absent frames (`ABSENCE_FRAMES_TO_REARM`) or 2 changed
(`NEW_CARD_FRAMES`) — ~500–700ms per card before any real work.

- [x] **1. Hash probes at a fixed modest resolution.** `captureFromVideo` reads
      the full native frame and rectifies the card plus five framing probes at
      native size, but `hashRectified` averages down to a 32×32 grid — hashing
      a 4K rectification buys nothing. Rectify hash inputs to ~512px tall
      regardless of camera resolution; keep native only for the OCR crops and
      the diagnostics frame. Smallest change with the biggest per-capture win.
      *Done:* `HASH_HEIGHT = 680`, the size the references themselves were built
      at. It turned out to be an accuracy fix as well — hashing at the camera's
      size cost 10-12 bits of grid quantisation against every reference.
      *Verify:* not by replay (bundles hold 720px frames). In the browser with
      the camera stub, hash the same source rectified at native and at 512px and
      require identical hashes, then measure the per-capture stall.
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
- [x] **5. Fix the detector's overshoot rather than probing around it.**
      `FRAMING_PROBES = [0.92, 0.94, 0.96, 0.98, 1]` exists because detection
      overshoots. Likely cause: the Canny attempt dilates with a 5×5 kernel and
      never erodes (`cardContour.js:344`), inflating the external contour ~2px
      per side. Try a morphological close (dilate then erode) and replay. If the
      basin re-centres on 1.0, cut probes from five to three — fewer client
      warps *and* fewer server index passes per capture. *Verify:* `--sweep
      0.84:1.04` before and after; the ladder A/B is `--ladder`. Note this is a
      scale error, not corner jitter — the fitted-edge corner spike was already
      built, measured (jitter down 3-8x, art distance unchanged: 396 either way)
      and deleted, so do not reach for corner precision again here.
      *Half done:* the close is in, and `client/lab/contour-lab.html` measures
      the `edges` attempt at +1.19% before and -0.40% after. The ladder is
      untouched: 1.19% does not account for a basin centred near 0.95, so
      something else still pulls outward on real cards. Cutting probes from five
      to three waits on a recorded session and `--sweep`. *Then two sleeved
      sessions arrived:* the sweep put the basin far lower and wider than the
      bare-card sample did, so the ladder was respread to
      `[0.84, 0.88, 0.92, 0.96, 1]` — five rungs still, 4/9 and 4/9 up to 8/9
      and 7/9. Cutting to three probes is off the table: the basin is wider than
      it looked, not narrower.
- [ ] **6. Say in the UI that 2/s is the art-hash path.** OCR is off by default
      and does not currently earn its cost (warm reads 7-28s on the phone,
      noise on both cards they touched, against a hash at 7/7 unaided), so the
      throughput figure users see should be the art-hash one. Capping `readBest`
      at two variants when the queue is deep is optional and low value.

## Sleeve glare

Glare is a specular highlight: saturated pixels that break contour detection,
flip hash bits across whole grid cells, and blank the collector block for OCR.

- [x] **7. Glare chip + shutter gate (do first).** Add a cheap glare metric to
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
      it must be replayed across *all* bundles before it is trusted, and it may
      require a hash-version bump. Check it against the crowding measurement in
      the testing doc too: ~1.5% of cards already sit within 27 bits of a
      different card, and this change moves every distance at once.
- [ ] **10. Add the adaptive-threshold attempt the header promises.**
      `cardContour.js:34` says "a foil under a lamp needs the adaptive one", but
      the attempts are Otsu, inverted Otsu and Canny — there is no
      `cv.adaptiveThreshold`. A glare stripe splits the card's region under a
      global threshold; adaptive is the tool for it. Add as a fourth attempt, or
      replace one Otsu polarity to keep the per-frame budget flat.
- [ ] **11. Highlight-clipping OCR variant.** Clamp above the 95th percentile
      before Sauvola so a bright band does not drag the local mean up and erase
      the strokes beside it. Lowest priority of all — OCR is off by default and
      has yet to earn its cost; do not spend a session here before task 6.
- [ ] **12. Docs: hardware footnote.** For a fixed rig, linear polarizing film
      over the lens plus a cross-polarized light kills sleeve glare outright.

## Tidy-ups

- [ ] **13.** The `via: 'edges'` path clones `closed` and deletes the original in
      its `finally` (`cardContour.js:340–349`) — an extra full-frame copy every
      tick. Return `closed` and delete only `edges`. Fold into task 4 or 5.

## Suggested order

Record the controlled sleeved/unsleeved pair first (it is the only open question
the existing bundles cannot answer), then:

7 (glare chip) → 1 (probe resolution) → 5 (+13) → 4 → 3 → 2 → 8 → 9 → 10 →
6 → 12 → 11.

Tasks 7 and 1 are small and self-contained and are the natural first sessions;
everything after 3 assumes the worker exists. Anything that changes a measured
number should update section 8 of
[SCAN_DIAGNOSTICS_TESTING.md](SCAN_DIAGNOSTICS_TESTING.md) so the next session
does not re-derive it.
