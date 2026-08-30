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
 * What this deliberately does *not* do is resolve. It returns distances and
 * uuids — no tiers, no fusion, no set biasing, no names or prices. Those live in
 * `resolveScanFused`, wound together with database lookups, and untangling them
 * is the actual work the note describes. Reimplementing any of it here would
 * produce a second copy of the rules to drift from the first, which is the
 * mistake `src/shared/` exists to prevent.
 */
import { ART_HASH_BYTES, FRAME_HASH_BYTES, hexToWords, hammingWords } from '../../../src/shared/cardHash.js';
// Taken from the shared module rather than repeated as 0.3: the two ends search
// the same index, so a threshold that drifts between them is a disagreement
// about what matched, not a tuning difference.
import { ART_MATCH_THRESHOLD } from '../../../src/shared/scanFusion.js';

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
