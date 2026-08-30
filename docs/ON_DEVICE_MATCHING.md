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
3. **Split resolution from hydration.** **Done.** `resolveScanFused` mixed pure
   ranking — fusion, tiers, `nameCertain`, `printingsOfBest`, set biasing — with
   database lookups that turn printing ids into names and prices. The pure half
   is now `src/shared/scanFusion.js`, beside `cardHash.js` and `cardGeometry.js`,
   for the same reason those moved: a copy on the client would drift from the
   server's, and the tests that pin the tiers would be pinning only one of them.
   `resolveScanFused` keeps only the impure work — the text lookup, the probe
   passes over the index, hydrating the printings the art found and the text did
   not — and hands the rest to `fuseScanResult`. Nothing about the answers
   changed; the fusion tests pass untouched, which is the point of moving the
   code rather than reimplementing it. `localIndex.js` now takes its match
   threshold from the shared module instead of repeating `0.3`, and a sweep in
   `test/serverImports.test.js` fails any shared module that imports outside
   `src/shared/` — that is what stops a stray `import db` quietly putting the
   ranking back on the server.
3.5 **What shipped.** `GET /api/scan/identity` serves the identity table —
   printing, card, name, set, collector and price per index row, in index row
   order, 5.6MB of JSON on a content hash etag — and `localIndex.resolve` puts
   it through `fuseScanResult`. `scan.js` fetches both halves in the background
   once the detector is up and matches locally from then on, falling back to the
   server whenever the index is not loaded, has failed to load, or the reader
   wants a capture refined by text. `timings.resolvedBy` records which answered.
   Image URLs are the one thing left out: they nearly triple the payload
   (1.25MB gzipped to 3.54MB) to serve the review screen's thumbnail, so
   `POST /api/scan/printings` hydrates those once per session at review time.
4. **Prices and commit stay on the server.** Prices are the exception the
   identity table makes — the price band is the colour the overlay pulses, so
   it cannot arrive a round trip late, and it is as fresh as the last sync.
   Everything else about a price stays server-side; the commit is one request
   at the end of a session, which is what the whole exercise is for.
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

## The spike, and what it has shown so far

Built: `GET /api/scan/hash-index` serves the packed file with an etag,
`client/src/utils/localIndex.js` reads and searches it in the browser, and
**Diagnostics & tuning → Time local matching** runs this session's own captures
through it on whatever device is holding the phone.

It searches and returns distances and uuids. It deliberately does *not* resolve
— no tiers, no fusion, no set biasing, no names or prices. Those were wound
together with database lookups inside `resolveScanFused`, and reimplementing any
of them here would have produced a second copy of the rules to drift from the
first. Untangling them was the real work, and the spike existed to decide
whether it was worth doing. It is untangled now (step 3 above): the rules are
`src/shared/scanFusion.js`, one copy, and what the client still lacks is the
identity table to hydrate a uuid into a name.

**Agreement with the server, over the shipped index and real captures:** the two
readers return identical match *sets* and identical distances. On 7 of 9 real
captures the order is identical too; on the other 2 it differs only among rows
tied on **both** art and frame distance. The server's last tiebreak is
`printingId`, which `import-mtgjson.js` reassigns every weekly sync; the device's
is file order, which is uuid-sorted and stable. Neither ordering is meaningful
and the set-bias step reorders ties anyway — but if this ships, both ends should
tiebreak on uuid so the two never disagree at all.

**Speed, on a desktop:** 1.2ms for one search of all 112,815 references, so
~6ms for a five-probe ladder against a measured 741ms round trip. That is the
easy half of the answer. The phone is the half that matters and only the button
can tell us.

The button now writes its result into the recording as `environment.localMatching`
— references, bytes, load time, mean and worst match time, and how many answers
agreed with the server. The first session it ran in, the answer existed only in
a status line on a phone and the bundle that came back could not be asked what
it had said.

## What settled it

Measured on the phone, through the button, on that phone's own captures:

    6.0MB / 112,815 refs downloaded and parsed in   1302 ms   (once)
    five-probe match                                  12 ms   mean, 13 ms worst

Against a `resolveMs` of 626-741 ms for the same work over the network. The
matching is roughly **fifty times faster on the phone than asking the server**,
and the whole index costs one 1.3-second download that a cache turns into a 304.

The bar set above was "under 100ms and the case is made". It came in at twelve.

### One misreading, worth recording

The same run reported "agreed with server on 0/1", which looked like the reader
being wrong and was not. The device returns art order; the server's top
candidate has been through fusion, tiers and **set biasing** — and that session
had `ECC` typed in, so the server had deliberately reordered tied printings and
the device had not. Comparing the two top answers scored set biasing as a
disagreement.

The bench now compares what it can honestly compare: whether the device *found*
the printing the server settled on, and whether it measured the same distance to
it. The answer, not the ranking, is what the untangling in step 3 moves — and
until it moves, the device has no opinion about it.
