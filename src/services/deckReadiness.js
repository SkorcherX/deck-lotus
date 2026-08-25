/**
 * Can this deck be sleeved up tonight, and if not, why not?
 *
 * There are two different ways to be short of a card and they call for
 * different actions, which is the whole reason this module exists rather than
 * a single "missing" count:
 *
 *   missing   — copies that are not in the collection at all. Buy them.
 *   contested — copies that exist but are already committed to another one of
 *               your decks. Cannibalise, or buy a spare.
 *
 * A deck reported simply as "short 3" cannot tell you which trip to make.
 *
 * Matching is at card level and ignores finish: readiness answers whether the
 * deck can be played, and a non-foil plays exactly like the foil the list
 * asks for. That is deliberately looser than `owned_printings` and
 * `deck_cards`, which key on `is_foil` because *those* are inventory and a
 * foil is a different object to own or trade.
 *
 * Nothing here imports anything — same rule as shoppingMerge.js, and for the
 * same reason: this is the part most worth testing and the SQLite driver will
 * not build everywhere this repo is worked on. Rows in, structure out.
 */

/** Deck states, worst-first. `rank` decides which one a deck ends up in. */
const STATES = {
  needs_buying: { rank: 3 },
  needs_assembly: { rank: 2 },
  ready: { rank: 1 },
  empty: { rank: 0 },
};

/**
 * Work out one card's standing for one deck.
 *
 * `elsewhere` is what this user's *other* decks have claimed — the caller must
 * already have excluded the deck being measured, or every card in it would
 * count as competing with itself and a perfectly built deck would report as
 * needing cannibalisation.
 */
function assessCard({ needed, owned, elsewhere }) {
  // Copies not spoken for by another deck. Over-commitment across decks can
  // push this negative, so it floors at zero.
  const free = Math.max(0, owned - elsewhere);

  const missing = Math.max(0, needed - owned);
  const usable = Math.min(needed, free);

  // What is left once the copies you can just pick up and the copies you do
  // not have are both accounted for: owned, but in use somewhere else.
  const contested = needed - missing - usable;

  return { needed, owned, elsewhere, free, missing, contested, usable };
}

/**
 * Fold per-card rows into per-deck readiness.
 *
 * Rows are keyed `(deckId, cardId)` but arrive one per `deck_cards` row, so a
 * card sitting in both the mainboard and the sideboard — or listed once foil
 * and once not — shows up more than once for the same deck. They are summed
 * here rather than in SQL so the aggregation is covered by tests.
 *
 * `deckIds` seeds the result so a deck with no cards still gets an entry;
 * a deck missing from the map reads as a bug at the call site, and an empty
 * deck reporting "Ready" would be a lie.
 */
export function assessDecks(rows, deckIds = []) {
  const decks = new Map();

  const deckFor = (deckId) => {
    if (!decks.has(deckId)) {
      decks.set(deckId, {
        deckId,
        state: 'empty',
        // Copies, not distinct cards. Being short one copy each of three
        // commons and short three copies of one common are different trips.
        missingCopies: 0,
        contestedCopies: 0,
        missingCards: 0,
        contestedCards: 0,
        totalCopies: 0,
        cards: [],
      });
    }
    return decks.get(deckId);
  };

  for (const deckId of deckIds) deckFor(deckId);

  // Sum the duplicate rows for a card first, then judge once. Judging each row
  // separately would compare the same owned copies against each board in turn
  // and call them free both times.
  const merged = new Map();

  for (const row of rows) {
    const key = `${row.deck_id}:${row.card_id}`;
    const existing = merged.get(key);

    if (existing) {
      existing.needed += row.needed || 0;
      continue;
    }

    merged.set(key, {
      deckId: row.deck_id,
      cardId: row.card_id,
      name: row.name,
      needed: row.needed || 0,
      owned: row.owned || 0,
      elsewhere: row.elsewhere || 0,
    });
  }

  for (const entry of merged.values()) {
    const deck = deckFor(entry.deckId);
    const assessed = assessCard(entry);

    deck.totalCopies += assessed.needed;
    deck.missingCopies += assessed.missing;
    deck.contestedCopies += assessed.contested;
    if (assessed.missing > 0) deck.missingCards += 1;
    if (assessed.contested > 0) deck.contestedCards += 1;

    deck.cards.push({
      cardId: entry.cardId,
      name: entry.name,
      ...assessed,
    });
  }

  for (const deck of decks.values()) {
    deck.state = stateFor(deck);

    // Worst first, then alphabetically — the point of the per-card list is the
    // shortfalls, and burying them under the cards that are fine makes it a
    // list you have to search rather than read.
    deck.cards.sort(
      (a, b) =>
        b.missing - a.missing ||
        b.contested - a.contested ||
        (a.name || '').localeCompare(b.name || '')
    );
  }

  return decks;
}

/**
 * Buying beats cannibalising: a deck that needs a shop trip *and* a teardown
 * is reported as needing the shop trip, because that is the blocking half.
 */
function stateFor(deck) {
  if (deck.totalCopies === 0) return 'empty';
  if (deck.missingCopies > 0) return 'needs_buying';
  if (deck.contestedCopies > 0) return 'needs_assembly';
  return 'ready';
}

/** Ordering helper for callers that want to surface the worst decks first. */
export function stateRank(state) {
  return STATES[state]?.rank ?? 0;
}

/**
 * The badge text. Kept here beside the states so a new state cannot be added
 * without a caller noticing it has no wording.
 */
export function describeState(deck) {
  switch (deck.state) {
    case 'needs_buying': {
      const parts = [`Short ${deck.missingCopies} to buy`];
      if (deck.contestedCopies > 0) parts.push(`${deck.contestedCopies} in other decks`);
      return parts.join(' · ');
    }
    case 'needs_assembly':
      return `Short ${deck.contestedCopies}, in other decks`;
    case 'ready':
      return 'Ready';
    case 'empty':
    default:
      return 'Empty';
  }
}
