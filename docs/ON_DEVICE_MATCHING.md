# Matching on the device

A design note, not a plan of record. It exists because a measurement changed the
question: the scanner's largest remaining cost is a network round trip, and the
obvious response — "write a phone app" — is aimed at the wrong half of it.

## What the measurement says

Per capture, on a phone over WiFi to a self-hosted server:

    shutterMs   579   frame read + card detection, now overlapped
    hashMs      197   rectify and hash the card and its five framing probes
    resolveMs   741   ask the server which card it is
    ------------------------------------------------------------------
    total     ~1520

The same nine captures, resolved on the machine hosting the server — full index
search, fusion, hydration, all of it — take a **mean of 9.5ms**, max 17.5.
Dropping the candidate limit from 25 to 3 saves under 2ms.

So `resolveMs` is not the matcher. It is ~730ms of link: WiFi round trip plus a
phone radio waking up between captures five seconds apart. Nothing done to the
server touches it, and nothing done to the index touches it.

## Why a native app is the wrong lever

A native app would not make matching faster than matching already is. It would
remove the round trip only because a native app would naturally hold the index
locally — and holding the index locally is a thing the *web* app can do, at a
size that is already being paid:

| what | size |
| --- | --- |
| `data/card-hashes.bin`, all 112,815 references | 6.0 MB |
| identity table: name, set, collector for each | 2.7 MB raw, 0.8 MB gzipped |
| **the whole matcher** | **~7 MB** |
| `opencv.js`, downloaded on first scan today | 12.7 MB |

The device already pulls 12.7MB of OpenCV before it can find a card in a frame.
The thing that says *which* card it is, is half that.

Search cost is not a problem either. The server searches all 112,815 references
five times — once per framing probe — inside those 9.5ms. A phone is slower,
but the honest comparison is tens of milliseconds against 730.

## What a native app would actually buy

Worth separating from the speed argument, because these are real and the speed
argument is not:

- **Camera control.** Exposure and focus locking, and torch behaviour that is
  not at the mercy of a browser's auto-everything. The two cards the scanner
  cannot read are foil commanders whose sheen depends entirely on angle and
  light; a fixed exposure might matter more to them than any hashing change.
- **Background work** without the constraints a page runs under.
- **Not competing with the browser** for memory on a 12MP frame.

None of that is why ManaBox feels fast. Local matching is.

## What moving the matcher would involve

Roughly in order, and the third item is the one with teeth:

1. **Serve the index as static assets with a version.** The weekly MTGJSON sync
   rebuilds `printings`, so a cached index has to be invalidated when it does —
   an etag or a build id the client checks on entering the scanner.
2. **A browser reader for the packed format.** `cardHashFile.js` is Node-only,
   but the format is a fixed header and fixed-width rows; the reading is a dozen
   lines against a `DataView`.
3. **Split resolution from hydration.** `resolveScanFused` currently mixes pure
   ranking — fusion, tiers, `nameCertain`, `printingsOfBest`, set biasing — with
   database lookups that turn printing ids into names and prices. The pure half
   belongs in `src/shared/`, beside `cardHash.js` and `cardGeometry.js`, for the
   same reason those moved: a copy on the client would drift from the server's,
   and the tests that pin the tiers would be pinning only one of them.
4. **Prices and commit stay on the server.** Prices change daily and are not
   part of identifying a card; the commit is one request at the end of a
   session, which is what the whole exercise is for.
5. **Keep the server path.** It is what the review screen, the session resolve
   and every existing test use, and it is the fallback when the index has not
   downloaded yet.

## What it would be worth

Per card: ~1520ms to ~800ms, and the scanner would work with no network at all
until commit time.

Worth being honest about the ceiling, though: a person feeding cards through
this takes about five seconds each, and the last measured session was bottlenecked
on the human, not the machine. Halving the machine's share is a real improvement
to how it feels — it is the difference between a cue that arrives while your hand
is still moving and one that arrives after — but it does not double throughput.
The cue changes (the pulse, the settled tone) were worth more per line of code
than this will be, and this is a substantial piece of work.

## What would settle it

A prototype that loads `card-hashes.bin` in the scan worker and searches it,
timed on the actual phone, against the same nine-card batch. If the search comes
in under 100ms, the case is made; if a mid-range phone takes half a second to
hamming 112k references five times, the round trip was cheaper than it looked.
