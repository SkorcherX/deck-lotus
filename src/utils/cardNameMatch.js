/**
 * Forgiving card-name matching.
 *
 * Typed searches miss for two reasons that have nothing to do with the user
 * being wrong about the card: punctuation ("Urzas" vs "Urza's", "Jotun" vs
 * "Jötun") and single-character typos. Normalization handles the first, a
 * bounded edit distance the second.
 *
 * The normalization here is mirrored by the `cards.name_normalized` generated
 * column (migration 024). If you change one, change the other.
 */

/**
 * Accent folds applied before lowercasing, since SQLite's lower() is
 * ASCII-only and would leave an uppercase accent untouched.
 */
const ACCENTS = [
  ['À', 'A'], ['Á', 'A'], ['Â', 'A'], ['Ã', 'A'], ['Ä', 'A'], ['Å', 'A'],
  ['à', 'a'], ['á', 'a'], ['â', 'a'], ['ã', 'a'], ['ä', 'a'], ['å', 'a'],
  ['È', 'E'], ['É', 'E'], ['Ê', 'E'], ['Ë', 'E'],
  ['è', 'e'], ['é', 'e'], ['ê', 'e'], ['ë', 'e'],
  ['Ì', 'I'], ['Í', 'I'], ['Î', 'I'], ['Ï', 'I'],
  ['ì', 'i'], ['í', 'i'], ['î', 'i'], ['ï', 'i'],
  ['Ò', 'O'], ['Ó', 'O'], ['Ô', 'O'], ['Õ', 'O'], ['Ö', 'O'],
  ['ò', 'o'], ['ó', 'o'], ['ô', 'o'], ['õ', 'o'], ['ö', 'o'],
  ['Ù', 'U'], ['Ú', 'U'], ['Û', 'U'], ['Ü', 'U'],
  ['ù', 'u'], ['ú', 'u'], ['û', 'u'], ['ü', 'u'],
  ['Ñ', 'N'], ['ñ', 'n'], ['Ç', 'C'], ['ç', 'c'],
  ['Æ', 'AE'], ['æ', 'ae'], ['Œ', 'OE'], ['œ', 'oe']
];

/** Punctuation dropped entirely, so "Urza's" and "Urzas" compare equal. */
const PUNCTUATION = ["'", '’', ',', '.', ':', ';', '!', '?', '"', '-', '—', '/', '(', ')'];

/**
 * Normalize a card name (or a search query) for comparison: fold accents,
 * drop punctuation, lowercase, collapse whitespace.
 */
export function normalizeForSearch(value) {
  if (!value) return '';

  let out = String(value);
  for (const [from, to] of ACCENTS) out = out.split(from).join(to);
  for (const mark of PUNCTUATION) out = out.split(mark).join('');

  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Backfill a normalized column in JavaScript, in batches.
 *
 * This deliberately does not happen in SQL. Expressing the normalization as
 * one expression means nesting a REPLACE per accent and punctuation mark, and
 * at ~60 deep SQLite's parser gives up with "parser stack overflow" — a limit
 * on expression nesting, not on data. Doing it here keeps one definition of
 * what normalization means, in JavaScript, where the search code reads it.
 *
 * `db` is a raw better-sqlite3 handle (what migrations are handed).
 */
export function backfillNormalizedColumn(db, { table, sourceColumn, targetColumn, idColumn = 'id' }) {
  const rows = db.prepare(
    `SELECT ${idColumn} AS id, ${sourceColumn} AS source
       FROM ${table}
      WHERE ${sourceColumn} IS NOT NULL`
  ).all();

  const update = db.prepare(
    `UPDATE ${table} SET ${targetColumn} = ? WHERE ${idColumn} = ?`
  );

  for (const row of rows) {
    update.run(normalizeForSearch(row.source), row.id);
  }

  return rows.length;
}

/**
 * Split a query into `tolerance + 1` chunks. By the pigeonhole principle, any
 * string within `tolerance` edits of the query must contain at least one chunk
 * verbatim — which turns "find the near misses" into a handful of LIKE
 * patterns SQLite can filter on, instead of handing the whole card table to
 * JavaScript.
 */
export function pigeonholeChunks(query, tolerance) {
  const pieces = tolerance + 1;
  if (query.length < pieces) return [query];

  const size = Math.floor(query.length / pieces);
  const chunks = [];

  for (let i = 0; i < pieces; i++) {
    // The last chunk takes the remainder.
    const start = i * size;
    const end = i === pieces - 1 ? query.length : start + size;
    const chunk = query.slice(start, end);
    if (chunk) chunks.push(chunk);
  }

  return chunks;
}

/** Chunks shorter than this match so much of the card table they filter nothing. */
const MIN_CHUNK = 3;

/**
 * How many edits we can forgive while still splitting the query into chunks
 * worth filtering on.
 *
 * Forgiving one more edit costs one more chunk, and a query only has so many
 * characters to divide up. Two-character chunks appear in thousands of card
 * names, so the shortlist fills with noise and the real match can fall off the
 * end — better to forgive one edit fewer and actually find the card.
 */
export function effectiveTolerance(length) {
  let tolerance = fuzzyTolerance(length);

  while (tolerance > 1 && Math.floor(length / (tolerance + 1)) < MIN_CHUNK) {
    tolerance--;
  }

  return tolerance;
}

/**
 * The SQL-side narrowing for a fuzzy pass: the tolerance in force, the length
 * floor, and the LIKE patterns a candidate must satisfy. Callers build their
 * own query around these, since the table and the id column differ, and pass
 * `tolerance` back to rankFuzzyCandidates so both stages agree.
 */
export function fuzzyPlan(normalizedQuery) {
  const tolerance = effectiveTolerance(normalizedQuery.length);

  return {
    tolerance,
    minLength: normalizedQuery.length - tolerance,
    likePatterns: pigeonholeChunks(normalizedQuery, tolerance).map((chunk) => `%${chunk}%`)
  };
}

/**
 * Levenshtein distance, abandoned once every path exceeds `max`.
 * Returns max + 1 to signal "further away than you care about".
 */
export function editDistance(a, b, max = 3) {
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
 * Edit distance from `query` to the closest substring of `text`.
 *
 * Plain edit distance is the wrong tool for a search box: people type a
 * fragment ("lightnig"), not the whole name, so comparing against "Lightning
 * Bolt" in full would score every long name as hopeless. Letting the match
 * start and end anywhere in `text` — the first DP row is all zeroes, and the
 * answer is the minimum of the last row — measures the fragment against the
 * best window of the name instead.
 */
export function fuzzySubstringDistance(query, text, max = 3) {
  if (!query) return 0;
  if (!text) return max + 1;
  if (text.includes(query)) return 0;

  let prev = new Array(text.length + 1).fill(0);
  let best = max + 1;

  for (let i = 1; i <= query.length; i++) {
    const curr = new Array(text.length + 1);
    curr[0] = i;
    let rowMin = i;

    for (let j = 1; j <= text.length; j++) {
      const cost = query[i - 1] === text[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    // Every alignment is already too expensive; no later row can improve.
    if (rowMin > max) return max + 1;
    prev = curr;
  }

  for (let j = 0; j <= text.length; j++) {
    if (prev[j] < best) best = prev[j];
  }

  return best;
}

/**
 * How much damage to forgive for a query of this length. Short queries get a
 * tight budget: at two allowed edits, a four-character query matches almost
 * anything.
 */
export function fuzzyTolerance(length) {
  if (length <= 4) return 1;
  if (length <= 8) return 2;
  return 3;
}

/**
 * Score candidates against the query and return their ids, closest first.
 * `candidates` are { id, text } with text already normalized. An id may
 * appear more than once (a card with several foreign names); its best score
 * wins and the id is returned once.
 *
 * `tolerance` must be the one fuzzyPlan handed the caller, so the shortlist
 * and the scoring forgive the same number of edits.
 */
export function rankFuzzyCandidates(normalizedQuery, candidates, limit, tolerance) {
  const best = new Map();

  for (const candidate of candidates) {
    const text = candidate.text;
    if (!text) continue;
    if (!sharesEnoughCharacters(normalizedQuery, text, tolerance)) continue;

    const distance = fuzzySubstringDistance(normalizedQuery, text, tolerance);
    if (distance > tolerance) continue;

    const scored = { id: candidate.id, distance, length: text.length, text };
    const previous = best.get(candidate.id);

    if (!previous || distance < previous.distance ||
        (distance === previous.distance && text.length < previous.length)) {
      best.set(candidate.id, scored);
    }
  }

  return [...best.values()]
    .sort((a, b) =>
      a.distance - b.distance ||
      a.length - b.length ||
      a.text.localeCompare(b.text)
    )
    .slice(0, limit)
    .map((row) => row.id);
}

/**
 * Cheap rejection before the O(n*m) matrix: a candidate that does not share
 * enough characters with the query cannot come within `max` edits of it.
 */
export function sharesEnoughCharacters(query, text, max) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) || 0) + 1);

  let missing = 0;
  for (const ch of query) {
    const available = counts.get(ch) || 0;
    if (available === 0) {
      missing++;
      if (missing > max) return false;
    } else {
      counts.set(ch, available - 1);
    }
  }

  return true;
}
