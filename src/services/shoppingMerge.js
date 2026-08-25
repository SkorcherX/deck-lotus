/**
 * Merging the two halves of a shopping list.
 *
 * Split out of shoppingService because it is the one piece of that file that
 * is pure — rows in, structure out — and it is also the piece most worth
 * getting right: it decides how many copies of each card the page quotes a
 * price for. Everything else there needs a database, which is not something
 * every machine this repo is worked on can provide.
 *
 * The one import is deckReadiness.js, which is pure for the same reason and
 * owns the rule for splitting a shortfall into "not owned" and "owned but
 * committed elsewhere". Two copies of that rule would mean the deck page and
 * this list disagreeing about what you are short of. Nothing else may be
 * imported here — keep it that way.
 */

import { assessCard } from './deckReadiness.js';

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
      // Ownership is a fact about the *card*, not about this printing: a copy
      // in any set fills the slot. The query therefore reports it once per
      // card and it is stashed here, to be allocated across that card's
      // printings after every row has been seen.
      if (card.card_needed != null) {
        entry.cardTotals = {
          needed: card.card_needed || 0,
          owned: card.card_owned || 0,
          elsewhere: card.card_elsewhere || 0,
        };
      }

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

  resolveQuantities(setMap);

  const sets = Array.from(setMap.values())
    // A set can be emptied by the step above — every card in it turned out to
    // be already owned. Leaving the header behind with nothing under it reads
    // as a rendering bug.
    .filter((set) => set.cards.length > 0)
    .sort((a, b) => a.setName.localeCompare(b.setName));

  const totalCards = sets.reduce((sum, set) => sum + set.cards.length, 0);
  const totalWanted = sets.reduce(
    (sum, set) => sum + set.cards.filter((c) => c.wanted).length,
    0
  );

  return { sets, totalCards, totalWanted, totalDecks };
}

/**
 * Decide how many copies of each entry to actually buy.
 *
 * Two things happen here and they are easy to confuse.
 *
 * The first is the shortfall. What a deck *lists* is not what you need to
 * buy — owning three of a four-of means buying one, not four. Ownership is
 * card-level, so the shortfall is worked out once per card and then handed
 * out across that card's printings, capped by what each printing was listed
 * for. Handing it out in list order is arbitrary but deterministic, and the
 * alternative — quoting the full shortfall against every printing — would
 * price a playset once per set it was ever printed in.
 *
 * The second is the merge with the wanted half: the *larger* of the two
 * claims, never their sum. A card usually lands on the wanted list because a
 * deck wants it, and adding them quotes a playset as five.
 */
function resolveQuantities(setMap) {
  // A card's printings can live in different sets, so this index has to be
  // built across the whole map rather than per set.
  const byCard = new Map();

  for (const set of setMap.values()) {
    for (const entry of set.cards) {
      if (!byCard.has(entry.cardId)) byCard.set(entry.cardId, []);
      byCard.get(entry.cardId).push(entry);
    }
  }

  for (const entries of byCard.values()) {
    const totals = entries.find((e) => e.cardTotals)?.cardTotals;

    // Rows with no ownership figures — the wanted half, and any caller still
    // on the old query — keep the pre-shortfall behaviour: what is listed is
    // what is quoted.
    let remainingMissing = totals ? assessCard(totals).missing : null;
    let remainingContested = totals ? assessCard(totals).contested : null;

    for (const entry of entries) {
      const listed = entry.decks.reduce((sum, d) => sum + (d.quantity || 0), 0);

      let forDecks = listed;
      entry.contested = 0;

      if (totals) {
        forDecks = Math.min(listed, remainingMissing);
        remainingMissing -= forDecks;

        // Copies you own but that another deck is already using. Not part of
        // the quantity to buy — you have them — but the bulk-bin view wants
        // them, because a cheap common tied up elsewhere is worth grabbing a
        // spare of rather than shuttling between decks.
        entry.contested = Math.min(listed - forDecks, remainingContested);
        remainingContested -= entry.contested;
      }

      entry.listed = listed;
      entry.shortfall = forDecks;
      entry.owned = totals ? totals.owned : null;

      const forWanted = entry.wanted ? entry.wanted.quantity : 0;
      const claimed = Math.max(forDecks, forWanted);

      // Zero is only ever a real answer when ownership figures explain it —
      // you already have the copies. Without them a zero means a malformed
      // row, and the old floor of 1 still applies: a free card on a shopping
      // list is never the right answer.
      entry.quantityNeeded = claimed > 0 ? claimed : totals ? 0 : 1;

      delete entry.cardTotals;
    }
  }

  // Drop what needs nothing. A contested entry stays: it needs no purchase for
  // the deck to be *listed* correctly, but the bulk view still has something
  // to say about it.
  for (const set of setMap.values()) {
    set.cards = set.cards.filter(
      (entry) => entry.quantityNeeded > 0 || entry.contested > 0 || entry.wanted
    );
  }
}
