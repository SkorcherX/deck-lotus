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
- [x] **2. Raise the analysis rate to 20fps.** The gates are frame counts, so
      halving `ANALYSIS_INTERVAL_MS` roughly halves per-card latency with no
      retuning — but only if per-tick work fits in 50ms, which depends on 3/4.
      Do after them. *Unblocked by 3 and 4, and now wanted for a second reason:*
      detection answers asynchronously, so the rate at which framings arrive to
      be averaged is bound by the worker round trip, and a recorded session came
      back with runs of one where it used to hold four.
      **Not free, though.** `difference` is measured between consecutive frames,
      so at 50ms apart a moving card scores about half what it scores at 100ms
      and the stability bar would admit twice the motion it was set for. Either
      scale the thresholds with the interval or normalise the metric to a fixed
      window — the metric changing meaning silently is exactly the class of
      thing `SETTINGS_VERSION` exists to stop.
      *Done.* Stillness is now measured against the frame from a fixed 100ms
      ago rather than against the frame before, so both halves of `difference`
      keep the meaning they were measured with and the thresholds carry over
      untouched. The absence and new-card gates were converted from frame counts
      to durations, since being early there means a card captured twice; the
      capture streak was deliberately left as a frame count, since shortening it
      is the point. `SETTINGS_VERSION` went to 12 because a stored `streak`
      would otherwise mean half the settle it used to.
- [x] **3. Move detection and analysis hashing into a Web Worker.** Transfer the
      downscaled `ImageData` to a worker running OpenCV; the main thread only
      draws the overlay from the last result. Decouples preview from detection
      cost and stops GC pauses reading as "motion" in the stillness metric.
      *Done for detection; analysis hashing stayed put.* The per-frame metrics
      run on a 176px buffer and are not what costs. Asking for a detection is
      0.04ms on the main thread against 3.84ms inline, the worker returns quads
      identical to the inline path (0px corner difference), and requests are
      dropped rather than queued so a slow device detects less often instead of
      answering about where the card used to be. Task 2 is now unblocked.
- [x] **4. ROI tracking that `scan.js:221` already claims exists.** The comment
      says the last quad is "fed back in as the next frame's hint";
      `detectCardContour` takes no hint. Either implement it — when
      `state.detected` exists, detect on a padded crop around the last quad and
      skip the Canny attempt, falling back to the full sweep when the card is
      lost — or fix the comment. Implementing is the large steady-state win.
      *Done:* `hint` narrows the search to a padded window and skips the Canny
      attempt; a contour closed by the window's own edge is rejected, and an
      empty tracked pass falls through to the full sweep. 1.3-2.3ms against
      3.7-8.1ms cold, with no drift over sixty fed-back frames.
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
- [x] **6. Say in the UI that 2/s is the art-hash path.** OCR is off by default
      and does not currently earn its cost (warm reads 7-28s on the phone,
      noise on both cards they touched, against a hash at 7/7 unaided), so the
      throughput figure users see should be the art-hash one. Capping `readBest`
      at two variants when the queue is deep is optional and low value.
      *Done, and the figure changed while this sat here.* The page never quoted
      a rate at all, so what went in is the statement rather than a correction:
      cards are named by their art in around half a second, and the text reader
      adds several seconds a card. Half a second, not 2/s, because on-device
      matching took a card from ~1520ms to 635ms — and it is phrased as "fast
      enough to keep up with you" rather than as a rate, since the bottleneck is
      the hand at about five seconds a card and cards-per-second is a number
      nobody can reproduce with a stack in front of them. The reader toggle's
      tooltip now carries the comparison too. `readBest` capping was left
      undone: it is optional, low value, and aimed at a path that is off.

## Naming and cues

- [x] **16. Say when the *name* is settled, separately from the printing.**
      Nine sessions, 61 resolved captures, and every one had a single card name
      inside the threshold — the tier was reporting doubt the evidence never
      had. `signals.nameCertain` now carries it, and the shutter's tone and the
      status line read from it rather than from `confident`. See
      docs/SCAN_ACTION_PLAN_2026-08-29.md.
- [x] **17. Record where the time between shutter and verdict goes.**
      `timings: { shutterMs, hashMs, resolveMs }` per capture. Should have come
      before the speed work rather than after it.

## Printings

- [x] **14. Bias candidates toward the sets a session has already resolved.**
      The art hash names the card and cannot name the printing: a recorded
      session of nine ECC precon cards came back tied across MKC, BLC, ECC and
      PLST at identical distances, and which sibling led changed with the
      framing probe. `resolveScanFused` now declines to call those `confident`
      (`signals.printingsOfBest`), which is honest but leaves the reviewer
      picking from four identical-looking rows.
      The information that would settle it is not in the photograph — it is in
      the stack. Cards come from one place: a precon, a booster box, a trade
      binder. So carry a per-session tally of the sets already resolved and use
      it to order printings the art considers tied, and only those. Two rules
      it has to keep: never let the bias reorder candidates the art actually
      separated, and never let it promote a printing to `confident` — a tally
      is a hint about a pile of cards, not evidence about the one in hand.
      Worth offering the same thing explicitly too ("I'm scanning ECC"), which
      is the same mechanism with the tally supplied by hand.
      *Done.* The tally is fed only by captures whose art matched a single
      printing, so it is seeded by the cards unique to the set rather than by
      the session's own guesses. `scan-replay.mjs --bias` replays it: three ECC
      sessions went from 3, 3 and 1 correct printings of nine to 8, 8 and 6.
      Four tests cover the rules, including the two that matter — a tally must
      not override a distance the art separated, and must not reach past the
      card the art chose.

- [ ] **15. Illumination-invariant art hashing, for foils.** A precon's foil
      commanders miss outright: two borderless foil cards measured 84 bits of
      256 from their own references, while their *frame* hashes sat at 22-26.
      That split is the diagnosis — the whole-card layout matches and only the
      art window is destroyed, which is what a large smooth sheen does to the
      low-frequency DCT signs the art hash is built from. The references are
      correct (Scryfall's image hashes to the packed row at 0 bits) and the
      printing is right, so nothing about the index can fix it.
      The standard remedy is a high-pass before the DCT: subtract a blurred copy
      of the 32x32 grid so smooth illumination gradients drop out and structure
      survives. It is `src/shared/cardHash.js` arithmetic, so it needs all 112k
      references rebuilt and a hash version bump — and it must be measured
      offline across every recorded bundle first, foils *and* non-foils, since a
      change that rescues foils by loosening everything else is not a rescue.
      Angle matters more than any of this in the meantime: the same two cards
      matched at 44 and 76 in earlier sessions, because sheen depends on where
      the light is.
      *Measured, not yet shipped.* `scripts/hash-variants.mjs` now exists for
      exactly this and has run over 72 captures from ten sessions. A high-pass
      of radius 2 matches 56/72 against the baseline's 51/72, strong-matches 8
      against 5, regresses no card, and leaves the nearest wrong card 37 bits
      clear of the threshold. But it is *not* a foil rescue — foils stay the
      worst cards either way — and shipping it invalidates all 112,815
      references, which are only cached as hashes: a rebuild re-downloads every
      Scryfall image, about three hours, plus a hash version bump. Worth doing
      deliberately; not worth slipping in. Numbers are in the testing doc.
      The cheap mitigation for foils meanwhile is the reader: OCR is exactly the
      second signal for a card whose art cannot be matched, and `readIfUnresolved`
      already asks for it on anything short of `confident`.

- [x] **18. Move the matcher onto the device.** `resolveMs` measured 741ms on a
      phone against 9.5ms of actual work on the server — it is the link, and it
      is now the largest single cost per card. The index is 6.0MB and the
      identity table 0.8MB gzipped, against the 12.7MB of OpenCV the device
      already downloads to find a card at all. The work is mostly one thing:
      splitting the pure ranking in `resolveScanFused` — fusion, tiers,
      `nameCertain`, set biasing — from the database hydration around it, and
      moving the pure half to `src/shared/` for the same reason `cardHash.js`
      and `cardGeometry.js` live there. See docs/ON_DEVICE_MATCHING.md, which
      also says what a native app would and would not buy, and what would
      settle it: a prototype search timed on the real phone.
      *The prototype ran, and settled it:* 12ms mean on the phone for a
      five-probe match over all 112,815 references, against 626-741ms for the
      same work over the network, plus a one-off 1.3s to download the index.
      Fifty times faster, and it works with no network until commit.
      *Step 3 of the note is now done:* the pure ranking lives in
      `src/shared/scanFusion.js` — `fuseScanResult`, the tiers, `nameCertain`,
      set biasing and the match thresholds — with `resolveScanFused` reduced to
      the text lookup, the index passes and the hydration around them. The
      fusion tests pass unchanged, which is the only evidence worth having that
      a move was a move.
      *And the wiring is in.* `GET /api/scan/identity` serves what each index
      row is — printing, card, name, set, collector, price — in index row order,
      so the uuids the device already downloaded are not sent a second time;
      `localIndex.resolve` searches, hydrates from it and calls
      `fuseScanResult`, the same function the server calls. The scanner fetches
      both halves in the background once the detector is up and matches locally
      from then on, falling back to the server when the index has not loaded,
      failed to load, or the reader wants a capture refined by text — that half
      is a card-table lookup and stays where the card table is.
      `timings.resolvedBy` records which side answered.
      `test/integration/localResolve.test.js` is the thing to keep: it asserts
      device against server rather than against expectations, tier, candidate
      order, probe choice, set bias and the nearest-reference message included.
      Image URLs are the one thing the device does not carry — they nearly
      triple the identity payload (1.25MB gzipped to 3.54MB) for the review
      screen's thumbnail — so `POST /api/scan/printings` fetches those once per
      session when the review table opens.
      *Measured in the field, thirteen captures on the phone, all thirteen
      answered on the device:* `resolveMs` 32ms mean — 27 on a hit, 50 on a miss
      where a second index pass buys the nearest-reference message — against
      626-741ms over the network. Shutter 447, hash 156, **635ms a card against
      ~1520**. Set biasing named the ECC printing on 10 of 10 hits. The three
      misses were the sleeved band at 82-88 bits, which this work never touched.

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
- [x] **8. Multi-frame composite at capture.** The shutter already waits for
      3–4 still frames and `recentQuads` holds their framings. Rectify the last
      N and take a per-pixel minimum (or median) before hashing: highlights are
      strictly brighter than the print beneath, and hand tremor guarantees the
      patch moves. *Verify:* replay against the sleeved bundle.
      *Done, with two changes to the shape of it.* **Median, not minimum:** the
      sleeved sessions recorded glare at 0.00-0.09% with the torch off, so the
      loss is not specular, and against noise a minimum is a bias rather than an
      average. A median still rejects a highlight present in a minority of
      frames. **Composited in the source plane, before any warp:** one pass
      serves all five probes and both OCR crops, where compositing each
      rectified probe would repeat the work five times and leave the reader's
      crops untouched. The burst is taken forward from the shutter rather than
      out of `recentQuads`, which never held frames — only framings.
      *Measured, and switched off.* The next session carried both hashes and the
      composite was worse or equal on seven of nine captures. Tremor moves the
      card, not just the glare: over a 66ms burst a hand-held card shifts more
      than the framing tolerance, so the median softens the detail the hash
      reads. It also cost 402ms per capture in the median alone at 12MP.
      `CAPTURE_BURST = 1`; the code and its tests stay for the fixed-rig case,
      where the frames would align and the glare would not.
- [x] **9. Glare-aware hashing.** In `downsampleToGrid`, exclude near-saturated
      pixels from each cell's average, falling back to the full average when a
      cell is entirely blown. This is shared-module arithmetic — reference
      hashes are built by `scripts/build-card-hashes.mjs` from clean scans, so
      it must be replayed across *all* bundles before it is trusted, and it may
      require a hash-version bump. Check it against the crowding measurement in
      the testing doc too: ~1.5% of cards already sit within 27 bits of a
      different card, and this change moves every distance at once.
      *Measured, and declined.* Built as `downsampleToGrid`'s `glareCut` option
      and run through `hash-variants.mjs` over 126 captures from fourteen
      sessions: **93/126 matched, which is the baseline exactly**, at cuts of
      250, 240 and 230. Per card it is identical on eight of the nine and half a
      bit worse on the ninth, does nothing for the two foils it was aimed at,
      and combined with the high-pass it undoes part of it (97/126 to 94/126).
      The reason retires the idea rather than deferring it: **task 7's shutter
      gate means a capture with blown pixels is never taken.** Across every
      recorded session the glare metric maxes at 1.13% of pixels and is 0.00% in
      most. There is nothing to exclude, and shipping it would cost all 112,815
      references rebuilt and a hash version bump to move no number. The option
      stays, off by default and byte-identical when off, because it is what lets
      the harness measure the real pipeline instead of a copy — and because the
      next person to propose this is owed the measurement, not the idea.
- [x] **10. Add the adaptive-threshold attempt the header promises.**
      `cardContour.js:34` said "a foil under a lamp needs the adaptive one", but
      the attempts are Otsu, inverted Otsu and Canny — there is no
      `cv.adaptiveThreshold`. A glare stripe splits the card's region under a
      global threshold; adaptive is the tool for it. Add as a fourth attempt, or
      replace one Otsu polarity to keep the per-frame budget flat.
      *Built, measured, declined — the comment is what got fixed.* Three glare
      scenes went into `client/lab/contour-lab.html` (a specular band drawn
      across a card of known corners) and the attempt was written against them:
      - **It does not answer the case it was proposed for.** On a dark card with
        a stripe across it, adaptive found nothing at all, at every block size
        (21-81) and constant (2-10) and both polarities — 51 of 168 parameter
        combinations found anything anywhere.
      - **It is worse where the others already work:** +3.57% of card width at
        its own best parameters against Otsu's -0.40%, and 2% is 92 bits.
      - **It cannot be added safely.** Attempts are scored by area, so a looser
        threshold wins by being looser: added as a fourth pass at its default
        parameters it took scenes Otsu had right and framed them 9.51% too big.
      - **It costs.** 3.8ms for three attempts, 12.6ms for four, against a
        detector already answering 3.6 times a second on a phone.
      A fallback that ran only when the others found nothing would never fire,
      for the reason in task 19: on those scenes they do not fail, they succeed
      at the wrong thing.
- [x] **11. Highlight-clipping OCR variant.** Clamp above the 95th percentile
      before Sauvola so a bright band does not drag the local mean up and erase
      the strokes beside it. Lowest priority of all — OCR is off by default and
      has yet to earn its cost; do not spend a session here before task 6.
      *Built, measured, not shipped — but it left a harness behind.* Three
      sessions finally carried OCR readings, so this could be measured rather
      than reasoned about. The pixel half of the preprocessing moved to
      `src/shared/ocrPreprocess.js` (the canvas wrapper stays in `cardOcr.js`)
      and `scripts/ocr-variants.mjs` now runs the real preprocessing and the
      real engine over a bundle's own crops, scored against what the *art* said
      the card was — an independent signal from the reader being measured.
      Over 21 captures from three sessions:

          collector block          score   full   none
          default                  0.119      0     16
          low-contrast             0.238      4     15
          grayscale                0.310      5     13
          clip 0.95                0.214      2     14
          clip 0.90                0.143      1     16
          clip 0.95 + low-contrast 0.214      4     16

      Clipping beats the *default* variant and loses to both alternatives
      already in the ladder, so as a fourth variant it would add a pass without
      adding an answer — `readBest` tries them in order and stops at 0.9. Titles
      say the same: clip 0.95 ties the default at 0.262, and clip+low-contrast
      ties low-contrast at 0.381.
      The premise turns out to be weak here too: with a band 4% of the crop tall
      at +100 luma, glare changes 87 pixels of the thresholded output and
      clipping recovers 6. Sauvola's window is 0.35 of the crop's height, so the
      top 5% of the histogram barely moves the mean it computes.
      The `clip` option stays, off by default and byte-identical when off, for
      the same reason `glareCut` did in task 9.
      **The loose thread worth pulling is not this one:** `grayscale` scored
      best on the collector block and is tried *third*. Reordering the ladder is
      free. It is not done here because 21 captures of one foil precon, replayed
      at the bundle's 720px rather than the phone's native resolution, is not
      enough to reorder a ladder on — it wants a session with the reader on and
      the winning variant recorded per capture, which the bundle does not yet
      carry.
- [x] **12. Docs: hardware footnote.** For a fixed rig, linear polarizing film
      over the lens plus a cross-polarized light kills sleeve glare outright.
      *Written up in the testing doc, under "What software cannot do".* It grew
      a second half while being written: the recorded sessions say glare is
      already gated out at capture and the remaining loss is foil sheen, which
      is the same optics problem seen from the other side — a polarizer is the
      only thing in this whole plan that addresses it at the source.

## Framing

- [x] **19. The detector frames the art box on a low-contrast card.** Found by
      the glare scenes added for task 10, and it is the more useful half of that
      session. On a card close to the desk in brightness — with or without a
      glare stripe — `detectCardContour` returns a quad **37.4% smaller than the
      card**: the art window's own contour, traced as though it were the card.
      Not a miss. A confident wrong answer, with an aspect error of 0.060, well
      inside the 0.16 tolerance, and it survives into the tracked path because
      the hint then locks onto it.
      A capture framed that way cannot match anything: the framing ladder spans
      0.84-1.0 and this is 0.63. It would read as "no match, nearest reference
      80-something bits away" — which is the shape of the misses that remain in
      the recorded sessions, though nothing yet ties the two together. That is
      the first thing to check: `--extract` a session's misses and look at
      whether the rectified card is the whole card.
      `RETR_EXTERNAL` is supposed to prevent this — the art box is a hole inside
      the card's region — so it only happens when the card's own region never
      closes and the box is the largest thing that does. Which suggests the fix
      is about closing the card's region rather than about scoring: the aspect
      and area bounds cannot tell a card from a picture of one, and tightening
      them to exclude a 0.63-scale quad would exclude real cards held further
      from the lens.
      Measured on synthetic scenes, so confirm it on a recorded session before
      building anything — that is what the lab's own header says it is for.
      *Checked, and it does not happen in the field.* Across fifteen recorded
      sessions, 143 captures, 28 of them misses:
      - **The misses are framed like the hits.** Detected area is 0.261 of frame
        at the median for a miss against 0.282 for a hit, ranges overlapping
        completely. An art-box quad is 0.63 of the card's width, so it would
        come in near 0.11 — nothing does. Per card the two are the same number:
        Ashling 0.253 missed against 0.249 hit, Mass of Mysteries 0.260 against
        0.259. Whatever separates a hit from a miss, it is not the framing.
      - **The extracted misses are whole cards.** Three pulled out and looked at
        — Ashling, Abundant Growth, Fertile Ground — and every one is the entire
        card, correctly rectified, borders included.
      - **The lab's trigger never arises here.** 137 of 143 detections came via
        `otsu-inverted`, six via `edges`: a dark card on a pale desk, which is
        the case the global threshold is best at. The art box appears in the lab
        only where card and desk are close in brightness, and nobody has scanned
        on a mat like that.
      So it is a real failure of the detector and an unreached one, left
      documented rather than fixed: the conditions to watch for are a scanning
      surface close to the card's own brightness and a `via` of `edges` on
      captures that miss. What the misses actually are is task 15 — every card
      in this precon is foil, the framing is right, and what changes between a
      capture that matches and one that does not is the sheen.

## Tidy-ups

- [x] **13.** The `via: 'edges'` path clones `closed` and deletes the original in
      its `finally` (`cardContour.js:340–349`) — an extra full-frame copy every
      tick. Return `closed` and delete only `edges`. *Done with task 5.*

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
