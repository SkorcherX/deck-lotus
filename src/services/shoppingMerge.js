/**
 * Merging the two halves of a shopping list.
 *
 * Split out of shoppingService because it is the one piece of that file that
 * is pure — rows in, structure out — and it is also the piece most worth
 * getting right: it decides how many copies of each card the page quotes a
 * price for. Everything else there needs a database, which is not something
 * every machine this repo is worked on can provide.
 *
 * Nothing here imports anything. Keep it that way.
 */

/**
 * Group rows from either half into the set-keyed structure the page renders.
 *
 * The same printing arriving from both halves is merged rather than repeated:
 * one entry that lists the decks needing it and also carries the wanted
 * quantity. Two entries would be double-counted by the totals and would send
 * the card to the cart optimizer twice.
 */
export function groupIntoSets(cards, totalDecks) {
  const setMap = new Map();

  for (const card of cards) {
    const setCode = card.set_code;

    if (!setMap.has(setCode)) {
      setMap.set(setCode, {
        setCode,
        setName: card.set_name || setCode.toUpperCase(),
        releaseDate: card.release_date,
        cards: [],
      });
    }

    const set = setMap.get(setCode);

    let entry = set.cards.find(
      (c) => c.cardId === card.card_id && c.printingId === card.printing_id
    );

    if (!entry) {
      entry = {
        cardId: card.card_id,
        printingId: card.printing_id,
        printingUuid: card.printing_uuid,
        name: card.name,
        manaCost: card.mana_cost,
        typeLine: card.type_line,
        colorIdentity: card.color_identity,
        setCode: card.set_code,
        collectorNumber: card.collector_number,
        rarity: card.rarity,
        imageUrl: card.image_url,
        price: card.price,
        decks: [],
        wanted: null,
      };
      set.cards.push(entry);
    }

    if (card.deck_id) {
      const already = entry.decks.find(
        (d) => d.deckId === card.deck_id && d.boardType === card.board_type
      );

      if (!already) {
        entry.decks.push({
          deckId: card.deck_id,
          deckName: card.deck_name,
          quantity: card.quantity,
          boardType: card.board_type,
        });
      }
    }

    if (card.wanted_id) {
      entry.wanted = {
        id: card.wanted_id,
        quantity: card.wanted_quantity,
        isFoil: card.wanted_is_foil === 1,
        note: card.wanted_note,
        addedAt: card.wanted_at,
        alreadyOwned: !!card.already_owned,
      };

      // A wanted row that carries its own price (foil, say) is the more
      // specific answer for this entry than the deck half's.
      if (card.price != null) entry.price = card.price;
    }
  }

  // How many copies to actually buy. The larger of the two claims, not their
  // sum: a card usually lands on the wanted list *because* a deck wants it,
  // and adding the two would quote four copies as five. Where only one half
  // has a claim, that half is the answer.
  for (const set of setMap.values()) {
    for (const entry of set.cards) {
      const forDecks = entry.decks.reduce((sum, d) => sum + (d.quantity || 0), 0);
      const forWanted = entry.wanted ? entry.wanted.quantity : 0;
      entry.quantityNeeded = Math.max(forDecks, forWanted, 1);
    }
  }

  const sets = Array.from(setMap.values()).sort((a, b) =>
    a.setName.localeCompare(b.setName)
  );

  const totalCards = sets.reduce((sum, set) => sum + set.cards.length, 0);
  const totalWanted = sets.reduce(
    (sum, set) => sum + set.cards.filter((c) => c.wanted).length,
    0
  );

  return { sets, totalCards, totalWanted, totalDecks };
}
