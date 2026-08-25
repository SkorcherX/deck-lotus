import db from '../db/connection.js';

/**
 * The found pile — cards ticked off at a shop, not yet owned.
 *
 * See migration 036 for why this is not just an inventory write. In short:
 * the card you pull out of a bulk box shares a name with the one your deck
 * lists and almost never a printing, so the tick records the name and the
 * count, and choosing printings happens later at a keyboard.
 *
 * Everything here is per-user and keyed on `card_id`, matching the shopping
 * and bulk-bin lists, which are card-level for the same reason.
 */

/** The pile, newest first — the order a trip actually happened in. */
export function getFoundPile(userId) {
  return db.all(
    `SELECT f.id, f.card_id AS cardId, f.card_name AS name, f.quantity,
            f.created_at AS foundAt
       FROM found_cards f
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC, f.card_name`,
    [userId]
  );
}

/** Just the card ids, for marking up a list without shipping the whole pile. */
export function getFoundCardIds(userId) {
  return db.all(`SELECT card_id FROM found_cards WHERE user_id = ?`, [userId])
    .map((r) => r.card_id);
}

/**
 * Toggle one card in the pile, returning its new state.
 *
 * A toggle rather than an add because this is a button pressed one-handed
 * over a box: the second press is a correction, not a second copy. Quantity
 * is edited deliberately on the review screen instead.
 *
 * The name is resolved here rather than trusted from the client — it is what
 * the review screen resolves back into a printing, so a client sending the
 * wrong one would produce a pile that quietly buys the wrong card.
 */
export function toggleFound(userId, cardId, { quantity = 1 } = {}) {
  const existing = db.get(
    `SELECT id FROM found_cards WHERE user_id = ? AND card_id = ?`,
    [userId, cardId]
  );

  if (existing) {
    db.run(`DELETE FROM found_cards WHERE id = ?`, [existing.id]);
    return { found: false, cardId };
  }

  const card = db.get(`SELECT id, name FROM cards WHERE id = ?`, [cardId]);
  if (!card) {
    const error = new Error('Card not found');
    error.status = 404;
    throw error;
  }

  db.run(
    `INSERT INTO found_cards (user_id, card_id, card_name, quantity) VALUES (?, ?, ?, ?)`,
    [userId, cardId, card.name, Math.max(1, quantity)]
  );

  return { found: true, cardId, name: card.name, quantity: Math.max(1, quantity) };
}

/** Set how many copies were found. Zero drops the row — same as unfinding it. */
export function setFoundQuantity(userId, cardId, quantity) {
  const qty = Number(quantity);

  if (!Number.isFinite(qty) || qty <= 0) {
    db.run(`DELETE FROM found_cards WHERE user_id = ? AND card_id = ?`, [userId, cardId]);
    return { found: false, cardId };
  }

  db.run(
    `UPDATE found_cards SET quantity = ? WHERE user_id = ? AND card_id = ?`,
    [Math.round(qty), userId, cardId]
  );

  return { found: true, cardId, quantity: Math.round(qty) };
}

/**
 * Empty the pile.
 *
 * Called after the review screen has added the cards to the collection, and
 * available on its own for a trip abandoned halfway. It does not touch
 * inventory: the two steps are separate on purpose, so a failed import leaves
 * the pile intact to try again.
 */
export function clearFoundPile(userId) {
  const { count } = db.get(
    `SELECT COUNT(*) as count FROM found_cards WHERE user_id = ?`,
    [userId]
  );

  db.run(`DELETE FROM found_cards WHERE user_id = ?`, [userId]);
  return count;
}
