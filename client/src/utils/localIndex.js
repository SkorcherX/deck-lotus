/**
 * The hash index, held on the device.
 *
 * A spike, not the feature. It exists to answer one question with a number:
 * matching a capture costs a 741ms round trip on a phone against 9.5ms of real
 * work on the server, and the index is 6MB — smaller than half the OpenCV build
 * the same phone already downloads to find a card at all. So: how long does a
 * phone take to search 112k references five times? Under 100ms and the round
 * trip is not worth paying; half a second and it was cheaper than it looked.
 * See docs/ON_DEVICE_MATCHING.md.
 *
 * The answer was twelve milliseconds, so this is no longer a spike: it resolves
 * now. Not by reimplementing the rules — that is the mistake `src/shared/`
 * exists to prevent — but by calling `fuseScanResult`, the same function the
 * server calls, over an identity table that says what each index row is. The
 * search below is still the search the spike measured; `resolve` is the wiring
 * around it.
 */
import { ART_HASH_BYTES, FRAME_HASH_BYTES, hexToWords, hammingWords } from '../../../src/shared/cardHash.js';
// Taken from the shared module rather than repeated as 0.3: the two ends search
// the same index, so a threshold that drifts between them is a disagreement
// about what matched, not a tuning difference.
import { ART_MATCH_THRESHOLD, fuseScanResult, matchConfidence } from '../../../src/shared/scanFusion.js';

const MAGIC = 0x444c4348; // 'DLCH'
const HEADER_BYTES = 16;
const UUID_BYTES = 16;
const ART_WORDS = ART_HASH_BYTES / 4;
const FRAME_WORDS = FRAME_HASH_BYTES / 4;
const WORDS_PER_ROW = ART_WORDS + FRAME_WORDS;
const ROW_BYTES = UUID_BYTES + ART_HASH_BYTES + FRAME_HASH_BYTES;
const ART_BITS = ART_HASH_BYTES * 8;

const state = {
  count: 0,
  /** Every row's hashes, flat, ART_WORDS + FRAME_WORDS per row. */
  words: null,
  /** Every row's uuid bytes, flat, 16 per row. Decoded only for a match. */
  uuids: null,
  bytes: 0,
  loadMs: 0,
};

export function isLoaded() {
  return state.count > 0;
}

export function stats() {
  return { count: state.count, bytes: state.bytes, loadMs: state.loadMs };
}

/**
 * Read the packed file into flat typed arrays.
 *
 * Word-at-a-time rather than hex: the file is already the bytes the search
 * wants, and going through strings would build 112k of them to throw away. The
 * layout is documented in src/services/cardHashFile.js, and the widths are read
 * from the header rather than assumed — a file written before a hash width
 * changed has to be refused rather than read as garbage.
 */
export function parse(buffer) {
  const view = new DataView(buffer);

  if (view.getUint32(0) !== MAGIC) throw new Error('Not a card hash index');
  const version = view.getUint16(4);
  if (version !== 1) throw new Error(`Hash index version ${version} is not supported`);

  const artBytes = view.getUint8(6);
  const frameBytes = view.getUint8(7);
  if (artBytes !== ART_HASH_BYTES || frameBytes !== FRAME_HASH_BYTES) {
    throw new Error(
      `Hash index holds ${artBytes}/${frameBytes} byte hashes, this build reads ${ART_HASH_BYTES}/${FRAME_HASH_BYTES}`
    );
  }

  const count = view.getUint32(8);
  const expected = HEADER_BYTES + count * ROW_BYTES;
  if (buffer.byteLength < expected) {
    throw new Error(`Hash index is truncated: ${buffer.byteLength} bytes, expected ${expected}`);
  }

  const words = new Uint32Array(count * WORDS_PER_ROW);
  const uuids = new Uint8Array(count * UUID_BYTES);

  for (let row = 0; row < count; row++) {
    const at = HEADER_BYTES + row * ROW_BYTES;

    for (let b = 0; b < UUID_BYTES; b++) uuids[row * UUID_BYTES + b] = view.getUint8(at + b);

    const base = row * WORDS_PER_ROW;
    for (let w = 0; w < ART_WORDS; w++) {
      words[base + w] = view.getUint32(at + UUID_BYTES + w * 4);
    }
    for (let w = 0; w < FRAME_WORDS; w++) {
      words[base + ART_WORDS + w] = view.getUint32(at + UUID_BYTES + ART_HASH_BYTES + w * 4);
    }
  }

  state.count = count;
  state.words = words;
  state.uuids = uuids;
  state.bytes = buffer.byteLength;
  return count;
}

/** Fetch and parse the index. Resolves to the row count. */
export async function load(request) {
  const started = performance.now();
  const buffer = await request();
  const count = parse(buffer);
  state.loadMs = Math.round(performance.now() - started);
  return count;
}

/** A row's uuid, in MTGJSON's dashed form. Built only for rows that matched. */
function uuidAt(row) {
  let hex = '';
  for (let b = 0; b < UUID_BYTES; b++) {
    hex += state.uuids[row * UUID_BYTES + b].toString(16).padStart(2, '0');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Every reference within `threshold` of this art hash, nearest first.
 *
 * Deliberately the same shape and the same ordering rule as findByArtHash on
 * the server — art first, frame breaking ties — so the two can be compared
 * capture for capture. They are compared: that is what the spike measures.
 */
export function search(artHash, frameHash = null, { threshold = ART_MATCH_THRESHOLD, limit = 40 } = {}) {
  if (!state.count || !artHash) return [];

  const probe = hexToWords(artHash);
  const frameProbe = frameHash ? hexToWords(frameHash) : null;
  const maxDistance = Math.round(threshold * ART_BITS);

  const matches = [];

  for (let row = 0; row < state.count; row++) {
    const base = row * WORDS_PER_ROW;
    const distance = hammingWords(probe, 0, state.words, base, ART_WORDS);
    if (distance > maxDistance) continue;

    matches.push({
      row,
      artDistance: distance,
      frameDistance: frameProbe
        ? hammingWords(frameProbe, 0, state.words, base + ART_WORDS, FRAME_WORDS)
        : null,
    });
  }

  matches.sort(
    (a, b) =>
      a.artDistance - b.artDistance || (a.frameDistance ?? 0) - (b.frameDistance ?? 0) || a.row - b.row
  );

  return matches.slice(0, limit).map((match) => ({
    // The row, because the identity table is aligned to it — and the uuid,
    // because that is what a match means outside this process and what the
    // bench compares against the server's answer.
    row: match.row,
    uuid: uuidAt(match.row),
    artDistance: match.artDistance,
    frameDistance: match.frameDistance,
  }));
}

/** The best match across a capture's framing probes, as the resolver does it. */
export function searchProbes(probes, options = {}) {
  let best = [];
  let bestIndex = null;

  for (let index = 0; index < probes.length; index++) {
    const found = search(probes[index].artHash, probes[index].frameHash, options);
    if (found.length && (!best.length || found[0].artDistance < best[0].artDistance)) {
      best = found;
      bestIndex = index;
    }
  }

  return { matches: best, probeIndex: bestIndex };
}

/**
 * The identity table: what each index row *is*.
 *
 * Columns in index row order, so `identity.names[row]` belongs to the row a
 * search just returned. The count is checked against the index's own before it
 * is used — the alignment is the whole design and a mismatched pair would name
 * cards by the wrong rows, silently and confidently, which is the worst failure
 * this code could have.
 */
const identity = {
  count: 0,
  printingIds: null,
  cardIds: null,
  names: null,
  sets: null,
  collectors: null,
  promos: null,
  prices: null,
  foilPriced: null,
  bytes: 0,
  loadMs: 0,
};

export function hasIdentity() {
  return identity.count > 0 && identity.count === state.count;
}

/** Whether this device can resolve a capture without asking the server. */
export function isReady() {
  return isLoaded() && hasIdentity();
}

/** Fetch and adopt the identity table. Resolves to the row count. */
export async function loadIdentity(request) {
  const started = performance.now();
  const payload = await request();

  if (payload.count !== state.count) {
    throw new Error(
      `Identity table is ${payload.count} rows and the index is ${state.count} — they are not the same build`
    );
  }

  identity.count = payload.count;
  identity.printingIds = payload.printingIds;
  identity.cardIds = payload.cardIds;
  identity.names = payload.names;
  identity.sets = payload.sets;
  identity.collectors = payload.collectors;
  identity.promos = new Set(payload.promos || []);
  identity.prices = payload.prices;
  // Absent on a version 1 payload; an empty set simply marks nothing.
  identity.foilPriced = new Set(payload.foilPriced || []);
  identity.loadMs = Math.round(performance.now() - started);

  return identity.count;
}

/**
 * One index row as a candidate, in the shape the review screen and the commit
 * already take.
 *
 * `imageUrl` is null on purpose and is not a gap in the answer: the identity
 * table leaves image URLs out because they cost more than everything else in it
 * put together, and the review screen fills them in for a whole session in one
 * request. Everything the scanning loop itself shows — the name, the printing,
 * the price band the overlay pulses in — is here.
 */
function candidateAt(row) {
  const printingId = identity.printingIds[row];
  if (printingId === null || printingId === undefined) return null;

  const price = identity.prices[row];

  return {
    cardId: identity.cardIds[row],
    name: identity.names[row],
    printingId,
    uuid: uuidAt(row),
    setCode: identity.sets[row],
    collectorNumber: identity.collectors[row],
    isPromo: identity.promos.has(row),
    imageUrl: null,
    price: price === null || price === undefined ? null : price / 100,
    priceType:
      price === null || price === undefined ? null : identity.foilPriced.has(row) ? 'foil' : 'normal',
    manaCost: null,
    typeLine: null,
    rarity: null,
    releasedAt: null,
  };
}

/**
 * Resolve a capture here, with the same rules the server would have used.
 *
 * The ranking is `fuseScanResult` from src/shared — the same function, not a
 * copy of it — so a locally matched card gets the same tier, the same
 * `nameCertain`, the same set biasing and the same candidate order as one the
 * server answered. What differs is only what is not in the identity table: no
 * text signal, because the OCR lookup is a database question, and no image URL.
 *
 * Returns the resolver's own shape, so a caller can use it wherever it used the
 * server's reply.
 */
export function resolve({ probes, setBias = null, limit = 25 } = {}) {
  const { matches, probeIndex } = searchProbes(probes);

  const hashMatches = [];
  const hydrated = new Map();

  for (const match of matches) {
    const candidate = candidateAt(match.row);
    // A row the index holds and this database does not. The server skips these
    // by never joining them; here they simply have no identity to offer.
    if (!candidate) continue;

    hashMatches.push({
      printingId: candidate.printingId,
      artDistance: match.artDistance,
      frameDistance: match.frameDistance,
      confidence: matchConfidence(match.artDistance),
    });
    hydrated.set(candidate.printingId, candidate);
  }

  return fuseScanResult({
    // Only paid for on a miss: fuseScanResult returns early with it, and a
    // capture that matched something never looks at it.
    nearest: hashMatches.length ? null : nearestReference(probes),
    // No reader ran, and this path never has one: refining by text goes back to
    // the server, which is where the card table is.
    text: { query: { name: null, setCode: null, collectorNumber: null }, candidates: [] },
    probes,
    probe: probes[probeIndex ?? 0] || { artHash: null, frameHash: null },
    probeIndex,
    hashMatches,
    hydrated,
    setBias,
    cap: limit,
  });
}

/**
 * The nearest reference to a hash, whatever the distance.
 *
 * The server's `nearestArtDistance`, on the device and for the same reason: a
 * capture whose nearest reference sits at 80 bits was framed slightly wrong and
 * is worth another try, one at 130 was not a picture of a card. Reported as a
 * bare "no match" those are indistinguishable, and they need opposite responses
 * from whoever is holding the cards.
 *
 * A second full pass, so it is asked for only once a resolve has already come
 * back empty — which on this device is about twelve milliseconds.
 */
function nearestReference(probes) {
  let best = null;

  for (const probe of probes) {
    if (!probe.artHash) continue;
    const words = hexToWords(probe.artHash);

    for (let row = 0; row < state.count; row++) {
      const distance = hammingWords(words, 0, state.words, row * WORDS_PER_ROW, ART_WORDS);
      if (!best || distance < best.artDistance) best = { row, artDistance: distance };
    }
  }

  if (!best) return null;

  const printingId = identity.printingIds?.[best.row] ?? null;

  return {
    printingId,
    artDistance: best.artDistance,
    bits: ART_BITS,
    // What it would have taken to match, so the number reads without having to
    // look the thresholds up.
    matchWithin: Math.round(ART_MATCH_THRESHOLD * ART_BITS),
  };
}

/** What the device is holding, for the diagnostics bundle and the status line. */
export function identityStats() {
  return { count: identity.count, loadMs: identity.loadMs };
}
