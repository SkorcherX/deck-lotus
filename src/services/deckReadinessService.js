import db from '../db/connection.js';
import { assessDecks, describeState, stateRank } from './deckReadiness.js';

/**
 * The database half of deck readiness. The arithmetic lives in
 * deckReadiness.js, which is import-free and tested; this file's only job is
 * to hand it honest rows.
 *
 * Both entry points below run a fixed number of queries no matter how many
 * decks are involved. The deck list page renders every deck a user owns, so a
 * per-deck lookup here would be one query per card shown — the same trap
 * getDisruptionCounts and getDeckRecords already exist to avoid.
 */

// Maybeboard is not a claim on anything. It is a list of cards being
// considered, so counting it would report decks as short of cards their owner
// has not decided to play — and, worse, would make those cards look committed
// to every *other* deck's readiness too.
const PLAYED_BOARDS = `
  COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END)
    IN ('mainboard', 'sideboard')`;

const PLAYED_BOARDS_FOR = (alias) => `
  COALESCE(${alias}.board_type, CASE WHEN ${alias}.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END)
    IN ('mainboard', 'sideboard')`;

// Owned copies of the card in any printing and either finish. Readiness asks
// whether the deck can be played, and a non-foil plays like the foil the list
// asks for — deliberately looser than owned_printings' own foil-aware key.
const OWNED_TOTAL = `(
  SELECT COALESCE(SUM(op.quantity), 0)
    FROM owned_printings op
    JOIN printings op_p ON op.printing_id = op_p.id
   WHERE op.user_id = ? AND op_p.card_id = c.id
)`;

// Copies this user's *other* decks have claimed. The `d2.id != d.id` is the
// load-bearing part: without it every card in the deck being measured would
// compete with itself and a finished deck would report as needing a teardown.
const ELSEWHERE_TOTAL = `(
  SELECT COALESCE(SUM(dc2.quantity), 0)
    FROM deck_cards dc2
    JOIN printings dc2_p ON dc2.printing_id = dc2_p.id
    JOIN decks d2 ON dc2.deck_id = d2.id
   WHERE d2.user_id = ?
     AND d2.id != d.id
     AND dc2_p.card_id = c.id
     AND ${PLAYED_BOARDS_FOR('dc2')}
)`;

/**
 * Rows of `(deck, card, needed, owned, elsewhere)` for every deck a user owns,
 * or for one deck when `deckId` is given.
 */
function claimRows(userId, deckId = null) {
  const scoped = deckId != null ? ' AND d.id = ?' : '';

  const sql = `
    SELECT
      d.id as deck_id,
      c.id as card_id,
      c.name,
      SUM(dc.quantity) as needed,
      ${OWNED_TOTAL} as owned,
      ${ELSEWHERE_TOTAL} as elsewhere
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    JOIN printings p ON dc.printing_id = p.id
    JOIN cards c ON p.card_id = c.id
   WHERE d.user_id = ?
     AND ${PLAYED_BOARDS}${scoped}
   GROUP BY d.id, c.id`;

  // Order matters and is easy to get wrong: the two correlated subqueries in
  // the SELECT bind before the WHERE clause does.
  const params = [userId, userId, userId];
  if (deckId != null) params.push(deckId);

  return db.all(sql, params);
}

/** Deck ids, so decks holding no cards still get an entry rather than vanishing. */
function deckIdsFor(userId, deckId = null) {
  if (deckId != null) {
    const found = db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
    return found ? [found.id] : [];
  }

  return db.all(`SELECT id FROM decks WHERE user_id = ?`, [userId]).map((d) => d.id);
}

/**
 * Readiness for every deck a user owns, keyed by deck id.
 *
 * Shaped for the deck list: the per-card breakdown is dropped, because that is
 * potentially thousands of rows to render a badge with.
 */
export function getDeckReadinessSummaries(userId) {
  const assessed = assessDecks(claimRows(userId), deckIdsFor(userId));
  const summaries = new Map();

  for (const [deckId, deck] of assessed) {
    summaries.set(deckId, summarise(deck));
  }

  return summaries;
}

/**
 * Readiness for one deck, including the per-card breakdown the deck page
 * shows. Returns null for a deck this user does not own — the caller has
 * already made that check, but returning a confident "Ready" for somebody
 * else's deck id would be worse than a null.
 */
export function getDeckReadiness(userId, deckId) {
  const ids = deckIdsFor(userId, deckId);
  if (ids.length === 0) return null;

  const deck = assessDecks(claimRows(userId, deckId), ids).get(ids[0]);

  return {
    ...summarise(deck),
    // Only the cards that need something. The rest is the deck list, which
    // the page is already showing next to this.
    shortfalls: deck.cards.filter((c) => c.missing > 0 || c.contested > 0),
  };
}

function summarise(deck) {
  return {
    deckId: deck.deckId,
    state: deck.state,
    label: describeState(deck),
    rank: stateRank(deck.state),
    missingCopies: deck.missingCopies,
    contestedCopies: deck.contestedCopies,
    missingCards: deck.missingCards,
    contestedCards: deck.contestedCards,
    totalCopies: deck.totalCopies,
  };
}
