/**
 * Recognising a deck somebody bought rather than built.
 *
 * The advisor's findings assume a deck is its owner's work and every card in
 * it is a choice they can revisit. A preconstructed deck is not that. It came
 * in a box, it is internally coherent already, and handing its owner a wall of
 * warnings about its mana base tells them the thing they bought is broken —
 * which is both unhelpful and, for a product built by people who do this for a
 * living, mostly wrong.
 *
 * So a deck that is still substantially the precon gets its findings collapsed
 * behind one line naming the deck and how much of it is stock. Nothing is
 * deleted: precons genuinely do have weak mana and thin removal, and somebody
 * who wants that detail can still open it.
 *
 * ── Matching is by card overlap, never by name or commander ────────────────
 *
 * Two reasons, both learned from the data. Deck names are whatever the owner
 * typed. And the commander is not reliable either: the C21 deck "Witherbloom
 * Witchcraft" is sold with Willowdusk, Essence Seer as its face commander, but
 * the copy this was written against had been rebuilt around Beledros
 * Witherbloom — a mythic printed in the same box. Matching on the commander
 * would have missed a deck that is otherwise 90-odd percent stock, which is
 * precisely the case worth catching.
 *
 * Names are compared normalised, and never by `card_id` or `printing_id`: the
 * weekly MTGJSON sync rebuilds those tables, and a precon printed in 2021 has
 * to keep matching afterwards.
 */

import db from '../db/connection.js';
import { normalizeForSearch } from '../utils/cardNameMatch.js';

/**
 * How much of a deck must come from one precon before its findings collapse.
 *
 * There is no natural line here and this one is a judgement, not a
 * measurement: a deck at 0.90 and a deck at 0.89 are the same deck. It is a
 * single constant, and the exact percentage travels with every match, so a UI
 * can always say "96% stock" rather than only "precon: yes". Swapping a
 * commander and a couple of cards — the common case — lands around 0.95;
 * a precon used as a starting point and half rebuilt lands well below.
 */
export const STOCK_THRESHOLD = 0.90;

/**
 * Below this share, an overlap is coincidence rather than provenance.
 *
 * Every Commander deck contains Sol Ring, Command Tower and twenty-odd basic
 * lands, so any two decks in the same colours overlap substantially without
 * being related at all. Tested against the fixture, an unrelated Simic deck
 * matched a Gruul precon at 25% purely on basics and staples — reporting that
 * as "25% of this deck is Draconic Rage" would be a claim about where the deck
 * came from, and it would be false. Nothing below this is returned.
 */
const MATCH_FLOOR = 0.50;

/** Precons sharing fewer cards than this are not worth the exact comparison. */
const CANDIDATE_FLOOR = 10;

/**
 * How many candidates get the precise second pass.
 *
 * Raised from five when the sixty-card types went in and the stored set grew
 * from 190 decks to about 660. The shortlist is by distinct shared names, and
 * with that many decks a genuine match has more company near the top — every
 * deck of the same colours shares its basics and its staples. Each extra
 * candidate is one small query.
 */
const CANDIDATES = 8;

/**
 * Cards keyed by normalised name, with quantities summed.
 *
 * A deck can list the same card as two rows — two printings, or a foil and a
 * non-foil, which are separate rows by design — and for this comparison they
 * are two copies of one card.
 */
function byName(cards) {
  const totals = new Map();
  for (const card of cards) {
    const name = card.name || card.card_name;
    if (!name) continue;
    const key = normalizeForSearch(name);
    const existing = totals.get(key);
    const quantity = Number(card.quantity) || 1;
    if (existing) existing.quantity += quantity;
    else totals.set(key, { name, quantity });
  }
  return totals;
}

const sum = (entries) => [...entries].reduce((total, [, e]) => total + e.quantity, 0);

/**
 * Compare one deck against one precon's cards.
 *
 * `stock` is the share of the *deck* that came from the precon, which is the
 * question being asked — "is this thing still the box I bought?". The reverse
 * share is reported as `coverage`, because the two differ in a way that
 * matters: a 100-card deck holding 40 cards of a precon is 40% stock, while a
 * precon with 40 cards pulled out for a rebuild covers 60% and is not a precon
 * any more. Both come back so a caller need not guess which it wanted.
 */
export function compareToPrecon(deckCards, preconCards) {
  const deck = byName(deckCards);
  const precon = byName(preconCards);

  const deckTotal = sum(deck);
  const preconTotal = sum(precon);

  let shared = 0;
  const added = [];

  for (const [key, entry] of deck) {
    const inPrecon = precon.get(key);
    // Copies beyond what the precon holds are the owner's addition, so the
    // smaller of the two is what actually came out of the box.
    const overlap = inPrecon ? Math.min(entry.quantity, inPrecon.quantity) : 0;
    shared += overlap;
    if (entry.quantity > overlap) {
      added.push({ name: entry.name, quantity: entry.quantity - overlap });
    }
  }

  const removed = [];
  for (const [key, entry] of precon) {
    const inDeck = deck.get(key);
    const overlap = inDeck ? Math.min(entry.quantity, inDeck.quantity) : 0;
    if (entry.quantity > overlap) {
      removed.push({ name: entry.name, quantity: entry.quantity - overlap });
    }
  }

  return {
    shared,
    deckTotal,
    preconTotal,
    stock: deckTotal > 0 ? shared / deckTotal : 0,
    coverage: preconTotal > 0 ? shared / preconTotal : 0,
    added: added.sort((a, b) => a.name.localeCompare(b.name)),
    removed: removed.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The precon a deck most resembles, or null.
 *
 * Two passes. The first asks SQL which precons share any cards at all and
 * takes the few sharing most — cheap, and it discards 185 of 190 decks. The
 * second does the exact quantity-aware comparison on those, because the
 * shortlist is by distinct names and a deck of thirty Islands would otherwise
 * rank oddly.
 */
/**
 * Is this candidate a better match than the one already held?
 *
 * Ties need a rule, and they are not hypothetical: MTGJSON publishes the same
 * physical product more than once. "Tombstone" is a Theme Deck and "Tombstone
 * - Enhanced Deck" is an Advanced Deck with the same 60 cards, so a deck built
 * from that box matches both at exactly 1.0. Without a tiebreak the summary
 * line would name whichever the query happened to return first and could
 * change between page loads, which reads as a bug even though both answers are
 * right.
 *
 * Higher coverage wins first — the deck that has least left over is the closer
 * description. Then the shorter name, which sounds arbitrary and is not: the
 * duplicates are a base product and a variant of it, and the variant's name is
 * the base name with something appended. "Tyranid Swarm" and "Tyranid Swarm
 * Collector's Edition" hold the same cards, and the plain one is both the more
 * likely thing to own and the smaller claim to make about somebody's shelf.
 * The lower id settles anything still tied, because it is stable.
 */
function better(comparison, candidate, best) {
  if (comparison.stock !== best.comparison.stock) return comparison.stock > best.comparison.stock;
  if (comparison.coverage !== best.comparison.coverage) {
    return comparison.coverage > best.comparison.coverage;
  }

  const name = String(candidate.name || '');
  const heldName = String(best.candidate.name || '');
  if (name.length !== heldName.length) return name.length < heldName.length;

  return candidate.id < best.candidate.id;
}

export function findPreconMatch(deckCards, { threshold = STOCK_THRESHOLD } = {}) {
  const deck = byName(deckCards);
  if (deck.size === 0) return null;

  const names = [...deck.keys()];
  const placeholders = names.map(() => '?').join(',');

  const candidates = db.all(
    `SELECT pd.id, pd.name, pd.set_code, pd.type, pd.release_date, pd.total_cards,
            COUNT(DISTINCT pdc.card_name_normalized) AS shared_names
       FROM precon_deck_cards pdc
       JOIN precon_decks pd ON pd.id = pdc.precon_deck_id
      WHERE pdc.card_name_normalized IN (${placeholders})
      GROUP BY pd.id
     HAVING shared_names >= ?
      ORDER BY shared_names DESC
      LIMIT ?`,
    [...names, CANDIDATE_FLOOR, CANDIDATES]
  );

  if (candidates.length === 0) return null;

  let best = null;
  for (const candidate of candidates) {
    const cards = db.all(
      `SELECT card_name AS name, quantity, is_commander, is_sideboard
         FROM precon_deck_cards WHERE precon_deck_id = ?`,
      [candidate.id]
    );

    const comparison = compareToPrecon(deckCards, cards);
    if (!best || better(comparison, candidate, best)) {
      best = { candidate, comparison };
    }
  }

  if (!best || best.comparison.stock < MATCH_FLOOR) return null;

  const { candidate, comparison } = best;

  return {
    preconId: candidate.id,
    name: candidate.name,
    setCode: candidate.set_code,
    type: candidate.type,
    releaseDate: candidate.release_date,
    // The share of the deck that came out of the box, 0..1. Always reported,
    // so a caller can show the number rather than only the verdict.
    stock: Number(comparison.stock.toFixed(4)),
    coverage: Number(comparison.coverage.toFixed(4)),
    sharedCards: comparison.shared,
    deckSize: comparison.deckTotal,
    // Whether it is stock enough for findings to be collapsed.
    isStock: comparison.stock >= threshold,
    // What the owner changed, so the summary can be specific rather than
    // asserting the deck is untouched when it plainly is not.
    added: comparison.added,
    removed: comparison.removed,
  };
}

/** Is there any precon data at all? Used to skip the work entirely. */
export function hasPrecons() {
  return db.get(`SELECT COUNT(*) AS n FROM precon_decks`).n > 0;
}

/**
 * One line describing a match, for the summary the findings collapse behind.
 *
 * Phrased as an observation with the number in it, per the advisor's rule that
 * nothing built on inference is stated as a flat fact.
 */
export function describeMatch(match) {
  if (!match) return null;

  const percent = Math.round(match.stock * 100);
  const set = match.setCode ? ` (${match.setCode})` : '';

  if (match.stock >= 0.995) {
    return `This is the ${match.name}${set} preconstructed deck, unchanged.`;
  }

  const changes = [];
  if (match.added.length) changes.push(`${match.added.length} card${match.added.length === 1 ? '' : 's'} added`);
  if (match.removed.length) changes.push(`${match.removed.length} swapped out`);

  return `${percent}% of this deck is the ${match.name}${set} preconstructed deck`
    + `${changes.length ? `, with ${changes.join(' and ')}` : ''}.`;
}
