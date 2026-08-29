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
captures[]
  at, trigger         'auto' | 'manual'
  quad                the four corners the capture was cut with, as frame fractions
  snap                { detected, via, area, aspectError, averaged }
  rectifiedSize       the size it was hashed at — fixed, see HASH_HEIGHT
  nativeRectifiedSize what it rectified to at the camera's own resolution
  artHash, frameHash  the unexpanded framing's hashes
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
until 80. Everything between is nearly empty, which is why 56 to 69 was cheap.

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

What it has settled so far: the `edges` attempt used to dilate without eroding
and overshot by a constant +1.19% of card width; a morphological close brings it
to -0.40%, the same floor the Otsu attempts sit at.

---

## 6. Pitfalls that have each cost a session

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
| the recorder | `client/src/utils/scanDiagnostics.js` |
| offline replay | `scripts/scan-replay.mjs` |
| tier and fusion tests | `test/integration/scanFusion.test.js` |

Constants worth knowing before changing anything:

- `ART_MATCH_THRESHOLD = 0.27` — 69 of 256 bits. What counts as the same art.
- `ART_STRONG_THRESHOLD = 0.16` — 41 bits. What may reach `confident` and skip
  review. Deliberately *not* widened alongside the match threshold: that is what
  makes widening the match threshold cheap.
- `FRAMING_PROBES = [0.92, 0.94, 0.96, 0.98, 1]` — the framings offered per
  capture. Inward, and measured that way.
- `RECORD_LIMIT = 24` — captures held, failures preferred.
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
- **Still unresolved: sleeves cost confidence.** Nothing in either session
  reached `confident` — the best art distance was 46 against a 41-bit strong
  threshold — so a sleeved card is confirmed by hand even when it matches. That
  is the sleeve itself rather than the framing. The test that would size it is
  the same cards unsleeved, in the same box and light.
- **Better light lowers distances but does not change what matches.** Across the
  desk/kitchen pair the matched distances fell (60, 56, 60, 60 to 54, 50, 56,
  46) while both sessions matched 4 of 9 on the old ladder. Light buys bits, not
  hits; the ladder bought hits.
