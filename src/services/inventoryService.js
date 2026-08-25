import db from '../db/connection.js';
import {
  normalizeForSearch,
  fuzzyPlan,
  rankFuzzyCandidates
} from '../utils/cardNameMatch.js';
import { ROLE_FILTERS } from './cardRoleService.js';
import { colorFilterSql } from '../utils/colorFilter.js';
import { isBasicLandSql } from './basicLands.js';
import { recordInventoryChange } from './auditService.js';

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

// A card can lead a Commander deck if it's a legendary creature, or its
// Oracle text explicitly grants that (backgrounds' partners, some
// planeswalkers, etc.). Expects `c` (cards) to be in scope.
const COMMANDER_ELIGIBLE_SQL = `(
  (c.type_line LIKE '%Legendary%' AND c.type_line LIKE '%Creature%')
  OR c.oracle_text LIKE '%can be your commander%'
)`;

// How many copies of a card the scope owns, and how many of those are
// committed to decks. Both are used twice over — once as a displayed column,
// once by the availability filter — and the filter has to agree with the
// number shown, so they are written once here. Each takes one set of scope
// params. Expects `c` (cards) to be in scope.
const ownedTotalSql = (scopeClause) => `(
  SELECT COALESCE(SUM(op.quantity), 0)
  FROM owned_printings op
  JOIN printings p ON op.printing_id = p.id
  WHERE op.user_id ${scopeClause} AND p.card_id = c.id
)`;

const inDecksTotalSql = (scopeClause) => `(
  SELECT COALESCE(SUM(dc.quantity), 0)
  FROM deck_cards dc
  JOIN printings p ON dc.printing_id = p.id
  JOIN decks d ON dc.deck_id = d.id
  WHERE d.user_id ${scopeClause} AND p.card_id = c.id
)`;

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
    names,
    colors = [],
    type,
    sets = [],
    sort = 'name',
    availability = 'all', // 'all', 'available', 'in_decks'
    commander = 'all', // 'all', 'eligible'
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
      ${ownedTotalSql(scope.clause)} as total_owned,
      ${inDecksTotalSql(scope.clause)} as total_in_decks,
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

  // Name filter. The inventory view sends one term per name chip and every
  // one has to match, so "bolt" + "lightning" narrows rather than widens.
  // `name` stays accepted as a single string for the callers that pass one.
  const nameTerms = (Array.isArray(names) ? names : name ? [name] : [])
    .map((term) => String(term).trim())
    .filter(Boolean);

  for (const term of nameTerms) {
    sql += ` AND c.name LIKE ?`;
    countSql += ` AND c.name LIKE ?`;
    params.push(`%${term}%`);
    countParams.push(`%${term}%`);
  }

  // Color filter. The rule for what counts as a colour — including that a land
  // counts as what it taps for — lives in colorFilterSql, shared with the deck
  // builder's panel so the two views cannot disagree.
  const colorFilter = colorFilterSql(colors, 'c');
  if (colorFilter.clause) {
    sql += ` AND ${colorFilter.clause}`;
    countSql += ` AND ${colorFilter.clause}`;
    params.push(...colorFilter.params);
    countParams.push(...colorFilter.params);
  }

  // Type filter
  if (type && type.trim() && type !== 'all') {
    sql += ` AND c.type_line LIKE ?`;
    countSql += ` AND c.type_line LIKE ?`;
    params.push(`%${type}%`);
    countParams.push(`%${type}%`);
  }

  // Commander eligibility filter: legendary creatures, plus anything else
  // Oracle text explicitly says can be a commander (backgrounds' partners,
  // certain planeswalkers, etc.)
  if (commander === 'eligible') {
    sql += ` AND ${COMMANDER_ELIGIBLE_SQL}`;
    countSql += ` AND ${COMMANDER_ELIGIBLE_SQL}`;
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

  // Availability filter. This has to be part of the query rather than a pass
  // over the fetched page: filtering afterwards would drop cards from a page
  // that was already cut to `limit`, leaving short pages and a total that
  // disagrees with what is on screen.
  if (availability === 'available') {
    const clause = ` AND (${ownedTotalSql(scope.clause)} - ${inDecksTotalSql(scope.clause)}) > 0`;
    sql += clause;
    countSql += clause;
    params.push(...scope.params, ...scope.params);
    countParams.push(...scope.params, ...scope.params);
  } else if (availability === 'in_decks') {
    const clause = ` AND ${inDecksTotalSql(scope.clause)} > 0`;
    sql += clause;
    countSql += clause;
    params.push(...scope.params);
    countParams.push(...scope.params);
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

  // Get printings for each card
  const cardsWithPrintings = cards.map(card => {
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

  // What the collection is made of. The CASE is deliberately the same ladder,
  // in the same order, as the deck stats query in deckService.js — an artifact
  // land has to land in the same bucket in both places, or the two breakdowns
  // disagree about a card the user can see in each.
  const typeBreakdown = db.all(`
    SELECT
      CASE
        WHEN c.type_line LIKE '%Creature%' THEN 'Creature'
        WHEN c.type_line LIKE '%Instant%' THEN 'Instant'
        WHEN c.type_line LIKE '%Sorcery%' THEN 'Sorcery'
        WHEN c.type_line LIKE '%Enchantment%' THEN 'Enchantment'
        WHEN c.type_line LIKE '%Artifact%' THEN 'Artifact'
        WHEN c.type_line LIKE '%Planeswalker%' THEN 'Planeswalker'
        WHEN c.type_line LIKE '%Land%' THEN 'Land'
        ELSE 'Other'
      END as type,
      COALESCE(SUM(op.quantity), 0) as total_cards
    FROM owned_printings op
    JOIN printings p ON op.printing_id = p.id
    JOIN cards c ON p.card_id = c.id
    WHERE op.user_id ${scope.clause}
    GROUP BY type
    ORDER BY total_cards DESC
  `, scope.params);

  const totalOwned = totalCopies?.count || 0;
  const totalInDecks = inDecks?.count || 0;

  return {
    uniqueCards: uniqueCards?.count || 0,
    totalCopies: totalOwned,
    inDecks: totalInDecks,
    available: totalOwned - totalInDecks,
    estimatedValue: estimatedValue?.total || 0,
    typeBreakdown: typeBreakdown || []
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
export function bulkAddToInventory(userId, items, context = {}) {
  const results = {
    added: 0,
    failed: 0,
    errors: []
  };

  // A batch id ties every row of one paste together, so a hundred-line import
  // that resolved against the wrong set can be pulled back out of the log as
  // a unit rather than reconstructed from timestamps.
  const batchId = context.batchId
    || `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const source = context.source || 'bulk_add';

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

      // What the line said is logged next to what it resolved to. A wrong set
      // code is invisible once it has become a printing id — the only way to
      // see that "Lightning Bolt (M10) 146" was entered and "Lightning Bolt
      // (LEA) 161" was stored is to keep both.
      recordInventoryChange({
        userId,
        actorUserId: context.actorUserId ?? userId,
        printingId: printing.id,
        isFoil,
        before: existing?.quantity || 0,
        after: (existing?.quantity || 0) + quantity,
        source,
        detail: {
          batchId,
          entered: {
            cardName: item.cardName ?? null,
            setCode: item.setCode ?? null,
            collectorNumber: item.collectorNumber ?? null,
            quantity,
            isFoil: !!isFoil,
          },
        },
      });

      results.added += quantity;
    } catch (error) {
      results.failed++;
      results.errors.push({ cardName: item.cardName, error: error.message });
    }
  }

  // Handed back so the import's own result can link straight to the batch it
  // just wrote, rather than making the user hunt for it by timestamp.
  return { ...results, batchId };
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

/**
 * Basic lands are exempt from availability accounting. Nobody tracks how many
 * Islands they own, and a deck asking for 24 of them is not over-allocated.
 */
const IS_BASIC_LAND = isBasicLandSql('c');


/**
 * The availability calculation, as a CTE other queries can build on.
 *
 * Ends with an `availability` table holding one row per printing-and-finish,
 * carrying enough card detail to render a list without a second query.
 * Expects six leading parameters, in order:
 *   userId, userId, currentDeckId, currentDeckId, userId, userId
 */
const AVAILABILITY_CTE = `
  WITH keys AS (
    SELECT printing_id, is_foil FROM owned_printings WHERE user_id = ?
    UNION
    SELECT dc.printing_id, dc.is_foil
      FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id
     WHERE d.user_id = ?
  ),
  usage AS (
    SELECT dc.printing_id,
           dc.is_foil,
           SUM(CASE WHEN dc.deck_id =  ? THEN dc.quantity ELSE 0 END) AS in_this_deck,
           SUM(CASE WHEN dc.deck_id <> ? THEN dc.quantity ELSE 0 END) AS committed
      FROM deck_cards dc
      JOIN decks d ON d.id = dc.deck_id
     WHERE d.user_id = ?
     GROUP BY dc.printing_id, dc.is_foil
  ),
  availability AS (
    SELECT
      k.printing_id,
      k.is_foil,
      c.id   AS card_id,
      c.name AS card_name,
      c.name_normalized,
      c.mana_cost,
      c.cmc,
      c.colors,
      c.color_identity,
      c.type_line,
      c.oracle_text,
      c.legalities,
      p.set_code,
      p.collector_number,
      p.rarity,
      p.image_url,
      COALESCE(o.quantity, 0)     AS owned,
      COALESCE(u.committed, 0)    AS committed,
      COALESCE(u.in_this_deck, 0) AS in_this_deck,
      CASE WHEN ${IS_BASIC_LAND} THEN 1 ELSE 0 END AS is_basic_land
    FROM keys k
    JOIN printings p ON p.id = k.printing_id
    JOIN cards c ON c.id = p.card_id
    LEFT JOIN owned_printings o
      ON o.user_id = ? AND o.printing_id = k.printing_id AND o.is_foil = k.is_foil
    LEFT JOIN usage u
      ON u.printing_id = k.printing_id AND u.is_foil = k.is_foil
  )
`;

/** -1 never matches a real deck id, so a null deckId needs no NULL handling. */
function availabilityParams(userId, deckId) {
  const currentDeck = deckId ?? -1;
  return [userId, userId, currentDeck, currentDeck, userId, userId];
}

/** Shape one availability row for callers. */
function toAvailability(row) {
  const unlimited = row.is_basic_land === 1;

  return {
    printingId: row.printing_id,
    isFoil: row.is_foil === 1,
    cardId: row.card_id,
    cardName: row.card_name,
    setCode: row.set_code,
    collectorNumber: row.collector_number,
    owned: row.owned,
    committed: row.committed,
    inThisDeck: row.in_this_deck,
    // Negative means over-allocated across decks — reported, never blocked.
    free: unlimited ? null : row.owned - row.committed - row.in_this_deck,
    unlimited
  };
}

/** Stable key for one printing in one finish. */
export function availabilityKey(printingId, isFoil) {
  return `${printingId}:${isFoil ? 1 : 0}`;
}

/**
 * How many copies of each printing-and-finish the user can still spend.
 *
 * Allocation is advisory: `free` is allowed to go negative, and that is the
 * point. Listing the same card in three decks is normal collection behaviour,
 * not an error, so this reports the shortfall and leaves the decision to the
 * user rather than clamping quantities.
 *
 * `committed` deliberately excludes `deckId`, so the deck being edited is
 * counted once — as `inThisDeck` — instead of appearing to compete with
 * itself.
 *
 * Covers every printing the user owns, plus any the deck lists but they do not
 * own (which come back owned: 0 and free negative).
 */
export function getAvailability(userId, deckId = null, printingIds = null) {
  const filter = printingIds && printingIds.length > 0
    ? `WHERE printing_id IN (${printingIds.map(() => '?').join(', ')})`
    : '';

  const rows = db.all(
    `${AVAILABILITY_CTE}
     SELECT * FROM availability
     ${filter}
     ORDER BY card_name, set_code, collector_number, is_foil`,
    [...availabilityParams(userId, deckId), ...(filter ? printingIds : [])]
  );

  return rows.map(toAvailability);
}

/**
 * The same figures keyed by printing and finish, for callers rendering a list
 * and looking each row up as they go.
 */
export function getAvailabilityMap(userId, deckId = null, printingIds = null) {
  const map = new Map();

  for (const entry of getAvailability(userId, deckId, printingIds)) {
    map.set(availabilityKey(entry.printingId, entry.isFoil), entry);
  }

  return map;
}

const COLORS = ['W', 'U', 'B', 'R', 'G'];

/**
 * Cards in the collection within a typo's reach of the query, closest first.
 *
 * Scoped to the rows the panel's other filters already allow, so a fuzzy match
 * cannot smuggle in a card the user filtered out — or one they do not own.
 */
function fuzzyOwnedCardIds(baseParams, otherClauses, otherParams, normalizedName) {
  const { tolerance, minLength, likePatterns } = fuzzyPlan(normalizedName);
  const chunkFilter = likePatterns.map(() => 'name_normalized LIKE ?').join(' OR ');

  const clauses = [
    ...otherClauses,
    'LENGTH(name_normalized) >= ?',
    `(${chunkFilter})`
  ];

  const candidates = db.all(
    `${AVAILABILITY_CTE}
     SELECT DISTINCT card_id AS id, name_normalized AS text
       FROM availability
      WHERE ${clauses.join(' AND ')}
      LIMIT ?`,
    [...baseParams, ...otherParams, minLength, ...likePatterns, FUZZY_CANDIDATE_CAP]
  );

  return rankFuzzyCandidates(normalizedName, candidates, FUZZY_NAME_MATCHES, tolerance);
}

/** How many distinct cards a typo may resolve to before it stops being helpful. */
const FUZZY_NAME_MATCHES = 25;

/**
 * The feed behind the deck builder's inventory panel: owned printings, with
 * their availability and enough detail to render, narrowed by the filters the
 * builder offers.
 *
 * Filters here rather than in the client because the list is paginated — a
 * client-side filter would give the wrong totals and page through the wrong
 * rows.
 */
export function getBuilderInventory(userId, deckId, filters = {}) {
  const {
    name,
    type,
    colors = [],
    colorIdentity,
    maxCmc,
    onlyFree = false,
    format,
    role,
    page = 1,
    limit = 60
  } = filters;

  const where = [];
  const params = [];

  // Only what they actually own — a deck card they do not own belongs in the
  // deck list, not in a panel offering cards to add.
  where.push('owned > 0');

  // The name filter is kept out of `where` so the fuzzy fallback below can
  // swap it out for a card-id list while keeping every other filter intact.
  const normalizedName = name && name.trim() ? normalizeForSearch(name) : '';

  if (type && type.trim() && type !== 'all') {
    where.push('type_line LIKE ?');
    params.push(`%${type}%`);
  }

  // Colour filter, shared with the inventory page. A land counts as the colours
  // it produces rather than the colours it is, which is what makes "show me
  // blue lands" work at all.
  const builderColorFilter = colorFilterSql(colors, '');
  if (builderColorFilter.clause) {
    where.push(builderColorFilter.clause);
    params.push(...builderColorFilter.params);
  }

  // Commander colour identity: every colour on the card must be one the
  // commander allows, so exclude any card carrying a colour outside the set.
  if (colorIdentity) {
    const allowed = String(colorIdentity).toUpperCase();
    for (const color of COLORS) {
      if (!allowed.includes(color)) {
        where.push(`(color_identity IS NULL OR color_identity NOT LIKE ?)`);
        params.push(`%${color}%`);
      }
    }
  }

  // Used by the curve suggestion to show what a top-heavy deck is short of.
  if (maxCmc !== undefined && maxCmc !== null && maxCmc !== '') {
    where.push('cmc <= ?');
    params.push(Number(maxCmc));
  }

  // What a card does, for the deck advisor's suggestions — "show me removal
  // that isn't creature removal" is not something the type and colour filters
  // can express. The SQL approximates the oracle-text predicate it is named
  // after; it only has to put plausible cards in front of someone.
  if (role && ROLE_FILTERS[role]) {
    where.push(ROLE_FILTERS[role].sql);
  }

  if (onlyFree) {
    where.push('(is_basic_land = 1 OR owned - committed - in_this_deck > 0)');
  }

  if (format && format.trim()) {
    // legalities is a JSON object built by the importer with lowercase format
    // keys and no whitespace, e.g. {"modern":"Legal",...}. Matching the pair as
    // text avoids depending on the JSON1 extension being compiled in.
    where.push('legalities LIKE ?');
    params.push(`%"${format.toLowerCase()}":"Legal"%`);
  }

  const baseParams = availabilityParams(userId, deckId);

  const buildWhere = (clauses) => (clauses.length ? `WHERE ${clauses.join(' AND ')}` : '');
  const countRows = (clauses, clauseParams) => db.get(
    `${AVAILABILITY_CTE} SELECT COUNT(*) AS total FROM availability ${buildWhere(clauses)}`,
    [...baseParams, ...clauseParams]
  ).total;

  const NAME_ORDER = 'card_name, set_code, collector_number, is_foil';

  // Substring match first, on the normalized name, so punctuation and accents
  // are optional.
  let clauses = normalizedName ? [...where, 'name_normalized LIKE ?'] : where;
  let queryParams = normalizedName ? [...params, `%${normalizedName}%`] : params;
  let order = NAME_ORDER;
  let total = countRows(clauses, queryParams);

  // Nothing contained what they typed, so assume a typo rather than a card
  // they do not own — matching how the card searches behave. The fallback
  // keeps every other filter, so it can only ever narrow.
  if (total === 0 && normalizedName) {
    const ids = fuzzyOwnedCardIds(baseParams, where, params, normalizedName);

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');

      clauses = [...where, `card_id IN (${placeholders})`];
      queryParams = [...params, ...ids];
      // Closest match first, as the fuzzy pass ranked them.
      order = `CASE card_id ${ids.map((id, i) => `WHEN ${id} THEN ${i}`).join(' ')} ELSE ${ids.length} END, ${NAME_ORDER}`;
      total = countRows(clauses, queryParams);
    }
  }

  const whereSql = buildWhere(clauses);

  const offset = (page - 1) * limit;

  const rows = db.all(
    `${AVAILABILITY_CTE}
     SELECT * FROM availability
     ${whereSql}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    [...baseParams, ...queryParams, limit, offset]
  );

  return {
    items: rows.map((row) => ({
      ...toAvailability(row),
      manaCost: row.mana_cost,
      cmc: row.cmc,
      colors: row.colors,
      colorIdentity: row.color_identity,
      typeLine: row.type_line,
      oracleText: row.oracle_text,
      rarity: row.rarity,
      imageUrl: row.image_url
    })),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit))
  };
}
