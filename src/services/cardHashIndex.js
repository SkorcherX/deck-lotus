/**
 * The in-memory perceptual-hash index.
 *
 * Loads data/card-hashes.bin once at boot and answers "which printings look
 * like this?" for a scanned card. This is the hash half of the two-signal
 * resolver; scanService.js holds the text half and fuses the two.
 *
 * ── Why there is no printing_hashes table ────────────────────────────────────
 * The plan called for one, and building it showed the table would have been
 * dead weight. Nothing ever looks a hash up *by value* — matching is a Hamming
 * scan over every row, because near-matches are the entire point and SQLite
 * cannot index "within 15 bits of this". So the table would have cost 6MB in
 * the database file, a load step, a backup question and a re-join after every
 * weekly sync, to serve no query that is ever made. The packed file is the
 * database; this module is its index.
 *
 * The only thing that does need rebuilding after scripts/import-mtgjson.js runs
 * is the uuid -> printing_id mapping, since that script clears `printings` and
 * the integer ids are reassigned. `reload()` is that rebuild, and it is one
 * query — see the note on syncService in refresh().
 *
 * ── Layout in memory ─────────────────────────────────────────────────────────
 * Hashes live in one flat Uint32Array rather than 112k separate arrays or
 * BigInts. A scan compares its capture against every row, so the inner loop is
 * the whole cost of the feature: a flat array keeps it as integer XOR and
 * popcount with no allocation per row. Measured on real data — 1ms to search
 * 6697 rows, so on the order of 20ms across the full 112815, against an OCR
 * read that takes seconds. Fast enough that no index or bucketing is worth the
 * complexity, which is just as well: near-matches are the point, and there is
 * no index for "within 15 bits of this".
 *
 * Rows whose uuid is not in `printings` are kept in the array but marked with
 * printingId -1 and skipped. Dropping them would mean re-packing the array on
 * every sync; the wasted space is a rounding error and the alternative is a
 * moving target.
 */
import { readFileSync, existsSync } from 'fs';
import db from '../db/connection.js';
import {
  PACKED_PATH,
  HEADER_BYTES,
  ROW_BYTES,
  UUID_BYTES,
  readHeader,
  unpackUuid,
} from './cardHashFile.js';
import {
  ART_HASH_BYTES,
  FRAME_HASH_BYTES,
  hexToWords,
  hammingWords,
} from '../shared/cardHash.js';

const ART_WORDS = ART_HASH_BYTES / 4;
const FRAME_WORDS = FRAME_HASH_BYTES / 4;
const WORDS_PER_ROW = ART_WORDS + FRAME_WORDS;

const ART_BITS = ART_HASH_BYTES * 8;

/**
 * How far a capture's art hash may sit from a reference and still be considered
 * the same illustration, as a fraction of the hash width.
 *
 * Measured against real Scryfall art (see cardHash.js): a same-illustration
 * pair sat at 12.5% and the closest pair of genuinely distinct cards at 39.2%.
 * 22% was placed between those, nearer the tolerant end — the measurement
 * compared two clean scans, while a real capture also carries glare, white
 * balance and a hand-held angle, and the cost of the two errors is not
 * symmetric. A miss puts one card in the review pile, where the user was going
 * to look anyway; a false match that agrees with a bad OCR read is how a wrong
 * card gets marked confident. The fusion in scanService is what keeps that
 * second case from being decided here alone.
 *
 * ── Why 27% and not 22% ─────────────────────────────────────────────────────
 * Two cards in a recorded session sat at 64 bits against a budget of 56, with
 * the nearest *wrong* card at 90 and 92. Both were the right answer, missed by
 * eight bits, with nearly thirty bits of clear air above them — and across four
 * sessions the hash has never once ranked a wrong card first.
 *
 * The move is safe because there is almost nothing in the band to let in.
 * Measured over the reference set itself: for 1505 sampled cards, the distance
 * to the nearest reference that is a *different* card.
 *
 *     0- 27 : 19 cards        ← genuine art sharing under two names
 *    28- 79 : 15 cards        ← nearly empty
 *    80-105 : 1471 cards      ← where distinct cards actually live
 *
 * Raising the bar from 56 to 69 admits three more of 1505, 1.5% to 1.7%. The
 * bulk does not begin until 80, so 69 sits inside the empty band with room on
 * both sides rather than on the edge of the population.
 *
 * The 19 close pairs are not hash failures. They are one illustration printed
 * under two names — Alchemy rebalances against their originals, the two faces
 * of a transforming card, the un-set sticker goblins — and offering both is
 * right, not a false positive.
 *
 * ART_STRONG_THRESHOLD is deliberately unchanged, so nothing newly reaches
 * `confident`: a match admitted by this widening still lands in review, which
 * is the whole reason widening it is cheap.
 *
 * ── Why 30% and not 27% ─────────────────────────────────────────────────────
 * Sleeves. A sleeved card costs roughly twenty bits — measured on the same nine
 * cards shot sleeved and bare in the same light — and it put a run of true
 * matches at 70 to 76, just the wrong side of 69. Five captures across five
 * recorded sessions sat in that strip.
 *
 * The crowding measurement was repeated for the step, sampling 401 references
 * against all 112,815, distance to the nearest reference that is a different
 * card:
 *
 *     0- 39 :  1.2%           ← genuine art sharing, as before
 *    60- 69 :  0.5%
 *    70- 79 :  1.0%           ← what this step admits
 *    80- 89 : 27.7%           ← the population starts here
 *    90-    : 69.6%
 *
 * So 77 bits still sits below the bulk, and 82 would not — which is why the
 * step stops here despite 0.32 scoring two matches better on these bundles.
 *
 * What the five recovered captures actually were is the part worth trusting:
 * replayed across the sleeved sessions they came back as Fertile Ground, Ingot
 * Chewer and Jungle Shrine — in each case the same card the *unsleeved* run of
 * the same stack had identified in that position. Not one of them was a card
 * that could not have been on the table. Every one landed in `unsure`, since
 * the strong threshold has not moved.
 *
 *     bundle              at 0.27   at 0.30
 *     sleeved desk          4/9       5/9
 *     sleeved kitchen       4/9       6/9
 *     bare kitchen          7/9       7/9
 *     bare, worker build    8/9       8/9
 *     sleeved, latest       6/9       8/9
 */
export const ART_MATCH_THRESHOLD = 0.3;

/**
 * Distance below which the top match is treated as unambiguous. Well inside the
 * same-illustration measurement, so a clean capture short-circuits the rest.
 */
export const ART_STRONG_THRESHOLD = 0.16;

let index = null;

/** Reset, so a test or a reload starts from nothing. */
export function unload() {
  index = null;
}

/**
 * Load the packed file and join it to the current `printings` rows.
 *
 * Never throws on a missing file: the hash signal is an enhancement to a
 * resolver that worked without it, and a deployment that has not got the file
 * yet should degrade to text-only scanning rather than fail to boot.
 */
export function load({ path = PACKED_PATH, quiet = false } = {}) {
  if (!existsSync(path)) {
    if (!quiet) {
      console.log(`⊘ No card hash file at ${path} — scanning will use OCR text only`);
    }
    index = { count: 0, hashes: new Uint32Array(0), printingIds: new Int32Array(0), matched: 0 };
    return index;
  }

  const buffer = readFileSync(path);
  const { count } = readHeader(buffer, path);

  const hashes = new Uint32Array(count * WORDS_PER_ROW);
  const printingIds = new Int32Array(count).fill(-1);
  const uuids = new Array(count);

  for (let row = 0; row < count; row++) {
    const offset = HEADER_BYTES + row * ROW_BYTES;
    uuids[row] = unpackUuid(buffer, offset);

    // Read the raw bytes straight into words rather than going through hex.
    // Both halves are big-endian in the file, matching hexToWords.
    const base = row * WORDS_PER_ROW;
    let byte = offset + UUID_BYTES;

    for (let w = 0; w < ART_WORDS; w++, byte += 4) {
      hashes[base + w] = buffer.readUInt32BE(byte);
    }
    for (let w = 0; w < FRAME_WORDS; w++, byte += 4) {
      hashes[base + ART_WORDS + w] = buffer.readUInt32BE(byte);
    }
  }

  // One query, not 112k. The uuid -> id map is the only part of this that the
  // weekly MTGJSON rebuild invalidates.
  const rows = db.all(`SELECT id, uuid FROM printings`);
  const idByUuid = new Map(rows.map((row) => [row.uuid, row.id]));

  let matched = 0;
  for (let row = 0; row < count; row++) {
    const id = idByUuid.get(uuids[row]);
    if (id !== undefined) {
      printingIds[row] = id;
      matched++;
    }
  }

  index = { count, hashes, printingIds, matched };

  if (!quiet) {
    const orphans = count - matched;
    console.log(
      `✓ Loaded ${count} card hashes from ${path}, ${matched} joined to printings` +
      (orphans ? ` (${orphans} not in this database)` : '')
    );
  }

  return index;
}

/**
 * Re-join to `printings` after the weekly sync.
 *
 * scripts/import-mtgjson.js clears and rebuilds `printings`, reassigning every
 * integer id. The hashes themselves are unaffected — they are keyed on uuid,
 * which is exactly why they are — but every printingId cached here is stale
 * the moment that script finishes. Anything that runs an import must call this
 * or the scanner will resolve to printings that no longer exist.
 */
export function refresh() {
  return load({ quiet: true });
}

function ensureLoaded() {
  if (!index) load({ quiet: true });
  return index;
}

/** Whether the hash signal is available at all. Callers degrade, not fail. */
export function isAvailable() {
  return ensureLoaded().matched > 0;
}

export function stats() {
  const current = ensureLoaded();
  return { count: current.count, joined: current.matched };
}

/**
 * Printings whose art matches this capture, nearest first.
 *
 * The art hash decides membership and the frame hash only orders within it.
 * That split is deliberate and load-bearing: the frame hash measured just 16-18
 * bits apart on genuinely different cards (see cardHash.js), so letting it
 * admit candidates would invent matches. It is discriminating enough to *rank*
 * printings the art has already agreed on, which is the one job it has —
 * separating two printings that share an illustration.
 *
 * @param {string} artHash    Capture's art hash, hex.
 * @param {string} [frameHash] Capture's frame hash, hex. Ordering only.
 * @param {object} [options]
 * @returns {Array<{printingId: number, artDistance: number, frameDistance: number|null, confidence: number}>}
 */
export function findByArtHash(artHash, frameHash = null, options = {}) {
  const { threshold = ART_MATCH_THRESHOLD, limit = 40 } = options;
  const current = ensureLoaded();

  if (!current.count || !artHash) return [];

  const probe = hexToWords(artHash);
  if (probe.length !== ART_WORDS) {
    throw new Error(`Art hash is ${probe.length} words, expected ${ART_WORDS}`);
  }

  const frameProbe = frameHash ? hexToWords(frameHash) : null;
  const maxDistance = Math.round(threshold * ART_BITS);

  const matches = [];

  for (let row = 0; row < current.count; row++) {
    if (current.printingIds[row] < 0) continue;

    const base = row * WORDS_PER_ROW;
    const distance = hammingWords(probe, 0, current.hashes, base, ART_WORDS);
    if (distance > maxDistance) continue;

    matches.push({
      printingId: current.printingIds[row],
      artDistance: distance,
      frameDistance: frameProbe
        ? hammingWords(frameProbe, 0, current.hashes, base + ART_WORDS, FRAME_WORDS)
        : null,
    });
  }

  // Art first, then frame. Sorting on art alone would leave printings sharing
  // one illustration in file order, which is arbitrary — the frame hash is the
  // only thing that can tell them apart, and this is where it earns its place.
  matches.sort((a, b) =>
    a.artDistance - b.artDistance ||
    (a.frameDistance ?? 0) - (b.frameDistance ?? 0) ||
    a.printingId - b.printingId
  );

  const trimmed = matches.slice(0, limit);

  for (const match of trimmed) {
    // Linear from "exact" to "at the threshold", so the number means the same
    // thing as the text-side confidences scanService already produces.
    const ratio = match.artDistance / ART_BITS;
    match.confidence = Math.max(0, Math.min(1, 1 - ratio / threshold));
  }

  return trimmed;
}

/**
 * The nearest reference to this hash, whatever the distance.
 *
 * findByArtHash answers "what matches"; this answers "how wrong was it", which
 * is a different and, when nothing matches, far more useful question. A capture
 * whose nearest reference sits at 60 bits is framed slightly wrong and worth
 * chasing; one at 130 is not a card at all, or is a card the reference set has
 * never seen. Told apart, those are two different investigations — reported as
 * a bare "no match", they are indistinguishable, which is exactly the position
 * a scanning session was leaving people in.
 *
 * Costs the same full pass as a search, which is under two milliseconds, and is
 * only asked for when a resolve has already come back empty.
 */
export function nearestArtDistance(artHash) {
  const current = ensureLoaded();
  if (!current.count || !artHash) return null;

  const probe = hexToWords(artHash);
  if (probe.length !== ART_WORDS) return null;

  let best = Infinity;
  let bestRow = -1;

  for (let row = 0; row < current.count; row++) {
    if (current.printingIds[row] < 0) continue;

    const distance = hammingWords(probe, 0, current.hashes, row * WORDS_PER_ROW, ART_WORDS);
    if (distance < best) {
      best = distance;
      bestRow = row;
    }
  }

  if (bestRow < 0) return null;

  return {
    printingId: current.printingIds[bestRow],
    artDistance: best,
    bits: ART_BITS,
    // What it would have taken to match, so the number reads without having to
    // look the thresholds up.
    matchWithin: Math.round(ART_MATCH_THRESHOLD * ART_BITS),
  };
}

/** Whether the best match is close enough to be believed on its own. */
export function isStrongMatch(match) {
  return Boolean(match) && match.artDistance / ART_BITS <= ART_STRONG_THRESHOLD;
}
