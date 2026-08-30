# Scan accuracy & notification-speed action plan — 2026-08-29

Source: `scan-diagnostics-2026-08-29T23-42-17-212Z.json` (9-card standard test
batch, same cards/order as all of today's runs), read against Opus 5's
hash-variant measurement (72 captures / 10 sessions).

## What this bundle shows

- **7/9 captures resolved, and every one of them had the correct card name on
  top.** Best art distances 32–72 of 256; in *all seven*, no card with a
  different name was within the match threshold at all. The name was
  unambiguous every time, even when the tier said `unsure`.
- **The two foil commanders missed the threshold by 7 bits** — nearest
  reference at 84 vs `matchWithin` 77. They are not far away; they are just
  outside the fence.
- **Tier vs reality is the notification bottleneck.** Tiers came back
  `unsure` ×4 and `pick-printing` ×3, `confident` ×0 — yet the name was right
  7/7. The tier is a *printing*-level verdict being used to gate a
  *name*-level announcement.
- **The reader was off** (`reader.enabled: false`). Opus's costed cheap
  mitigation for the foils — `readIfUnresolved` — was not actually running in
  this session, so the foil result tells us nothing about whether OCR rescues
  them.
- **The probe ladder wins at scale 0.96 almost every time**: `probeIndex` 3
  (scale 0.96) in 6/7 matches, once each at 0.92 and 1.0. The detector's crop
  runs ~4% small relative to the references, consistently. The ladder always
  runs all 5 scales' hashes before resolving.
- Framing itself is exact (`quadAgeMs: 0`, `quadSource: capture`,
  `otsu-inverted` on every capture, glare ≤ 0.08). Detector round trip:
  mean 236 ms, max 834 ms — matches Opus's open item; affects live tracking
  cadence, not capture accuracy.

## Action plan (ranked)

### 1. Notify on the name, not the tier — biggest speed win, no rebuild
Add a name-level confidence: aggregate candidate distances by card *name*;
if the best name has no different-named card within the threshold (true in
7/7 here), announce the name immediately ("Cultivate ✓ — choosing
printing…") while printing resolution/set-biasing continues in the
background. Today the user waits through an `unsure` tier for an answer that
was already certain. Keep `confident`/`pick-printing` semantics for the
printing step untouched (set-tally seeding must still key off the existing
`confident` tier — see recent commits).

### 2. Turn the reader on for unresolved captures — foil mitigation, zero cost
`readIfUnresolved` exists precisely for the two foil commanders and was
disabled in this bundle. Enable it (at minimum in the default settings for
this device) and re-run the same 9-card batch to measure whether OCR closes
the 2/9 gap before deciding anything bigger.

### 3. Decide the high-pass r2 hash rebuild — accuracy, deliberate op
Opus measured: high-pass radius-2 gives +5 matched, +3 strong of 72, no
discrimination cost. The foils in this bundle sit 7 bits over threshold;
r2's average gain may or may not bridge that (Opus found foils stay worst
either way — do not sell this as the foil fix). Cost: full reference rebuild,
~3 h of Scryfall downloads, hash version bump invalidating all 112,815
references. Do it when a 3-hour window is acceptable; step 2's re-measure
should happen first so the before/after is clean.

### 4. Reorder / short-circuit the probe ladder — capture-time latency
Try scale 0.96 first (or start at the last successful scale, like the set
tally seeds from prior answers), and stop probing once a name-unambiguous
match is found instead of always hashing all 5 scales. Separately worth a
look: the consistent 4% undersize suggests the quad inset or reference crop
margin disagrees slightly — fixing that at the source could tighten every
distance (bests here were 32–72; well-framed captures should sit lower).
Measure with `scripts/hash-variants.mjs` replay before changing anything.

### 5. Instrument capture→verdict latency
The diagnostics record when a capture happened but not how long resolution
took, so "speed up the notification" can't currently be measured. Add
per-capture timing (detect → rectify → hash → resolve → notify) to the
diagnostics format before optimizing further.

### 6. Detection round trip (236 ms mean, 834 ms max) — park it
Known, uncosted, affects live tracking feel only. Revisit after 1–5.

## Standing cautions carried over from Opus
- Frame hash is not a usable discriminator (correct card ranks ~20,000th by
  frame hash alone) — never quote its absolute distance as evidence.
- Any hash-arithmetic change requires the version bump + full rebuild;
  never slip one in with other work.
- Replay measurements must include the scale ladder (`hash-variants.mjs`
  composes the exported `cardHash.js` steps — use it, don't copy the math).


---

## Review — what was verified, changed, and disputed

Checked against all nine recorded sessions rather than the one bundle, then
actioned. Where this disagrees with the plan above, the plan above is left as
written: it was right about the substance every time.

### Verified and strengthened

**Name-level certainty (1) holds far more strongly than one bundle showed.**
Across nine sessions, 61 captures resolved to something, and in *all 61* every
candidate inside the match threshold shared one card name. Not one capture had
two names to choose between.

**The 4% undersize (4) has an explanation: the sleeve.** These are sleeved
cards, and a sleeve adds roughly 2mm to a 63mm card — about 3%. Detection finds
the sleeve's outline because that is the boundary in the picture. It is not a
disagreement between the quad inset and the reference crop, and "fixing it at
the source" would mean detecting the card inside its sleeve, which the contour
detector cannot do. The ladder covering 0.96 is the fix, and it already does.

### Disputed — the notification is not gated on the tier

Proposal 1 is described as the biggest *speed* win, with the name announced
"while printing resolution continues in the background". There is no background
stage: name and printing are decided in the same server call, and
`renderLiveMatch` already paints the name the moment it returns. Nothing waits
on the tier.

What the tier *does* gate is the cue. `signalMatch` played the low 440Hz
"needs review" tone on anything short of `confident`, which on a box of reprints
is every single card — telling somebody to stop when they need not. So the win
is real and it is semantic, not temporal.

**Done:** `signals.nameCertain` on the server, and the client now sounds the
settled tone and marks the status `Cultivate ✓ — (choosing printing)` on it.
Three tests, including the one that matters: two *different* cards within the
threshold must never read as certain. The fixture had no shared-art pair, so
one was added — without it the check passed with `nameCertain` hardcoded true.

### Done as specified

**Timing instrumentation (5).** Every capture now records
`timings: { shutterMs, hashMs, resolveMs }`. The plan is right that "make the
notification faster" was unmeasurable, and it should have been added before any
of the speed work, not after.

### Left alone, with reasons

**The reader (2)** needs no code: the toggle exists and `readIfUnresolved`
already fires on anything short of `confident`. Turning it on by default for
everyone is a 17MB download and seconds per card for a benefit only foils see.
Run the 9-card batch with it on and the numbers decide it.

**The hash rebuild (3)** is unchanged and remains a deliberate operation. Note
the foils sit 7 bits outside on a *nearest* that is almost certainly the right
card — but the crowding measurement puts the bulk of *wrong* cards from 80 bits
up, so widening the threshold to reach them is exactly the trade that band
exists to refuse.

**Ladder short-circuiting (4)** buys less than it appears. The five probes are
hashed on the client and sent in one request; stopping early client-side would
mean sequential round trips, which is slower. Stopping early server-side saves
1.7ms per skipped probe. Reordering alone saves nothing.

**The 236ms detection round trip (6)** — agreed, parked, and it no longer costs
capture accuracy now that captures detect on their own frame.
