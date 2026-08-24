import db from '../db/connection.js';
import { parseDeckList, findCard } from './importService.js';
import { groupIntoSets } from './shoppingMerge.js';

/**
 * The shopping list has two halves.
 *
 * The derived half is what your decks need and you do not own — the original
 * feature, and still computed fresh on every read so it cannot disagree with
 * the decks it came from.
 *
 * The wanted half is `shopping_list_items`: cards somebody asked for that no
 * deck is asking for. Before it existed the only way to shop for a card you
 * merely wanted was to build a deck to hold it.
 *
 * They merge into one structure on read, which is the point. Everything
 * downstream — the filters, the totals, the Mana Pool cart optimizer, the
 * export — works on that structure and needed no knowledge of where a card
 * came from. A card that is both wanted and needed by a deck is one entry
 * carrying both facts, not two rows saying the same thing.
 */

// Set-and-printing columns, shared by both halves so the merged entries are
// the same shape whichever side produced them.
const CARD_COLUMNS = `
      c.id as card_id,
      c.name,
      c.mana_cost,
      c.type_line,
      c.color_identity,
      p.id as printing_id,
      p.uuid as printing_uuid,
      p.set_code,
      p.collector_number,
      p.rarity,
      p.image_url,
      s.name as set_name,
      s.release_date`;

// Foil copies price off the foil row and fall back to normal, the same rule
// the rest of the app uses. A foil you are shopping for that quotes the
// non-foil price is worse than quoting nothing.
const PRICE_FOR = (foilExpr) => `
      COALESCE(
        CASE WHEN ${foilExpr} THEN (
          SELECT price FROM prices
           WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'foil'
           LIMIT 1
        ) END,
        (SELECT price FROM prices
          WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal'
          LIMIT 1)
      )`;


/**
 * Get shopping list for selected decks
 * Returns cards needed (not owned) grouped by set
 */
export function getShoppingList(userId, deckIds) {
  // No decks selected is no longer the same as nothing to shop for: the
  // wanted list stands on its own, and returning early here is what used to
  // make the page go blank the moment you deselected everything.
  if (!deckIds || deckIds.length === 0) {
    return groupIntoSets(wantedCards(userId), 0);
  }

  // Get all unique cards needed from selected decks that user doesn't own
  const placeholders = deckIds.map(() => '?').join(',');

  const query = `
    SELECT DISTINCT
      ${CARD_COLUMNS},
      d.id as deck_id,
      d.name as deck_name,
      dc.quantity,
      COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) as board_type,
      ${PRICE_FOR('dc.is_foil = 1')} as price
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    JOIN printings p ON dc.printing_id = p.id
    JOIN cards c ON p.card_id = c.id
    LEFT JOIN sets s ON p.set_code = s.code
    LEFT JOIN owned_cards oc ON oc.user_id = ? AND oc.card_id = c.id
    WHERE d.user_id = ?
      AND d.id IN (${placeholders})
      AND oc.id IS NULL
    ORDER BY s.name, p.collector_number, c.name
  `;

  const params = [userId, userId, ...deckIds];
  const cards = db.all(query, params);

  return groupIntoSets([...cards, ...wantedCards(userId)], deckIds.length);
}

/**
 * The wanted half, as rows shaped like the deck half.
 *
 * Owned cards are deliberately NOT filtered out here, unlike the deck query.
 * A deck needing a card you own is not a shopping problem; a card you put on
 * the list by hand is a decision, and silently dropping it because a copy
 * turned up elsewhere would look like the list losing entries. The row says
 * you own it and the UI marks it.
 */
function wantedCards(userId) {
  return db.all(`
    SELECT
      ${CARD_COLUMNS},
      sli.id as wanted_id,
      sli.quantity as wanted_quantity,
      sli.is_foil as wanted_is_foil,
      sli.note as wanted_note,
      sli.created_at as wanted_at,
      (oc.id IS NOT NULL) as already_owned,
      ${PRICE_FOR('sli.is_foil = 1')} as price
    FROM shopping_list_items sli
    JOIN printings p ON sli.printing_id = p.id
    JOIN cards c ON p.card_id = c.id
    LEFT JOIN sets s ON p.set_code = s.code
    LEFT JOIN owned_cards oc ON oc.user_id = sli.user_id AND oc.card_id = c.id
    WHERE sli.user_id = ?
    ORDER BY s.name, p.collector_number, c.name
  `, [userId]);
}

// ---------------------------------------------------------------------------
// The wanted list
// ---------------------------------------------------------------------------

/**
 * Put a printing on the list, or raise the count if it is already there.
 *
 * Adding is additive rather than absolute because that is what the callers
 * mean: clicking "want" twice on Browse Cards means two copies, and pasting a
 * list that mentions a card twice means both lines counted. Setting an exact
 * number is what setWantedQuantity is for.
 */
export function addWantedCard(userId, { printingId, quantity = 1, isFoil = false, note = null }) {
  const wanted = Math.max(1, parseInt(quantity, 10) || 1);
  const foilFlag = isFoil ? 1 : 0;

  const printing = db.get(
    `SELECT p.id, p.set_code, p.collector_number, c.name
       FROM printings p JOIN cards c ON c.id = p.card_id
      WHERE p.id = ?`,
    [printingId]
  );

  if (!printing) throw new Error('Printing not found');

  db.run(
    `INSERT INTO shopping_list_items (user_id, printing_id, quantity, is_foil, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, printing_id, is_foil) DO UPDATE SET
       quantity = quantity + excluded.quantity,
       note = COALESCE(excluded.note, note),
       updated_at = CURRENT_TIMESTAMP`,
    [userId, printing.id, wanted, foilFlag, note]
  );

  return {
    printingId: printing.id,
    name: printing.name,
    setCode: printing.set_code,
    collectorNumber: printing.collector_number,
    quantity: wanted,
    isFoil: !!foilFlag,
  };
}

/** Set an exact count. Zero or less removes the row — see removeWantedCard. */
export function setWantedQuantity(userId, itemId, quantity) {
  const next = parseInt(quantity, 10);

  if (!Number.isFinite(next) || next <= 0) {
    return removeWantedCard(userId, itemId);
  }

  // Scoped by user_id as well as id, so an id from somebody else's list
  // matches nothing rather than editing their row.
  db.run(
    `UPDATE shopping_list_items
        SET quantity = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?`,
    [next, itemId, userId]
  );

  return { removed: false };
}

export function removeWantedCard(userId, itemId) {
  db.run(`DELETE FROM shopping_list_items WHERE id = ? AND user_id = ?`, [itemId, userId]);
  return { removed: true };
}

export function clearWantedCards(userId) {
  const before = db.get(
    `SELECT COUNT(*) as count FROM shopping_list_items WHERE user_id = ?`,
    [userId]
  ).count;

  db.run(`DELETE FROM shopping_list_items WHERE user_id = ?`, [userId]);

  return { cleared: before };
}

/**
 * Add a pasted block of text to the list.
 *
 * Deliberately the same parser the deck import and the inventory bulk add
 * use, including the nameless "1 FDN 1" set-and-collector form — people paste
 * the same text into all three boxes, and a list that accepted a slightly
 * different dialect would be a trap.
 *
 * Lines that resolve to nothing come back as `unresolved` rather than failing
 * the whole paste, for the same reason a deck import does not: a partial list
 * is a legitimate result, and the three bad set codes are what the caller
 * needs shown back to them.
 */
export function addWantedCardsBulk(userId, text) {
  const parsed = parseDeckList(text || '');

  const added = [];
  const unresolved = [];

  for (const line of parsed) {
    const card = findCard(line.name, line.setCode, line.collectorNumber);

    if (!card) {
      unresolved.push({
        line: line.line ?? null,
        name: line.name ?? null,
        setCode: line.setCode ?? null,
        collectorNumber: line.collectorNumber ?? null,
        quantity: line.quantity,
      });
      continue;
    }

    try {
      added.push(
        addWantedCard(userId, {
          printingId: card.printing_id,
          quantity: line.quantity,
          isFoil: !!line.isFoil,
        })
      );
    } catch (error) {
      unresolved.push({
        line: line.line ?? null,
        name: line.name ?? null,
        setCode: line.setCode ?? null,
        collectorNumber: line.collectorNumber ?? null,
        quantity: line.quantity,
        error: error.message,
      });
    }
  }

  return { added, unresolved, parsed: parsed.length };
}

/**
 * The cheapest printing of a card, for entry points that work at card level.
 *
 * Browse Cards knows a card, not a printing, and the list stores printings.
 * Cheapest is the right default for a shopping list specifically — you are
 * being quoted a price, and the quote should be the best one available. The
 * user can swap the printing afterwards.
 */
export function cheapestPrintingOf(cardId) {
  return db.get(
    `SELECT p.id
       FROM printings p
       LEFT JOIN prices pr
         ON pr.printing_uuid = p.uuid
        AND pr.provider = 'tcgplayer'
        AND pr.price_type = 'normal'
      WHERE p.card_id = ?
      ORDER BY CASE WHEN pr.price IS NULL THEN 1 ELSE 0 END, pr.price ASC, p.id ASC
      LIMIT 1`,
    [cardId]
  )?.id || null;
}
