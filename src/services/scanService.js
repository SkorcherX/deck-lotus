import db from '../db/connection.js';

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

const MAX_CANDIDATES = 20;

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
function nameSimilarity(scanned, dbName) {
  if (!scanned || !dbName) return 0;
  const a = scanned.toLowerCase();
  const faces = [dbName.toLowerCase(), dbName.toLowerCase().split(' // ')[0]];

  let best = 0;
  for (const face of faces) {
    if (a === face) return 1;
    const cap = Math.max(2, Math.ceil(face.length * 0.25));
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
  p.released_at
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
    collect(findByName(normalizedName), 'name');
    if (byPrintingId.size === 0) {
      collect(findByFuzzyName(normalizedName), 'fuzzy-name');
    }
  }

  const requested = parseInt(limit, 10);
  const cap = Math.min(Math.max(Number.isNaN(requested) ? 10 : requested, 1), MAX_CANDIDATES);

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
