import db from '../db/connection.js';
import {
  findByArtHash,
  isAvailable as hashesAvailable,
  nearestArtDistance,
} from './cardHashIndex.js';
import { SCAN_TIERS, fuseScanResult } from '../shared/scanFusion.js';

/**
 * Resolution layer for camera-scanned cards.
 *
 * OCR output is noisy and incomplete, so nothing here returns a single answer.
 * Every lookup produces ranked candidates with a confidence score, and the
 * verification step decides. This is deliberately different from
 * importService's findCard(), which returns the first match and is right to do
 * so — a deck list is typed by a human, a collector block is guessed by a
 * camera.
 */

/**
 * Default ceiling on returned candidates. A ranked shortlist is all the scan
 * page needs; a caller that genuinely wants more — the printing picker, which
 * lists every printing of a name-only match — passes its own limit. This was a
 * hard constant until the picker needed more than a shortlist.
 */
const MAX_CANDIDATES = 20;

/**
 * The ceiling a caller may raise the limit to. Guards against a client asking
 * for the whole table; the largest legitimate need is one card's printings.
 */
const ABSOLUTE_MAX_CANDIDATES = 250;

/**
 * Normalize a card name the way importService does, so both paths agree on the
 * MTGJSON double-faced separator.
 */
export function normalizeCardName(name) {
  if (!name) return null;
  return name.replace(/\s+/g, ' ').trim().replace(/\s\/\s/g, ' // ') || null;
}

/**
 * Normalize a printed set code. The collector block prints it uppercase, but
 * OCR routinely returns lowercase or drags in punctuation from the
 * "DMU • EN" line.
 */
export function normalizeSetCode(setCode) {
  if (!setCode) return null;
  const cleaned = String(setCode).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned || null;
}

/**
 * Normalize a printed collector number into the forms MTGJSON might store.
 *
 * The card prints "0123/281"; MTGJSON stores "123". Some printings keep a
 * letter suffix ("123a"), and promos use a star that OCR usually mangles.
 * Returns an ordered list of strings to try, most likely first, rather than one
 * canonical value — which form a set actually uses varies.
 */
export function collectorNumberVariants(collectorNumber) {
  if (collectorNumber === null || collectorNumber === undefined) return [];

  // The set total after the slash is not part of the collector number.
  let raw = String(collectorNumber).trim().split('/')[0].trim();

  // OCR reads the star glyph as a variety of things; normalize them all to the
  // character MTGJSON stores.
  raw = raw.replace(/[*✦✳★]/g, '★');

  // Keep digits, letters and the star. The rarity letter is a separate token on
  // the card, but a stray space or bullet is cheap to drop.
  raw = raw.replace(/[^0-9A-Za-z★]/g, '');
  if (!raw) return [];

  const variants = [];
  const push = (v) => {
    if (v && !variants.includes(v)) variants.push(v);
  };

  const match = raw.match(/^(\D*)(\d+)(.*)$/);
  if (match) {
    const [, prefix, digits, suffix] = match;
    const stripped = String(parseInt(digits, 10));

    // Leading zeros stripped is the common MTGJSON form.
    push(prefix + stripped + suffix);
    push(prefix + digits + suffix);
    // A suffix is often the rarity letter bleeding into the crop, so the bare
    // number is worth trying too.
    if (suffix) {
      push(prefix + stripped + suffix.toLowerCase());
      push(prefix + stripped);
    }
  } else {
    push(raw);
  }

  return variants;
}

/**
 * Levenshtein distance, capped — OCR name errors run to a character or two, so
 * anything past `max` can stop early rather than finish the matrix.
 */
function editDistance(a, b, max = 4) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

/**
 * 0..1 similarity between an OCR'd name and a database name. Compares against
 * the front face too, since a DFC prints only its front face name.
 */
function nameSimilarity(scanned, dbName, tolerance = 0.25) {
  if (!scanned || !dbName) return 0;
  const a = scanned.toLowerCase();
  const faces = [dbName.toLowerCase(), dbName.toLowerCase().split(' // ')[0]];

  let best = 0;
  for (const face of faces) {
    if (a === face) return 1;
    // How much damage to consider at all. The default suits a name standing on
    // its own; callers with another field already matched can afford to look
    // further, since they are disambiguating rather than identifying.
    const cap = Math.max(2, Math.ceil(face.length * tolerance));
    const distance = editDistance(a, face, cap);
    const score = 1 - distance / Math.max(a.length, face.length);
    if (score > best) best = score;
  }
  return Math.max(0, best);
}

const PRINTING_COLUMNS = `
  c.id AS card_id,
  c.name AS card_name,
  c.mana_cost,
  c.type_line,
  p.id AS printing_id,
  p.uuid,
  p.set_code,
  p.collector_number,
  p.rarity,
  p.image_url,
  p.is_promo,
  p.released_at,
  -- What the card is worth, so a scan can say so without a second round trip.
  --
  -- tcgplayer/normal is the figure the rest of the app quotes, so the scanner
  -- quotes the same one rather than inventing a second answer for the same
  -- card. Falling back to foil only when there is no normal price at all: a
  -- scan cannot see whether the card in front of the lens is foil, so guessing
  -- the foil price for an ordinary copy would overstate most of a box — but a
  -- foil-only printing has no normal price to quote and would otherwise show
  -- as worthless.
  COALESCE(
    (SELECT price FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1),
    (SELECT price FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil' LIMIT 1)
  ) AS price,
  -- Which of the two the price above actually came from. The fallback is not
  -- a rounding difference: 10,972 of 112,815 printings have no normal price at
  -- all, and they are the showcase and serialised ones, so the substituted
  -- figure is systematically the most inflated number available. Flusterstorm
  -- is $9.78 as SOA 18 and $208.59 as the foil-only SOA 148. Quoted without
  -- saying which, that is not a price, it is a guess wearing one.
  CASE
    WHEN EXISTS (SELECT 1 FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal') THEN 'normal'
    WHEN EXISTS (SELECT 1 FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil') THEN 'foil'
  END AS price_type
`;

function queryPrintings(where, params, limit = MAX_CANDIDATES) {
  return db.all(
    `SELECT ${PRINTING_COLUMNS}
     FROM cards c
     JOIN printings p ON c.id = p.card_id
     WHERE ${where}
     ORDER BY p.released_at DESC
     LIMIT ?`,
    [...params, limit]
  );
}

/**
 * Look a printing up by set and collector number alone.
 *
 * This is the highest-signal path for a 2015+ card and the one findCard cannot
 * take — every branch of findCard requires a name. A scanned collector block
 * often reads cleanly while the title band is glared out, so the name has to be
 * optional here.
 */
export function findBySetAndCollector(setCode, collectorNumber, limit = MAX_CANDIDATES) {
  const set = normalizeSetCode(setCode);
  const variants = collectorNumberVariants(collectorNumber);
  if (!set || variants.length === 0) return [];

  for (const variant of variants) {
    const rows = queryPrintings(
      'p.set_code = ? COLLATE NOCASE AND p.collector_number = ? COLLATE NOCASE',
      [set, variant],
      limit
    );
    // Variants are ordered most-likely-first, so the first that hits is the
    // form this set actually uses.
    if (rows.length > 0) return rows;
  }

  return [];
}

/**
 * Printings with this collector number in a set whose code is nearly what was
 * read.
 *
 * OCR gets a three-letter set code almost right far more often than it gets it
 * exactly right — a real capture of a Dominaria United card read "OMU". The
 * collector number is usually the sounder of the two, so the number is trusted
 * and the set code is treated as approximate: candidate sets are those holding
 * that collector number, narrowed to codes within one edit of what was read.
 */
export function findByFuzzySetAndCollector(setCode, collectorNumber, limit = MAX_CANDIDATES) {
  const set = normalizeSetCode(setCode);
  const variants = collectorNumberVariants(collectorNumber);
  if (!set || variants.length === 0) return [];

  for (const variant of variants) {
    const rows = queryPrintings(
      'p.collector_number = ? COLLATE NOCASE',
      [variant],
      // A collector number is shared by every set that reaches it, so this
      // deliberately over-fetches before the set code narrows it down.
      500
    );
    if (rows.length === 0) continue;

    const near = rows.filter((row) => {
      const candidate = normalizeSetCode(row.set_code);
      if (!candidate || candidate === set) return false;
      // One edit, and only between codes of comparable length: "OMU" for "DMU"
      // is a misread, "M21" for "M2" is a different set.
      if (Math.abs(candidate.length - set.length) > 1) return false;
      return editDistance(candidate, set, 1) <= 1;
    });

    if (near.length > 0) return near.slice(0, limit);
  }

  return [];
}

/**
 * Printings of a card whose name is near what was read, holding this collector
 * number — in any set.
 *
 * Measured across real captures, the collector number is by far the soundest
 * field: correct on every card tried, at 83-95% confidence, while the printed
 * set code came back wrong every time (FDN read as FON, and once as ALC). So
 * the set code is not required at all here. An approximate name plus an exact
 * collector number narrows the database sharply, and unlike a wrong set code it
 * cannot quietly point at the wrong card: ALC is a real set, so a misread that
 * happens to be valid resolves confidently and wrongly.
 */
export function findByNameAndCollector(name, collectorNumber, limit = MAX_CANDIDATES) {
  const normalized = normalizeCardName(name);
  const variants = collectorNumberVariants(collectorNumber);
  if (!normalized || variants.length === 0) return [];

  for (const variant of variants) {
    // Over-fetch: a collector number is shared by every set that reaches it, and
    // the name is what narrows it back down.
    const rows = queryPrintings('p.collector_number = ? COLLATE NOCASE', [variant], 500);
    if (rows.length === 0) continue;

    // A looser bar than elsewhere, deliberately. The collector number has
    // already narrowed this to a handful of cards, so the name only has to tell
    // them apart — and a foil's title reads badly: "Dazzling Angel" came back
    // from a real capture as "Dazzl ns Ange", five edits out, which the usual
    // threshold rejects outright.
    const matching = rows.filter((row) => nameSimilarity(normalized, row.card_name, 0.45) >= 0.6);
    if (matching.length > 0) return matching.slice(0, limit);
  }

  return [];
}

/**
 * Every printing of a card, by exact name or as the front face of a DFC.
 */
export function findByName(name, limit = MAX_CANDIDATES) {
  const normalized = normalizeCardName(name);
  if (!normalized) return [];

  const rows = queryPrintings('c.name = ? COLLATE NOCASE', [normalized], limit);
  if (rows.length > 0) return rows;

  return queryPrintings('c.name LIKE ? COLLATE NOCASE', [normalized + ' //%'], limit);
}

/**
 * Fuzzy name search for when OCR mangled a character or two.
 *
 * Narrows on a prefix so the edit-distance pass runs over a handful of names
 * rather than the whole card table, then falls back to a substring match when
 * the damage is in the leading characters.
 */
export function findByFuzzyName(name, limit = MAX_CANDIDATES) {
  const normalized = normalizeCardName(name);
  if (!normalized || normalized.length < 4) return [];

  const prefix = normalized.slice(0, 4);
  let names = db.all(
    `SELECT id, name FROM cards WHERE name LIKE ? COLLATE NOCASE LIMIT 200`,
    [prefix + '%']
  );

  if (names.length === 0) {
    const middle = normalized.slice(1, Math.max(5, normalized.length - 1));
    names = db.all(
      `SELECT id, name FROM cards WHERE name LIKE ? COLLATE NOCASE LIMIT 200`,
      ['%' + middle + '%']
    );
  }

  const scored = names
    .map((row) => ({ ...row, similarity: nameSimilarity(normalized, row.name) }))
    .filter((row) => row.similarity >= 0.7)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  const rows = [];
  for (const card of scored) {
    rows.push(...queryPrintings('c.id = ?', [card.id], limit));
  }
  return rows;
}

/**
 * Base confidence per strategy — what the strategy itself is worth, before the
 * scanned name is compared against the result.
 */
const STRATEGY_CONFIDENCE = {
  'name+set+collector': 0.98,
  'set+collector': 0.9,
  // Below an exact set match but above a name-only one: the collector number
  // still had to match exactly, and the set code was only one character out.
  'fuzzy-set+collector': 0.78,
  // No set code involved, so this cannot be misled by one. The collector number
  // matched exactly and the name is close, which in practice is a stronger
  // combination than a set code that OCR rarely gets right.
  'name+collector': 0.86,
  'name+set': 0.72,
  name: 0.55,
  'fuzzy-name': 0.35,
};

/**
 * Resolve an OCR reading into ranked candidates.
 *
 * Runs every strategy the available fields allow rather than stopping at the
 * first hit, so a set code misread off a promo still surfaces the right card
 * lower down the list instead of returning nothing.
 *
 * @param {object} scan
 * @param {string|null} scan.name             OCR'd title band
 * @param {string|null} scan.setCode          OCR'd set code
 * @param {string|null} scan.collectorNumber  OCR'd collector number
 * @param {number} [scan.limit]
 * @returns {{query: object, candidates: Array}}
 */
export function resolveScan({ name = null, setCode = null, collectorNumber = null, limit = 10 } = {}) {
  const normalizedName = normalizeCardName(name);
  const normalizedSet = normalizeSetCode(setCode);
  const variants = collectorNumberVariants(collectorNumber);
  const normalizedCollector = variants[0] || null;

  const byPrintingId = new Map();

  const collect = (rows, strategy) => {
    for (const row of rows) {
      const base = STRATEGY_CONFIDENCE[strategy];

      // A name we could read is evidence in its own right: it either confirms
      // the candidate or argues against it. With no name read, the structural
      // match carries the score alone.
      let confidence = base;
      let similarity = null;
      if (normalizedName) {
        similarity = nameSimilarity(normalizedName, row.card_name);
        confidence = base * (0.6 + 0.4 * similarity);
      }

      const existing = byPrintingId.get(row.printing_id);
      if (existing) {
        if (!existing.matchedBy.includes(strategy)) existing.matchedBy.push(strategy);
        if (existing.confidence >= confidence) continue;
        existing.confidence = Math.round(confidence * 1000) / 1000;
        continue;
      }

      byPrintingId.set(row.printing_id, {
        cardId: row.card_id,
        name: row.card_name,
        manaCost: row.mana_cost,
        typeLine: row.type_line,
        printingId: row.printing_id,
        uuid: row.uuid,
        setCode: row.set_code,
        collectorNumber: row.collector_number,
        rarity: row.rarity,
        imageUrl: row.image_url,
        isPromo: !!row.is_promo,
        releasedAt: row.released_at,
        price: row.price ?? null,
        priceType: row.price_type ?? null,
        confidence: Math.round(confidence * 1000) / 1000,
        nameSimilarity: similarity === null ? null : Math.round(similarity * 1000) / 1000,
        matchedBy: [strategy],
      });
    }
  };

  if (normalizedSet && normalizedCollector) {
    const rows = findBySetAndCollector(normalizedSet, normalizedCollector);
    if (normalizedName) {
      const named = rows.filter((r) => nameSimilarity(normalizedName, r.card_name) >= 0.85);
      collect(named, 'name+set+collector');
    }
    collect(rows, 'set+collector');

    // Only worth the wider search when the set code as read matched nothing.
    if (rows.length === 0) {
      collect(findByFuzzySetAndCollector(normalizedSet, normalizedCollector), 'fuzzy-set+collector');
    }
  }

  // Name plus collector number, ignoring the set code entirely. Runs whenever
  // both are present, not only as a fallback: a set code read wrongly but
  // plausibly would otherwise win on a strategy that scores higher.
  if (normalizedName && normalizedCollector) {
    collect(findByNameAndCollector(normalizedName, normalizedCollector), 'name+collector');
  }

  if (normalizedName && normalizedSet) {
    collect(
      queryPrintings(
        'c.name = ? COLLATE NOCASE AND p.set_code = ? COLLATE NOCASE',
        [normalizedName, normalizedSet]
      ),
      'name+set'
    );
    collect(
      queryPrintings(
        'c.name LIKE ? COLLATE NOCASE AND p.set_code = ? COLLATE NOCASE',
        [normalizedName + ' //%', normalizedSet]
      ),
      'name+set'
    );
  }

  if (normalizedName) {
    // Widened to the requested limit rather than left at MAX_CANDIDATES: this
    // is the strategy the printing picker relies on, and a name-only match on a
    // card with dozens of printings has to be able to list all of them. Capping
    // the query at 20 and then slicing to `limit` would silently return a
    // truncated list that looked complete.
    const nameLimit = Math.min(
      Math.max(parseInt(limit, 10) || MAX_CANDIDATES, MAX_CANDIDATES),
      ABSOLUTE_MAX_CANDIDATES
    );
    collect(findByName(normalizedName, nameLimit), 'name');
    if (byPrintingId.size === 0) {
      collect(findByFuzzyName(normalizedName, nameLimit), 'fuzzy-name');
    }
  }

  const requested = parseInt(limit, 10);
  const cap = Math.min(Math.max(Number.isNaN(requested) ? 10 : requested, 1), ABSOLUTE_MAX_CANDIDATES);

  const candidates = [...byPrintingId.values()]
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      // Equal confidence usually means several printings of the same card; the
      // most recent first is what a scanned card most often is.
      return String(b.releasedAt || '').localeCompare(String(a.releasedAt || ''));
    })
    .slice(0, cap);

  return {
    query: {
      name: normalizedName,
      setCode: normalizedSet,
      collectorNumber: normalizedCollector,
      collectorNumberVariants: variants,
    },
    candidates,
  };
}

/**
 * Hydrate printings by id, for candidates the hash found and the text did not.
 *
 * Exported because a device that matched locally has the same gap and cannot
 * fill it: it holds names, sets and prices, not image URLs — those nearly
 * triple the identity table for a thumbnail the review screen asks for once.
 * See scanIdentityService.
 */
export function printingsByIds(ids) {
  if (!ids.length) return [];
  return db.all(
    `SELECT ${PRINTING_COLUMNS}
     FROM cards c
     JOIN printings p ON c.id = p.card_id
     WHERE p.id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
}

// The tiers, the tie width and the set biasing moved to src/shared/ with the
// rest of the pure ranking; re-exported because every caller of this module
// imports SCAN_TIERS from it.
export { SCAN_TIERS };

/**
 * A hydrated printing row in the shape the candidate list uses. The art-hash
 * half of a fused result carries printings the text lookup never produced, so
 * they arrive as database rows and have to be dressed the same way resolveScan
 * dresses its own before the two can be ranked against each other.
 */
function printingRowToCandidate(row) {
  return {
    cardId: row.card_id,
    name: row.card_name,
    manaCost: row.mana_cost,
    typeLine: row.type_line,
    printingId: row.printing_id,
    uuid: row.uuid,
    setCode: row.set_code,
    collectorNumber: row.collector_number,
    rarity: row.rarity,
    imageUrl: row.image_url,
    isPromo: !!row.is_promo,
    releasedAt: row.released_at,
    price: row.price ?? null,
    priceType: row.price_type ?? null,
  };
}

/**
 * Resolve a scan using the OCR text and the capture's perceptual hashes together.
 *
 * The point is that the two fail in uncorrelated ways. OCR reads the collector
 * block and names a printing exactly, when it can read it at all; the art hash
 * recognises the picture through glare and blur but cannot tell two printings
 * of one illustration apart. Neither is trustworthy alone, and their agreement
 * is worth more than a high score from either — which is why CONFIDENT requires
 * both to point at the same printing and can never be reached by one signal
 * being emphatic.
 *
 * The second gain is subtler and matters more in practice. Once the hash has
 * produced a shortlist, the OCR text stops being an open-vocabulary read: the
 * question turns from "is this string a valid set code" into "which of these
 * few printings is this reading closest to", and nearest-match over a handful
 * of candidates tolerates character errors that would sink a free-text lookup.
 *
 * Degrades to plain resolveScan when no hash is supplied or no hash file is
 * loaded, so a deployment without data/card-hashes.bin still scans as before.
 *
 * @param {object} scan
 * @param {string|null} scan.name             OCR'd title band
 * @param {string|null} scan.setCode          OCR'd set code
 * @param {string|null} scan.collectorNumber  OCR'd collector number
 * @param {string|null} scan.artHash          Capture's art hash, hex
 * @param {string|null} scan.frameHash        Capture's frame hash, hex
 * @param {number} [scan.limit]
 * @returns {{query: object, tier: string, candidates: Array, signals: object}}
 */
export function resolveScanFused({
  name = null,
  setCode = null,
  collectorNumber = null,
  artHash = null,
  frameHash = null,
  artHashes = null,
  frameHashes = null,
  setBias = null,
  limit = 10,
} = {}) {
  // Resolved wide and trimmed at the end: a printing that the text ranked 30th
  // can be the right answer once the art agrees with it, and it has to still be
  // in the list for that to be noticed.
  const text = resolveScan({ name, setCode, collectorNumber, limit: ABSOLUTE_MAX_CANDIDATES });

  const cap = Math.min(Math.max(parseInt(limit, 10) || 10, 1), ABSOLUTE_MAX_CANDIDATES);

  // A capture may arrive as several framings of itself rather than one.
  //
  // Detection finds the card's printed frame reliably, but whether it stops at
  // the inner or the outer edge of the black border depends on which boundary
  // held the most contrast — and the references are whole cards, border
  // included. Measured on a real capture, the detected framing sat 86 bits from
  // its own reference and the same capture expanded 8% sat at 30. The right
  // expansion is not knowable from the picture, so the client sends a few and
  // the best one wins. Each costs one 1.7ms pass of the index.
  const probes = Array.isArray(artHashes) && artHashes.length
    ? artHashes.map((hash, index) => ({
        artHash: hash,
        frameHash: Array.isArray(frameHashes) ? frameHashes[index] || null : frameHash,
      }))
    : [{ artHash, frameHash }];

  let hashMatches = [];
  let probe = probes[0];
  let probeIndex = 0;

  if (hashesAvailable()) {
    for (let index = 0; index < probes.length; index++) {
      const candidate = probes[index];
      if (!candidate.artHash) continue;

      const found = findByArtHash(candidate.artHash, candidate.frameHash);
      // Nearest wins outright. These are framings of one photograph, so this is
      // not weighing different evidence — it is picking the crop that lines up
      // with how the references were built.
      if (found.length && (!hashMatches.length || found[0].artDistance < hashMatches[0].artDistance)) {
        hashMatches = found;
        probe = candidate;
        probeIndex = index;
      }
    }
  }

  // Nothing matched, so ask how wrong it was — see fuseScanResult's no-match
  // branch for why a bare "no match" is not worth reporting on its own.
  let nearest = null;
  if (!hashMatches.length && hashesAvailable()) {
    for (const candidate of probes) {
      if (!candidate.artHash) continue;
      const found = nearestArtDistance(candidate.artHash);
      if (found && (!nearest || found.artDistance < nearest.artDistance)) nearest = found;
    }
  }

  // The database half: printings the art found and the text did not have to be
  // turned into names and prices before the fusion can rank them.
  const hydrated = new Map();
  if (hashMatches.length) {
    const fromText = new Set(text.candidates.map((candidate) => candidate.printingId));
    const missing = hashMatches
      .map((match) => match.printingId)
      .filter((id) => !fromText.has(id));

    for (const row of printingsByIds(missing)) {
      hydrated.set(row.printing_id, printingRowToCandidate(row));
    }
  }

  return fuseScanResult({
    text,
    probes,
    probe,
    probeIndex,
    hashMatches,
    hydrated,
    nearest,
    setBias,
    cap,
  });
}
