/**
 * Matching a free-text sealed product name ("Kamigawa: Neon Dynasty - Set
 * Booster Display") to MTGJSON's catalog ("Kamigawa Neon Dynasty Set Booster
 * Box"). Import-free so it can be tested without the SQLite driver.
 *
 * Retailers and MTGJSON disagree on punctuation and on box/display, and
 * retailer names repeat the set name; the tokens that decide the match are
 * the product-type ones, so every token is compared after folding synonyms.
 */
const SYNONYMS = new Map([
  ['display', 'box'], ['booster box', 'box'], ['bundle', 'bundle'], ['fat pack', 'bundle'],
  ['boosters', 'booster'], ['packs', 'pack'], ['decks', 'deck'],
]);

export function normalizeSealedName(name) {
  let text = String(name || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/universes beyond/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const [from, to] of SYNONYMS) text = text.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  return text.replace(/\s+/g, ' ').trim();
}

// Tokens that say what kind of product it is, as opposed to which set.
const KIND = new Set([
  'draft', 'set', 'collector', 'play', 'jumpstart', 'bundle', 'prerelease', 'box', 'pack',
  'case', 'deck', 'commander', 'starter', 'theme', 'gift', 'planeswalker', 'challenger',
  'beginner', 'sample', 'tournament', 'intro', 'kit', 'vip', 'omega', 'minimal', 'secret', 'lair',
]);

function tokens(text) {
  return new Set(normalizeSealedName(text).split(' ').filter((t) => t && t !== 'the' && t !== 'of' && t !== 'magic' && t !== 'gathering'));
}

/**
 * Best catalog entry for `name`, or null. `candidates` are
 * `{ uuid, name, ... }`. Exact normalised match wins; otherwise the candidate
 * whose tokens best cover the query's, with a floor so a wrong product type
 * ("Draft" vs "Set") is never accepted just because the set name matched.
 */
export function matchSealedProduct(name, candidates) {
  const target = normalizeSealedName(name);
  const exact = candidates.find((c) => normalizeSealedName(c.name) === target);
  if (exact) return exact;

  const want = tokens(name);
  const wantKind = [...want].filter((t) => KIND.has(t)).sort().join(' ');
  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    const have = tokens(c.name);
    // What kind of product it is has to agree exactly — a Draft box is not a
    // Set box however well the set name matches.
    if ([...have].filter((t) => KIND.has(t)).sort().join(' ') !== wantKind) continue;
    let shared = 0;
    for (const t of want) if (have.has(t)) shared++;
    const missing = want.size - shared;
    const extra = have.size - shared;
    // Every query token must be there except at most one, and noise is penalised.
    if (missing > 1) continue;
    const score = shared / (want.size + extra * 0.5);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.6 ? best : null;
}
