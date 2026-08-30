import db from '../db/connection.js';
import {
  findByArtHash,
  isAvailable as hashesAvailable,
  isStrongMatch,
  nearestArtDistance,
} from './cardHashIndex.js';

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
  ) AS price
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

/** Hydrate printings by id, for candidates the hash found and the text did not. */
function printingsByIds(ids) {
  if (!ids.length) return [];
  return db.all(
    `SELECT ${PRINTING_COLUMNS}
     FROM cards c
     JOIN printings p ON c.id = p.card_id
     WHERE p.id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
}

/**
 * What the two signals together concluded, and therefore how much of the
 * reviewer's attention this row needs.
 *
 * `confident` is the only tier that lets a row collapse out of the review
 * table, so it is deliberately the narrowest of the four. The rest all mean
 * "look at this" and differ only in what the reviewer is being asked to decide.
 */
export const SCAN_TIERS = {
  /** Art and text independently reached the same printing. Nothing to decide. */
  CONFIDENT: 'confident',
  /**
   * The art is certain but the printing is not — reprints sharing one
   * illustration, or a pre-2015 card with no collector block to read. The
   * reviewer is picking a printing, not a card.
   */
  PICK_PRINTING: 'pick-printing',
  /** Both signals are strong and they disagree. The reviewer picks between them. */
  CONFLICT: 'conflict',
  /** Weak, or only one signal spoke. The old text-only behaviour. */
  UNSURE: 'unsure',
};

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
/**
 * How close two printings of one card have to sit before the art is treated as
 * having no opinion about which is which, in bits of the 256-bit art hash.
 *
 * Reprints share an illustration, so what separates their references is not the
 * picture — it is the difference between two scans of one picture. A recorded
 * session put four printings of Seaside Citadel at exactly 50, three of Ingot
 * Chewer within 4, and reordered all of them when the same photograph was
 * hashed at another rung of the framing ladder.
 *
 * 12 bits, and the anchor is elsewhere in this pipeline: hashing *the same
 * pixels* at the camera's resolution rather than the reference's moved the art
 * hash 10-12 bits, flat, at every size (see HASH_HEIGHT). A gap that a change
 * of scale can manufacture on identical input is not evidence about which
 * printing is in someone's hand.
 *
 * Measured against three recorded ECC sessions — how many of nine cards came
 * back as the ECC printing that was actually on the table:
 *
 *      tie bits    6     12    20    30
 *      session A   7/9   8/9   8/9   9/9
 *      session B   3/9   8/9   8/9   8/9
 *      session C   6/9   6/9   6/9   6/9
 *
 * Most of it arrives by 12 and the rest is bought by overriding differences
 * large enough to be real — a borderless or showcase printing genuinely differs
 * from a normal one, and 30 is most of the way to the 41 bits that separate a
 * confident match from an unsure one. So: 12.
 */
const PRINTING_TIE_BITS = 12;

/**
 * Order tied printings by the sets a session has already been sure about.
 *
 * The art can name the card and has nothing to say about which printing is in
 * the hand. The information that would settle it is not in the photograph — it
 * is in the stack: cards come from a precon, a booster box, a binder, and one
 * session is usually one place. So a caller may pass a tally of the sets it has
 * already resolved unambiguously, and ties are broken toward it.
 *
 * Three rules, and the whole value of this depends on keeping them:
 *
 * 1. **Only printings of the card that already won.** This never changes which
 *    *card* is first. A tally about sets is not evidence about identity.
 * 2. **Only where the art is genuinely tied**, within PRINTING_TIE_BITS. A
 *    distance the art actually separated is evidence; overriding it with a
 *    tally would be preferring a guess about the stack to a measurement of the
 *    picture.
 * 3. **Never promotes anything.** Tiers are decided before this runs, so a
 *    biased order cannot turn a printing choice into a `confident` one. A tally
 *    is a hint about a pile of cards, not proof about the one in hand.
 *
 * Mutates `merged` in place, because it is the list about to be returned and
 * copying it to reorder a handful of neighbours would be ceremony.
 */
function applySetBias(merged, setBias) {
  if (!setBias || !merged.length) return;

  const tally = new Map(
    Object.entries(setBias)
      .filter(([code, count]) => code && Number.isFinite(count) && count > 0)
      .map(([code, count]) => [String(code).toUpperCase(), count])
  );
  if (!tally.size) return;

  const best = merged[0];
  if (best.artDistance === null || best.artDistance === undefined) return;

  // The run of leading candidates that are the same card and tied with it. A
  // contiguous run from the front, because anything below a candidate the art
  // separated is not tied with the winner however close it looks.
  let end = 0;
  while (
    end < merged.length &&
    merged[end].cardId === best.cardId &&
    Number.isFinite(merged[end].artDistance) &&
    merged[end].artDistance - best.artDistance <= PRINTING_TIE_BITS
  ) {
    end++;
  }

  if (end < 2) return;

  const tied = merged.slice(0, end);
  tied.sort((a, b) => {
    const score = (candidate) => tally.get(String(candidate.setCode || '').toUpperCase()) || 0;
    // Stable within equal scores: the art's own order is the fallback, not an
    // alphabetical or arbitrary one.
    return score(b) - score(a);
  });

  merged.splice(0, end, ...tied);
}

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

  artHash = probe.artHash;
  frameHash = probe.frameHash;

  if (!hashMatches.length) {
    // No hash signal at all — no capture hash, no hash file, or nothing within
    // threshold. Reported honestly as single-signal rather than dressed up.
    //
    // When there was a hash and it simply matched nothing, say how close the
    // nearest reference was. "No match" alone cannot distinguish a capture
    // framed slightly wrong, which is recoverable, from one that is not a card
    // at all — and a review screen full of bare "no match" rows leaves nobody,
    // including whoever has to fix it, any idea which they are looking at.
    let nearest = null;
    if (hashesAvailable()) {
      for (const candidate of probes) {
        if (!candidate.artHash) continue;
        const found = nearestArtDistance(candidate.artHash);
        if (found && (!nearest || found.artDistance < nearest.artDistance)) nearest = found;
      }
    }

    return {
      query: { ...text.query, artHash, frameHash },
      tier: SCAN_TIERS.UNSURE,
      candidates: text.candidates.slice(0, cap),
      signals: {
        text: text.candidates.length,
        hash: 0,
        agreed: false,
        bestArtDistance: null,
        nearest,
        probes: probes.length,
        probeIndex: null,
        // Stated rather than left undefined: the art matched nothing here, so
        // whatever the reader proposed is a proposal. A caller reading a
        // missing field as falsy would get the right answer by luck, and the
        // one thing this flag must never do is let a misread card be announced
        // as settled.
        nameCertain: false,
      },
    };
  }

  const textById = new Map(text.candidates.map((candidate) => [candidate.printingId, candidate]));
  const hashById = new Map(hashMatches.map((match) => [match.printingId, match]));

  // Printings the hash found and the text did not still have to be shown. On a
  // pre-2015 card the hash is the *only* signal there is, and dropping its finds
  // for want of a collector block would discard the one thing that worked.
  const missing = hashMatches
    .map((match) => match.printingId)
    .filter((id) => !textById.has(id));

  const hydrated = new Map();
  for (const row of printingsByIds(missing)) {
    hydrated.set(row.printing_id, row);
  }

  const merged = [];

  for (const match of hashMatches) {
    const existing = textById.get(match.printingId);

    if (existing) {
      merged.push({
        ...existing,
        artDistance: match.artDistance,
        frameDistance: match.frameDistance,
        hashConfidence: match.confidence,
        // Agreement beats either signal alone, but the result stays under 1: it
        // is still a scan, and the review step is not a formality.
        //
        // Combined as a noisy-or rather than a mean, and that is the whole
        // point: agreement must never rank a printing *below* what one signal
        // alone already gave it. A mean does exactly that whenever the two
        // differ — averaging a strong read against a weak-but-correct one lands
        // between them, and the fixed bonus is not always enough to climb back.
        //
        // Seen on a real capture: OCR read "Springleaf Drum / ECL / 0260" at
        // 0.84 and the art independently found the same printing, but at 54 of
        // its 56-bit budget, so hash confidence was 0.041. The mean scored the
        // agreed printing 0.5*0.84 + 0.5*0.041 + 0.2 = 0.64, while three basic
        // lands the collector number alone had turned up kept 0.803 and took
        // the top of the list. Both signals were right, they agreed, and fusing
        // them buried the answer under Plains.
        //
        // Noisy-or is monotone in both inputs and never falls below either, so
        // a weak second signal can only ever help. It also repairs `agreed`
        // below, which asks whether the merged winner is the text's winner and
        // was reading false for the same reason.
        confidence:
          Math.round(
            Math.min(0.99, 1 - (1 - existing.confidence) * (1 - match.confidence)) * 1000
          ) / 1000,
        matchedBy: [...existing.matchedBy, 'art-hash'],
      });
      continue;
    }

    const row = hydrated.get(match.printingId);
    if (!row) continue;

    merged.push({
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
      artDistance: match.artDistance,
      frameDistance: match.frameDistance,
      hashConfidence: match.confidence,
      confidence: Math.round(match.confidence * 1000) / 1000,
      nameSimilarity: null,
      matchedBy: ['art-hash'],
    });
  }

  // Text-only candidates keep their place, below anything the art agreed with.
  for (const candidate of text.candidates) {
    if (hashById.has(candidate.printingId)) continue;
    merged.push({ ...candidate, artDistance: null, frameDistance: null, hashConfidence: null });
  }

  // Printings the art actually found rank above printings only the text
  // proposed, and confidence orders within each group rather than across them.
  //
  // Without this a bad read does not merely fail to help, it actively buries
  // the right answer — because a text candidate's confidence says how
  // unambiguous the *database lookup* was, not how good the *read* was. Two
  // real captures, both with the art already correct:
  //
  //   OCR "A 7C POLSON 07 / CON" -> Darklit Gargoyle [CON 7] at 0.825,
  //      over Scarblade's Malice, which the art had at 42 bits and 0.392.
  //   OCR "M4 10 F / 195 ECL EN" -> Clachan Festival [ECL 10] at 0.788,
  //      over Safewright Cavalry, which the art had at 58 bits and 0.161.
  //
  // Both reads were noise. Both resolved to exactly one printing, which is what
  // made them look certain, and a wrong card went to the top of the list.
  //
  // This is only reached when the art matched something — the no-match case
  // returns above — so it never reorders a text-only result, and it cannot
  // disturb the case the fusion exists for: reprints sharing one illustration
  // are all art-backed, so the text still orders freely among them. What it
  // gives up is the case where the art matches a wrong card within threshold
  // *and* the text alone finds the right one. That is the rarer failure by a
  // wide margin — a different card lands within threshold about 1.7% of the
  // time, nearly always genuine art sharing — and the row still goes to review
  // with both offered.
  const artBacked = (candidate) => candidate.artDistance !== null && candidate.artDistance !== undefined;
  merged.sort((a, b) => (artBacked(b) ? 1 : 0) - (artBacked(a) ? 1 : 0) || b.confidence - a.confidence);

  const best = merged[0] || null;
  const bestHash = hashMatches[0];
  const bestText = text.candidates[0] || null;

  // Do the two signals name the same printing? Deliberately not "is either one
  // confident": a strong text read and a strong art match pointing at different
  // printings is exactly the case that must never collapse out of review.
  const agreed = Boolean(
    bestText && hashById.has(bestText.printingId) && best && best.printingId === bestText.printingId
  );

  // Printings whose art the search actually agreed with. "Only one printing
  // matched" is a claim about the art, not about the merged list, which also
  // carries every text-only candidate below it.
  const strongEnough = hashMatches.filter(isStrongMatch);

  // How many printings of the *same card* the art found. A reprint shares its
  // illustration with every other printing of it, so wherever this is above one
  // the art has named the card and has nothing whatever to say about which
  // printing is in the hand — the differences between them are the framing's
  // noise, not evidence.
  //
  // A recorded session settled this. Nine cards from one ECC precon, unsleeved,
  // came back naming half a dozen different sets: Seaside Citadel tied at 50
  // across MKC, BLC, ECC and PLST, Ingot Chewer at 64 across CM2, ECC and JVC,
  // and Abundant Growth was called `confident` for DMC at 36 while ECC — the
  // card actually on the table — sat outside the top four. Re-hashed at a
  // different rung of the probe ladder the order changed again. Which of a set
  // of reprints wins is decided by a few bits of resampling.
  //
  // That matters more here than a ranking usually would: this app stores and
  // prices *printings*, so collapsing a reprint out of review at `confident`
  // files the wrong set into someone's collection at the wrong price, silently.
  const bestCardPrintings = best
    ? merged.filter((candidate) => artBacked(candidate) && candidate.cardId === best.cardId).length
    : 0;

  applySetBias(merged, setBias);

  // Whether the art agreed on *which card this is*, as distinct from which
  // printing of it. Every art-backed candidate belonging to one card means
  // there is nothing left to decide about the name, however many printings are
  // still on the table.
  //
  // Measured over nine recorded sessions: 61 captures resolved to something,
  // and in all 61 every candidate within the match threshold shared a single
  // card name. Not one had two names to choose between. So a tier of `unsure`
  // has been reporting doubt about the name that the evidence never had — it is
  // a printing-level verdict, and the name deserves its own.
  const nameCertain = Boolean(
    best && artBacked(best) && merged.filter(artBacked).every((c) => c.cardId === best.cardId)
  );

  let tier;
  if (agreed && isStrongMatch(bestHash)) {
    tier = SCAN_TIERS.CONFIDENT;
  } else if (!bestText && strongEnough.length === 1 && bestCardPrintings === 1) {
    // The art is certain and it matched exactly one printing in the whole
    // reference set — one printing of one card, so there is genuinely nothing
    // left to decide. Requiring a text read here would have meant a tesseract
    // pass to confirm an answer that had no alternative, which is what made
    // every card need review when the reader is off.
    //
    // The second half of that test is the one bought with a recorded session:
    // "only one printing scored strongly" is not the same claim as "only one
    // printing of this card matched at all". A reprint whose siblings sit just
    // the wrong side of the strong threshold used to collapse out of review on
    // the strength of a gap that is framing noise.
    tier = SCAN_TIERS.CONFIDENT;
  } else if (!bestText && isStrongMatch(bestHash)) {
    // The art is certain and there is nothing to place it with: a pre-2015 card,
    // a collector block lost to glare, or — much the commonest — a card printed
    // more than once. The card is known, the printing is not.
    tier = SCAN_TIERS.PICK_PRINTING;
  } else if (bestText && isStrongMatch(bestHash) && !agreed) {
    tier = SCAN_TIERS.CONFLICT;
  } else {
    tier = SCAN_TIERS.UNSURE;
  }

  return {
    query: { ...text.query, artHash, frameHash },
    tier,
    candidates: merged.slice(0, cap),
    signals: {
      text: text.candidates.length,
      hash: hashMatches.length,
      // Printings of the winning card the art matched. Above one means the
      // printing was chosen by hand, not by the scanner.
      printingsOfBest: bestCardPrintings,
      // Whether a session's set tally was used to order tied printings, so a
      // recording says when the order shown was the art's and when it was the
      // stack's. See applySetBias.
      setBiased: !!setBias && bestCardPrintings > 1,
      // The name is settled even where the printing is not. See above.
      nameCertain,
      agreed,
      bestArtDistance: bestHash ? bestHash.artDistance : null,
      // Which of the offered framings won. On its own it is trivia; across a
      // recorded session it says whether the expansions are centred on where
      // detection actually stops, which is the only way to tune them on
      // evidence rather than on a guess about black borders.
      probes: probes.length,
      probeIndex,
    },
  };
}
