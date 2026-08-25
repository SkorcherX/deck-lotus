/**
 * The bulk-bin list: what to look for while rummaging through a shop's
 * cheap-card boxes.
 *
 * This is a different errand from the shopping list it is built on, and the
 * differences are the whole point:
 *
 *   - Price is judged on the *cheapest printing anywhere*, not on the one the
 *     deck happens to list. You are not going to find a specific printing in a
 *     bin, and a card that is $8 in the set your deck names and $0.15 in three
 *     others belongs on this list.
 *   - The output is a flat A–Z list, not grouped by set. Set grouping is right
 *     for buying singles online and useless standing at a box.
 *   - Copies you own but that another deck is using are included, because a
 *     cheap common tied up elsewhere is exactly the thing worth grabbing a
 *     spare of instead of shuttling it between decks.
 *
 * Import-free, like shoppingMerge.js and deckReadiness.js — rows in, list out,
 * so it runs where the SQLite driver will not build.
 *
 * The printable version of this list is built in the client
 * (components/shopping.js), not here: it exports what is on screen, minus the
 * cards already ticked off, which is a fact only the page knows. A second
 * formatter on this side would drift from it silently.
 */

/** What a bulk box actually holds. Rares turn up, but not reliably. */
const BIN_RARITIES = ['common', 'uncommon'];

/** WUBRG order. Anything else — including a stray lowercase — is dropped. */
const COLOR_ORDER = ['W', 'U', 'B', 'R', 'G'];

/**
 * Colour identity as an ordered list of pips.
 *
 * Stored as a comma-joined string by scripts/import-mtgjson.js ("G,U"), but
 * older rows and other sources have been seen bare ("GU"), so the split is on
 * "not a letter" and then filtered against the five real colours rather than
 * trusting the separator.
 *
 * Sorted into WUBRG rather than left in whatever order the source used: the
 * whole point is a column you scan straight down, and Golgari drawn as B,G on
 * one line and G,B on the next defeats that.
 *
 * An empty result is meaningful and not an error — it is a colourless card,
 * which the reader still wants marked.
 */
export function colorPips(colorIdentity) {
  if (!colorIdentity) return [];

  const seen = new Set(
    String(colorIdentity)
      .toUpperCase()
      .split(/[^A-Z]+/)
      .join('')
      .split('')
  );

  return COLOR_ORDER.filter((c) => seen.has(c));
}

/**
 * Build the list.
 *
 * `entries` are the flattened cards from getShoppingList (with contested rows
 * included), and `cheapest` maps a card id to its cheapest priced printing
 * anywhere. Cards absent from that map have no price data at all — they are
 * not silently dropped but returned under `unpriced`, because a card missing
 * from a shopping list with no explanation is indistinguishable from a bug.
 */
export function buildBulkList(entries, cheapest, options = {}) {
  const {
    threshold = 1,
    commonsOnly = true,
    includeContested = true,
  } = options;

  const cards = [];
  const unpriced = [];
  let overThreshold = 0;
  let tooRare = 0;

  for (const entry of entries) {
    // Copies to actually look for. The shortfall is what you must buy; the
    // contested copies are ones you own but would otherwise have to pull out
    // of another deck. Adding them answers "what would make this deck stand on
    // its own" — which is the question you are at the shop to answer.
    const toBuy = entry.quantityNeeded || 0;
    const contested = includeContested ? entry.contested || 0 : 0;
    const quantity = toBuy + contested;

    if (quantity <= 0) continue;

    const printing = cheapest[entry.cardId];

    if (!printing || printing.price == null) {
      unpriced.push({ cardId: entry.cardId, name: entry.name, quantity });
      continue;
    }

    if (printing.price > threshold) {
      overThreshold += 1;
      continue;
    }

    const rarity = (printing.rarity || '').toLowerCase();

    if (commonsOnly && !BIN_RARITIES.includes(rarity)) {
      tooRare += 1;
      continue;
    }

    cards.push({
      cardId: entry.cardId,
      name: entry.name,
      quantity,
      // Kept apart so the line can say which copies are a purchase and which
      // are a card you already own somewhere else. They are not the same news.
      toBuy,
      contested,
      // Pre-split, so the page renders pips rather than re-parsing a database
      // format it should not have to know about.
      colors: colorPips(entry.colorIdentity),
      printingId: printing.printingId,
      printingUuid: printing.printingUuid,
      // The set and number of the *cheapest* printing, so you can check the
      // card in your hand is the one being quoted.
      setCode: printing.setCode,
      collectorNumber: printing.collectorNumber,
      rarity,
      price: printing.price,
      lineTotal: printing.price * quantity,
      decks: entry.decks || [],
      wanted: !!entry.wanted,
    });
  }

  // A–Z by name. Bulk boxes are not reliably sorted by anything, so the list
  // is ordered for the person reading it rather than for the box.
  cards.sort((a, b) => a.name.localeCompare(b.name));
  unpriced.sort((a, b) => a.name.localeCompare(b.name));

  return {
    cards,
    unpriced,
    totalCards: cards.length,
    totalCopies: cards.reduce((sum, c) => sum + c.quantity, 0),
    contestedCopies: cards.reduce((sum, c) => sum + c.contested, 0),
    estimatedTotal: cards.reduce((sum, c) => sum + c.lineTotal, 0),
    // Why the list is shorter than the shopping list. Without these the view
    // looks like it has lost cards.
    excluded: { overThreshold, tooRare, unpriced: unpriced.length },
  };
}

/**
 * Flatten the set-grouped shopping payload into plain entries.
 *
 * A card printed in several sets appears once per set in that structure. Here
 * it must appear once, with the claims added up: two entries would be two
 * lines for one card in the box, and you would look for it twice.
 */
export function flattenShoppingSets(sets) {
  const byCard = new Map();

  for (const set of sets || []) {
    for (const card of set.cards || []) {
      const existing = byCard.get(card.cardId);

      if (existing) {
        existing.quantityNeeded += card.quantityNeeded || 0;
        existing.contested += card.contested || 0;
        for (const deck of card.decks || []) {
          if (!existing.decks.some((d) => d.deckId === deck.deckId && d.boardType === deck.boardType)) {
            existing.decks.push(deck);
          }
        }
        existing.wanted = existing.wanted || !!card.wanted;
        continue;
      }

      byCard.set(card.cardId, {
        cardId: card.cardId,
        name: card.name,
        // Colour identity, not the mana cost: this is for spotting a card in a
        // box at a glance, and the cost of a card you are looking for is not
        // something you can see while it is still face-down in the row.
        colorIdentity: card.colorIdentity,
        quantityNeeded: card.quantityNeeded || 0,
        contested: card.contested || 0,
        decks: [...(card.decks || [])],
        wanted: !!card.wanted,
      });
    }
  }

  return Array.from(byCard.values());
}
