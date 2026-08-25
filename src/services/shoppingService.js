import db from '../db/connection.js';
import { parseDeckList, findCard } from './importService.js';
import { groupIntoSets } from './shoppingMerge.js';
import { buildBulkList, flattenShoppingSets } from './bulkBin.js';
import { isBasicLandSql } from './basicLands.js';
import { deckPrioritySql } from './deckPriority.js';

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

// ---------------------------------------------------------------------------
// Ownership, at card level
// ---------------------------------------------------------------------------
//
// What a deck lists is not what you have to buy. Owning three of a four-of
// means buying one — and until this existed, owning *one* meant the card
// vanished from the list entirely, because the old query asked only whether a
// copy existed at all. That silently hid exactly the partial playsets a
// shopping list is for.
//
// All three numbers below are per card, not per printing: a copy in any set
// fills the slot, in either finish. The rows still arrive per printing so the
// page can price and link a specific one, and shoppingMerge.js hands the
// card's shortfall out across them.

// Every copy owned, any printing, either finish.
//
// owned_printings, not owned_cards. The latter is a legacy presence table kept
// for backward compatibility whose quantity is written as a literal 1 (see
// cardService.js) — which is precisely why the old query here could only ask
// whether a copy existed. Counting it would put the partial-playset bug back.
const CARD_OWNED = `(
  SELECT COALESCE(SUM(op.quantity), 0)
    FROM owned_printings op
    JOIN printings op_p ON op.printing_id = op_p.id
   WHERE op.user_id = ? AND op_p.card_id = c.id
)`;

// What the decks being shopped for want between them. Deliberately counts
// every board including the maybeboard, which is what this list has always
// done: a maybeboard is a list of cards you are considering buying, and this
// is the page you buy them on.
const CARD_NEEDED_IN = (placeholders) => `(
  SELECT COALESCE(SUM(sel.quantity), 0)
    FROM deck_cards sel
    JOIN printings sel_p ON sel.printing_id = sel_p.id
    JOIN decks sel_d ON sel.deck_id = sel_d.id
   WHERE sel_d.user_id = ?
     AND sel_d.id IN (${placeholders})
     AND sel_p.card_id = c.id
)`;

/**
 * The best claim any *selected* deck has on this card, as a priority rank.
 *
 * Used to decide which unselected decks are allowed to contest it. Taking the
 * MIN — the most committed selected deck that wants the card — means shopping
 * for a Ready deck is not told its cards are tied up in an idea somebody
 * imported and never built.
 *
 * Per card rather than per selection, so a mixed bag of selected decks is
 * judged card by card instead of all being levelled to the weakest deck in
 * the set. That also keeps this identical to the readiness rule when a single
 * deck is selected, which is what stops the deck page and the shopping page
 * disagreeing about the same card.
 *
 * NULL when no selected deck lists the card — a wanted-list row, say. The
 * comparison below is written so that case counts every claim, because
 * without a deck of your own asking for it there is nothing to outrank.
 */
const BEST_SELECTED_PRIORITY = (placeholders) => `(
  SELECT MIN(${deckPrioritySql('pri_d')})
    FROM deck_cards pri
    JOIN printings pri_p ON pri.printing_id = pri_p.id
    JOIN decks pri_d ON pri.deck_id = pri_d.id
   WHERE pri_d.user_id = ?
     AND pri_d.id IN (${placeholders})
     AND pri_p.card_id = c.id
)`;

// Copies the decks you did *not* select have already claimed. Three things
// narrow this.
//
// Maybeboards are excluded, unlike CARD_NEEDED_IN above: a card another deck
// is merely considering is not spoken for, and treating it as committed would
// report copies as contested that are sitting free in the binder.
//
// The priority comparison excludes decks less committed than the one you are
// shopping for, so an idea nobody has built cannot make a finished deck look
// short. See deckPriority.js.
const CARD_ELSEWHERE_NOT_IN = (placeholders) => `(
  SELECT COALESCE(SUM(oth.quantity), 0)
    FROM deck_cards oth
    JOIN printings oth_p ON oth.printing_id = oth_p.id
    JOIN decks oth_d ON oth.deck_id = oth_d.id
   WHERE oth_d.user_id = ?
     AND oth_d.id NOT IN (${placeholders})
     AND oth_p.card_id = c.id
     AND COALESCE(oth.board_type, CASE WHEN oth.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END)
         IN ('mainboard', 'sideboard')
     AND ${deckPrioritySql('oth_d')} <= COALESCE(${BEST_SELECTED_PRIORITY(placeholders)}, 99)
)`;

const IS_BASIC_LAND = isBasicLandSql('c');

/**
 * Get shopping list for selected decks, grouped by set.
 *
 * "Needed" means the shortfall, not what the decks list: owning three of a
 * four-of puts one copy on the list, and owning all four puts none. Until this
 * counted quantities, owning a single copy removed the card outright — which
 * hid exactly the partial playsets the page exists to fill.
 */
export function getShoppingList(userId, deckIds, { includeContested = false } = {}) {
  // No decks selected is no longer the same as nothing to shop for: the
  // wanted list stands on its own, and returning early here is what used to
  // make the page go blank the moment you deselected everything.
  if (!deckIds || deckIds.length === 0) {
    return groupIntoSets(wantedCards(userId), 0);
  }

  const placeholders = deckIds.map(() => '?').join(',');

  // Wrapped so the filter can be written once against the computed columns. It
  // is a filter rather than a job for the merge module because otherwise every
  // card in every selected deck comes back over the wire.
  //
  // Which filter depends on what the caller is shopping for. By default:
  // copies that do not exist in the collection — the shopping list proper.
  //
  // `includeContested` widens it to copies that exist but are committed to a
  // deck you did not select. Those need no purchase for the selected decks to
  // be *listed* correctly, so they are off by default: every consumer of this
  // payload reads `quantityNeeded || 1`, and a zero-quantity entry would
  // become one copy of a card you already own sitting in the cart. The
  // bulk-bin view asks for them deliberately, and quotes them itself.
  const query = `
    SELECT * FROM (
      SELECT DISTINCT
        ${CARD_COLUMNS},
        d.id as deck_id,
        d.name as deck_name,
        dc.quantity,
        COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) as board_type,
        ${PRICE_FOR('dc.is_foil = 1')} as price,
        ${CARD_NEEDED_IN(placeholders)} as card_needed,
        ${CARD_OWNED} as card_owned,
        ${CARD_ELSEWHERE_NOT_IN(placeholders)} as card_elsewhere
      FROM deck_cards dc
      JOIN decks d ON dc.deck_id = d.id
      JOIN printings p ON dc.printing_id = p.id
      JOIN cards c ON p.card_id = c.id
      LEFT JOIN sets s ON p.set_code = s.code
      WHERE d.user_id = ?
        AND d.id IN (${placeholders})
        -- Basic lands are never shopped for. See basicLands.js: they are
        -- exempt from availability everywhere, so a list that quoted 24
        -- Islands would be quoting a trip nobody makes. Hand-added wanted
        -- rows below are untouched — putting an Island on the list yourself
        -- is a decision, not a derived shortfall.
        AND NOT ${IS_BASIC_LAND}
    )
    WHERE ${includeContested
      ? 'MAX(0, card_owned - card_elsewhere) < card_needed'
      : 'card_owned < card_needed'}
    ORDER BY set_name, collector_number, name
  `;

  // Bound in the order the `?`s appear: the three correlated subqueries in the
  // SELECT come before the WHERE clause, and two of them carry the deck list.
  const params = [
    userId, ...deckIds,   // card_needed
    userId,               // card_owned
    userId, ...deckIds,   // card_elsewhere
    userId, ...deckIds,   // ...and its nested BEST_SELECTED_PRIORITY
    userId, ...deckIds,   // WHERE
  ];

  const cards = db.all(query, params);

  const list = groupIntoSets([...cards, ...wantedCards(userId)], deckIds.length);

  // A contested row without the name of the deck holding the copy reads as the
  // list quoting a card you already have. The bulk view learned this first and
  // decorates its own flattened entries; the set-grouped view needs it for the
  // same reason, so the lookup happens here — one query for the page, not one
  // per contested card.
  if (includeContested) {
    const entries = list.sets.flatMap((set) => set.cards);
    const holders = decksHoldingCards(userId, entries.map((e) => e.cardId), deckIds);
    for (const entry of entries) {
      if (entry.contested) entry.heldBy = holders.get(entry.cardId) || [];
    }
  }

  return list;
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

// ---------------------------------------------------------------------------
// The bulk-bin view
// ---------------------------------------------------------------------------

// SQLite's default limit is 999 bound parameters, and a shopping list for a
// few Commander decks clears that easily. Splitting the lookup is cheaper than
// raising the limit at the connection.
const PARAM_CHUNK = 900;

function chunked(values, size = PARAM_CHUNK) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * The cheapest priced printing of each card, keyed by card id.
 *
 * Card level, not printing level, because that is the question a bulk box
 * answers: any copy fills the slot, so the price that matters is the best one
 * in print anywhere, not the one the deck happens to name.
 *
 * The bare columns alongside MIN() are deliberate and are not a GROUP BY
 * mistake: SQLite guarantees that when a query uses a single MIN() or MAX()
 * aggregate, the other columns come from the row that produced it. That is
 * what makes this one query rather than one per card.
 */
export function cheapestPrintingsFor(cardIds) {
  const found = {};
  if (!cardIds || cardIds.length === 0) return found;

  for (const chunk of chunked([...new Set(cardIds)])) {
    const placeholders = chunk.map(() => '?').join(',');

    const rows = db.all(
      `SELECT
         p.card_id as card_id,
         p.id as printing_id,
         p.uuid as printing_uuid,
         p.set_code,
         p.collector_number,
         p.rarity,
         MIN(pr.price) as price
       FROM printings p
       JOIN prices pr
         ON pr.printing_uuid = p.uuid
        AND pr.provider = 'tcgplayer'
        AND pr.price_type = 'normal'
      WHERE p.card_id IN (${placeholders})
        AND pr.price IS NOT NULL
        AND pr.price > 0
      GROUP BY p.card_id`,
      chunk
    );

    for (const row of rows) {
      found[row.card_id] = {
        printingId: row.printing_id,
        printingUuid: row.printing_uuid,
        setCode: row.set_code,
        collectorNumber: row.collector_number,
        rarity: row.rarity,
        price: row.price,
      };
    }
  }

  return found;
}

/** The user's bulk price ceiling, falling back to the column default. */
export function getBulkThreshold(userId) {
  const row = db.get(`SELECT bulk_price_threshold FROM users WHERE id = ?`, [userId]);
  return row?.bulk_price_threshold ?? 1;
}

/**
 * Save the ceiling. Clamped rather than rejected: the control is a number box
 * on the page, and a stray keystroke should not throw an error at somebody
 * who is halfway out the door to a card shop.
 */
export function setBulkThreshold(userId, value) {
  const parsed = Number.parseFloat(value);
  const threshold = Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : 1;

  db.run(
    `UPDATE users SET bulk_price_threshold = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [threshold, userId]
  );

  return threshold;
}

/**
 * Which of your *other* decks are holding copies of these cards.
 *
 * A contested row is on the bulk list because a deck you are not shopping for
 * has the copy you own. Without naming that deck the row reads as a card you
 * need for the deck you selected — which you already own, so the list looks
 * like it is telling you to buy something twice. The name is the whole
 * explanation for the row's presence.
 *
 * Deliberately names decks without counting them: the number on the row is
 * `contested`, worked out by the merge and capped by what the selected decks
 * actually list. A second count derived here would be the same figure computed
 * a different way, and the two would disagree the first time a card was listed
 * in more places than it was owned.
 *
 * Board rule matches CARD_ELSEWHERE_NOT_IN exactly. If it did not, a card
 * could be reported as held by a deck that the count above says is not holding
 * it.
 */
function decksHoldingCards(userId, cardIds, excludeDeckIds) {
  if (!cardIds || cardIds.length === 0) return new Map();

  const byCard = new Map();
  const excluded = excludeDeckIds || [];
  const excludeSql = excluded.length
    ? `AND d.id NOT IN (${excluded.map(() => '?').join(',')})`
    : '';

  // Must match CARD_ELSEWHERE_NOT_IN's priority rule exactly. If it did not,
  // a row would name a deck as holding a copy that the contested count above
  // it never counted — and the number and the name sit on the same line.
  const prioritySql = excluded.length
    ? `AND ${deckPrioritySql('d')} <= COALESCE((
         SELECT MIN(${deckPrioritySql('pri_d')})
           FROM deck_cards pri
           JOIN printings pri_p ON pri.printing_id = pri_p.id
           JOIN decks pri_d ON pri.deck_id = pri_d.id
          WHERE pri_d.id IN (${excluded.map(() => '?').join(',')})
            AND pri_p.card_id = p.card_id
       ), 99)`
    : '';

  // The deck list rides in the same statement, so it comes out of the same
  // variable budget — without this a user with a lot of decks could push a
  // full chunk past SQLite's limit and the whole view would 500.
  for (const chunk of chunked(cardIds, Math.max(1, PARAM_CHUNK - (excluded.length * 2) - 1))) {
    const rows = db.all(
      `SELECT p.card_id as card_id,
              d.id as deck_id,
              d.name as deck_name,
              SUM(dc.quantity) as quantity
         FROM deck_cards dc
         JOIN decks d ON dc.deck_id = d.id
         JOIN printings p ON dc.printing_id = p.id
        WHERE d.user_id = ?
          ${excludeSql}
          ${prioritySql}
          AND p.card_id IN (${chunk.map(() => '?').join(',')})
          AND COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END)
              IN ('mainboard', 'sideboard')
        GROUP BY p.card_id, d.id
        ORDER BY d.name`,
      [userId, ...excluded, ...(excluded.length ? excluded : []), ...chunk]
    );

    for (const row of rows) {
      if (!byCard.has(row.card_id)) byCard.set(row.card_id, []);
      byCard.get(row.card_id).push({
        deckId: row.deck_id,
        deckName: row.deck_name,
        quantity: row.quantity,
      });
    }
  }

  return byCard;
}

/**
 * What to look for in a shop's cheap-card boxes.
 *
 * Built on the same shopping list as the set-grouped view, asked with
 * `includeContested` — a cheap common tied up in another deck is worth
 * grabbing a spare of rather than shuttling between decks, and that is exactly
 * the card a bin turns up. The filtering and ordering are in bulkBin.js, which
 * is pure and tested.
 */
export function getBulkBinList(userId, deckIds, options = {}) {
  const threshold = options.threshold != null ? Number(options.threshold) : getBulkThreshold(userId);

  const shopping = getShoppingList(userId, deckIds, { includeContested: true });
  const entries = flattenShoppingSets(shopping.sets);
  const cheapest = cheapestPrintingsFor(entries.map((e) => e.cardId));

  // One query for the whole list, not one per contested card — this view
  // renders every cheap card several decks are fighting over.
  const holders = decksHoldingCards(userId, entries.map((e) => e.cardId), deckIds);
  for (const entry of entries) {
    entry.heldBy = holders.get(entry.cardId) || [];
  }

  const list = buildBulkList(entries, cheapest, {
    threshold,
    commonsOnly: options.commonsOnly !== false,
    includeContested: options.includeContested !== false,
  });

  return {
    ...list,
    threshold,
    commonsOnly: options.commonsOnly !== false,
    includeContested: options.includeContested !== false,
    totalDecks: shopping.totalDecks,
  };
}
