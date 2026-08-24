import db from '../db/connection.js';

/**
 * The audit log: who changed what, and where the change came in from.
 *
 * Written from the service layer rather than from routes, so a change made
 * through the API, the UI, or as a side effect of accepting a trade all land
 * in the same place with the same shape.
 *
 * Two rules hold everywhere in this file:
 *
 *  1. Logging never breaks the thing being logged. Every write is wrapped —
 *     a collection edit that succeeded must not be reported as failed because
 *     the history could not be written. A dropped audit row is a gap in a
 *     report; a thrown one is lost inventory.
 *
 *  2. Card identity is copied in, not referenced. `scripts/import-mtgjson.js`
 *     clears `printings` every weekly sync, so a row that only held a
 *     printing_id would read as a blank line after the next Sunday. The name,
 *     set code and collector number are stored as text; `printing_uuid` is the
 *     identifier that survives a reimport.
 */

// Actions worth naming in one place, so the filter dropdown and the writers
// cannot drift apart.
export const AUDIT_ACTIONS = {
  INVENTORY_ADD: 'inventory.add',
  INVENTORY_REMOVE: 'inventory.remove',
  INVENTORY_SET: 'inventory.set',
  DECK_CREATE: 'deck.create',
  DECK_UPDATE: 'deck.update',
  DECK_DELETE: 'deck.delete',
  DECK_CARD_ADD: 'deck.card_add',
  DECK_CARD_UPDATE: 'deck.card_update',
  DECK_CARD_REMOVE: 'deck.card_remove',
  TRADE_CREATE: 'trade.create',
  TRADE_ACCEPT: 'trade.accept',
  TRADE_DECLINE: 'trade.decline',
  TRADE_CANCEL: 'trade.cancel',
  TRADE_COUNTER: 'trade.counter',
};

export const AUDIT_SOURCES = [
  'bulk_add',
  'quick_add',
  'card_page',
  'deck_builder',
  'deck_import',
  'trade',
  'scan',
  'api',
];

/**
 * Look up the human-readable identity of a printing.
 *
 * Returns nulls rather than throwing when the printing is missing — mid-sync
 * the table is empty, and a nameless audit row still records that a change
 * happened, which beats recording nothing.
 */
function describePrinting(printingId) {
  if (!printingId) return {};

  try {
    const row = db.get(
      `SELECT p.uuid, p.set_code, p.collector_number, c.name
         FROM printings p
         JOIN cards c ON p.card_id = c.id
        WHERE p.id = ?`,
      [printingId]
    );

    if (!row) return {};

    return {
      printing_uuid: row.uuid,
      card_name: row.name,
      set_code: row.set_code,
      collector_number: row.collector_number,
    };
  } catch {
    return {};
  }
}

/**
 * Look up a username for the log.
 *
 * Denormalised for the same reason card identity is: the log has to still
 * read as a sentence after the account it names has gone. Returns null rather
 * than throwing, so a missing user costs a name and not the entry.
 */
function describeUser(userId) {
  if (!userId) return null;

  try {
    const row = db.get(`SELECT id, username FROM users WHERE id = ?`, [userId]);
    return row ? { id: row.id, username: row.username } : null;
  } catch {
    return null;
  }
}

/**
 * Write one audit row. Never throws — see rule 1 at the top of this file.
 */
export function recordAudit(entry) {
  try {
    const {
      userId,
      actorUserId = null,
      entityType,
      action,
      source = 'api',
      printingId = null,
      printingUuid = null,
      cardName = null,
      setCode = null,
      collectorNumber = null,
      isFoil = null,
      quantityBefore = null,
      quantityAfter = null,
      quantityDelta = null,
      deckId = null,
      deckName = null,
      tradeId = null,
      detail = null,
    } = entry;

    if (!userId || !entityType || !action) return;

    db.run(
      `INSERT INTO audit_log (
         user_id, actor_user_id, entity_type, action, source,
         printing_id, printing_uuid, card_name, set_code, collector_number, is_foil,
         quantity_before, quantity_after, quantity_delta,
         deck_id, deck_name, trade_id, detail
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        actorUserId ?? userId,
        entityType,
        action,
        source,
        printingId,
        printingUuid,
        cardName,
        setCode,
        collectorNumber,
        isFoil === null ? null : (isFoil ? 1 : 0),
        quantityBefore,
        quantityAfter,
        quantityDelta,
        deckId,
        deckName,
        tradeId,
        detail === null ? null : JSON.stringify(detail),
      ]
    );
  } catch (error) {
    // Deliberately swallowed. See rule 1.
    console.error('audit: failed to record entry:', error.message);
  }
}

/**
 * Record a change to how many copies of a printing somebody owns.
 *
 * Takes before and after rather than a delta so the log answers "what did it
 * used to be?" — the question you have when undoing a bad import by hand. The
 * action is derived from the direction of the change, so a filter on
 * `inventory.add` really does list only additions.
 *
 * A no-op (before === after) is not logged: replaying a quantity that was
 * already set is not a change, and logging it buries the real ones.
 */
export function recordInventoryChange({
  userId,
  actorUserId = null,
  printingId,
  isFoil = false,
  before = 0,
  after = 0,
  source = 'api',
  tradeId = null,
  detail = null,
}) {
  const from = before || 0;
  const to = after || 0;

  if (from === to) return;

  const action =
    to > from ? AUDIT_ACTIONS.INVENTORY_ADD
      : to === 0 ? AUDIT_ACTIONS.INVENTORY_REMOVE
        : AUDIT_ACTIONS.INVENTORY_SET;

  recordAudit({
    userId,
    actorUserId,
    entityType: 'inventory',
    action,
    source,
    printingId,
    isFoil,
    quantityBefore: from,
    quantityAfter: to,
    quantityDelta: to - from,
    tradeId,
    detail,
    ...describePrinting(printingId),
  });
}

/** Record something that happened to a deck, with or without a card involved. */
export function recordDeckEvent({
  userId,
  actorUserId = null,
  action,
  source = 'deck_builder',
  deckId,
  deckName = null,
  printingId = null,
  isFoil = null,
  quantityBefore = null,
  quantityAfter = null,
  detail = null,
}) {
  const before = quantityBefore;
  const after = quantityAfter;

  recordAudit({
    userId,
    actorUserId,
    entityType: 'deck',
    action,
    source,
    deckId,
    deckName,
    printingId,
    isFoil,
    quantityBefore: before,
    quantityAfter: after,
    quantityDelta:
      before === null || after === null ? null : after - before,
    detail,
    ...describePrinting(printingId),
  });
}

/**
 * Record a trade changing state. The card movements are logged separately.
 *
 * `counterpartyId` is the other side of the trade *from this row's owner* —
 * these events are written once per party, so the same trade produces two
 * rows that name each other. Without it a trade you started reads as "Trade
 * #12" with nobody in it: `actor_user_id` only identifies the far side on the
 * rows where somebody else acted, which is never the initiator's own row.
 */
export function recordTradeEvent({
  userId,
  actorUserId = null,
  counterpartyId = null,
  action,
  tradeId,
  detail = null,
}) {
  const counterparty = describeUser(counterpartyId);

  recordAudit({
    userId,
    actorUserId,
    entityType: 'trade',
    action,
    source: 'trade',
    tradeId,
    detail: counterparty ? { ...(detail || {}), counterparty } : detail,
  });
}

/**
 * The counterparty of a card movement, for stamping into an inventory
 * change's detail. Exported because the trade service is the only thing that
 * knows who the other side is, and the inventory writer it calls does not.
 */
export function describeCounterparty(userId) {
  return describeUser(userId);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const MAX_PAGE_SIZE = 200;

/**
 * List audit entries, newest first.
 *
 * `userIds` is the scope the caller is allowed to see: a single id for a
 * regular user, or an array for an admin looking across the household. It is
 * never taken from the request directly — the route resolves it — because it
 * is the only thing standing between one user's log and another's.
 */
export function listAuditEntries(userIds, filters = {}) {
  const {
    action = null,
    entityType = null,
    source = null,
    search = null,
    from = null,
    to = null,
    page = 1,
    limit = 50,
  } = filters;

  const scopeIds = Array.isArray(userIds) ? userIds : [userIds];

  if (scopeIds.length === 0) {
    return { entries: [], pagination: { page: 1, limit, total: 0, pages: 0 } };
  }

  const where = [`a.user_id IN (${scopeIds.map(() => '?').join(',')})`];
  const params = [...scopeIds];

  if (action) {
    where.push('a.action = ?');
    params.push(action);
  }

  if (entityType) {
    where.push('a.entity_type = ?');
    params.push(entityType);
  }

  if (source) {
    where.push('a.source = ?');
    params.push(source);
  }

  if (search) {
    // Card name, set code and deck name in one box — the three things you
    // know when you are hunting a batch you got wrong. `c.name` is the
    // recovered name (see the join below); without it a row whose name only
    // exists at read time would be visible but unsearchable, which is the
    // more confusing of the two failures.
    where.push('(a.card_name LIKE ? OR c.name LIKE ? OR a.set_code LIKE ? OR a.deck_name LIKE ? OR a.collector_number = ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, search);
  }

  if (from) {
    where.push('a.created_at >= ?');
    params.push(from);
  }

  if (to) {
    // Callers pass a plain date; include everything that happened on it.
    where.push('a.created_at <= ?');
    params.push(`${to} 23:59:59`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;

  // Card identity is copied in at write time, but a row written while the
  // printings table was mid-rebuild — or before the name was being captured —
  // has nothing to show, and a nameless line is exactly the line somebody is
  // scrolling for. Where the row kept a uuid, the name is recovered from the
  // current printings table on the way out.
  //
  // The join is on printing_uuid and never on printing_id: the weekly MTGJSON
  // import reassigns ids, so a stale id would attach some other card's name to
  // the row, which is worse than leaving it blank.
  //
  // Shared by the count and the page so the search can reach the recovered
  // name in both — a filter that pages differently from how it counts is a
  // bug that only shows up on the last page.
  const fromSql = `
       FROM audit_log a
       LEFT JOIN users u ON a.user_id = u.id
       LEFT JOIN users actor ON a.actor_user_id = actor.id
       LEFT JOIN printings p ON a.card_name IS NULL AND a.printing_uuid IS NOT NULL AND p.uuid = a.printing_uuid
       LEFT JOIN cards c ON c.id = p.card_id`;

  const total = db.get(
    `SELECT COUNT(*) as count ${fromSql} ${whereSql}`,
    params
  ).count;

  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_PAGE_SIZE);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  // The COALESCE aliases deliberately shadow the columns `a.*` just selected:
  // the later column of a duplicated name is the one that reaches the row
  // object, so every reader downstream sees the recovered value without
  // knowing it was recovered.
  const entries = db.all(
    `SELECT a.*,
            COALESCE(a.card_name, c.name) as card_name,
            COALESCE(a.set_code, p.set_code) as set_code,
            COALESCE(a.collector_number, p.collector_number) as collector_number,
            u.username as username,
            actor.username as actor_username
       ${fromSql}
       ${whereSql}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, offset]
  ).map((row) => ({
    ...row,
    is_foil: row.is_foil === null ? null : row.is_foil === 1,
    detail: parseDetail(row.detail),
  }));

  return {
    entries,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit),
    },
  };
}

function parseDetail(detail) {
  if (!detail) return null;
  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

/**
 * The distinct values actually present in the caller's log, for populating
 * the filter dropdowns. Offering a filter that matches nothing is worse than
 * offering none, so these come from the data rather than from the constants.
 */
export function getAuditFilterOptions(userIds) {
  const scopeIds = Array.isArray(userIds) ? userIds : [userIds];

  if (scopeIds.length === 0) {
    return { actions: [], sources: [], entityTypes: [] };
  }

  const placeholders = scopeIds.map(() => '?').join(',');

  const column = (name) =>
    db.all(
      `SELECT DISTINCT ${name} as value FROM audit_log
        WHERE user_id IN (${placeholders}) AND ${name} IS NOT NULL
        ORDER BY value`,
      scopeIds
    ).map((row) => row.value);

  return {
    actions: column('action'),
    sources: column('source'),
    entityTypes: column('entity_type'),
  };
}
