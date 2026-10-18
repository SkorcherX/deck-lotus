import db from '../db/connection.js';
import { scoreDeck } from '../shared/powerScore.js';
import { isBasicLand } from './basicLands.js';

/**
 * The database half of the power score: what each card costs and how popular
 * it is. The arithmetic is src/shared/powerScore.js.
 *
 * Price is the card's lowest USD price across every printing — the cheapest
 * way to own it, which is what demand for the card is about, not what this
 * deck's printing cost. TCGplayer and Card Kingdom only (Cardmarket is EUR).
 * Normal first; a card with no normal price anywhere falls back to its foil
 * price rather than reading as free. scripts/power-score-report.mjs goes
 * through here too, so the tuning report and the page cannot disagree.
 */

const CHUNK = 500;

/**
 * @param entries [{ cardId, quantity }] — one per card; quantities of the same
 *                card are summed
 * @returns scoreDeck's result
 */
export function scoreCardIds(entries) {
  const qty = new Map();
  for (const { cardId, quantity } of entries || []) {
    if (cardId == null) continue;
    qty.set(cardId, (qty.get(cardId) || 0) + (quantity || 1));
  }
  const ids = [...qty.keys()];

  const rows = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    rows.push(...db.all(
      `SELECT c.id, c.name, c.cmc, c.type_line, c.supertypes, c.edhrec_rank,
         MIN(CASE WHEN pr.price_type = 'normal' THEN pr.price END) AS normal_price,
         MIN(CASE WHEN pr.price_type = 'foil' THEN pr.price END) AS foil_price
       FROM cards c
       LEFT JOIN printings p ON p.card_id = c.id
       LEFT JOIN prices pr ON pr.printing_uuid = p.uuid
         AND pr.provider IN ('tcgplayer', 'cardkingdom') AND pr.price > 0
       WHERE c.id IN (${chunk.map(() => '?').join(',')})
       GROUP BY c.id`,
      chunk
    ));
  }

  return scoreDeck(rows.map((c) => ({
    name: c.name,
    cmc: c.cmc,
    quantity: qty.get(c.id),
    isLand: /\bLand\b/.test(c.type_line || ''),
    isBasicLand: isBasicLand(c),
    price: c.normal_price ?? c.foil_price,
    edhrecRank: c.edhrec_rank,
  })));
}

/** Mainboard and commander rows from getDeck, scored. */
export function scoreDeckCards(cards) {
  return scoreCardIds((cards || [])
    .filter((c) => c.is_commander || (c.board_type || (c.is_sideboard ? 'sideboard' : 'mainboard')) === 'mainboard')
    .map((c) => ({ cardId: c.card_id, quantity: c.quantity })));
}
