/**
 * The analytics page: what a collection is made of, what it is worth, and
 * when it changed.
 *
 * Every function takes a scope: one user id, or several. A regular user only
 * ever gets their own id — `resolveScope` in routes/analytics.js decides, never
 * the query. Several ids is an admin looking at a household as one collection,
 * and the numbers are then the household's: cards moving between two people
 * inside the scope (a trade, a loan) never left it, so they are not counted as
 * coming in, going out, or lent out.
 *
 * Copies are counted by quantity, and value is per copy with its finish
 * (OWNED_COPY_PRICE), so a playset of a $10 card is $40 and a foil is priced
 * as a foil.
 */
import db from '../db/connection.js';
import { OWNED_COPY_PRICE } from './inventoryService.js';
import { isBasicLand } from './basicLands.js';
import { LIVE_LOAN_STATUSES } from './loanHoldings.js';
import {
  summariseColors, summariseComposition, summariseDeckUse, fillMonths, round2,
} from './analyticsMath.js';

const LIVE_LOANS = `(${LIVE_LOAN_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * `in` is a parenthesised placeholder list to interpolate after IN; `ids` the
 * params that fill it. Take `in` once per use in a query and spread `ids` the
 * same number of times, in the same order.
 */
function scopeOf(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).map(Number);
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    throw new Error('Analytics scope must be one or more user ids');
  }
  return { in: `(${ids.map(() => '?').join(',')})`, ids };
}

export function getSummary(userIds) {
  const s = scopeOf(userIds);
  const totals = db.get(`
    SELECT COALESCE(SUM(op.quantity), 0) AS total_cards,
           COUNT(DISTINCT p.card_id) AS unique_cards,
           COUNT(DISTINCT p.set_code) AS sets,
           COALESCE(SUM(CASE WHEN op.is_foil = 1 THEN op.quantity ELSE 0 END), 0) AS foil_cards,
           COALESCE(SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)), 0) AS total_value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
     WHERE op.user_id IN ${s.in} AND op.quantity > 0
  `, s.ids);

  const recent = db.get(`
    SELECT COALESCE(SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END), 0) AS added
      FROM audit_log
     WHERE user_id IN ${s.in} AND entity_type = 'inventory'
       AND created_at >= datetime('now', '-30 days')
  `, s.ids);

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
 * start. In a combined scope a trade between two of its members shows as both
 * an add and a removal — each person's collection really did change.
 */
export function getTimeline(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT strftime('%Y-%m', created_at) AS month,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id IN ${s.in} AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
     GROUP BY month
     ORDER BY month
  `, s.ids);

  const bySource = db.all(`
    SELECT source,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id IN ${s.in} AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
     GROUP BY source
     ORDER BY added DESC
  `, s.ids);

  const first = db.get(
    `SELECT MIN(created_at) AS since FROM audit_log WHERE user_id IN ${s.in} AND entity_type = 'inventory'`,
    s.ids
  );

  const thisMonth = new Date().toISOString().slice(0, 7);
  return {
    trackingSince: first?.since || null,
    months: fillMonths(rows, thisMonth),
    bySource,
  };
}

/** Every set the scope owns something from, with copies and total value. */
export function getSets(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT p.set_code AS code,
           COALESCE(st.name, p.set_code) AS name,
           st.release_date AS releaseDate,
           st.keyrune_code AS keyrune,
           SUM(op.quantity) AS copies,
           COUNT(DISTINCT p.card_id) AS uniqueCards,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      LEFT JOIN sets st ON st.code = p.set_code
     WHERE op.user_id IN ${s.in} AND op.quantity > 0
     GROUP BY p.set_code
     ORDER BY value DESC
  `, s.ids);

  return rows.map((r) => ({ ...r, value: round2(r.value) }));
}

/** Copies and value per color bucket — see analyticsMath.colorCategory. */
export function getColors(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT c.colors, c.type_line, c.supertypes,
           SUM(op.quantity) AS copies,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      JOIN cards c ON c.id = p.card_id
     WHERE op.user_id IN ${s.in} AND op.quantity > 0
     GROUP BY c.id
  `, s.ids);

  return summariseColors(rows.map((r) => ({
    colors: r.colors,
    typeLine: r.type_line,
    isBasic: isBasicLand(r),
    copies: r.copies,
    value: r.value,
  })));
}

/** Card types, rarity and mana curve — see analyticsMath.summariseComposition. */
export function getComposition(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT c.type_line, c.cmc, p.rarity,
           SUM(op.quantity) AS copies,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      JOIN cards c ON c.id = p.card_id
     WHERE op.user_id IN ${s.in} AND op.quantity > 0
     GROUP BY p.id
  `, s.ids);

  return summariseComposition(rows.map((r) => ({
    typeLine: r.type_line, rarity: r.rarity, cmc: r.cmc, copies: r.copies, value: r.value,
  })));
}

/**
 * The most valuable owned printings, ranked by the price of one copy. Foil and
 * non-foil are separate rows, as they are priced. Grouped across the scope, so
 * two people each holding one copy show as one row of two.
 */
export function getTopCards(userIds, limit = 10) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT * FROM (
      SELECT c.name, p.set_code AS setCode, p.collector_number AS collectorNumber,
             p.image_url AS imageUrl, op.is_foil AS isFoil, SUM(op.quantity) AS quantity,
             ${OWNED_COPY_PRICE} AS price
        FROM owned_printings op
        JOIN printings p ON p.id = op.printing_id
        JOIN cards c ON c.id = p.card_id
       WHERE op.user_id IN ${s.in} AND op.quantity > 0
       GROUP BY p.id, op.is_foil
    )
     WHERE price IS NOT NULL
     ORDER BY price DESC
     LIMIT ?
  `, [...s.ids, limit]);

  return rows.map((r) => ({
    ...r,
    isFoil: r.isFoil === 1,
    price: round2(r.price),
    total: round2(r.price * r.quantity),
  }));
}

/**
 * How much of each set the scope has: distinct cards owned from it over
 * distinct cards printed in it. By card, not printing — a borderless variant
 * of a card already owned does not move the number, which is what "have I got
 * the set" means to most people. Across a household, a card counts once
 * whoever holds it.
 */
export function getSetCompletion(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    WITH mine AS (
      SELECT p.set_code, COUNT(DISTINCT p.card_id) AS owned
        FROM owned_printings op
        JOIN printings p ON p.id = op.printing_id
       WHERE op.user_id IN ${s.in} AND op.quantity > 0
       GROUP BY p.set_code
    )
    SELECT m.set_code AS code, COALESCE(st.name, m.set_code) AS name,
           st.release_date AS releaseDate, st.keyrune_code AS keyrune,
           m.owned,
           (SELECT COUNT(DISTINCT p2.card_id) FROM printings p2 WHERE p2.set_code = m.set_code) AS total
      FROM mine m
      LEFT JOIN sets st ON st.code = m.set_code
  `, s.ids);

  return rows
    .map((r) => ({ ...r, percent: r.total ? round2((r.owned / r.total) * 100) : 0 }))
    .sort((a, b) => b.percent - a.percent || b.owned - a.owned);
}

/**
 * Cards in and out per day for the last year, for the calendar. Only days with
 * activity are returned; the client lays out the empty ones.
 */
export function getDailyActivity(userIds) {
  const s = scopeOf(userIds);
  return db.all(`
    SELECT date(created_at) AS date,
           SUM(CASE WHEN quantity_delta > 0 THEN quantity_delta ELSE 0 END) AS added,
           SUM(CASE WHEN quantity_delta < 0 THEN -quantity_delta ELSE 0 END) AS removed
      FROM audit_log
     WHERE user_id IN ${s.in} AND entity_type = 'inventory' AND quantity_delta IS NOT NULL
       AND created_at >= date('now', '-371 days')
     GROUP BY date(created_at)
     ORDER BY date
  `, s.ids);
}

/**
 * How much of the collection is doing something: in decks, lent out, or idle.
 * Counted per card (any printing), against the scope's own decks and loans,
 * the same way the Inventory page's In Decks and Lent Out columns count — see
 * analyticsMath.summariseDeckUse for the split.
 *
 * Only a loan to someone outside the scope is "lent out". Lent within a
 * household, the copy is still in the household, and if the borrower has put
 * it in a deck, that deck's listing already counts it.
 */
export function getDeckUse(userIds) {
  const s = scopeOf(userIds);
  const rows = db.all(`
    SELECT c.name, c.type_line, c.supertypes,
           SUM(op.quantity) AS owned,
           SUM(op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)) AS value,
           (SELECT COALESCE(SUM(dc.quantity), 0)
              FROM deck_cards dc
              JOIN printings dp ON dp.id = dc.printing_id
              JOIN decks d ON d.id = dc.deck_id
             WHERE d.user_id IN ${s.in} AND dp.card_id = c.id) AS in_decks,
           (SELECT COALESCE(SUM(cl.quantity), 0)
              FROM card_loans cl
              JOIN printings lp ON lp.uuid = cl.printing_uuid
             WHERE cl.lender_user_id IN ${s.in} AND cl.borrower_user_id NOT IN ${s.in}
               AND lp.card_id = c.id AND cl.status IN ${LIVE_LOANS}) AS lent
      FROM owned_printings op
      JOIN printings p ON p.id = op.printing_id
      JOIN cards c ON c.id = p.card_id
     WHERE op.user_id IN ${s.in} AND op.quantity > 0
     GROUP BY c.id
  `, [...s.ids, ...s.ids, ...s.ids, ...s.ids]);

  return summariseDeckUse(rows.map((r) => ({
    name: r.name,
    owned: r.owned,
    inDecks: r.in_decks,
    lent: r.lent,
    value: r.value,
    isBasic: isBasicLand(r),
  })));
}

/**
 * Trade and loan activity from the scope's side only: counts and card totals,
 * never the other party's collection or decks.
 *
 * Trade item `direction` is relative to the proposer (`from_user_id`): 'give'
 * moves a card from the proposer to the recipient, 'receive' the other way.
 * A card comes *in* when it lands with someone in the scope from someone
 * outside it, and goes *out* the reverse; a trade or loan between two members
 * is counted under `withinGroup` instead. Declined items never moved and are
 * excluded.
 */
export function getTradesAndLoans(userIds) {
  const s = scopeOf(userIds);
  const both = [...s.ids, ...s.ids];

  const trades = db.all(`
    SELECT status,
           COUNT(*) AS count,
           SUM(CASE WHEN from_user_id IN ${s.in} AND to_user_id IN ${s.in} THEN 1 ELSE 0 END) AS internal
      FROM trades
     WHERE from_user_id IN ${s.in} OR to_user_id IN ${s.in}
     GROUP BY status
  `, [...both, ...both]);

  // giver/receiver per item, then in = lands inside from outside, out = reverse.
  const moved = db.get(`
    WITH items AS (
      SELECT ti.quantity,
             CASE WHEN ti.direction = 'give' THEN t.from_user_id ELSE t.to_user_id END AS giver,
             CASE WHEN ti.direction = 'give' THEN t.to_user_id ELSE t.from_user_id END AS receiver
        FROM trades t
        JOIN trade_items ti ON ti.trade_id = t.id
       WHERE t.status = 'accepted' AND ti.declined = 0
    )
    SELECT
      COALESCE(SUM(CASE WHEN receiver IN ${s.in} AND giver NOT IN ${s.in} THEN quantity END), 0) AS cards_in,
      COALESCE(SUM(CASE WHEN giver IN ${s.in} AND receiver NOT IN ${s.in} THEN quantity END), 0) AS cards_out
      FROM items
  `, [...both, ...both]);

  const loans = db.get(`
    WITH l AS (
      SELECT quantity, status,
             lender_user_id IN ${s.in} AS lender_in,
             borrower_user_id IN ${s.in} AS borrower_in
        FROM card_loans
       WHERE status NOT IN ('declined', 'cancelled', 'requested')
    )
    SELECT
      COALESCE(SUM(CASE WHEN lender_in AND NOT borrower_in AND status IN ${LIVE_LOANS} THEN quantity END), 0) AS lent_now,
      COALESCE(SUM(CASE WHEN borrower_in AND NOT lender_in AND status IN ${LIVE_LOANS} THEN quantity END), 0) AS borrowed_now,
      COUNT(CASE WHEN lender_in AND NOT borrower_in THEN 1 END) AS loans_made,
      COUNT(CASE WHEN borrower_in AND NOT lender_in THEN 1 END) AS loans_taken,
      COUNT(CASE WHEN lender_in AND borrower_in THEN 1 END) AS loans_internal
      FROM l
  `, both);

  const byStatus = Object.fromEntries(trades.map((t) => [t.status, t]));
  const n = (status) => byStatus[status]?.count || 0;
  return {
    trades: {
      accepted: n('accepted'),
      open: n('pending') + n('awaiting_counter'),
      closed: trades
        .filter((t) => !['accepted', 'pending', 'awaiting_counter'].includes(t.status))
        .reduce((sum, t) => sum + t.count, 0),
      cardsIn: moved.cards_in,
      cardsOut: moved.cards_out,
      withinGroup: byStatus.accepted?.internal || 0,
    },
    loans: {
      lentNow: loans.lent_now,
      borrowedNow: loans.borrowed_now,
      made: loans.loans_made,
      taken: loans.loans_taken,
      withinGroup: loans.loans_internal,
    },
  };
}

/**
 * Collection value by day. For several users the day's values are summed —
 * every user gets a snapshot on the same run, so a day either has everyone or
 * predates someone's account.
 */
export function getValueHistory(userIds) {
  const s = scopeOf(userIds);
  return db.all(`
    SELECT snapshot_date AS date, SUM(total_value) AS value, SUM(total_cards) AS cards
      FROM collection_value_snapshots
     WHERE user_id IN ${s.in}
     GROUP BY snapshot_date
     ORDER BY snapshot_date
  `, s.ids).map((r) => ({ ...r, value: round2(r.value) }));
}

/**
 * Write today's value for every user. Called after the daily price refresh,
 * which is the only time prices move. Re-running on the same day replaces
 * that day's row rather than adding one. Always per user: a household total is
 * summed at read time, never stored.
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
