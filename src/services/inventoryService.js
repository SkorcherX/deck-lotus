import db from '../db/connection.js';
import {
  normalizeForSearch,
  fuzzyPlan,
  rankFuzzyCandidates
} from '../utils/cardNameMatch.js';

// Price of one owned copy, honouring its finish. Foil copies are worth their
// foil price; where a printing has no foil price synced we fall back to the
// normal price rather than treating the copy as unpriced.
// Expects `op` (owned_printings) and `p` (printings) to be in scope.
const OWNED_COPY_PRICE = `
  COALESCE(
    (SELECT price FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer'
        AND price_type = CASE WHEN op.is_foil = 1 THEN 'foil' ELSE 'normal' END
      LIMIT 1),
    (SELECT price FROM prices
      WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal'
      LIMIT 1)
  )
`;

/**
 * Builds a `= ?` or `IN (?,?,...)` clause plus matching params for a user
 * scope that may be a single id (regular per-user routes) or an array of ids
 * (admin cross-user views). Callers interpolate `clause` directly after a
 * column name, e.g. \`op.user_id ${clause}\`.
 */
function userScopeSql(userIds) {
  if (Array.isArray(userIds)) {
    if (userIds.length === 0) {
      throw new Error('userIds must be a non-empty array');
    }
    return { clause: `IN (${userIds.map(() => '?').join(',')})`, params: [...userIds] };
  }
  return { clause: '= ?', params: [userIds] };
}

/**
 * Get all owned cards for inventory display
 * Returns cards with printing details, quantities, and deck usage stats
 */
export function getInventory(userIds, filters = {}) {
  const {
    name,
    colors = [],
    type,
    sets = [],
    sort = 'name',
    availability = 'all', // 'all', 'available', 'in_decks'
    page = 1,
    limit = 50
  } = filters;

  const isMultiUser = Array.isArray(userIds);
  const scope = userScopeSql(userIds);
  const usernamesById = isMultiUser ? getUsernamesById(userIds) : null;

  const offset = (page - 1) * limit;
  const params = [];
  const countParams = [];

  // Base query - get all owned cards with their details
  let sql = `
    SELECT DISTINCT
      c.id as card_id,
      c.name,
      c.mana_cost,
      c.cmc,
      c.colors,
      c.type_line,
      c.oracle_text,
      (SELECT p.image_url FROM printings p WHERE p.card_id = c.id AND p.image_url IS NOT NULL LIMIT 1) as image_url,
      (
        SELECT COALESCE(SUM(op.quantity), 0)
        FROM owned_printings op
        JOIN printings p ON op.printing_id = p.id
        WHERE op.user_id ${scope.clause} AND p.card_id = c.id
      ) as total_owned,
      (
        SELECT COALESCE(SUM(dc.quantity), 0)
        FROM deck_cards dc
        JOIN printings p ON dc.printing_id = p.id
        JOIN decks d ON dc.deck_id = d.id
        WHERE d.user_id ${scope.clause} AND p.card_id = c.id
      ) as total_in_decks,
      (
        SELECT MAX(NULLIF(${OWNED_COPY_PRICE}, 0))
        FROM owned_printings op
        JOIN printings p ON op.printing_id = p.id
        WHERE op.user_id ${scope.clause} AND p.card_id = c.id
      ) as max_price
    FROM cards c
    WHERE c.id IN (
      SELECT DISTINCT p.card_id
      FROM owned_printings op
      JOIN printings p ON op.printing_id = p.id
      WHERE op.user_id ${scope.clause}
    )
  `;

  // Params for the subqueries — order matches the SELECT above:
  // total_owned, total_in_decks, max_price, then the WHERE ... IN
  params.push(...scope.params, ...scope.params, ...scope.params, ...scope.params);

  // Count query
  let countSql = `
    SELECT COUNT(DISTINCT c.id) as total
    FROM cards c
    WHERE c.id IN (
      SELECT DISTINCT p.card_id
      FROM owned_printings op
      JOIN printings p ON op.printing_id = p.id
      WHERE op.user_id ${scope.clause}
    )
  `;
  countParams.push(...scope.params);

  // Name filter
  if (name && name.trim()) {
    sql += ` AND c.name LIKE ?`;
    countSql += ` AND c.name LIKE ?`;
    params.push(`%${name}%`);
    countParams.push(`%${name}%`);
  }

  // Color filter
  const colorsArray = Array.isArray(colors) ? colors : [];
  if (colorsArray.length > 0) {
    const hasColorless = colorsArray.includes('C');
    const actualColors = colorsArray.filter(c => c !== 'C');

    if (hasColorless && actualColors.length === 0) {
      sql += ` AND (c.colors IS NULL OR c.colors = '' OR c.colors = '[]')`;
      countSql += ` AND (c.colors IS NULL OR c.colors = '' OR c.colors = '[]')`;
    } else if (hasColorless && actualColors.length > 0) {
      sql += ` AND (`;
      countSql += ` AND (`;
      const colorConditions = [];
      actualColors.forEach(color => {
        colorConditions.push(`c.colors LIKE ?`);
        params.push(`%${color}%`);
        countParams.push(`%${color}%`);
      });
      sql += colorConditions.join(' AND ');
      countSql += colorConditions.join(' AND ');
      sql += ` OR c.colors IS NULL OR c.colors = '' OR c.colors = '[]')`;
      countSql += ` OR c.colors IS NULL OR c.colors = '' OR c.colors = '[]')`;
    } else {
      actualColors.forEach(color => {
        sql += ` AND c.colors LIKE ?`;
        countSql += ` AND c.colors LIKE ?`;
        params.push(`%${color}%`);
        countParams.push(`%${color}%`);
      });
    }
  }

  // Type filter
  if (type && type.trim() && type !== 'all') {
    sql += ` AND c.type_line LIKE ?`;
    countSql += ` AND c.type_line LIKE ?`;
    params.push(`%${type}%`);
    countParams.push(`%${type}%`);
  }

  // Set filter - cards that have owned printings in the selected sets
  const setsArray = Array.isArray(sets) ? sets : [];
  if (setsArray.length > 0) {
    const placeholders = setsArray.map(() => '?').join(',');
    sql += ` AND c.id IN (
      SELECT DISTINCT p2.card_id
      FROM owned_printings op2
      JOIN printings p2 ON op2.printing_id = p2.id
      WHERE op2.user_id ${scope.clause} AND p2.set_code IN (${placeholders})
    )`;
    countSql += ` AND c.id IN (
      SELECT DISTINCT p2.card_id
      FROM owned_printings op2
      JOIN printings p2 ON op2.printing_id = p2.id
      WHERE op2.user_id ${scope.clause} AND p2.set_code IN (${placeholders})
    )`;
    params.push(...scope.params, ...setsArray);
    countParams.push(...scope.params, ...setsArray);
  }

  // Get total count
  const countResult = db.get(countSql, countParams);
  const total = countResult ? countResult.total : 0;

  // Sorting
  switch (sort) {
    case 'name':
      sql += ` ORDER BY c.name ASC`;
      break;
    case 'cmc':
      sql += ` ORDER BY c.cmc ASC, c.name ASC`;
      break;
    case 'color':
      sql += ` ORDER BY c.colors ASC, c.name ASC`;
      break;
    case 'quantity':
      sql += ` ORDER BY total_owned DESC, c.name ASC`;
      break;
    case 'type':
      sql += ` ORDER BY c.type_line ASC, c.name ASC`;
      break;
    // Cards with no synced price sort last in both directions — "unknown" is
    // not the same as "cheap", so they should not head up the ascending list.
    case 'price_desc':
      sql += ` ORDER BY max_price IS NULL, max_price DESC, c.name ASC`;
      break;
    case 'price_asc':
      sql += ` ORDER BY max_price IS NULL, max_price ASC, c.name ASC`;
      break;
    default:
      sql += ` ORDER BY c.name ASC`;
  }

  // Pagination
  sql += ` LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  const cards = db.all(sql, params);

  // Filter by availability after fetching (since it involves calculated fields)
  let filteredCards = cards;
  if (availability === 'available') {
    filteredCards = cards.filter(card => (card.total_owned - card.total_in_decks) > 0);
  } else if (availability === 'in_decks') {
    filteredCards = cards.filter(card => card.total_in_decks > 0);
  }

  // Get printings for each card
  const cardsWithPrintings = filteredCards.map(card => {
    const printings = db.all(`
      SELECT
        op.id as owned_printing_id,
        op.user_id,
        op.quantity,
        op.is_foil,
        p.id as printing_id,
        p.set_code,
        p.collector_number,
        p.rarity,
        p.image_url,
        s.name as set_name,
        ${OWNED_COPY_PRICE} as price
      FROM owned_printings op
      JOIN printings p ON op.printing_id = p.id
      LEFT JOIN sets s ON p.set_code = s.code
      WHERE op.user_id ${scope.clause} AND p.card_id = ?
      ORDER BY p.set_code, p.collector_number, op.is_foil
    `, [...scope.params, card.card_id]);

    // Admin multi-user view: show whose collection each card's copies come
    // from, so filtering to a subset of users is legible per-card rather than
    // just an opaque combined total.
    const owners = isMultiUser ? summarizeOwners(printings, usernamesById) : undefined;

    return {
      ...card,
      ...(owners ? { owners } : {}),
      // Show the art of a printing actually owned, not whichever one the
      // card-level query happened to reach first. The list is how a collection
      // is recognised at a glance, and the art is the thing a user recognises —
      // showing a different printing's art than the one they chose, and than
      // the detail view shows when they click through, makes their own
      // collection look unfamiliar.
      //
      // Where several printings of a card are owned, the one with the most
      // copies represents the row; ties fall to the printings query's own
      // ordering, so the choice is stable between requests.
      image_url: representativeImage(printings) || card.image_url,
      available: card.total_owned - card.total_in_decks,
      printings
    };
  });

  return {
    cards: cardsWithPrintings,
    pagination: {
      page,
      totalPages: Math.ceil(total / limit),
      totalCards: total,
      limit
    }
  };
}

function getUsernamesById(userIds) {
  const rows = db.all(
    `SELECT id, username FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`,
    userIds
  );
  return new Map(rows.map(r => [r.id, r.username]));
}

/**
 * Per-card owner breakdown for the admin multi-user view: how many copies
 * each selected user contributes, summed across their printings.
 */
function summarizeOwners(printings, usernamesById) {
  const totals = new Map();
  for (const printing of printings) {
    totals.set(printing.user_id, (totals.get(printing.user_id) || 0) + printing.quantity);
  }
  return [...totals.entries()].map(([userId, quantity]) => ({
    userId,
    username: usernamesById.get(userId) || `#${userId}`,
    quantity
  }));
}

/**
 * The owned printing whose art should stand for the card in a list.
 *
 * Returns null when no owned printing has an image, leaving the caller to fall
 * back to any printing of the card — a picture of the right card beats no
 * picture at all.
 */
function representativeImage(printings) {
  let best = null;
  for (const printing of printings) {
    if (!printing.image_url) continue;
    if (!best || printing.quantity > best.quantity) best = printing;
  }
  return best ? best.image_url : null;
}

/**
 * Get inventory statistics
 */
export function getInventoryStats(userIds) {
  const scope = userScopeSql(userIds);

  // Total unique cards owned
  const uniqueCards = db.get(`
    SELECT COUNT(DISTINCT p.card_id) as count
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    WHERE op.user_id ${scope.clause}
  `, scope.params);

  // Total copies owned
  const totalCopies = db.get(`
    SELECT COALESCE(SUM(quantity), 0) as count
    FROM owned_printings
    WHERE user_id ${scope.clause}
  `, scope.params);

  // Total in decks
  const inDecks = db.get(`
    SELECT COALESCE(SUM(dc.quantity), 0) as count
    FROM deck_cards dc
    JOIN decks d ON dc.deck_id = d.id
    WHERE d.user_id ${scope.clause}
  `, scope.params);

  // Estimated total value
  const estimatedValue = db.get(`
    SELECT COALESCE(SUM(
      op.quantity * COALESCE(${OWNED_COPY_PRICE}, 0)
    ), 0) as total
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    WHERE op.user_id ${scope.clause}
  `, scope.params);

  const totalOwned = totalCopies?.count || 0;
  const totalInDecks = inDecks?.count || 0;

  return {
    uniqueCards: uniqueCards?.count || 0,
    totalCopies: totalOwned,
    inDecks: totalInDecks,
    available: totalOwned - totalInDecks,
    estimatedValue: estimatedValue?.total || 0
  };
}

// Ceiling on how many near-miss candidates the edit-distance pass considers.
// Only reached when every chunk of the query is a common substring.
const FUZZY_CANDIDATE_CAP = 3000;

const INVENTORY_SEARCH_COLUMNS = `
  c.id as card_id,
  c.name,
  c.mana_cost,
  c.type_line,
  (SELECT p.image_url FROM printings p WHERE p.card_id = c.id AND p.image_url IS NOT NULL LIMIT 1) as image_url,
  (SELECT p.id FROM printings p WHERE p.card_id = c.id ORDER BY
    CASE WHEN (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1) IS NULL THEN 999999
    ELSE (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1) END ASC
    LIMIT 1) as cheapest_printing_id,
  (
    SELECT COALESCE(SUM(op.quantity), 0)
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    WHERE op.user_id = ? AND p.card_id = c.id
  ) as total_owned
`;

/**
 * Card ids within a typo's reach of the query, best match first.
 *
 * Only worth running when the substring search found nothing, since it walks
 * the card table. The length filter and the shared-character check throw out
 * the vast majority of names before the edit-distance matrix runs.
 */
function fuzzyCardIdsByName(normalizedQuery, limit) {
  // Any name within `tolerance` edits contains one of these patterns verbatim,
  // so this narrows to a shortlist without discarding a real match.
  const { tolerance, minLength, likePatterns } = fuzzyPlan(normalizedQuery);
  const chunkFilter = likePatterns.map(() => 'name_normalized LIKE ?').join(' OR ');

  const candidates = db.all(
    `SELECT id, name_normalized AS text FROM cards
     WHERE name_normalized IS NOT NULL
       AND LENGTH(name_normalized) >= ?
       AND (${chunkFilter})
     LIMIT ?`,
    [minLength, ...likePatterns, FUZZY_CANDIDATE_CAP]
  );

  return rankFuzzyCandidates(normalizedQuery, candidates, limit, tolerance);
}

/**
 * Search cards for quick-add to inventory
 * Returns cards with their ownership status
 *
 * Matches on the normalized name, so punctuation and accents are optional
 * ("urzas tower", "jotun grunt"). If that finds nothing, falls back to an
 * edit-distance pass that forgives a typo or two.
 */
export function searchCardsForInventoryAdd(userId, query, limit = 10) {
  if (!query || query.trim().length < 2) {
    return [];
  }

  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) {
    return [];
  }

  const cards = db.all(`
    SELECT ${INVENTORY_SEARCH_COLUMNS}
    FROM cards c
    WHERE c.name_normalized LIKE ?
    ORDER BY
      CASE WHEN c.name_normalized LIKE ? THEN 0 ELSE 1 END,
      LENGTH(c.name),
      c.name
    LIMIT ?
  `, [userId, `%${normalizedQuery}%`, `${normalizedQuery}%`, limit]);

  if (cards.length > 0) {
    return cards;
  }

  // Nothing contained what they typed — assume a typo rather than a card
  // that does not exist.
  const ids = fuzzyCardIdsByName(normalizedQuery, limit);
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(', ');
  const matches = db.all(`
    SELECT ${INVENTORY_SEARCH_COLUMNS}
    FROM cards c
    WHERE c.id IN (${placeholders})
  `, [userId, ...ids]);

  // Restore the ranking the fuzzy pass worked out; SQL gave it back in id order.
  const order = new Map(ids.map((id, index) => [id, index]));
  return matches.sort((a, b) => order.get(a.card_id) - order.get(b.card_id));
}

/**
 * Resolve one bulk-add item to a concrete printing.
 *
 * Two ways in:
 *  - set code + collector number, with no card name at all. This pair
 *    identifies exactly one printing, so we can skip name matching entirely.
 *  - card name, optionally narrowed by set code, falling back to the
 *    cheapest printing of that card.
 *
 * Returns { printing, cardId, cardName, setCode, collectorNumber } on success
 * or { error } describing why the line could not be resolved.
 */
function resolveBulkItem(item) {
  const { cardName, collectorNumber } = item;
  // Set codes are stored the way MTGJSON emits them: uppercase.
  const setCode = item.setCode ? item.setCode.toUpperCase() : null;

  // Set code + collector number identifies a single printing on its own.
  if (setCode && collectorNumber) {
    const printing = db.get(
      `SELECT p.id, p.card_id, p.set_code, p.collector_number, c.name
       FROM printings p
       JOIN cards c ON c.id = p.card_id
       WHERE p.set_code = ? AND p.collector_number = ? COLLATE NOCASE
       LIMIT 1`,
      [setCode, String(collectorNumber)]
    );

    if (!printing) {
      return { error: `No printing found for ${setCode} ${collectorNumber}` };
    }

    return {
      printing,
      cardId: printing.card_id,
      cardName: printing.name,
      setCode: printing.set_code,
      collectorNumber: printing.collector_number
    };
  }

  if (!cardName) {
    return { error: 'Card name, or set code and collector number, is required' };
  }

  // Find the card
  let card = db.get(`SELECT id, name FROM cards WHERE name = ?`, [cardName]);

  if (!card) {
    // Try fuzzy match
    card = db.get(
      `SELECT id, name FROM cards WHERE name LIKE ? LIMIT 1`,
      [`%${cardName}%`]
    );

    if (!card) {
      return { error: 'Card not found' };
    }
  }

  // Find the printing
  let printing;
  if (setCode) {
    printing = db.get(
      `SELECT id, card_id, set_code, collector_number FROM printings
       WHERE card_id = ? AND set_code = ? LIMIT 1`,
      [card.id, setCode]
    );
  }

  if (!printing) {
    // Get cheapest printing
    printing = db.get(`
      SELECT p.id, p.card_id, p.set_code, p.collector_number
      FROM printings p
      WHERE p.card_id = ?
      ORDER BY
        CASE WHEN (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1) IS NULL THEN 999999
        ELSE (SELECT price FROM prices WHERE printing_uuid = p.uuid AND provider = 'tcgplayer' AND price_type = 'normal' LIMIT 1) END ASC
      LIMIT 1
    `, [card.id]);
  }

  if (!printing) {
    return { error: 'Printing not found' };
  }

  return {
    printing,
    cardId: card.id,
    cardName: card.name,
    setCode: printing.set_code,
    collectorNumber: printing.collector_number
  };
}

/**
 * Resolve bulk-add items without writing anything, so the UI can show what
 * each line actually maps to. Matters most for set-code + collector-number
 * lines, where the user never typed a card name to check against.
 */
export function resolveBulkAddItems(items) {
  return items.map((item) => {
    const quantity = item.quantity ?? 1;
    const isFoil = !!item.isFoil;

    let resolved;
    try {
      resolved = resolveBulkItem(item);
    } catch (error) {
      resolved = { error: error.message };
    }

    if (resolved.error) {
      return {
        input: item,
        quantity,
        isFoil,
        resolved: false,
        error: resolved.error
      };
    }

    return {
      input: item,
      quantity,
      isFoil,
      resolved: true,
      printingId: resolved.printing.id,
      cardName: resolved.cardName,
      setCode: resolved.setCode,
      collectorNumber: resolved.collectorNumber
    };
  });
}

/**
 * Bulk add cards to inventory
 * Accepts array of items: { cardName, setCode, collectorNumber, quantity, isFoil }
 * Either cardName or (setCode + collectorNumber) must be present.
 */
export function bulkAddToInventory(userId, items) {
  const results = {
    added: 0,
    failed: 0,
    errors: []
  };

  for (const item of items) {
    try {
      const { quantity = 1, isFoil = false } = item;
      const foilFlag = isFoil ? 1 : 0;

      const resolved = resolveBulkItem(item);

      if (resolved.error) {
        results.failed++;
        results.errors.push({
          cardName: item.cardName,
          setCode: item.setCode,
          collectorNumber: item.collectorNumber,
          error: resolved.error
        });
        continue;
      }

      const { printing, cardId } = resolved;

      // Add or update owned_printings
      const existing = db.get(
        `SELECT id, quantity FROM owned_printings WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
        [userId, printing.id, foilFlag]
      );

      if (existing) {
        db.run(
          `UPDATE owned_printings SET quantity = quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          [quantity, existing.id]
        );
      } else {
        db.run(
          `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?, ?, ?, ?)`,
          [userId, printing.id, quantity, foilFlag]
        );
      }

      // Update owned_cards for backward compatibility
      db.run(
        `INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (?, ?, 1)
         ON CONFLICT(user_id, card_id) DO UPDATE SET quantity = 1`,
        [userId, cardId]
      );

      results.added += quantity;
    } catch (error) {
      results.failed++;
      results.errors.push({ cardName: item.cardName, error: error.message });
    }
  }

  return results;
}

/**
 * Get sets that the user owns cards from (for filtering)
 */
export function getOwnedSets(userId) {
  return db.all(`
    SELECT DISTINCT s.code, s.name, s.release_date,
      (SELECT COUNT(*) FROM owned_printings op2
       JOIN printings p2 ON op2.printing_id = p2.id
       WHERE op2.user_id = ? AND p2.set_code = s.code) as owned_count
    FROM sets s
    WHERE s.code IN (
      SELECT DISTINCT p.set_code
      FROM owned_printings op
      JOIN printings p ON op.printing_id = p.id
      WHERE op.user_id = ?
    )
    ORDER BY s.release_date DESC, s.name
  `, [userId, userId]);
}
