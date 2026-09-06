/**
 * The database side of the deck generator.
 *
 * `deckGeneratorService` is pure — rows in, proposal out — so this is where
 * the rows come from and where an accepted proposal turns into a real deck.
 * The same split as `formatRulesService` over `deckAdvisorService`, and for the
 * same reason: the arithmetic stays testable on a machine where better-sqlite3
 * will not build.
 *
 * ── Proposing is not building ──────────────────────────────────────────────
 *
 * Generating writes nothing. The whole point of the split is that a proposal
 * built out of heuristics over English card text gets looked at before it
 * becomes a deck — the role classification will misfire, and a deck that
 * appeared in the list without anybody agreeing to it is worse than no deck.
 * So `proposeDeck` returns and forgets; `acceptProposal` is a separate,
 * deliberate call.
 *
 * An accepted deck is created as an **idea**, never as ready or building. That
 * is not cosmetic: `deckPriority` says an idea's claim on a card yields to
 * every deck above it, so a generated list cannot report a sleeved deck as
 * short of cards sitting in its own box. It is also honest — nobody has
 * sleeved this yet.
 */

import db from '../db/connection.js';
import {
  buildDeck, resolveTheme, isLegalIn, ROLE_PREDICATE_BY_CODE,
} from './deckGeneratorService.js';
import { rankThemes, withinColorIdentity } from './cardSynergyService.js';
import { getGeneratorPool } from './inventoryService.js';
import { findCard } from './importService.js';
import { isBasicLandSql, isBasicLand } from './basicLands.js';
import { cheapestPrintingOf, addWantedCard } from './shoppingService.js';
import { recordDeckEvent, AUDIT_ACTIONS } from './auditService.js';

/**
 * Cards the user owns that could lead a Commander deck.
 *
 * The same test the deck builder and the inventory panel already make, so the
 * three cannot disagree about what is a commander.
 */
export function commanderOptions(userId, { includeCommitted = true } = {}) {
  return getGeneratorPool(userId, { includeCommitted })
    .filter((card) => {
      const type = String(card.type_line || '');
      if (/legendary/i.test(type) && /creature/i.test(type)) return true;
      return /can be your commander/i.test(String(card.oracle_text || ''));
    })
    .map((card) => ({
      cardId: card.card_id,
      name: card.name,
      typeLine: card.type_line,
      colorIdentity: String(card.color_identity || '').replace(/[^WUBRG]/g, ''),
      manaCost: card.mana_cost,
      available: card.available,
      committed: card.committed,
      // For browsing by art. The image is of the copy actually owned, and the
      // rules text travels with it because a commander is chosen for what it
      // does — a gallery of pictures with no text is a poster, not a picker.
      imageUrl: card.image_url || null,
      oracleText: card.oracle_text || '',
      power: card.power,
      toughness: card.toughness,
      cmc: card.cmc,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One commander from the pool, by card id. */
function commanderFrom(pool, commanderCardId) {
  if (commanderCardId == null) return null;
  return pool.find((card) => Number(card.card_id) === Number(commanderCardId)) || null;
}

/**
 * The themes worth offering for a commander, strongest first.
 *
 * Offered rather than chosen silently. The strength of a theme is the whole
 * argument for building around it, so the player sees the numbers — 27
 * enablers, 20 payoffs — and picks. A generator that decided quietly would be
 * asking to be trusted about a judgement it makes from regular expressions.
 */
export function themeOptions(userId, commanderCardId, {
  includeCommitted = true, identity: chosenIdentity = null, format = 'commander',
  reviseDeckId = null,
} = {}) {
  // The same pool the proposal will be built from, revision included: a theme
  // measured without the deck's own cards is measured against a collection the
  // build will never see, and the numbers offered would not be the numbers the
  // deck was built with.
  const pool = getGeneratorPool(userId, { includeCommitted, exceptDeckId: reviseDeckId })
    .filter((card) => isLegalIn(card, format));
  const commander = commanderFrom(pool, commanderCardId);
  const identity = commander
    ? String(commander.color_identity || '').replace(/[^WUBRG]/g, '')
    : (chosenIdentity || null);

  const spells = pool.filter((card) => !/\bland\b/i.test(String(card.type_line || '')));

  return rankThemes(spells, { identity })
    .filter((theme) => theme.strength > 0)
    .slice(0, 8)
    .map((theme) => ({
      key: theme.key,
      label: theme.label,
      // What the theme means, in words rather than counts. See the note on
      // THEMES: the numbers below are evidence, and evidence is only useful to
      // somebody who already knows what is being claimed.
      blurb: theme.blurb || '',
      enablerName: theme.enablerName || 'enablers',
      payoffName: theme.payoffName || 'payoffs',
      tribe: theme.tribe,
      enablers: theme.enablers,
      payoffs: theme.payoffs,
      strength: theme.strength,
      viable: theme.viable,
      // Evidence, capped: the panel shows a few names so a player can judge
      // the classification rather than take it on faith.
      examples: theme.payoffCards.slice(0, 6),
    }));
}

/**
 * The decks a revision could start from, newest first.
 *
 * Every deck qualifies, including the ones the generator made: a proposal
 * saved as an idea and then half-tuned by hand is exactly the thing somebody
 * wants a second pass over.
 */
export function revisableDecks(userId) {
  return db.all(
    `SELECT
       d.id,
       d.name,
       d.format,
       d.status,
       (SELECT SUM(dc.quantity)
          FROM deck_cards dc
         WHERE dc.deck_id = d.id
           AND COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) = 'mainboard'
       ) AS cards,
       (SELECT c.name
          FROM deck_cards dc
          JOIN printings p ON dc.printing_id = p.id
          JOIN cards c ON p.card_id = c.id
         WHERE dc.deck_id = d.id AND dc.is_commander = 1
         LIMIT 1) AS commander_name
     FROM decks d
     WHERE d.user_id = ?
     ORDER BY d.updated_at DESC`,
    [userId]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    format: row.format || null,
    status: row.status || null,
    cards: row.cards || 0,
    commanderName: row.commander_name || null,
  }));
}

/**
 * The theme a deck already has, read from the cards in it.
 *
 * Ranked over the deck's own cards rather than the whole pool, so it answers
 * "what is this deck doing" instead of "what could be built". Nothing is
 * returned when the deck is not dense enough in anything to be described —
 * a pile of good cards is a real answer, and inventing a theme for it would
 * make the revision chase something the deck never was.
 */
function themeOfDeck(pool) {
  const own = pool.filter((card) => (card.in_deck || 0) > 0);
  if (own.length === 0) return null;

  const best = rankThemes(own).filter((theme) => theme.strength > 0)[0];
  return best ? best.key : null;
}

/** A deck being revised: what it is, and what is in it. */
function revisionTarget(userId, deckId) {
  const deck = db.get('SELECT id, name, format, status FROM decks WHERE id = ? AND user_id = ?',
    [deckId, userId]);

  if (!deck) throw new Error('That deck is not one of yours');

  const cards = db.all(
    `SELECT
       c.id AS card_id,
       c.name,
       c.color_identity,
       c.type_line,
       dc.quantity,
       dc.is_commander,
       COALESCE(dc.board_type, CASE WHEN dc.is_sideboard = 1 THEN 'sideboard' ELSE 'mainboard' END) AS board
     FROM deck_cards dc
     JOIN printings p ON dc.printing_id = p.id
     JOIN cards c ON p.card_id = c.id
     WHERE dc.deck_id = ?`,
    [deckId]
  );

  return { deck, cards };
}

/**
 * What a proposal would change about the deck it was built from.
 *
 * Counted by name and by copies, because a revision that cuts two of a
 * four-of is a real change and a diff that only knows presence would call
 * that deck unchanged. Basics are left out of both sides: they are free and
 * unlimited (see basicLands.js), the mana base recomputes them from scratch
 * every time, and listing "cut 4 Island, add 3 Island" as revisions buries
 * the changes that are actually decisions.
 *
 * The commander is not diffed either. It is chosen, not proposed — a revision
 * that swapped it would be a different deck.
 */
function diffAgainstDeck(target, proposal) {
  const before = new Map();
  for (const row of target.cards) {
    if (row.board !== 'mainboard' || row.is_commander) continue;
    if (isBasicLand(row)) continue;
    before.set(row.name, (before.get(row.name) || 0) + row.quantity);
  }

  const after = new Map();
  for (const card of [...proposal.mainboard, ...proposal.lands]) {
    if (card.isBasic || isBasicLand({ type_line: card.typeLine })) continue;
    after.set(card.name, (after.get(card.name) || 0) + card.quantity);
  }

  const added = [];
  const cut = [];
  const kept = [];

  for (const [name, count] of after) {
    const had = before.get(name) || 0;
    if (had === 0) added.push({ name, quantity: count });
    else {
      kept.push({ name, quantity: Math.min(had, count) });
      if (count > had) added.push({ name, quantity: count - had });
    }
  }

  for (const [name, count] of before) {
    const now = after.get(name) || 0;
    if (now < count) cut.push({ name, quantity: count - now });
  }

  const byName = (a, b) => a.name.localeCompare(b.name);

  return {
    deckId: target.deck.id,
    deckName: target.deck.name,
    deckStatus: target.deck.status || null,
    added: added.sort(byName),
    cut: cut.sort(byName),
    keptCount: kept.reduce((sum, row) => sum + row.quantity, 0),
    // Said outright rather than left to be inferred from three empty lists.
    unchanged: added.length === 0 && cut.length === 0,
  };
}

/**
 * Build a proposal. Writes nothing — including when revising: a revision is a
 * suggestion about a deck, and the deck it is about is left exactly as it was
 * until somebody saves the result as a deck of its own.
 */
export function proposeDeck(userId, {
  commanderCardId = null,
  format = 'commander',
  themeKey = null,
  includeCommitted = true,
  landCount = null,
  identity = null,
  reviseDeckId = null,
} = {}) {
  const target = reviseDeckId == null ? null : revisionTarget(userId, reviseDeckId);

  // A revision inherits the deck's own format and commander unless it was
  // told otherwise. Asking again for facts already recorded against the deck
  // is how the two end up disagreeing.
  if (target) {
    format = format || target.deck.format || 'commander';
    if (commanderCardId == null) {
      const leader = target.cards.find((row) => row.is_commander);
      if (leader) commanderCardId = leader.card_id;
    }
  }

  const pool = getGeneratorPool(userId, {
    includeCommitted,
    // The deck's own cards stop counting as spoken for, which is the whole
    // point: a revision may keep what is already sleeved.
    exceptDeckId: reviseDeckId,
  });
  const commander = commanderFrom(pool, commanderCardId);

  if (commanderCardId != null && !commander) {
    throw new Error('That commander is not in your collection, or every copy is already in a deck');
  }

  // A revision with no theme named takes the deck's own theme, not the
  // collection's strongest. Left to choose freely the generator answers a
  // different question — "what is the best deck in these colours" — and
  // proposes something that shares a commander with the deck and very little
  // else. That is a rebuild, and the person asked for a revision.
  if (target && !themeKey) {
    themeKey = themeOfDeck(pool);
  }

  // Colours come from the commander when there is one, and are chosen
  // outright when there is not — a 60-card format has nothing to infer them
  // from.
  const proposal = buildDeck(pool, {
    commander, format, themeKey, landCount,
    identity: commander ? null : (identity || null),
  });

  return {
    ...proposal,
    // What this would change about the deck it started from. Null when
    // nothing was being revised, so a caller can tell "built from scratch"
    // apart from "revised and changed nothing".
    revision: target ? diffAgainstDeck(target, proposal) : null,
    // What the pool actually was, because "no removal found" means something
    // very different at 271 cards than at 1,033. Without this the shortfalls
    // read as a fault in the collection rather than in what was available.
    pool: {
      cards: pool.length,
      includeCommitted,
      committedCards: pool.filter((card) => (card.committed || 0) > 0).length,
    },
    commanderCard: commander
      ? {
        cardId: commander.card_id,
        // Carried so the commander binds to the copy they own like every
        // other card. Without it the accept path falls back to a lookup by
        // name and stores whichever printing sorts first, which is routinely
        // one that is not in the collection.
        printingId: commander.printing_id ?? null,
        isFoil: Boolean(commander.is_foil),
        name: commander.name,
        manaCost: commander.mana_cost,
        typeLine: commander.type_line,
        colorIdentity: String(commander.color_identity || '').replace(/[^WUBRG]/g, ''),
      }
      : null,
  };
}

/**
 * Cards worth buying to close a proposal's role gaps.
 *
 * A shortfall is a count — "wanted 8 spot removal, found 4" — and a shopping
 * list holds cards, so something has to turn one into the other. That is all
 * this does: for each role the collection came up short on, it names cards
 * that would fill it and are not already owned.
 *
 * ── Ranked by how much they are played, which is a reversal ────────────────
 *
 * Popularity was rejected as the objective for choosing *from* a collection,
 * because there the pool is fixed and what matters is how the cards work
 * together. Shopping is the opposite question. The pool is every card ever
 * printed, the constraint is money, and "what do people actually put in this
 * slot" is exactly what somebody about to spend money wants to know. So
 * `edhrec_rank` ranks these, and the price travels with every suggestion so
 * the choice stays the buyer's.
 *
 * Only the most-played cards in the identity are examined rather than all
 * 34,656: the role predicates are regular expressions over oracle text and
 * running them across the whole table for a web request is wasteful when the
 * cards that fill a removal slot are, by construction, near the top of that
 * ordering.
 */
const SUGGESTION_SCAN = 2500;

export function suggestForGaps(userId, {
  commanderCardId = null,
  format = 'commander',
  themeKey = null,
  includeCommitted = true,
  identity = null,
  perGap = 6,
} = {}) {
  const proposal = proposeDeck(userId, {
    commanderCardId, format, themeKey, includeCommitted, identity,
  });

  const roleGaps = proposal.shortfalls.filter((s) => s.kind === 'role' && s.found < s.wanted);
  if (roleGaps.length === 0) {
    return { proposal, gaps: [] };
  }

  // The identity the proposal actually settled on, which is the commander's
  // where there is one and the chosen colours where there is not.
  const deckIdentity = String(proposal.colorIdentity || '').replace(/[^WUBRG]/g, '');
  const where = [
    `c.oracle_text IS NOT NULL`,
    `c.oracle_text != ''`,
    // Legal in the format being built. The column is MTGJSON's JSON blob and
    // the values are capitalised, hence the LIKE rather than a comparison.
    `c.legalities LIKE ?`,
    // Not already owned: this is a buy list, and a card sitting in a box is
    // not something to buy.
    `NOT EXISTS (
       SELECT 1 FROM owned_printings op
       JOIN printings op_p ON op_p.id = op.printing_id
       WHERE op.user_id = ? AND op_p.card_id = c.id
     )`,
    // Never suggest basics: they are free everywhere.
    `NOT ${isBasicLandSql('c')}`,
  ];
  const params = [`%"${format.toLowerCase()}":"Legal"%`, userId];

  for (const color of ['W', 'U', 'B', 'R', 'G']) {
    if (!deckIdentity.includes(color)) {
      where.push(`(c.color_identity IS NULL OR c.color_identity NOT LIKE ?)`);
      params.push(`%${color}%`);
    }
  }

  const candidates = db.all(
    `SELECT c.id AS card_id, c.name, c.mana_cost, c.cmc, c.type_line, c.oracle_text,
            c.keywords, c.power, c.color_identity, c.supertypes, c.edhrec_rank
       FROM cards c
      WHERE ${where.join(' AND ')}
        AND c.edhrec_rank IS NOT NULL
      ORDER BY c.edhrec_rank ASC
      LIMIT ?`,
    [...params, SUGGESTION_SCAN]
  );

  const gaps = roleGaps.map((gap) => {
    const matches = ROLE_PREDICATE_BY_CODE[gap.code] || (() => false);
    const picks = [];

    for (const card of candidates) {
      if (picks.length >= perGap) break;
      if (!matches(card)) continue;

      const printingId = cheapestPrintingOf(card.card_id);
      if (!printingId) continue;

      picks.push({
        cardId: card.card_id,
        name: card.name,
        manaCost: card.mana_cost,
        typeLine: card.type_line,
        printingId,
        edhrecRank: card.edhrec_rank,
        price: priceOfPrinting(printingId),
      });
    }

    return {
      code: gap.code,
      label: gap.label,
      wanted: gap.wanted,
      found: gap.found,
      short: gap.wanted - gap.found,
      suggestions: picks,
    };
  });

  return { proposal, gaps };
}

/** What the cheapest printing costs, so a suggestion can carry its price. */
function priceOfPrinting(printingId) {
  const row = db.get(
    `SELECT pr.price FROM printings p
       JOIN prices pr ON pr.printing_uuid = p.uuid
      WHERE p.id = ? AND pr.provider = 'tcgplayer' AND pr.price_type = 'normal'
      LIMIT 1`,
    [printingId]
  );
  return row ? row.price : null;
}

/**
 * Add chosen suggestions to the shopping list.
 *
 * They go in as *wanted* cards rather than as a deck's needs. The derived half
 * of the shopping list is computed from decks on every read, and a proposal is
 * not a deck — it may never become one. `shopping_list_items` is the half that
 * holds "I want this on its own account", which is exactly what pressing this
 * means.
 *
 * The note says where the entry came from, because a shopping list read in a
 * shop three weeks later is a list of names with no memory attached.
 */
export function addGapsToShoppingList(userId, { items = [] } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Nothing was selected');
  }

  const added = [];
  const failed = [];

  for (const item of items) {
    try {
      added.push(addWantedCard(userId, {
        printingId: Number(item.printingId),
        quantity: Math.max(1, Number(item.quantity) || 1),
        isFoil: false,
        note: item.note || 'Suggested by the deck generator',
      }));
    } catch (error) {
      // One bad printing id must not lose the rest of a selection.
      failed.push({ printingId: item.printingId, reason: error.message });
    }
  }

  return { added, failed };
}

/**
 * Resolve one proposed card to a printing to store it as.
 *
 * The pool already carries a printing the user owns, and that is the one to
 * use: binding by name would pick whatever printing the card table returns
 * first, which is frequently one they do not have. Basic lands have no owned
 * printing by design — they are not tracked as inventory — so those alone fall
 * back to a lookup by name.
 */
function printingFor(entry) {
  if (entry.printingId) return Number(entry.printingId);
  const found = findCard(entry.name, null, null);
  return found ? found.printing_id : null;
}

/**
 * Turn an accepted proposal into a real deck.
 *
 * The card list comes from the client rather than being regenerated here, so
 * the deck that gets saved is the one that was on screen. Regenerating would
 * be a shade safer and could quietly produce a different 99 — the pool moves
 * as other decks change — and a builder that saves something other than what
 * it showed you is not one you would use twice. Nothing is granted by this
 * that a user could not do by adding the cards by hand.
 */
export function acceptProposal(userId, { name, format = 'commander', commander = null, cards = [] }) {
  if (!name || !String(name).trim()) throw new Error('A deck name is required');
  if (!Array.isArray(cards) || cards.length === 0) throw new Error('The proposal has no cards');

  const deckName = String(name).trim();
  const batchId = `deck-generate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let deckId = null;
  const unresolved = [];
  let added = 0;

  db.transaction(() => {
    db.run(
      `INSERT INTO decks (user_id, name, format, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idea', datetime('now'), datetime('now'))`,
      [userId, deckName, format || '']
    );
    deckId = db.get(
      `SELECT id FROM decks WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
      [userId]
    ).id;

    const entries = commander
      ? [{ ...commander, quantity: 1, isCommander: true }, ...cards]
      : [...cards];

    for (const entry of entries) {
      const printingId = printingFor(entry);
      if (!printingId) {
        unresolved.push({ name: entry.name, quantity: entry.quantity || 1 });
        continue;
      }

      const quantity = Math.max(1, Number(entry.quantity) || 1);
      const isCommander = entry.isCommander ? 1 : 0;
      // There is no 'commander' board: `deck_cards.board_type` is checked
      // against mainboard/sideboard/maybeboard, and a commander is a mainboard
      // card carrying is_commander. Storing it any other way fails the CHECK.
      const boardType = 'mainboard';

      // The finish the pool actually found, not an assumed non-foil. Somebody
      // who owns only a foil copy owns no non-foil one, and writing the deck
      // row as non-foil claims a card that is not in the collection — 32 of
      // one fixture collection's 538 cards are in exactly that position.
      const isFoil = entry.isFoil ? 1 : 0;

      // Keyed UNIQUE(deck_id, printing_id, board_type, is_foil) since migration
      // 038, so a printing proposed twice adds up rather than colliding — and
      // the same printing in two finishes stays two rows, which is the point
      // of the key.
      const existing = db.get(
        `SELECT id FROM deck_cards
          WHERE deck_id = ? AND printing_id = ? AND board_type = ? AND is_foil = ?`,
        [deckId, printingId, boardType, isFoil]
      );

      if (existing) {
        db.run(`UPDATE deck_cards SET quantity = quantity + ? WHERE id = ?`, [quantity, existing.id]);
      } else {
        db.run(
          `INSERT INTO deck_cards
             (deck_id, printing_id, quantity, is_sideboard, is_commander, board_type, is_foil)
           VALUES (?, ?, ?, 0, ?, ?, ?)`,
          [deckId, printingId, quantity, isCommander, boardType, isFoil]
        );
      }
      added += quantity;
    }

    // One batchId across the deck, the same as a bulk add, so a generated deck
    // somebody regrets can be found and undone as a unit.
    recordDeckEvent({
      userId,
      action: AUDIT_ACTIONS.DECK_CREATE,
      source: 'deck_generator',
      deckId,
      deckName,
      detail: { batchId, format: format || null, cards: added, unresolved: unresolved.length },
    });
  });

  return { deckId, name: deckName, added, unresolved };
}
