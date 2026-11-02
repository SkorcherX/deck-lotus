import db from '../db/connection.js';
import { NOT_A_STAND_IN } from '../shared/standInPrintings.js';

/**
 * The cheapest printing of a card, for entry points that work at card level:
 * a shopping-list line, a Browse Cards "want", a deck-list line that named a
 * card but no set.
 *
 * Browse Cards knows a card, not a printing, and the list stores printings.
 * Cheapest is the right default for a shopping list specifically — you are
 * being quoted a price, and the quote should be the best one available. The
 * user can swap the printing afterwards.
 */
export function cheapestPrintingOf(cardId) {
  // English first, whatever the price: a cheaper Japanese printing is not a
  // printing the user asked for, and its art cannot be read. `language` held
  // 'en' for every printing until the import carried MTGJSON's value, so the
  // Japanese alternate arts are also caught by their ★ collector numbers.
  // Then memorabilia and the like never ahead of a real printing, then price,
  // unpriced and zero-priced last.
  return db.get(
    `SELECT p.id
       FROM printings p
       LEFT JOIN sets s ON s.code = p.set_code
       LEFT JOIN prices pr
         ON pr.printing_uuid = p.uuid
        AND pr.provider = 'tcgplayer'
        AND pr.price_type = 'normal'
      WHERE p.card_id = ?
      ORDER BY COALESCE(p.language, 'en') NOT IN ('en', 'English'),
               p.collector_number LIKE '%★%',
               COALESCE(s.type, '') IN (${NOT_A_STAND_IN.map(() => '?').join(',')}),
               CASE WHEN pr.price IS NULL OR pr.price <= 0 THEN 1 ELSE 0 END, pr.price ASC,
               s.release_date DESC, p.id ASC
      LIMIT 1`,
    [cardId, ...NOT_A_STAND_IN]
  )?.id || null;
}
