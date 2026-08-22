import db from '../db/connection.js';
import { setOwnedPrintingQuantity } from './cardService.js';

/**
 * Card trades between users of the same instance.
 *
 * The reason this exists is inventory accuracy, not ceremony. When two people
 * in the same household swap cards by hand, one of them updates their
 * collection and the other forgets, and the house total drifts upward
 * forever. A trade moves both collections inside one transaction, so the sum
 * across users is conserved by construction.
 *
 * Every quantity is keyed by printing *and finish*. owned_printings and
 * deck_cards both treat foil and non-foil as separate rows, so a trade that
 * loses track of is_foil moves the wrong copies.
 */

/** Boards, in the order they should be raided. See allocateShortfall. */
const BOARD_ORDER = { maybeboard: 0, sideboard: 1, mainboard: 2 };

const VALID_RESOLUTIONS = new Set(['removed', 'kept']);

/** Stable key for one printing in one finish. */
function key(printingId, isFoil) {
  return `${printingId}:${isFoil ? 1 : 0}`;
}

function boardOf(row) {
  return row.board_type || (row.is_sideboard === 1 ? 'sideboard' : 'mainboard');
}

/**
 * Basic lands are exempt from availability accounting everywhere else in the
 * app (see inventoryService's IS_BASIC_LAND), so they are exempt here too:
 * trading away a Mountain should not report every deck as broken.
 */
const IS_BASIC_LAND = `(
  (c.supertypes IS NOT NULL AND c.supertypes LIKE '%Basic%' AND c.type_line LIKE '%Land%')
  OR c.type_line LIKE 'Basic %Land%'
)`;

/** Card and printing detail for a set of printing ids, keyed by printing id. */
function describePrintings(printingIds) {
  if (printingIds.length === 0) return new Map();

  const rows = db.all(
    `SELECT p.id AS printing_id, p.set_code, p.collector_number, p.image_url,
            c.id AS card_id, c.name AS card_name, c.type_line,
            CASE WHEN ${IS_BASIC_LAND} THEN 1 ELSE 0 END AS is_basic_land
       FROM printings p
       JOIN cards c ON c.id = p.card_id
      WHERE p.id IN (${printingIds.map(() => '?').join(',')})`,
    printingIds
  );

  return new Map(rows.map((r) => [r.printing_id, r]));
}

// ---------------------------------------------------------------------------
// Impact on decks
// ---------------------------------------------------------------------------

/**
 * Which deck_cards rows a user would be unable to cover for a given set of
 * printings, given a prospective change to what they own.
 *
 * `deltas` maps a printing/finish key to the change in owned copies (negative
 * for cards leaving). Pass an empty map to measure the collection as it
 * actually stands right now — that is what acceptTrade does after moving the
 * cards, so the recorded shortfall reflects reality rather than a forecast.
 *
 * Only the *excess* counts. Owning four, listing two in a deck and trading
 * away two breaks nothing; trading away three leaves the deck one short.
 */
function shortfallsFor(userId, printingKeys, deltas = new Map()) {
  const out = [];

  for (const { printingId, isFoil } of printingKeys) {
    const foilFlag = isFoil ? 1 : 0;
    const k = key(printingId, isFoil);

    const ownedRow = db.get(
      `SELECT quantity FROM owned_printings
        WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
      [userId, printingId, foilFlag]
    );

    const owned = ownedRow?.quantity || 0;
    const remaining = Math.max(0, owned + (deltas.get(k) || 0));

    // A deck can list the same printing and finish on two boards, so this is
    // one row per board, not one per deck.
    const deckRows = db.all(
      `SELECT dc.id AS deck_card_id, dc.quantity, dc.is_sideboard, dc.board_type,
              d.id AS deck_id, d.name AS deck_name, d.format, d.updated_at
         FROM deck_cards dc
         JOIN decks d ON d.id = dc.deck_id
        WHERE d.user_id = ? AND dc.printing_id = ? AND dc.is_foil = ?`,
      [userId, printingId, foilFlag]
    );

    const committed = deckRows.reduce((sum, r) => sum + r.quantity, 0);
    const shortfall = Math.max(0, committed - remaining);

    out.push({
      printingId,
      isFoil: !!isFoil,
      owned,
      remaining,
      committed,
      shortfall,
      decks: shortfall > 0 ? allocateShortfall(deckRows, shortfall) : []
    });
  }

  return out;
}

/**
 * Decide which decks eat the shortfall.
 *
 * Decks are charged least-recently-updated first, so the deck the user is
 * actively working on is the last one to lose a card. A dusty deck that has
 * not been touched in months is the cheapest place for the shortfall to land.
 * Within a deck the maybeboard goes before the sideboard before the
 * mainboard — a maybeboard entry is a wish, a mainboard slot is the deck.
 *
 * The order is deterministic rather than clever. The user can move copies
 * between decks afterwards; the point is that the shortfall lands somewhere
 * visible instead of being spread invisibly across everything.
 */
function allocateShortfall(deckRows, shortfall) {
  const ordered = [...deckRows].sort((a, b) => {
    if (a.updated_at !== b.updated_at) return a.updated_at < b.updated_at ? -1 : 1;
    return BOARD_ORDER[boardOf(a)] - BOARD_ORDER[boardOf(b)];
  });

  const charged = [];
  let left = shortfall;

  for (const row of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, row.quantity);
    left -= take;

    charged.push({
      deckId: row.deck_id,
      deckName: row.deck_name,
      format: row.format,
      boardType: boardOf(row),
      listed: row.quantity,
      quantity: take
    });
  }

  return charged;
}

/**
 * What a proposed trade would cost each side's decks, before anyone commits
 * to it. Drives the warnings in the trade builder.
 *
 * Cards are netted per side first: sending away two copies and receiving one
 * back of the same printing is a loss of one, and warning about two would be
 * a lie.
 */
export function previewImpact(fromUserId, toUserId, items) {
  const normalized = normalizeItems(items);

  return {
    from: impactForSide(fromUserId, normalized, 'give'),
    to: impactForSide(toUserId, normalized, 'receive')
  };
}

/** Net change to one side's collection, then the decks it would leave short. */
function impactForSide(userId, items, losingDirection) {
  const deltas = new Map();
  const keys = new Map();

  for (const item of items) {
    const k = key(item.printingId, item.isFoil);
    const sign = item.direction === losingDirection ? -1 : 1;
    deltas.set(k, (deltas.get(k) || 0) + sign * item.quantity);
    keys.set(k, { printingId: item.printingId, isFoil: item.isFoil });
  }

  // Only cards this side is a net loser of can break their decks.
  const losing = [...keys.entries()]
    .filter(([k]) => deltas.get(k) < 0)
    .map(([, value]) => value);

  const details = describePrintings(losing.map((entry) => entry.printingId));

  return shortfallsFor(userId, losing, deltas)
    .map((row) => {
      const detail = details.get(row.printingId) || {};
      return {
        ...row,
        cardName: detail.card_name || 'Unknown card',
        setCode: detail.set_code,
        collectorNumber: detail.collector_number,
        isBasicLand: detail.is_basic_land === 1
      };
    })
    // Basic lands are never tracked closely enough for a shortfall to mean
    // anything, and a card no deck needs is not worth a warning.
    .filter((row) => !row.isBasicLand && row.shortfall > 0);
}

// ---------------------------------------------------------------------------
// Proposing
// ---------------------------------------------------------------------------

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A trade needs at least one card');
  }

  const merged = new Map();

  for (const raw of items) {
    const printingId = Number(raw.printingId);
    const quantity = Number(raw.quantity ?? 1);
    const isFoil = !!raw.isFoil;
    const direction = raw.direction === 'receive' ? 'receive' : 'give';

    if (!Number.isInteger(printingId) || printingId <= 0) {
      throw new Error('Each trade item needs a printing');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error('Trade quantities must be whole numbers above zero');
    }

    // The same card can legitimately be listed twice by a fumbling UI; fold
    // the duplicates rather than tripping the UNIQUE constraint on insert.
    const k = `${direction}:${key(printingId, isFoil)}`;
    const existing = merged.get(k);

    if (existing) {
      existing.quantity += quantity;
    } else {
      merged.set(k, { printingId, isFoil, quantity, direction });
    }
  }

  return [...merged.values()];
}

/**
 * Propose a trade. Nothing moves until the other side accepts.
 *
 * Quantities are sanity-checked here so the proposer is told immediately, but
 * they are checked again at accept time — the collection can change in
 * between, and the check that matters is the one inside the transaction.
 */
export function createTrade(fromUserId, toUserId, items, note = null) {
  const partnerId = Number(toUserId);
  const partner = db.get(`SELECT id, username FROM users WHERE id = ?`, [partnerId]);

  if (!partner) {
    throw new Error('Trade partner not found');
  }
  if (partnerId === Number(fromUserId)) {
    throw new Error('You cannot trade with yourself');
  }

  const normalized = normalizeItems(items);

  for (const item of normalized) {
    assertHasCopies(item.direction === 'give' ? fromUserId : partnerId, item);
  }

  const tradeId = db.transaction(() => {
    const result = db.run(
      `INSERT INTO trades (from_user_id, to_user_id, status, note) VALUES (?, ?, 'pending', ?)`,
      [fromUserId, partnerId, note || null]
    );

    const id = result.lastInsertRowid;

    for (const item of normalized) {
      db.run(
        `INSERT INTO trade_items (trade_id, printing_id, is_foil, quantity, direction)
         VALUES (?, ?, ?, ?, ?)`,
        [id, item.printingId, item.isFoil ? 1 : 0, item.quantity, item.direction]
      );
    }

    return id;
  });

  return getTradeById(tradeId, fromUserId);
}

/** Refuse to build a trade out of cards somebody does not have. */
function assertHasCopies(userId, item) {
  const row = db.get(
    `SELECT quantity FROM owned_printings
      WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
    [userId, item.printingId, item.isFoil ? 1 : 0]
  );

  const owned = row?.quantity || 0;

  if (owned < item.quantity) {
    const detail = describePrintings([item.printingId]).get(item.printingId);
    const name = detail ? `${detail.card_name} (${detail.set_code})` : `printing ${item.printingId}`;
    const finish = item.isFoil ? ' foil' : '';

    throw new Error(
      `Only ${owned}${finish} cop${owned === 1 ? 'y' : 'ies'} of ${name} available` +
      ` — the trade asks for ${item.quantity}`
    );
  }
}

// ---------------------------------------------------------------------------
// Accepting
// ---------------------------------------------------------------------------

/** Move copies out of a collection, deleting the row at zero. */
function takeCopies(userId, printingId, isFoil, quantity) {
  const row = db.get(
    `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
    [userId, printingId, isFoil ? 1 : 0]
  );

  const have = row?.quantity || 0;

  if (have < quantity) {
    const detail = describePrintings([printingId]).get(printingId);
    const name = detail ? detail.card_name : `printing ${printingId}`;
    throw new Error(`${name}: only ${have} copies left, the trade needs ${quantity}`);
  }

  // Goes through setOwnedPrintingQuantity so the legacy owned_cards mirror
  // stays in step, including being cleared when the last printing goes.
  setOwnedPrintingQuantity(userId, printingId, have - quantity, isFoil);
}

function addCopies(userId, printingId, isFoil, quantity) {
  const row = db.get(
    `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
    [userId, printingId, isFoil ? 1 : 0]
  );

  setOwnedPrintingQuantity(userId, printingId, (row?.quantity || 0) + quantity, isFoil);
}

/**
 * Accept a pending trade: both collections move, and any deck left short is
 * recorded, all inside one transaction.
 *
 * Every decrement runs before every increment, so a trade that sends two
 * copies of a card and receives one of the same card back cannot accidentally
 * spend the incoming copy.
 *
 * Decks are never edited here. A deck that can no longer be built keeps
 * listing what it lists until its owner acknowledges the disruption and says
 * what should happen — see acknowledgeDisruption.
 */
export function acceptTrade(tradeId, userId) {
  const trade = loadTrade(tradeId);

  if (!trade) throw new Error('Trade not found');
  if (trade.to_user_id !== userId) {
    throw new Error('Only the person a trade was sent to can accept it');
  }
  if (trade.status !== 'pending') {
    throw new Error(`This trade is already ${trade.status}`);
  }

  const items = loadItems(tradeId);

  db.transaction(() => {
    // Losing side first, for both parties.
    for (const item of items) {
      const giver = item.direction === 'give' ? trade.from_user_id : trade.to_user_id;
      takeCopies(giver, item.printing_id, item.is_foil === 1, item.quantity);
    }

    for (const item of items) {
      const receiver = item.direction === 'give' ? trade.to_user_id : trade.from_user_id;
      addCopies(receiver, item.printing_id, item.is_foil === 1, item.quantity);
    }

    db.run(
      `UPDATE trades SET status = 'accepted', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [tradeId]
    );

    // Measured against the collections as they now stand, so the numbers
    // recorded are the ones the user will actually see in the deck.
    recordDisruptions(trade.from_user_id, items, 'give', tradeId);
    recordDisruptions(trade.to_user_id, items, 'receive', tradeId);
  });

  return getTradeById(tradeId, userId);
}

/** Write a disruption row for every deck this side can no longer cover. */
function recordDisruptions(userId, items, losingDirection, tradeId) {
  const keys = new Map();

  for (const item of items) {
    if (item.direction !== losingDirection) continue;

    keys.set(key(item.printing_id, item.is_foil === 1), {
      printingId: item.printing_id,
      isFoil: item.is_foil === 1
    });
  }

  const targets = [...keys.values()];
  if (targets.length === 0) return;

  const details = describePrintings(targets.map((t) => t.printingId));

  for (const row of shortfallsFor(userId, targets)) {
    const detail = details.get(row.printingId);
    if (!detail || detail.is_basic_land === 1) continue;

    for (const deck of row.decks) {
      db.run(
        `INSERT INTO deck_card_disruptions
           (deck_id, trade_id, printing_id, is_foil, board_type, quantity, card_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          deck.deckId,
          tradeId,
          row.printingId,
          row.isFoil ? 1 : 0,
          deck.boardType,
          deck.quantity,
          detail.card_name
        ]
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Declining and cancelling
// ---------------------------------------------------------------------------

export function declineTrade(tradeId, userId) {
  return closeTrade(
    tradeId, userId, 'declined',
    (trade) => trade.to_user_id === userId,
    'Only the person a trade was sent to can decline it'
  );
}

export function cancelTrade(tradeId, userId) {
  return closeTrade(
    tradeId, userId, 'cancelled',
    (trade) => trade.from_user_id === userId,
    'Only the person who proposed a trade can cancel it'
  );
}

function closeTrade(tradeId, userId, status, allowed, message) {
  const trade = loadTrade(tradeId);

  if (!trade) throw new Error('Trade not found');
  if (!allowed(trade)) throw new Error(message);
  if (trade.status !== 'pending') throw new Error(`This trade is already ${trade.status}`);

  db.run(
    `UPDATE trades SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, tradeId]
  );

  return getTradeById(tradeId, userId);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function loadTrade(tradeId) {
  return db.get(`SELECT * FROM trades WHERE id = ?`, [tradeId]);
}

function loadItems(tradeId) {
  return db.all(`SELECT * FROM trade_items WHERE trade_id = ? ORDER BY id`, [tradeId]);
}

/** Everyone else on this instance — the people you can trade with. */
export function listTradePartners(userId) {
  return db.all(
    `SELECT u.id, u.username,
            (SELECT COALESCE(SUM(op.quantity), 0) FROM owned_printings op
              WHERE op.user_id = u.id) AS card_count
       FROM users u
      WHERE u.id <> ?
      ORDER BY u.username COLLATE NOCASE`,
    [userId]
  );
}

const TRADE_ITEM_COLUMNS = `
  ti.id, ti.trade_id, ti.printing_id, ti.is_foil, ti.quantity, ti.direction,
  p.set_code, p.collector_number, p.image_url,
  c.id AS card_id, c.name AS card_name, c.mana_cost, c.type_line
`;

/** A trade with its cards, as seen by one of the two participants. */
export function getTradeById(tradeId, userId) {
  const trade = db.get(
    `SELECT t.*, fu.username AS from_username, tu.username AS to_username
       FROM trades t
       JOIN users fu ON fu.id = t.from_user_id
       JOIN users tu ON tu.id = t.to_user_id
      WHERE t.id = ?`,
    [tradeId]
  );

  if (!trade) return null;
  if (trade.from_user_id !== userId && trade.to_user_id !== userId) return null;

  const items = db.all(
    `SELECT ${TRADE_ITEM_COLUMNS}
       FROM trade_items ti
       JOIN printings p ON p.id = ti.printing_id
       JOIN cards c ON c.id = p.card_id
      WHERE ti.trade_id = ?
      ORDER BY c.name, p.set_code`,
    [tradeId]
  );

  return shapeTrade(trade, items, userId);
}

/**
 * Present a trade from the viewer's point of view. Stored directions are
 * relative to the proposer, so a recipient reading them raw would see every
 * arrow backwards.
 */
function shapeTrade(trade, items, userId) {
  const viewerIsProposer = trade.from_user_id === userId;

  const shaped = items.map((item) => ({
    id: item.id,
    printingId: item.printing_id,
    isFoil: item.is_foil === 1,
    quantity: item.quantity,
    cardId: item.card_id,
    cardName: item.card_name,
    manaCost: item.mana_cost,
    typeLine: item.type_line,
    setCode: item.set_code,
    collectorNumber: item.collector_number,
    imageUrl: item.image_url,
    // 'out' leaves the viewer's collection, 'in' enters it.
    flow: (item.direction === 'give') === viewerIsProposer ? 'out' : 'in'
  }));

  return {
    id: trade.id,
    status: trade.status,
    note: trade.note,
    createdAt: trade.created_at,
    resolvedAt: trade.resolved_at,
    fromUserId: trade.from_user_id,
    toUserId: trade.to_user_id,
    fromUsername: trade.from_username,
    toUsername: trade.to_username,
    viewerIsProposer,
    counterpartyName: viewerIsProposer ? trade.to_username : trade.from_username,
    canAccept: trade.status === 'pending' && !viewerIsProposer,
    canCancel: trade.status === 'pending' && viewerIsProposer,
    giving: shaped.filter((item) => item.flow === 'out'),
    receiving: shaped.filter((item) => item.flow === 'in')
  };
}

/** Every trade the user is part of, newest first. */
export function listTrades(userId, { status = null } = {}) {
  const clause = status ? `AND t.status = ?` : '';
  const params = status ? [userId, userId, status] : [userId, userId];

  const trades = db.all(
    `SELECT t.*, fu.username AS from_username, tu.username AS to_username
       FROM trades t
       JOIN users fu ON fu.id = t.from_user_id
       JOIN users tu ON tu.id = t.to_user_id
      WHERE (t.from_user_id = ? OR t.to_user_id = ?) ${clause}
      ORDER BY t.created_at DESC`,
    params
  );

  if (trades.length === 0) return [];

  const items = db.all(
    `SELECT ${TRADE_ITEM_COLUMNS}
       FROM trade_items ti
       JOIN printings p ON p.id = ti.printing_id
       JOIN cards c ON c.id = p.card_id
      WHERE ti.trade_id IN (${trades.map(() => '?').join(',')})
      ORDER BY c.name, p.set_code`,
    trades.map((t) => t.id)
  );

  const byTrade = new Map(trades.map((t) => [t.id, []]));
  for (const item of items) byTrade.get(item.trade_id)?.push(item);

  return trades.map((t) => shapeTrade(t, byTrade.get(t.id) || [], userId));
}

/** How many trades are sitting in the user's inbox awaiting their answer. */
export function countPendingIncoming(userId) {
  return db.get(
    `SELECT COUNT(*) AS count FROM trades WHERE to_user_id = ? AND status = 'pending'`,
    [userId]
  ).count;
}

// ---------------------------------------------------------------------------
// Deck disruptions
// ---------------------------------------------------------------------------

/**
 * Unacknowledged disruptions for a user, optionally narrowed to one deck.
 *
 * These stay put until the owner deals with them. Nothing expires them and
 * nothing acts on them automatically — an unread one is the whole point.
 */
export function getDisruptions(userId, deckId = null) {
  const clause = deckId ? `AND dcd.deck_id = ?` : '';
  const params = deckId ? [userId, deckId] : [userId];

  const rows = db.all(
    `SELECT dcd.*, d.name AS deck_name, d.format,
            t.resolved_at AS traded_at,
            t.from_user_id AS trade_from_user_id,
            fu.username AS from_username, tu.username AS to_username,
            p.set_code, p.collector_number, p.image_url
       FROM deck_card_disruptions dcd
       JOIN decks d ON d.id = dcd.deck_id
       LEFT JOIN trades t ON t.id = dcd.trade_id
       LEFT JOIN users fu ON fu.id = t.from_user_id
       LEFT JOIN users tu ON tu.id = t.to_user_id
       LEFT JOIN printings p ON p.id = dcd.printing_id
      WHERE d.user_id = ? AND dcd.acknowledged_at IS NULL ${clause}
      ORDER BY dcd.created_at DESC, dcd.id`,
    params
  );

  return rows.map((row) => ({
    id: row.id,
    deckId: row.deck_id,
    deckName: row.deck_name,
    format: row.format,
    tradeId: row.trade_id,
    tradedAt: row.traded_at,
    printingId: row.printing_id,
    isFoil: row.is_foil === 1,
    boardType: row.board_type,
    quantity: row.quantity,
    cardName: row.card_name,
    setCode: row.set_code,
    collectorNumber: row.collector_number,
    imageUrl: row.image_url,
    // Whoever ended up with the card: the other participant in the trade.
    tradedTo: row.trade_from_user_id === userId ? row.to_username : row.from_username
  }));
}

/** Unacknowledged disruption counts per deck, for badging deck lists. */
export function getDisruptionCounts(userId) {
  const rows = db.all(
    `SELECT dcd.deck_id, SUM(dcd.quantity) AS cards, COUNT(*) AS entries
       FROM deck_card_disruptions dcd
       JOIN decks d ON d.id = dcd.deck_id
      WHERE d.user_id = ? AND dcd.acknowledged_at IS NULL
      GROUP BY dcd.deck_id`,
    [userId]
  );

  return new Map(rows.map((r) => [r.deck_id, { cards: r.cards, entries: r.entries }]));
}

/**
 * Acknowledge a traded-away card and decide what the deck becomes.
 *
 * 'removed' takes the copies out of the deck. The deck genuinely shrinks —
 * a 60-card Legacy deck becomes 59 — and the format check starts saying so,
 * which is the honest outcome and the reason this feature exists.
 *
 * 'kept' leaves the deck listing a card its owner no longer holds, for when
 * they intend to buy or borrow another copy. The deck stays 60, and the
 * builder's availability figures already report the missing copy on their own.
 */
export function acknowledgeDisruption(disruptionId, userId, resolution) {
  if (!VALID_RESOLUTIONS.has(resolution)) {
    throw new Error(`Unknown resolution '${resolution}'`);
  }

  const disruption = db.get(
    `SELECT dcd.* FROM deck_card_disruptions dcd
       JOIN decks d ON d.id = dcd.deck_id
      WHERE dcd.id = ? AND d.user_id = ?`,
    [disruptionId, userId]
  );

  if (!disruption) throw new Error('Disruption not found');
  if (disruption.acknowledged_at) throw new Error('This card has already been dealt with');

  db.transaction(() => {
    if (resolution === 'removed') {
      removeFromDeck(disruption);
    }

    db.run(
      `UPDATE deck_card_disruptions
          SET acknowledged_at = CURRENT_TIMESTAMP, resolution = ?
        WHERE id = ?`,
      [resolution, disruptionId]
    );
  });

  return { success: true, resolution, deckId: disruption.deck_id };
}

/**
 * Take the traded copies out of the deck.
 *
 * The row is found by deck, printing, finish and board rather than by a
 * stored deck_cards id, because the user may have edited that row between the
 * trade and the acknowledgement. If they already removed the card themselves,
 * there is nothing to do — and that is a success, not an error.
 */
function removeFromDeck(disruption) {
  const row = db.get(
    `SELECT id, quantity FROM deck_cards
      WHERE deck_id = ? AND printing_id = ? AND is_foil = ?
        AND COALESCE(board_type, CASE WHEN is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) = ?`,
    [disruption.deck_id, disruption.printing_id, disruption.is_foil, disruption.board_type]
  );

  if (!row) return;

  const remaining = row.quantity - disruption.quantity;

  if (remaining > 0) {
    db.run(`UPDATE deck_cards SET quantity = ? WHERE id = ?`, [remaining, row.id]);
  } else {
    db.run(`DELETE FROM deck_cards WHERE id = ?`, [row.id]);
  }

  db.run(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [disruption.deck_id]);
}
