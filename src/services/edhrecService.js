import db from '../db/connection.js';
import { commanderSlug, parseCommanderPage } from '../shared/edhrecPage.js';
import { LIVE_LOAN_STATUSES } from './loanHoldings.js';
import { isBasicLandSql } from './basicLands.js';
import { parseDeckList, importDeck, findCard } from './importService.js';
import { recordDeckEvent, AUDIT_ACTIONS } from './auditService.js';
import { cheapestPrintingOf } from './shoppingService.js';
import { getDeckById } from './deckService.js';
import { normalizeForSearch } from '../utils/cardNameMatch.js';

/**
 * "What does EDHREC say this commander runs, and which of those do I have?"
 *
 * The page comes from EDHREC's undocumented JSON (see src/shared/edhrecPage.js)
 * and is cached per commander for CACHE_HOURS — their numbers move over weeks,
 * so one request a day per commander is plenty and keeps us a polite caller.
 * Only the commander's slug leaves the server.
 *
 * Ownership is counted the way the Inventory page counts it: owned across
 * every printing and finish, `available` = owned − in decks − lent out.
 */

const EDHREC_BASE = process.env.EDHREC_URL || 'https://json.edhrec.com/pages/commanders';
const TIMEOUT_MS = 15000;
const CACHE_HOURS = 24;
const LIVE = `(${LIVE_LOAN_STATUSES.map((s) => `'${s}'`).join(',')})`;

export class EdhrecError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function fetchPage(slug) {
  let res;
  try {
    res = await fetch(`${EDHREC_BASE}/${encodeURIComponent(slug)}.json`, {
      headers: { Accept: 'application/json', 'User-Agent': 'deck-lotus (self-hosted collection manager)' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new EdhrecError(`Could not reach EDHREC: ${error.message}`, 502);
  }
  // EDHREC answers an unknown slug with 403 or 404 rather than an empty page.
  if (res.status === 403 || res.status === 404) {
    throw new EdhrecError(`EDHREC has no commander page for "${slug}". Try pasting the page's URL.`, 404);
  }
  if (!res.ok) throw new EdhrecError(`EDHREC answered ${res.status}`, 502);

  const page = parseCommanderPage(await res.json());
  if (!page.cards.length) throw new EdhrecError(`EDHREC's page for "${slug}" listed no cards`, 404);
  return page;
}

/** The cached page, fetched when missing, older than CACHE_HOURS, or `refresh`. */
async function loadPage(slug, refresh) {
  const row = db.get(
    `SELECT payload, fetched_at, (julianday('now') - julianday(fetched_at)) * 24 AS age_hours
       FROM edhrec_cache WHERE slug = ?`,
    [slug]
  );
  if (row && !refresh && row.age_hours < CACHE_HOURS) {
    try { return { page: JSON.parse(row.payload), fetchedAt: row.fetched_at }; } catch { /* refetch */ }
  }

  try {
    const page = await fetchPage(slug);
    db.run(
      `INSERT INTO edhrec_cache (slug, payload, fetched_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(slug) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      [slug, JSON.stringify(page)]
    );
    return { page, fetchedAt: db.get(`SELECT fetched_at FROM edhrec_cache WHERE slug = ?`, [slug]).fetched_at };
  } catch (error) {
    // A stale page beats no page when EDHREC is down or has moved its JSON.
    if (row && error.statusCode === 502) {
      try { return { page: JSON.parse(row.payload), fetchedAt: row.fetched_at, stale: true }; } catch { /* fall through */ }
    }
    throw error;
  }
}

/**
 * The card each EDHREC name refers to, with the caller's counts. EDHREC names
 * double-faced cards by both faces; MTGJSON's `cards.name` may hold either the
 * full "A // B" or the front face, so both are tried.
 */
function ownershipFor(userId, names) {
  const byName = new Map();
  // Resolving the name and counting copies are separate statements so each
  // can use an index: an OR across `=` and LIKE scans the whole cards table,
  // which across ~300 names took the page ten seconds. The DFC fallback is a
  // range on the name rather than a LIKE for the same reason.
  const exact = db.prepare(`SELECT id FROM cards WHERE name = ? LIMIT 1`);
  const frontFace = db.prepare(`SELECT id FROM cards WHERE name >= ? AND name < ? ORDER BY name LIMIT 1`);
  const counts = db.prepare(`
    SELECT c.id AS card_id, c.name, c.type_line, c.mana_cost, c.cmc,
      ${isBasicLandSql('c')} AS is_basic,
      -- Preview art: a printing the user owns (most copies first), so an owned
      -- card never shows a version they don't hold; otherwise a readable one —
      -- English, from an ordinary set, plain frame, newest first. Language was
      -- stored as 'en' for every printing before the import carried it, so
      -- the Japanese alternate arts are also caught by their ★ collector
      -- numbers and the Mystical Archive by its set type.
      (SELECT p.image_url FROM printings p LEFT JOIN sets s ON s.code = p.set_code
        WHERE p.card_id = c.id AND p.image_url IS NOT NULL
        ORDER BY COALESCE((SELECT SUM(op.quantity) FROM owned_printings op
                           WHERE op.user_id = @u AND op.printing_id = p.id), 0) DESC,
                 COALESCE(p.language, 'en') NOT IN ('en', 'English'),
                 p.collector_number LIKE '%★%',
                 COALESCE(p.is_promo, 0)
                   OR COALESCE(s.type, '') IN ('promo', 'masterpiece', 'memorabilia', 'funny', 'token', 'alchemy'),
                 COALESCE(p.border_color, 'black') NOT IN ('black', 'white'),
                 COALESCE(p.is_full_art, 0),
                 p.collector_number GLOB '*[^0-9]*',
                 s.release_date DESC
        LIMIT 1) AS image_url,
      -- The card's lowest rarity in print: a card that was ever a common is
      -- a common to anyone hunting for a copy. Special/bonus only when it has
      -- never been printed as anything else.
      (SELECT CASE MIN(CASE p.rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 WHEN 'rare' THEN 3
                                     WHEN 'mythic' THEN 4 ELSE 5 END)
                WHEN 1 THEN 'common' WHEN 2 THEN 'uncommon' WHEN 3 THEN 'rare' WHEN 4 THEN 'mythic' ELSE 'special' END
         FROM printings p WHERE p.card_id = c.id) AS rarity,
      (SELECT COALESCE(SUM(op.quantity), 0) FROM owned_printings op JOIN printings p ON op.printing_id = p.id
        WHERE op.user_id = @u AND p.card_id = c.id) AS owned,
      (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc JOIN printings p ON dc.printing_id = p.id
        JOIN decks d ON dc.deck_id = d.id WHERE d.user_id = @u AND d.is_proxy = 0 AND p.card_id = c.id) AS in_decks,
      (SELECT COALESCE(SUM(cl.quantity), 0) FROM card_loans cl JOIN printings p ON p.uuid = cl.printing_uuid
        WHERE cl.lender_user_id = @u AND p.card_id = c.id AND cl.status IN ${LIVE}) AS lent_out,
      (SELECT MIN(pr.price) FROM printings p JOIN prices pr ON pr.printing_uuid = p.uuid
        WHERE p.card_id = c.id AND pr.provider = 'tcgplayer' AND pr.price_type = 'normal' AND pr.price > 0) AS price
    FROM cards c WHERE c.id = @id
  `);

  for (const name of names) {
    const firstFace = name.split(' // ')[0];
    const id = exact.get(name)?.id
      ?? (firstFace !== name ? exact.get(firstFace)?.id : undefined)
      ?? frontFace.get(`${firstFace} //`, `${firstFace} /0`)?.id;
    if (id != null) byName.set(name, counts.get({ u: userId, id }));
  }
  return byName;
}

/**
 * EDHREC's recommendations for a commander, each card marked with what the
 * caller owns. Returns the categories in EDHREC's order plus a de-duplicated
 * `cards` list (one row per card, its first category) for the table.
 */
/**
 * Commander names for the lookup box's autocomplete. Eligible the way
 * canBeCommander in formatRulesService.js decides it — MTGJSON's leadership
 * flag, else a legendary creature, a Background, or "can be your
 * commander" — so the list offers only names EDHREC has a page for.
 * Names starting with the query come first.
 */
export function suggestCommanders(query, limit = 10) {
  const normalized = normalizeForSearch(query || '');
  if (!normalized || normalized.length < 2) return [];
  return db.all(`
    SELECT c.name, c.mana_cost, c.type_line
    FROM cards c
    WHERE c.name_normalized LIKE @infix
      AND (
        json_extract(c.leadership_skills, '$.commander') = 1
        OR (c.leadership_skills IS NULL AND (
              (c.type_line LIKE '%Legendary%' AND c.type_line LIKE '%Creature%')
           OR c.type_line LIKE '%Background%'
           OR c.oracle_text LIKE '%can be your commander%'))
      )
    ORDER BY c.name_normalized NOT LIKE @prefix, c.name
    LIMIT @limit
  `, { infix: `%${normalized}%`, prefix: `${normalized}%`, limit: Math.min(25, Math.max(1, limit)) })
    .map((r) => ({ name: r.name, manaCost: r.mana_cost, typeLine: r.type_line }));
}

export async function getCommanderRecommendations(userId, input, { refresh = false } = {}) {
  const slug = commanderSlug(input);
  if (!slug) throw new EdhrecError('Enter a commander name or an EDHREC URL', 400);

  const { page, fetchedAt, stale } = await loadPage(slug, refresh);
  const owned = ownershipFor(userId, page.cards.map((c) => c.name));

  const cards = page.cards.map((c) => {
    const row = owned.get(c.name);
    if (!row) return { ...c, cardId: null, matched: false, owned: 0, inDecks: 0, lentOut: 0, available: 0 };
    return {
      ...c,
      cardId: row.card_id,
      matched: true,
      typeLine: row.type_line,
      manaCost: row.mana_cost,
      cmc: row.cmc,
      rarity: row.rarity,
      imageUrl: row.image_url,
      isBasic: !!row.is_basic,
      price: row.price ?? null,
      owned: row.owned,
      inDecks: row.in_decks,
      lentOut: row.lent_out,
      available: Math.max(0, row.owned - row.in_decks - row.lent_out),
    };
  });

  // Basic lands are free everywhere (basicLands.js): never short, never bought,
  // so they count as had whatever the collection holds.
  const has = (c) => c.owned > 0 || c.isBasic;
  const summary = {
    total: cards.length,
    owned: cards.filter(has).length,
    available: cards.filter((c) => c.available > 0 || c.isBasic).length,
    missing: cards.filter((c) => c.matched && c.owned === 0 && !c.isBasic).length,
    unmatched: cards.filter((c) => !c.matched).length,
    missingCost: cards
      .filter((c) => c.matched && c.owned === 0 && !c.isBasic)
      .reduce((sum, c) => sum + (c.price || 0), 0),
  };

  return {
    slug,
    url: `https://edhrec.com/commanders/${slug}`,
    commander: page.commander,
    categories: page.lists.map((l) => ({ tag: l.tag, header: l.header, names: l.cards.map((c) => c.name) })),
    cards,
    summary,
    fetchedAt,
    stale: !!stale,
  };
}

/**
 * A new `idea` deck from picked EDHREC cards, with the commander on top.
 * `idea` because it is a wish list, not a build: it sits lowest in
 * deckPriority, so it never makes a real deck look short of its cards.
 */
export function createIdeaDeck(userId, { name, commander, cardNames }) {
  const picked = [...new Set((cardNames || []).filter(Boolean))];
  if (!picked.length) throw new EdhrecError('Pick at least one card', 400);

  const lines = picked.filter((n) => n !== commander).map((n) => `1 ${n}`);
  const cardList = parseDeckList(lines.join('\n'));
  if (commander) cardList.unshift({ ...parseDeckList(`1 ${commander}`)[0], isCommander: true });

  const result = importDeck(userId, name || `${commander || 'EDHREC'} (EDHREC)`, 'commander', cardList);
  db.run(`UPDATE decks SET status = 'idea' WHERE id = ? AND user_id = ?`, [result.deckId, userId]);
  return { deck: getDeckById(result.deckId, userId), imported: result.imported, unresolved: result.unresolved };
}

/**
 * Add picked cards to a deck the user already has — an idea or a deck being
 * built that EDHREC is filling out.
 *
 * Cards the deck already lists (any printing, main or sideboard) are skipped
 * and reported, not added again: EDHREC's pages are Commander, where a second
 * copy is a legality error rather than a choice. Each new card goes in at a
 * printing the user owns (the one they hold most of, its finish included), so
 * it reads as owned and the pull list finds it; otherwise the cheapest
 * printing, the same default as the shopping list. One batchId on every audit
 * row, so the addition can be found and undone as a unit.
 */
export function addCardsToDeck(userId, { deckId, cardNames }) {
  const deck = db.get(`SELECT id, name FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
  if (!deck) throw new EdhrecError('Deck not found', 404);

  const picked = [...new Set((cardNames || []).map((n) => String(n || '').trim()).filter(Boolean))];
  if (!picked.length) throw new EdhrecError('Pick at least one card', 400);

  const inDeck = new Set(db.all(`
    SELECT DISTINCT p.card_id FROM deck_cards dc JOIN printings p ON p.id = dc.printing_id
     WHERE dc.deck_id = ?
       AND COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) IN ('mainboard', 'sideboard')
  `, [deck.id]).map((r) => r.card_id));

  const ownedPrinting = db.prepare(`
    SELECT op.printing_id, op.is_foil, SUM(op.quantity) AS q
      FROM owned_printings op JOIN printings p ON p.id = op.printing_id
     WHERE op.user_id = ? AND p.card_id = ?
     GROUP BY op.printing_id, op.is_foil
     ORDER BY q DESC, op.is_foil ASC
     LIMIT 1
  `);
  const existingRow = db.prepare(`
    SELECT id, quantity FROM deck_cards WHERE deck_id = ? AND printing_id = ? AND board_type = 'mainboard' AND is_foil = ?
  `);
  const insertRow = db.prepare(`
    INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type, is_foil)
    VALUES (?, ?, 1, 0, 0, 'mainboard', ?)
  `);

  const batchId = `edhrec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const added = [];
  const skipped = [];
  const unresolved = [];

  db.transaction(() => {
    for (const name of picked) {
      const card = findCard(name);
      if (!card) { unresolved.push(name); continue; }
      if (inDeck.has(card.id)) { skipped.push(card.name); continue; }

      const owned = ownedPrinting.get(userId, card.id);
      const printingId = owned?.printing_id ?? cheapestPrintingOf(card.id) ?? card.printing_id;
      const isFoil = owned ? owned.is_foil : 0;

      // Two names can resolve to one card (a DFC by either face).
      if (existingRow.get(deck.id, printingId, isFoil)) { skipped.push(card.name); continue; }
      insertRow.run(deck.id, printingId, isFoil);
      inDeck.add(card.id);
      added.push({ name: card.name, owned: !!owned });

      recordDeckEvent({
        userId,
        action: AUDIT_ACTIONS.DECK_CARD_ADD,
        source: 'edhrec',
        deckId: deck.id,
        deckName: deck.name,
        printingId,
        isFoil: !!isFoil,
        quantityBefore: 0,
        quantityAfter: 1,
        detail: { boardType: 'mainboard', batchId },
      });
    }
    if (added.length) db.run(`UPDATE decks SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [deck.id]);
  });

  return { deck: { id: deck.id, name: deck.name }, added, skipped, unresolved };
}
