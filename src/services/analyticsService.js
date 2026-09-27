/**
 * The analytics page: what a user's collection is made of, what it is worth,
 * and when it changed.
 *
 * Only ever the caller's own collection. If a partner or share view is ever
 * added, it must not carry anything derived from decks — see the
 * partner-browse rules in CLAUDE.md.
 *
 * Copies are counted by quantity, and value is per copy with its finish
 * (OWNED_COPY_PRICE), so a playset of a $10 card is $40 and a foil is priced
 * as a foil.
 */
import db from '../db/connection.js';
import { OWNED_COPY_PRICE } from './inventoryService.js';
import { isBasicLand } from './basicLands.js';
import { summariseColors, summariseComposition, fillMonths, round2 } from './analyticsMath.js';

export function getSummary(userId) {
  const totals = db.get(`
    SELECT COALESCE(SUM(op.quantity), 0) AS total_cards,
           COUNT(DISTINCT p.card_id) AS unique_cards,
           COUNT(DISTINCT p.set_code) AS sets,
           COALESCE(SUM(CASE WHEN op.is_foil = 1 THEN op.quantity ELSE 0 END), 0) AS foil_cards,
           COALESCE(SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)), 0) AS total_value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
     WHERE op.user_id = ? AND op.quantity > 0
  `, [userId]);

  const recent = db.get(`
    SELECT COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0) AS added
      FROM audit_log
     WHERE user_id = ? AND entity_type = 'inventory'
       AND created_at >= datetime('now', '-30 days')
  `, [userId]);

  return {
    totalCards: totals.total_cards,
    uniqueCards: totals.unique_cards,
    sets: totals.sets,
    foilCards: totals.foil_cards,
    totalValue: round2(totals.total_value),
    addedLast30Days: recent.added,
  };
}

/**
 * Cards in and out, by month, from the audit log.
 *
 * The audit log is the only honest source: it records removals, and its
 * dates are when the change happened. `trackingSince` is its first row, so the
 * page can say that nothing before it is known rather than implying a quiet
 * start.
 */
export function getTimeline(userId) {
  const rows = db.all(`
    SELECT strftime('%Y-%m', created_at) AS month,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id = ? AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
     GROUP BY month
     ORDER BY month
  `, [userId]);

  const bySource = db.all(`
    SELECT source,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id = ? AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
     GROUP BY source
     ORDER BY added DESC
  `, [userId]);

  const first = db.get(
    `SELECT MIN(created_at) AS since FROM audit_log WHERE user_id = ? AND entity_type = 'inventory'`,
    [userId]
  );

  const thisMonth = new Date().toISOString().slice(0, 7);
  return {
    trackingSince: first?.since || null,
    months: fillMonths(rows, thisMonth),
    bySource,
  };
}

/** Every set the user owns something from, with copies and total value. */
export function getSets(userId) {
  const rows = db.all(`
    SELECT p.set_code AS code,
           COALESCE(s.name, p.set_code) AS name,
           s.release_date AS releaseDate,
           s.keyrune_code AS keyrune,
           SUM(op.quantity) AS copies,
           COUNT(DISTINCT p.card_id) AS uniqueCards,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      LEFT JOIN sets s ON s.code = p.set_code
     WHERE op.user_id = ? AND op.quantity > 0
     GROUP BY p.set_code
     ORDER BY value DESC
  `, [userId]);

  return rows.map((r) => ({ ...r, value: round2(r.value) }));
}

/** Copies and value per color bucket — see analyticsMath.colorCategory. */
export function getColors(userId) {
  const rows = db.all(`
    SELECT c.colors, c.type_line, c.supertypes,
           SUM(op.quantity) AS copies,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      JOIN cards c ON c.id = p.card_id
     WHERE op.user_id = ? AND op.quantity > 0
     GROUP BY c.id
  `, [userId]);

  return summariseColors(rows.map((r) => ({
    colors: r.colors,
    typeLine: r.type_line,
    isBasic: isBasicLand(r),
    copies: r.copies,
    value: r.value,
  })));
}

/** Card types, rarity and mana curve — see analyticsMath.summariseComposition. */
export function getComposition(userId) {
  const rows = db.all(`
    SELECT c.type_line, c.cmc, p.rarity,
           SUM(op.quantity) AS copies,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      JOIN cards c ON c.id = p.card_id
     WHERE op.user_id = ? AND op.quantity > 0
     GROUP BY p.id
  `, [userId]);

  return summariseComposition(rows.map((r) => ({
    typeLine: r.type_line, rarity: r.rarity, cmc: r.cmc, copies: r.copies, value: r.value,
  })));
}

/**
 * The most valuable owned rows, ranked by the price of one copy. Foil and
 * non-foil copies of a printing are separate rows, as they are priced.
 */
export function getTopCards(userId, limit = 10) {
  const rows = db.all(`
    SELECT * FROM (
      SELECT c.name, p.set_code AS setCode, p.collector_number AS collectorNumber,
             p.image_url AS imageUrl, op.is_foil AS isFoil, op.quantity,
             ${OWNED_COPY_PRICE} AS price
        FROM owned_printings op
        JOIN printings p ON p.id = op.printing_id
        JOIN cards c ON c.id = p.card_id
       WHERE op.user_id = ? AND op.quantity > 0
    )
     WHERE price IS NOT NULL
     ORDER BY price DESC
     LIMIT ?
  `, [userId, limit]);

  return rows.map((r) => ({
    ...r,
    isFoil: r.isFoil === 1,
    price: round2(r.price),
    total: round2(r.price * r.quantity),
  }));
}

/**
 * How much of each set the user has: distinct cards owned from it over
 * distinct cards printed in it. By card, not printing — a borderless variant
 * of a card already owned does not move the number, which is what "have I got
 * the set" means to most people.
 */
export function getSetCompletion(userId) {
  const rows = db.all(`
    WITH mine AS (
      SELECT p.set_code, COUNT(DISTINCT p.card_id) AS owned
        FROM owned_printings op
        JOIN printings p ON p.id = op.printing_id
       WHERE op.user_id = ? AND op.quantity > 0
       GROUP BY p.set_code
    )
    SELECT m.set_code AS code, COALESCE(s.name, m.set_code) AS name,
           s.release_date AS releaseDate, s.keyrune_code AS keyrune,
           m.owned,
           (SELECT COUNT(DISTINCT p2.card_id) FROM printings p2 WHERE p2.set_code = m.set_code) AS total
      FROM mine m
      LEFT JOIN sets s ON s.code = m.set_code
  `, [userId]);

  return rows
    .map((r) => ({ ...r, percent: r.total ? round2((r.owned / r.total) * 100) : 0 }))
    .sort((a, b) => b.percent - a.percent || b.owned - a.owned);
}

/**
 * Cards in and out per day for the last year, for the calendar. Only days with
 * activity are returned; the client lays out the empty ones.
 */
export function getDailyActivity(userId) {
  return db.all(`
    SELECT date(created_at) AS date,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id = ? AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
       AND created_at >= date('now', '-371 days')
     GROUP BY date(created_at)
     ORDER BY date
  `, [userId]);
}

export function getValueHistory(userId) {
  return db.all(`
    SELECT snapshot_date AS date, total_value AS value, total_cards AS cards
      FROM collection_value_snapshots
     WHERE user_id = ?
     ORDER BY snapshot_date
  `, [userId]);
}

/**
 * Write today's value for every user. Called after the daily price refresh,
 * which is the only time prices move. Re-running on the same day replaces
 * that day's row rather than adding one.
 */
export function recordValueSnapshots() {
  const users = db.all(`SELECT id FROM users`);
  const upsert = db.prepare(`
    INSERT INTO collection_value_snapshots (user_id, snapshot_date, total_value, total_cards, unique_cards)
    VALUES (?, date('now'), ?, ?, ?)
    ON CONFLICT(user_id, snapshot_date) DO UPDATE SET
      total_value = excluded.total_value,
      total_cards = excluded.total_cards,
      unique_cards = excluded.unique_cards,
      created_at = CURRENT_TIMESTAMP
  `);

  let written = 0;
  db.transaction(() => {
    for (const { id } of users) {
      const s = getSummary(id);
      upsert.run(id, s.totalValue, s.totalCards, s.uniqueCards);
      written++;
    }
  });
  return written;
}
