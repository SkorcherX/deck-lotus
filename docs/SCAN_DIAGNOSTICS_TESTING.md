# Testing the card scanner against recorded sessions

How the scanner is actually tuned. Nearly every number in the scan commits —
"1/7 to 5/7", "3/7 to 5/7, none wrong", "corner spread 1.87x" — came from this
method rather than from rescanning and hoping.

The short version: **a diagnostics bundle contains enough to run the whole match
again offline.** So a change to the probe ladder, the match threshold or the
candidate ranking is measured against real captures in seconds, and only the
change that measures well gets shipped.

---

## 1. Where the data comes from

On the scan page, open **Diagnostics & tuning**, tick **Record**, scan, then
press **Download**. The browser saves
`scan-diagnostics-<timestamp>.json`, typically 1-3MB.

Two things about the recording that matter when reading a bundle:

- **It holds 24 captures, and prefers failures.** When it overflows it gives up
  the oldest *settled* (`confident`) capture first, so a long clean run keeps a
  rolling sample of successes plus every miss it saw. Before that it was a plain
  ring, and a 90-card run arrived with 24 successes and no trace of the one card
  that failed.
- **Download waits for reads.** Pressing Download while OCR reads are in flight
  asks first, because a bundle taken early is missing exactly the part somebody
  turned the reader on to see. The status line counts them down.

---

## 2. What is in a bundle

```
format, version
environment
  recordedAt, downloadedAt, userAgent, screen
  settings            thresholds, crop regions, marked quad, snap/detect flags
  reader              { enabled, warm, pending }
  detector            { samples, mean, max, rate, worker } — round trips in ms
  localMatching       what "Time local matching" measured, if it was pressed
  setBias             the set tally in force, typed or inferred, or null
captures[]
  at, trigger         'auto' | 'manual'
  quad                the four corners the capture was cut with, as frame fractions
  snap                { detected, via, area, aspectError, averaged, runLength, freshLength }
  rectifiedSize       the size it was hashed at — fixed, see HASH_HEIGHT
  nativeRectifiedSize what it rectified to at the camera's own resolution
  artHash, frameHash  the unexpanded framing's hashes
  singleArtHash       the same framing from the first frame alone, uncomposited
  burst               how many frames were composited into the capture
  probeScales         the ladder offered, e.g. [0.92, 0.94, 0.96, 0.98, 1]
  rectified           the rectified card, JPEG data URL, 488px wide
  frame               the whole frame it was cut from, JPEG data URL, 720px wide
  resolution          the art-only answer: tier, signals, candidates
  refinedResolution   the answer after OCR, where the reader had something to add
  reading             what the reader saw, plus wasWarm / engineMs / recognizeMs
  readQueued          whether this capture was ever handed to the reader
```

Fields worth knowing the meaning of, because each was added to settle a specific
argument that could not be settled without it:

| field | why it exists |
| --- | --- |
| `signals.probeIndex` | which rung of the ladder won. Across three sessions no outward probe ever won, which is what turned the ladder around. |
| `signals.nearest` | on a miss, the distance to the closest reference. Tells "framed slightly wrong" (60-ish) from "not this card" (90+). |
| `refinedResolution` | the text-refined answer, recorded *beside* the art-only one. Without both, `signals.text: 0` looked like "OCR contributed nothing" when it meant "OCR was never asked". |
| `reader.enabled` | whether OCR was on at all. Two sessions were spent inferring this from timestamps. |
| `readQueued` | separates "the reader was never asked" from "the bundle was downloaded before the read finished". |
| `wasWarm` / `recognizeMs` | `elapsedMs` alone is two numbers in one: a cold read carries a ~17MB download inside it. |
| `snap.averaged` | how many detections were averaged into the framing. 1 means the run disagreed and a single frame was used. |
| `detector.rate` | detections per second actually delivered. Detection runs in a worker and requests are dropped while one is in flight, so this is one over the round trip, not the loop's tick rate — and it is the ceiling on how fresh a capture's framing can be. |
| `snap.quadSource` | `capture` when the framing was detected on the captured frame itself, `live` when detection could not answer in time and the loop's last quad was used. |
| `snap.quadAgeMs` | how old the framing a capture was cut with was, in milliseconds. Two sessions were recorded before this existed in which every capture was framed from a detection over 300ms old, and nothing in the bundle said so. |
| `snap.freshLength` | how many of the held detections were recent enough (`QUAD_AGE_MS`) to average. Below `runLength` means detection is answering slower than the shutter settles, which is what let a capture be framed from quads taken while the card was still being put down. |
| `snap.runLength` | how many detections were *available* to average. Detection answers asynchronously since it moved into a worker, so a short run and a disagreeing run are different faults and `averaged` alone cannot tell them apart. |
| `singleArtHash` / `burst` | a capture is the median of a short burst of frames. This is what the first frame alone would have hashed to, so the two distances against the winning candidate say whether the burst paid for its shutter lag. |
| `nativeRectifiedSize` | what the card rectified to at the camera's own resolution. `rectifiedSize` is fixed at the hash size now, so this is the only field left that says whether a session was shot close or far. |

A bundle carries no account data — no user, no token, no collection. A scan is a
photograph of a card on a table and that is all this should ever be able to leak.

---

## 3. Replaying a session offline

This is the main tool. `scripts/scan-replay.mjs` takes the recorded frame and the
recorded quad and runs the real pipeline over them: the same warp, the same
`hashRectified`, the same 112k index, the same `resolveScanFused`.

```bash
DATABASE_PATH=data/deck-lotus-test.db node scripts/scan-replay.mjs <bundle.json>
```

`DATABASE_PATH` is required: the hash index joins `data/card-hashes.bin` to the
`printings` table, and against an empty database it loads zero rows. The script
says so rather than reporting everything as a miss.

**Reproduce the session.** With no options it uses the ladder the session itself
recorded, so the output should closely track what the bundle says happened:

```
cap0    Brambleback Brute [ECL 128] art=38 confident
cap3    Gallant Fowlknight [ECL 17] art=20 confident
cap7    miss (nearest 80)

7/8 matched, 6 confident
```

**A/B a change.** `--ladder` runs a different probe ladder over the same
captures and marks every capture whose answer changed with `*`:

```bash
node scripts/scan-replay.mjs bundle.json --ladder 1,1.04,1.08,1.12
```

That is the comparison that turned the ladder inward — the old outward ladder
scores 3 confident on a session the inward one scores 6 on.

**Find the basin.** `--sweep lo:hi` tries one scale at a time and prints the art
distance per capture, which is how you tell "the framing is slightly off" from
"no framing recovers this":

```bash
node scripts/scan-replay.mjs bundle.json --sweep 0.84:1.04
```

**Order ties by the stack.** `--bias` accumulates a set tally exactly as the
client does — only captures whose art matched a single printing contribute —
and passes it back in, so a replay shows what set biasing would have done to a
recorded session:

```bash
node scripts/scan-replay.mjs bundle.json --bias
```

On three ECC precon sessions that took the right printing from 3, 3 and 1 of
nine to 8, 8 and 6.

**Look at the pictures.** `--extract DIR` writes every `rectified` and `frame`
out as JPEGs. Reading the frames is how cards get identified for ground truth,
and how the sleeve run was diagnosed.

### What replay cannot tell you

The bundle's `frame` is downscaled to 720px wide; the phone captured at ~11MP.
So replayed distances differ from the recorded ones by a few bits — close enough
to compare *changes* against each other, not to quote as absolute truth. When a
recorded and a replayed number disagree slightly, the recorded one is the real
measurement.

Both ends now hash at `HASH_HEIGHT`, so the gap is smaller than it was, but it
does mean numbers from a bundle recorded before that change do not line up with
numbers replayed after it. Compare within one run, not across the change.

---

## 4. Ground truth

The bundle says what the matcher *thought*. To know whether it was right:

1. `--extract` the frames and read the card name off the photograph.
2. Fetch that printing's reference from Scryfall and hash it, to compare against
   directly:

```js
const res = await fetch('https://api.scryfall.com/cards/ecl/260',
  { headers: { 'User-Agent': 'deck-lotus-diag/1.0' } });
```

Scryfall asks for a real User-Agent and 50-100ms between requests. Their image
for a printing is exactly what `scripts/build-card-hashes.mjs` hashed, so
`hashRectified` on it gives the same reference the index holds.

A useful shortcut: on a miss, `signals.nearest.printingId` is often the correct
card sitting just over the threshold. Looking those up is how "the ranking is
perfect, the threshold is what fails" was established — every miss in one
session had the right card as its nearest.

### Checking a threshold change is safe

Before widening `ART_MATCH_THRESHOLD`, measure how crowded the band is. For a
sample of references, find the distance to the nearest reference that is a
*different card* — `readPackedHashes()` and `hammingWords()` do this over the
whole file in a few seconds. The distribution is strongly bimodal: about 1.5% of
cards sit within 27 bits of a different card (genuine art sharing — Alchemy
rebalances, the two faces of a transforming card), and the bulk does not start
until 80. Everything between is nearly empty, which is why 56 to 69 was cheap,
and 69 to 77 after it.

Re-measured for that second step over 401 references against all 112,815: 1.2%
within 39 bits, 0.5% in 60-69, 1.0% in 70-79, then 27.7% in 80-89 and the rest
above. Count a different *printing of the same card* as agreement, not as a
collision — sharing art with yourself is not a false positive, and forgetting
that makes the near band look four times as crowded as it is.

---

## 5. Driving the UI in a browser

Offline replay covers the matcher. Anything about the *page* — the overlay, the
shutter, the preflight, the recording buffer — needs the real app.

```
preview_start { name: "test-env" }     # from .claude/launch.json, port 3100
```

Log in as `Valoxi` / `test` (any fixture account, password `test`).

**Stub the camera with a recorded frame.** This is the trick that makes UI
testing repeatable — a canvas redrawn every frame is a perfectly motionless
camera pointed at a real card:

```js
const img = new Image();
await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('img')); img.src = '/still-card.jpg'; });
const c = document.createElement('canvas');
c.width = img.naturalWidth; c.height = img.naturalHeight;
const cx = c.getContext('2d');
(function draw(){ cx.drawImage(img, 0, 0); requestAnimationFrame(draw); })();
const stream = c.captureStream(15);
navigator.mediaDevices.getUserMedia = async () => stream;
navigator.mediaDevices.enumerateDevices = async () =>
  ([{ kind: 'videoinput', deviceId: 'fake', label: 'Fake camera' }]);
```

Serve the image by copying a frame into `client/dist/`. Add per-frame noise to
the canvas to measure detector jitter — that is how "corner spread drops 1.87x"
was measured, by comparing the overlay's raw per-frame quad against the quad
captures were actually cut from.

**Patch `fetch` to force an outcome.** Injecting a price, or emptying
`results[].candidates` to make one capture miss, is how the recording buffer's
"keep the failure" behaviour was tested without waiting for a real miss. Note
the resolve response is `{ results: [ ... ] }`, not a bare candidate list.

**Test the phone layout.** `resize_window { preset: "mobile" }`. Several bugs
only exist there — see the pitfalls below.

---

### Weighing a change to the hash itself

`scripts/hash-variants.mjs` measures a proposed change to `cardHash.js` before
anyone makes one. It composes the *real* steps — `downsampleToGrid`, `dct2d`,
`signBlock` are exported for it — with one filter inserted between the grid and
the DCT, so a variant is the pipeline with one thing changed rather than a copy
that can drift.

```bash
node scripts/scan-replay.mjs bundle.json --extract out/shots_session1   # per session
node scripts/hash-variants.mjs out out/refs --per-card
```

`refs` holds one Scryfall image per card named `0_Card_Name.jpg`, numbered in
capture order — the deck's order, not alphabetical. Pairing them by name instead
reports a flat 0 matched, which is at least a loud way to be wrong.

It answers three questions together, and a variant has to pass all three: does
it match more captures to the card that was on the table, does it bring
*different* cards closer, and what does it do to the cards it was not aimed at.
A variant that wins the first and loses the second is a looser threshold wearing
a disguise.

**What it has measured so far.** Re-run over **126 captures from fourteen
sessions** — the ECC nine, same stack, same order, sleeved and bare:

     variant                        matched  strong    mean   nearest wrong
     baseline                        93/126      15    62.7             116
     high-pass r1                    93/126      18    62.9             112
     high-pass r2                    97/126      19    62.0             114
     high-pass r4                    95/126      20    61.8             116
     local-norm r2                   95/126      11    65.5             114
     local-norm r4                  100/126      12    63.3             114
     glare-cut 250                   93/126      15    62.8             116
     glare-cut 240                   93/126      14    62.9             116
     glare-cut 230                   93/126      15    63.0             116
     glare-cut 240 + high-pass r2    94/126      19    62.7             114

(The earlier ten-session run read 51/72 baseline, 56/72 for high-pass r2 — the
same ordering, on a smaller corpus.)

A high-pass of radius 2 — the grid minus a blurred copy of itself — matches five
more captures, strong-matches three more, and leaves discrimination untouched
(the nearest wrong card moves 2 bits of 256, and stays 37 bits clear of the
threshold). Per card, it gains Cultivate 3/8 to 5/8, Abundant Growth and Ingot
Chewer one each, one of the two foils one, and **regresses nothing**.

It is not, however, the foil rescue it was proposed as. Foils remain the worst
cards in the sample either way. On the wider corpus `local-norm r4` now scores
higher still — 100/126 — but strong-matches fewer than half what the high-pass
does (12 against 19), and a match that never reaches `confident` is a row
somebody still has to look at.

**Glare-aware hashing was measured here and declined.** Excluding near-saturated
pixels from each cell's average — task 9 of the pipeline plan — matches
**93/126, exactly the baseline**, at every cut tried, and drifts the mean
slightly the wrong way. Per card it is identical to baseline on eight of the
nine and half a bit worse on the ninth; it does nothing for the two foils it was
aimed at. Combined with the high-pass it *undoes* part of it, 97/126 down to
94/126.

The reason is the glare gate, and it is worth stating because it retires the
idea rather than deferring it: **the shutter refuses to fire while glare is over
threshold**, so a capture with blown pixels never gets taken. Measured over
every recorded session, the glare metric maxes at 1.13% of pixels and is 0.00%
in most of them. There is nothing for this filter to exclude. Shipping it would
cost a rebuild of all 112,815 references — three hours of Scryfall downloads —
and a hash version bump, for a number that does not move.

`downsampleToGrid` keeps the `glareCut` option, off by default and
byte-identical when off (pinned by a test in `test/cardHash.test.js`), so the
measurement stays reproducible against the real pipeline.

**The cost is the reason it has not shipped.** Changing this arithmetic
invalidates all 112,815 references at once, and only the *hashes* are cached —
`data/card-hashes.raw.jsonl` holds no images. So a rebuild re-downloads every
Scryfall image at the 50-100ms spacing they ask for: three hours or so of
network, and a hash version bump so a new capture can never be compared against
an old reference. That is a deliberate operation, not something to slip into a
session. The measurement is here so the decision can be made on numbers.

### Where the framing ladder sits now

Capture-time framing moved the basin up: winning probes went from 0.84-0.90 in
the stale-framing sessions to 0.92-1.00 after it, and the two lowest rungs stop
winning at all. That looks like an argument for re-centring `FRAMING_PROBES`,
and it was measured rather than acted on:

     ladder                     matches (5 bundles)   mean art distance
     0.84 0.88 0.92 0.96 1.00       39/45              48.3 / 55.4
     0.90 0.93 0.96 0.98 1.00       39/45              47.7 / 53.7
     0.90 0.94 0.96 0.98 1.00       39/45              48.0 / 53.1
     0.92 0.95 0.97 0.99 1.00       39/45              48.6 / 52.6

Identical match counts, distances differing by one to three bits with no
consistent winner between the two post-fix bundles. So the ladder was left
alone: there is nothing here to fit except noise. Worth re-checking once a few
more sessions have been recorded on capture-time framing, and the thing to look
for is whether the 0.84 and 0.88 rungs ever win again — if they never do, three
rungs would buy back two warps and two index passes per capture.

### Is compositing earning its lag?

Every capture carries `artHash` (the composite) and `singleArtHash` (the first
frame alone). Hash both against the winning candidate's reference and compare —
the composite should sit at or below the single frame, and the size of the gap
is what says whether `CAPTURE_BURST` should be 3, 5, or 1.

Do it over a whole session rather than a capture or two: the burst is fighting
noise, and a single capture's difference is itself noise.

This has been done once and the answer was no. Composite against single, over
nine captures: 54/52, 76/74, 82/82, 88/86, 84/86, 98/102, 84/82, 108/108,
106/104 — worse or equal on seven. Tremor moves the card and not only the
glare, so a 66ms burst composites misaligned frames; and the median cost 402ms
per capture at 12MP. `CAPTURE_BURST` is 1. Worth redoing only for a fixed
camera, where the frames would actually align.

### The pulse, without a camera

`client/lab/pulse-lab.html` fires the same `pulseOverlay` call the scanner makes
when an answer lands, one button per band, against a static outline and a
stand-in name panel — both halves pulse, and both are worth checking. Dev server
only, like the contour lab. Use it for the colours and the restart behaviour;
what it cannot show is the thing that matters most — whether the cue reads from
the corner of the eye while somebody is looking at the cards rather than the
screen.

### Measuring the detector without a session

`client/lab/contour-lab.html` draws a card at known corners and reports how far
`detectCardContour`'s quad sits outside them, per attempt. It is served by the
vite dev server only (`npm run client:dev`, then `/lab/contour-lab.html`) and is
not copied into `client/dist`.

It answers one narrow question — does an attempt sit N pixels off the border it
found, and does a change move N — on data far cleaner than reality. That is the
same synthetic-fixture trap that flattered the detector this one replaced, so
never tune thresholds or the framing ladder from it. Those need a bundle and
`--sweep`.

What it has settled so far:

- The `edges` attempt used to dilate without eroding and overshot by a constant
  +1.19% of card width; a morphological close brings it to -0.40%, the same
  floor the Otsu attempts sit at.
- ROI tracking does not move the answer. Sixty frames of feeding each quad back
  in as the next frame's hint moved it at most 1px in total and never lost the
  card; one tracked frame agrees with a cold sweep to within 1px, at 1.3-2.3ms
  against 3.7-8.1ms. A hint aimed at the wrong corner, or one whose window cuts
  the card, both return the cold answer exactly.
- **An adaptive-threshold attempt was measured here and declined** (task 10).
  The **Glare stripe** button draws the case it was proposed for. Adaptive alone,
  swept over block sizes 21-81, constants 2-10 and both polarities — 168
  combinations, 51 of which found anything at all:

      scene                                 shipped   adaptive, best params
      dark card, pale desk                   -0.40%   -0.40%
      pale card, dark mat                    -0.40%   +3.57%
      card and desk alike                   -37.40%   +1.59%
      card barely darker than desk          -37.40%   -0.40%
      dark card, glare stripe               -37.40%   not found, any parameters
      card like desk, glare stripe           -0.40%   +1.59%
      pale card on dark mat, glare stripe    -0.40%   +3.57%

  It fails the glare case it was for, is worse than Otsu where Otsu works, and
  cannot be added as a fourth attempt anyway: attempts are scored by area, so a
  looser threshold wins by being looser — at its default parameters it took
  scenes Otsu had right and framed them 9.51% too large. It also took the frame
  from 3.8ms to 12.6ms. The header of `cardContour.js` now records this instead
  of promising the attempt.
- **The detector frames the art box on a low-contrast card**, which is what
  those glare scenes actually caught. Where the card and the desk are close in
  brightness, the quad comes back **37.4% smaller than the card** — the art
  window's contour, with an aspect error of 0.060, inside the 0.16 tolerance,
  and the tracked path then locks onto it. It is a confident wrong answer rather
  than a miss, and a capture framed at 0.63 is off the bottom of a ladder that
  spans 0.84-1.0.

  **It does not happen in the recorded sessions, and that check is worth
  repeating rather than re-deriving.** Over fifteen sessions and 143 captures,
  the 28 misses are framed exactly like the 115 hits — median detected area
  0.261 against 0.282, and the same figure per card (Ashling 0.253 missed
  against 0.249 hit). An art-box quad would come in near 0.11. Three misses
  extracted and looked at are whole cards. And 137 of the 143 detections came
  via `otsu-inverted` — a dark card on a pale desk, where the global threshold
  is at its best — so the lab's trigger, card and desk close in brightness,
  never arises. The way to catch it if it ever does: a `via` of `edges` on
  captures that miss, and a detected area around a third of the usual.

The **Cold vs tracked** button measures that last point, and is worth re-running
after any change to the attempts or the contour filters.

---

## 6. Pitfalls that have each cost a session

- **The Browser pane blocks camera access.** Stubbing `getUserMedia` does not
  get around it — the app has been handed a real device or a rejection before a
  stub can land, and the rAF loop stalls while the pane is hidden. The live loop
  is verified on a real device; everything under it — detection, hashing,
  resolution — is verified in the lab page and by replay, which is part of why
  those exist.
- **The dev server does not reload.** `npm run test:env` is plain `node`, not
  nodemon. After editing anything under `src/`, stop and restart the preview or
  you are testing the old server. A server-side change that "did not work" is
  this until proven otherwise.
- **`npm run client:build` empties `client/dist`.** Any test image staged there
  disappears, and the next `new Image()` rejects with an `Event` that serialises
  as `javascript_tool failed: Event`. Re-copy after every build.
- **The desktop layout hides mobile bugs.** `.scan-page-scanning` gives the
  stage a fixed height and `object-fit: cover` on the video, which crops it. The
  overlay was drawn in stage coordinates while quads are in frame coordinates,
  so outlines landed on the card's art box — and looked perfect on a desktop,
  where the video fills the stage exactly.
- **`vector-effect: non-scaling-stroke` means screen pixels.** A `stroke-width`
  of 0.4 in a 0-100 viewBox is not 0.4% of the video, it is under half a
  physical pixel. Every overlay outline was invisible for this reason.
- **A test can pass for the wrong reason.** The fixture's two Bolt printings
  share an illustration, so anything measured against them lands in
  `pick-printing` whatever the thresholds say. Always check a new test fails
  when the fix is reverted — two tests here did not, and were rewritten.
- **Compare one variable at a time.** The sleeve session changed sleeves *and*
  the card set at once, so its 3/11 cannot be attributed to either. There is no
  offline fix for a confounded experiment.
- **`scripts/` ships in the container; `client/src` does not.** A script that
  imports from the client tree runs fine locally and breaks the image.
  `test/serverImports.test.js` catches it — it caught the replay harness — and
  the fix is to move the shared part to `src/shared/`, never to silence it.

---

## 7. The pieces, and where they live

| what | where |
| --- | --- |
| hashing, shared by browser, server and the hash builder | `src/shared/cardHash.js` |
| the packed reference file and its readers | `data/card-hashes.bin`, `src/services/cardHashFile.js` |
| the in-memory index and its thresholds | `src/services/cardHashIndex.js` |
| candidate resolution and the two-signal fusion | `src/services/scanService.js` |
| card proportions, square-to-quad map, rectified size | `src/shared/cardGeometry.js` |
| the capture warp and crops (re-exports the geometry) | `client/src/utils/cardCapture.js` |
| card detection | `client/src/utils/cardContour.js` |
| the scan page, probe ladder, capture loop | `client/src/components/scan.js` |
| detection's worker, and the client the page talks to | `client/src/workers/cardDetect.worker.js`, `client/src/utils/cardDetector.js` |
| the recorder | `client/src/utils/scanDiagnostics.js` |
| offline replay | `scripts/scan-replay.mjs` |
| tier and fusion tests | `test/integration/scanFusion.test.js` |

Constants worth knowing before changing anything:

- `ART_MATCH_THRESHOLD = 0.3` — 77 of 256 bits. What counts as the same art.
  Widened from 0.27 once sleeves were measured: they cost ~20 bits and put true
  matches at 70-76. The band 70-79 holds ~1% of references' nearest-different-
  card distance and the population starts at 80, so 0.32 would not be safe.
- `ART_STRONG_THRESHOLD = 0.16` — 41 bits. What may reach `confident` and skip
  review. Deliberately *not* widened alongside the match threshold: that is what
  makes widening the match threshold cheap.
- `FRAMING_PROBES = [0.92, 0.94, 0.96, 0.98, 1]` — the framings offered per
  capture. Inward, and measured that way.
- `RECORD_LIMIT = 24` — captures held, failures preferred.
- `ANALYSIS_INTERVAL_MS = 50` — the loop analyses 20 frames a second, and every
  frame-counted gate is that much shorter in wall time.
- `STABILITY_WINDOW_MS = 100` — but stillness is compared over this fixed span
  whatever the analysis rate, because `difference` carries movement (which
  grows with the gap) and noise (which does not). Change the rate and the
  thresholds still mean what they were measured to mean; change this and none
  of them do.
- `CAPTURE_BURST = 1` — frames median-composited into one capture. Was 3 until a
  session measured the composite as worse or equal on seven of nine captures, at
  402ms apiece.
- `HASH_HEIGHT = 680` — the rectified height a capture is hashed at, matching
  the `normal` Scryfall image every reference was built from. Captures used to
  be hashed at whatever the camera gave, which cost 10-12 bits of grid
  quantisation for nothing. OCR crops are still cut at the camera's resolution.

---

## 8. What the evidence currently says

So the next session does not re-derive it:

- **The hash's ranking is reliable; the threshold is the binding constraint.**
  Across sessions the top match has been the correct card essentially every
  time, and misses are the right card sitting 60-90 bits out.
- **Light matters more than code.** Springleaf Drum was unmatchable at 84-92 for
  five sessions and matched at 24, confidently, once a torch was on. Which card
  fails moves with the lighting.
- **Corner accuracy is not the bottleneck.** Replacing `approxPolyDP`'s vertices
  with corners from fitted card edges was built and measured: it cut corner
  jitter under sensor noise three- to eightfold, and moved the sum of art
  distances by *nothing* — 396 either way over seven captures, three cards
  better and three worse. Modelling the edges as curves rather than lines did
  not help either, which rules out the lens bow (real, up to 1.5% of card width)
  as the limit. The spike was deleted rather than merged. Before rebuilding it,
  reproduce that measurement: `--sweep` on a session where captures already
  match, and check whether corner precision is what is actually costing bits.
- **OCR does not currently earn its cost.** Warm reads measured 7-28 seconds on
  the phone and produced noise on both cards they touched, while the hash was at
  7/7 unaided. It can no longer do damage — a misread cannot outrank a printing
  the art found — but it is off by default for a reason.
- **Sleeves move the basin, and that was most of the sleeve problem.** Two
  sessions of the same nine sleeved cards in the same order — one at a desk, one
  in better kitchen light — put the per-capture framing optimum between 0.84 and
  1.00, with a cluster wanting 0.86-0.90 that the old ladder could not reach.
  Detection finds the *sleeve's* outline, so the correction a sleeved card needs
  is larger than a bare one's. Respreading the same five probes to
  `[0.84, 0.88, 0.92, 0.96, 1]` took those sessions from 4/9 and 4/9 to 8/9 and
  7/9 at identical cost. The earlier unexplained 3/11 sleeved run is very likely
  the same thing.
- **The reader can rescue a foil, and could also overwrite a good answer.**
  With OCR on, one session read `Ashling, the Limitless / ECC / 0001` off a foil
  the art had missed at 88 bits — the rescue the reader exists for. In the same
  session it also replaced a correctly identified Jungle Shrine with "Lava Axe",
  a Smokebraider with "Tributary Instructor", and a Seaside Citadel with
  "Plains". The cause was not the reader: refinement re-asked the matcher with
  the *unexpanded* art hash instead of the framing ladder, so at scale 1.0 the
  art matched nothing on a sleeved card and an unopposed misread stood alone.
  Refinement now sends the same probes as the first pass. A reading is a second
  signal, and it is only ever safe next to the first one.
- **Where the time between shutter and verdict goes**, measured on a phone:
  `shutterMs` 745-1215, `hashMs` 142-241, `resolveMs` 450-921 — about 1.8s in
  total. Overlapping the frame read with the detection round trip took the
  shutter half to 579ms mean on the next run.
- **`resolveMs` is the network, not the matcher.** The same nine captures
  resolved locally, index and all, in a **mean of 9.5ms** (max 17.5; dropping
  `limit` from 25 to 3 saves under 2ms). The phone measures 700-900ms for the
  same work. So ~730ms is the link — WiFi round trip and radio wake between
  captures five seconds apart — and no amount of server work will touch it.
  Anything aimed at `resolveMs` should be aimed at the connection: keeping it
  warm, or overlapping the request with work the client has to do anyway.
- **The matcher now runs on the device, so `resolveMs` means two things.**
  `timings.resolvedBy` says which answered — `device` or `server` — and a bundle
  recorded before that field existed is a server one. The scanner downloads the
  6MB index and the 5.6MB identity table in the background after the detector is
  up, so a cold session's first captures can still be server-matched; comparing
  `resolveMs` across a session without reading `resolvedBy` averages the two.

  Measured on the first real session after it shipped — thirteen captures, an
  ECC precon, all thirteen answered on the device:

      shutterMs   447   (was 579)
      hashMs      156   (was 197)
      resolveMs    32   (was 626-741)
      total       635   (was ~1520)

  `resolveMs` splits by outcome: **27ms on the ten hits, 50ms on the three
  misses.** A miss pays a second full index pass for `nearest`, about 23ms, and
  that is what buys the difference between "reframe it" and "that was not a
  card". The 32ms sits above the 12ms the bench measured because the bench timed
  the search alone on a warm loop; this is the search plus hydration plus fusion.
  Nothing in that session refined by text, so the server fallback is still
  unexercised in the field — a session with the reader on is what would cover it.
- **Set biasing carried every printing in that session.** `setBias: {ECC: 100}`
  typed in by hand; **10 of 10 matched captures came back as the ECC printing**,
  eight of them with `setBiased: true` — ties broken across as many as 31
  printings of the right card. `nameCertain` was true on all ten, so the name
  was never the open question, only the printing.
- **A miss is not a framing problem.** The obvious suspicion about a card that
  will not match is that it was cut wrong, and the bundles say otherwise:
  detected area is the same for hits and misses, per card and in aggregate, and
  extracted misses are whole cards. Every card in the ECC precon these sessions
  are shot from is foil, and what changes between a capture that matches and one
  that does not is where the light is — which is task 15's territory, not the
  detector's. Rule framing out first with `snap.area`; it is two lines and it
  saves chasing the wrong half of the pipeline.
- **The sleeved band is still the whole of the loss.** The three misses sat at
  82, 86 and 88 bits against the 77-bit threshold, and the winning probe was
  never rung 0 — index 1 to 4 across the session, so the respread ladder is
  still earning its rungs. Neither number moved with the on-device work, and
  neither was expected to: task 9 and task 15 in the pipeline plan are what
  address them.
- **Detection answers about 3.6 times a second on a phone.** Measured:
  `detector: { mean: 281.5, max: 865.2, rate: 3.6, worker: true }`. The loop asks
  twenty times a second and drops what it cannot keep up with, so the live quad
  is 180-460ms old — and the shutter fires *because* the card has been still for
  four frames, which means a stale quad can predate the stillness that triggered
  the capture. Captures are therefore framed by detecting on the captured frame
  itself and waiting for it, once per card; `snap.quadSource` says whether that
  worked. Whether the 281ms is transport or OpenCV on the device is still open.
- **Set biasing recovers most of the printings the art cannot choose.** A tally
  of the sets a session has already been *sure* about — captures where the art
  matched exactly one printing — orders the ties. Replayed over three ECC precon
  sessions it took the correct printing from 3, 3 and 1 of nine to 8, 8 and 6.
  It only ever reorders printings of the card that already won, only within
  `PRINTING_TIE_BITS`, and never changes a tier. `signals.setBiased` says when
  it was applied.

  The tally's weak point is its seed, and both ways it can fail have now been
  seen in one session each. It gets no seed at all when the cards unique to the
  set miss — a precon's unique cards are usually its foil commanders, which are
  the hardest cards in the box to match. And it seeds itself *wrongly* if the
  bar is only "one printing matched": one capture matching a single printing at
  54 bits of a 77-bit budget put INR into the tally, and seven later cards were
  ordered toward a set that was never on the table.

  So the bar is `confident` — a strong art match *and* a single printing — and
  the **Scanning set** field supplies the seed by hand at a weight above
  anything inferred. `environment.setBias` records what was in force, because a
  bundle showing the bias firing could not otherwise distinguish "they typed it"
  from "it seeded itself wrongly".
- **A foil's frame hash looks close and means nothing.** The two foil commanders
  sat 22 and 26 bits from their references on the frame hash while the art hash
  was 84, which reads like a usable fallback. It is not: ranked by frame hash
  alone the correct card came 20,516th and 5,919th of 112,815, with 22,901 and
  8,276 cards at or nearer. The frame hash is 64 bits of whole-card layout and
  thousands of cards share it. Absolute distance says nothing without the
  crowding beside it.
- **The art names the card, not the printing, and that is not a ranking bug.**
  Nine cards from one ECC precon, unsleeved: Seaside Citadel came back tied at
  50 across MKC, BLC, ECC and PLST; Ingot Chewer at 64 across CM2, ECC and JVC;
  Abundant Growth resolved `confident` to DMC while ECC — the card on the table
  — sat outside the top four, and re-hashing the same photograph at another rung
  of the framing ladder reordered them again. Reprints share an illustration, so
  the few bits between them are resampling noise. `resolveScanFused` now counts
  printings of the winning card (`signals.printingsOfBest`) and refuses
  `confident` where there is more than one; the same session goes from calling
  one of them certain to offering the choice. Anything further — biasing toward
  the sets a session has already resolved, or letting someone name the set they
  are scanning — is unbuilt.
- **Sleeves cost about 20 bits, and the unsleeved control proved it.**
  Same nine cards, same kitchen light: sleeved gave 0 confident with a best art
  distance of 46, unsleeved gave 2 confident at 26 and 36 and 7/9 matched
  against 4/9. The sleeve is a real, large cost — not framing, and not glare
  (the recorded `glare` was 0.00 on every capture in both runs, flash off).
- **Two of the sleeve's twenty bits were recoverable for free.** Sleeved true
  matches were landing at 70-76 against a 69-bit threshold. Widening it to 77
  (`ART_MATCH_THRESHOLD = 0.3`) recovered five captures across the recorded
  sessions, every one of them the same card the unsleeved run of the same stack
  had identified in that position, and every one landing in `unsure` rather than
  `confident`. The rest of the sleeve's cost is still there.
- **Still unresolved: sleeves cost confidence.** Nothing in either session
  reached `confident` — the best art distance was 46 against a 41-bit strong
  threshold — so a sleeved card is confirmed by hand even when it matches. That
  is the sleeve itself rather than the framing. Now sized, above: about 20 bits.
  What would recover them is unbuilt — glare suppression at capture (a per-pixel
  minimum over the frames the shutter already waits for) is the leading idea.
- **Better light lowers distances but does not change what matches.** Across the
  desk/kitchen pair the matched distances fell (60, 56, 60, 60 to 54, 50, 56,
  46) while both sessions matched 4 of 9 on the old ladder. Light buys bits, not
  hits; the ladder bought hits.
