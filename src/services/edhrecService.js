import db from '../db/connection.js';
import { commanderSlug, parseCommanderPage } from '../shared/edhrecPage.js';
import { LIVE_LOAN_STATUSES } from './loanHoldings.js';
import { isBasicLandSql } from './basicLands.js';
import { parseDeckList, importDeck } from './importService.js';
import { getDeckById } from './deckService.js';

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
    SELECT c.id AS card_id, c.name, c.type_line, c.mana_cost,
      ${isBasicLandSql('c')} AS is_basic,
      (SELECT COALESCE(SUM(op.quantity), 0) FROM owned_printings op JOIN printings p ON op.printing_id = p.id
        WHERE op.user_id = @u AND p.card_id = c.id) AS owned,
      (SELECT COALESCE(SUM(dc.quantity), 0) FROM deck_cards dc JOIN printings p ON dc.printing_id = p.id
        JOIN decks d ON dc.deck_id = d.id WHERE d.user_id = @u AND p.card_id = c.id) AS in_decks,
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
