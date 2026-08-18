# Camera Scan Import — Implementation Plan

Scan physical cards with a webcam, read the card name and the printing details
from the card face, resolve them against the local MTGJSON database, and import
the confirmed results into inventory.

Status: **Phases 0-2 complete.**

---

## 1. Feasibility summary

Feasible. Three constraints shape the whole design:

1. **`getUserMedia` requires a secure context.** Over plain HTTP on a LAN
   address, `navigator.mediaDevices` is `undefined` — this is not a permission
   prompt that can be clicked through. Resolved by fronting the app with a
   Cloudflare Tunnel (see Phase 0).
2. **Printed collector details only exist on 2015+ cards.** The Magic 2015 frame
   introduced the bottom-left collector block. Older cards carry no printed set
   code or collector number; the set is indicated only by the set symbol, which
   is artwork and not OCR-readable. MTGJSON assigns collector numbers to old
   cards in our database, so lookups appear to work — but there is nothing on
   the physical card to read.
3. **A laptop camera looks down at the desk, not straight at a held card.**
   Discovered by testing, not planning: holding a card up to a lid-mounted
   camera is awkward, and the natural posture — card flat, lid tilted — shows
   the card as a trapezoid. Perspective correction therefore moved from a
   Phase 5 "maybe" into Phase 2, and framing became a draggable quad.
4. **Foil cannot be reliably detected from a webcam.** It depends on glare
   angle, and glare is also the main thing that breaks OCR. Foil is a checkbox
   in the verification step, never a guess.

### What already exists and will be reused

| Asset | Location | Use |
|---|---|---|
| `findCard(name, setCode, collectorNumber)` | `src/services/importService.js` | Resolution cascade with DFC (`//`) fallbacks |
| Bulk add preview | `client/src/components/inventory.js` | Pattern for the verification table |
| `setOwnedPrintingQuantity(userId, printingId, qty, isFoil)` | `src/services/cardService.js` | Commit path, already foil-aware |
| CSP disabled | `src/server.js` | WASM and blob workers are not blocked |
| `client/public/` → `dist/` → image | `Dockerfile` | Ships OCR assets with no Dockerfile change |

---

## 2. Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Secure context | Cloudflare Tunnel + Cloudflare Access | Real cert, no per-browser flags, no port forwarding. Access policy required — the tunnel makes the app internet-reachable. |
| OCR location | Client-side (`tesseract.js`, WASM) | No new server dependencies, no images over the network, Docker image unchanged, scales per user. |
| Pre-2015 cards | Name-only lookup, user picks the printing | Full collection coverage; older cards cost one extra click. Explicitly *not* auto-picking the cheapest printing, which would silently distort collection value. |
| Scan flow | Continuous queue, verify the batch at the end | Matches how a stack of cards is actually handled. |
| Card detection | Four-corner quad marked by hand, warped to a card rectangle; **not** OpenCV | Revised in Phase 2 after testing on a real laptop. A fixed rectangle assumes the card fills the frame; the comfortable posture is a card flat on the desk with the lid tilted at it, which is a trapezoid. Marking the corners once per session rectifies it exactly, and the card stays put on the desk all session. OpenCV.js remains unnecessary — finding corners is the expensive part, and here the user supplies them. |
| Capture images | Never uploaded; kept client-side as object URLs | Sidesteps the 10mb body limit entirely and keeps card photos off the server. |

### Non-goals for v1

- Automatic foil detection
- Non-English card recognition (`card_foreign_data` exists; a later phase)
- Mobile-optimised capture (the target is a laptop/PC webcam)
- Bulk scanning via a feeder, or video stream without per-card framing

---

## 3. Pipeline design

### Capture

A `<video>` element with a **draggable four-corner quad** at Magic's aspect ratio
(63 × 88mm ≈ 0.716). The corners are placed on the card once; every capture is
warped back to a true card rectangle before anything is cropped, so all crop
regions are fractions of a rectified card and know nothing about camera angle.

Auto-capture fires when all three conditions hold for ~3 consecutive frames,
evaluated on a small rectified canvas:

- **Stability** — frame-to-frame pixel difference below threshold (not moving)
- **Sharpness** — variance of a Laplacian convolution above threshold (not blurred)
- **Presence** — difference from a marked empty-desk reference (a card is there)

Presence replaced the planned edge-energy test after measurement: on a real
webcam an empty desk scored 18.7 edge energy against a card's 19.7, and the
fixed guide auto-captured an empty room twelve times over. Differenced against a
reference of the same patch of desk, empty reads 2.1 and a card 73.9. Edge
energy survives only as the fallback when no reference has been marked.

A manual shutter button and a still-image upload path are always available as
fallbacks — both for accessibility and for debugging the pipeline without a
camera.

### Region extraction

Two crops taken relative to the guide rectangle, not the full frame:

- **Title band** — top ~8%, left ~70% (excludes the mana cost)
- **Collector block** — bottom-left, ~x 4–30%, y 88–97%; two lines, e.g.
  `0123/281 R` and `DMU • EN`

### Preprocess and OCR

Per region: grayscale → upscale 2–3× → adaptive threshold. Tesseract in
single-line page-segmentation mode with **per-region character whitelists**
(digits and `/` for the collector number, `A-Z0-9` for the set code, full
alphabet for the title). Constraining the charset per region is the single
biggest accuracy lever available.

### Resolve

A new endpoint returning **ranked candidates with confidence**, never a single
answer. Reuses `findCard`'s cascade plus two additions:

- **Set + collector lookup that does not require a name.** The strongest
  available signal, and currently unsupported — every branch of `findCard`
  requires a name.
- **Collector-number normalisation** — `0123` vs `123` vs `123a` vs `★`, and
  splitting `123/281` on the slash.

### Verify and commit

Scanned cards accumulate in a queue. The verification table shows the capture
thumbnail beside the matched card image, with editable name / set / collector,
a printing picker, quantity, and a foil checkbox. Nothing touches inventory
until confirmed.

---

## 4. Phases

Ordered so the headlessly-testable work comes first and the camera is never a
prerequisite for progress.

### Phase 0 — Secure context (infrastructure, no repo change) — done

Stand up `cloudflared` pointing at the app, add a Cloudflare Access policy, keep
the LAN URL for non-camera use.

*Done when:* `navigator.mediaDevices.getUserMedia` is defined at the tunnel
hostname, and the app is not reachable publicly without passing Access.

### Phase 1 — Resolution layer — done

Collector-number normalisation; set+collector lookup without a name; migration
adding a composite index on `(set_code, collector_number)` (only `set_code` is
indexed today); resolve endpoint returning ranked candidates with confidence.

*Done when:* candidates can be fetched with `curl` for modern, old, DFC and
promo cards, with sensible ranking and no camera involved.

Delivered as `src/services/scanService.js` (normalisation, the nameless
set+collector lookup, fuzzy name recovery and confidence ranking),
`src/routes/scan.js` (`GET /api/scan/resolve` for one reading,
`POST /api/scan/resolve` for a batch) and migration
`022-add-set-collector-index`.

### Phase 2 — Capture UI — done

Video preview, guide overlay, auto-capture heuristics, manual shutter, still
upload fallback. Emits the two crops and renders them on-screen for tuning.

*Done when:* a card held in frame reliably auto-captures, and the two crops land
on the right regions across several sets.

Delivered as a Scan page: `client/src/utils/cardCapture.js` (guide geometry,
region crops, the three frame metrics and the auto-capture state machine) and
`client/src/components/scan.js` (camera, live metric readout, manual shutter,
still-image fallback, capture strip). Captures are dispatched as a
`scan:capture` event carrying the card crop and the two region crops; Phase 3
listens for it.

The metrics and the crop regions are exposed in a Tuning panel and persisted in
`localStorage`; the quad is persisted separately, since it describes the user's
desk rather than our tuning, and survives a settings-version bump that discards
stale threshold values.

Verified against a real laptop webcam and real cards: the quad rectified a
keystoned card to 401×560, the title band read "Sky Theater Strix" and the
collector block "067/264 C / WAR • EN" legibly by eye, and swapping three cards
produced exactly three captures with none fired mid-placement. Defaults are now
measured rather than guessed (stillness 2.0, focus 250, presence 12, 3 frames).

Known limitation, deferred to Phase 5: the quad is fixed, so a card laid down a
few millimetres off the last one drifts the crops. Both regions carry margin to
absorb it — the title band the most, being furthest from the anchored corners —
but automatic per-frame card detection is the real fix.

### Phase 3 — OCR

`tesseract.js` bundled locally in `client/public/` (never a CDN — the app is
offline/self-hosted), worker setup, preprocessing, per-region whitelists, and
parsing to `{name, setCode, collectorNumber}` with per-field confidence.

*Done when:* a representative tray of modern cards yields correct set code and
collector number at a measured hit rate, with confidence tracked per field.

### Phase 4 — Queue, verification, commit

Scan queue with thumbnails, verification table, editable fields, printing picker
for name-only matches, quantity, foil checkbox, and batch commit through
`setOwnedPrintingQuantity`.

The printing picker pages its results. Phase 1's resolve endpoint caps
candidates at 20, which is fine for a ranked shortlist but not for a name-only
match on a card with dozens of printings — the picker needs all of them.

*Done when:* a stack of mixed cards can be scanned continuously, corrected in
one pass, and committed with inventory totals matching.

### Phase 5 — Accuracy hardening (optional, driven by real hit rates)

Perspective correction is already done (Phase 2). Remaining candidates:
automatic per-frame quad detection so cards need not be placed consistently;
remembering
user corrections; non-English support via `card_foreign_data`; per-set quirk
handling.

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Glare on sleeves and foils destroys OCR | Guide advises angle; manual re-capture; correction in verification |
| Printed set code ≠ MTGJSON set code (promos, Universes Beyond, prerelease) | Resolve returns candidates, not certainties |
| Tesseract assets (~2–4MB WASM plus ~10–15MB language data) | Bundled locally, cached after first load |
| Client CPU too slow for OCR | Crops are small; measure in Phase 3 before committing to client-side |
| Old cards dominate the collection | Phase 1 makes the name-only path good before the camera exists |
| Tunnel outage removes camera access | LAN URL keeps every other feature working |

---

## 6. Open questions

- Acceptable per-card scan time, end to end?
- Minimum hit rate on modern cards before this replaces manual entry?
- Should a scan session be able to default to foil (for scanning a foil binder),
  rather than ticking each card?
