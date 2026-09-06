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
import { buildDeck, resolveTheme } from './deckGeneratorService.js';
import { rankThemes, withinColorIdentity } from './cardSynergyService.js';
import { getGeneratorPool } from './inventoryService.js';
import { findCard } from './importService.js';
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
export function themeOptions(userId, commanderCardId, { includeCommitted = true } = {}) {
  const pool = getGeneratorPool(userId, { includeCommitted });
  const commander = commanderFrom(pool, commanderCardId);
  const identity = commander
    ? String(commander.color_identity || '').replace(/[^WUBRG]/g, '')
    : null;

  const spells = pool.filter((card) => !/\bland\b/i.test(String(card.type_line || '')));

  return rankThemes(spells, { identity })
    .filter((theme) => theme.strength > 0)
    .slice(0, 8)
    .map((theme) => ({
      key: theme.key,
      label: theme.label,
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
 * Build a proposal. Writes nothing.
 */
export function proposeDeck(userId, {
  commanderCardId = null,
  format = 'commander',
  themeKey = null,
  includeCommitted = true,
  landCount = null,
} = {}) {
  const pool = getGeneratorPool(userId, { includeCommitted });
  const commander = commanderFrom(pool, commanderCardId);

  if (commanderCardId != null && !commander) {
    throw new Error('That commander is not in your collection, or every copy is already in a deck');
  }

  const proposal = buildDeck(pool, { commander, format, themeKey, landCount });

  return {
    ...proposal,
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
