/**
 * Committing a scan session.
 *
 * A session is scanned, reviewed as a whole, and only then sent somewhere. This
 * module is the "only then": nothing above it writes, and the two destinations
 * below are the only ways a scan reaches the database.
 *
 * The two destinations are genuinely different operations, not a flag:
 *
 * - **Collection** adds copies you now own. It goes through
 *   `addOwnedPrintingQuantity`, the additive half of the choke point every
 *   collection change passes through, so it is audited like any other edit.
 * - **Deck** records a deck you built out of cards you already own, and must
 *   therefore leave inventory completely alone. Scanning a sleeved deck is not
 *   acquiring 100 cards; treating it as one would double every card in it.
 *
 * Both stamp a `batchId` into the audit detail, in the same shape
 * `bulkAddToInventory` uses. That is what makes a session recoverable: a
 * mis-scanned stack can be pulled back out of the log as a unit rather than
 * reconstructed from timestamps. It is also what makes reviewing a batch
 * rather than each card a safe trade — the mistake is undoable.
 *
 * Every commit runs in one transaction. Half a committed session is worse than
 * none: the reviewer has already approved the list and has no way to tell which
 * rows landed.
 */
import db from '../db/connection.js';
import { addOwnedPrintingQuantity } from './cardService.js';
import { addCardToDeck, BOARD_TYPES } from './deckService.js';

/**
 * Boards a scanned card can land on, taken from deckService rather than listed
 * again here. A second copy of this list is exactly the thing that drifts: it
 * would still validate, just against a set the deck writer no longer agrees
 * with. Note that `commander` is not among them — a commander is a *flag* on a
 * mainboard row, not a board of its own.
 */
const BOARDS = new Set(BOARD_TYPES);

/**
 * Validate and normalise one reviewed row.
 *
 * Rows arrive from the client, so nothing here trusts them. In particular the
 * printing id is checked against `printings` rather than assumed — a stale scan
 * session held open across a weekly MTGJSON sync would carry ids that were
 * reassigned underneath it, and silently adding the wrong card is exactly the
 * failure the review step exists to prevent.
 */
function normalizeItem(item, index) {
  const printingId = Number(item?.printingId);
  if (!Number.isInteger(printingId) || printingId < 1) {
    return { error: `Row ${index + 1}: no printing chosen` };
  }

  const quantity = item?.quantity === undefined ? 1 : Number(item.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
    return { error: `Row ${index + 1}: quantity must be a whole number from 1 to 999` };
  }

  const board = item?.boardType || 'mainboard';
  if (!BOARDS.has(board)) {
    return { error: `Row ${index + 1}: unknown board "${board}"` };
  }

  return {
    printingId,
    quantity,
    // Foil is never inferred from a capture — glare is both what suggests a
    // foil and what breaks the read. It is only ever what the reviewer ticked.
    isFoil: Boolean(item?.isFoil),
    board,
    isCommander: Boolean(item?.isCommander),
  };
}

function normalizeAll(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('A scan session needs at least one card');
  }
  if (items.length > 500) {
    throw new Error('At most 500 cards per commit');
  }

  const normalized = [];
  for (const [index, item] of items.entries()) {
    const result = normalizeItem(item, index);
    if (result.error) throw new Error(result.error);
    normalized.push(result);
  }

  const ids = [...new Set(normalized.map((item) => item.printingId))];
  const known = db.all(
    `SELECT id FROM printings WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );

  if (known.length !== ids.length) {
    const found = new Set(known.map((row) => row.id));
    const missing = ids.filter((id) => !found.has(id));
    throw new Error(
      `${missing.length} printing(s) no longer exist — the card database was rebuilt ` +
      `while this session was open. Re-resolve the session before committing.`
    );
  }

  return normalized;
}

function newBatchId() {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Commit a reviewed session into the collection.
 *
 * @param {number} userId
 * @param {Array<{printingId, quantity, isFoil}>} items
 * @param {object} [context]
 * @returns {{batchId: string, committed: number, cards: number}}
 */
export function commitScanToCollection(userId, items, context = {}) {
  const normalized = normalizeAll(items);
  const batchId = context.batchId || newBatchId();

  // db.transaction runs the function immediately — see DbAdapter in
  // db/connection.js. It does not return a callable to invoke afterwards.
  db.transaction(() => {
    for (const item of normalized) {
      addOwnedPrintingQuantity(userId, item.printingId, item.quantity, item.isFoil, {
        source: 'scan',
        // The batch id belongs inside `detail`, which is where
        // addOwnedPrintingQuantity looks and where bulkAddToInventory puts it.
        // Passed at the top level it is accepted and silently dropped, and the
        // session stops being recoverable as a unit — which is the entire
        // safety argument for reviewing a batch rather than each card.
        detail: { batchId, scanned: { quantity: item.quantity, isFoil: item.isFoil } },
      });
    }
  });

  return {
    batchId,
    cards: normalized.length,
    committed: normalized.reduce((total, item) => total + item.quantity, 0),
  };
}

/**
 * Commit a reviewed session into a deck, without touching inventory.
 *
 * `addCardToDeck` verifies deck ownership itself and derives the sideboard flag
 * from the board type rather than trusting a caller-supplied pair, so the deck
 * id is passed straight through rather than being checked here as well — one
 * owner check, in the place that does the write.
 *
 * @param {number} userId
 * @param {number} deckId
 * @param {Array<{printingId, quantity, isFoil, boardType, isCommander}>} items
 * @param {object} [context]
 * @returns {{batchId: string, committed: number, cards: number, deckId: number}}
 */
export function commitScanToDeck(userId, deckId, items, context = {}) {
  const normalized = normalizeAll(items);
  const batchId = context.batchId || newBatchId();

  const deck = db.get(`SELECT id FROM decks WHERE id = ? AND user_id = ?`, [deckId, userId]);
  if (!deck) {
    // Checked here as well as in addCardToDeck, so a session aimed at someone
    // else's deck is refused before the transaction opens rather than throwing
    // part-way through a hundred cards.
    throw new Error('Deck not found or access denied');
  }

  db.transaction(() => {
    for (const item of normalized) {
      addCardToDeck(
        deckId,
        userId,
        item.printingId,
        item.quantity,
        // isSideboard is derived from boardType by resolveBoard; passing false
        // here and letting the board decide is what keeps the two in step.
        false,
        item.isCommander,
        item.board,
        item.isFoil
      );
    }
  });

  return {
    batchId,
    deckId,
    cards: normalized.length,
    committed: normalized.reduce((total, item) => total + item.quantity, 0),
  };
}

/**
 * Which of these printings the user does not own enough of.
 *
 * Scanning a deck you built is normally scanning cards you own, so a shortfall
 * usually means the collection is out of date rather than that the deck is
 * short — which is why "also add these to my collection" is offered at review
 * time. It is offered, never applied: the other reading, that the deck really
 * does contain a borrowed card, is real too, and readiness and the shopping
 * list are right to report it. Only the person holding the cards knows which.
 *
 * Counts are per finish, because `owned_printings` is keyed on `is_foil` and a
 * foil copy genuinely does not satisfy a non-foil listing.
 */
export function ownershipShortfall(userId, items) {
  const normalized = normalizeAll(items);

  const wanted = new Map();
  for (const item of normalized) {
    const key = `${item.printingId}:${item.isFoil ? 1 : 0}`;
    wanted.set(key, (wanted.get(key) || 0) + item.quantity);
  }

  const shortfalls = [];

  for (const [key, needed] of wanted) {
    const [printingId, foilFlag] = key.split(':').map(Number);

    const owned = db.get(
      `SELECT quantity FROM owned_printings
       WHERE user_id = ? AND printing_id = ? AND is_foil = ?`,
      [userId, printingId, foilFlag]
    );

    const have = owned?.quantity || 0;
    if (have < needed) {
      shortfalls.push({
        printingId,
        isFoil: Boolean(foilFlag),
        needed,
        owned: have,
        short: needed - have,
      });
    }
  }

  return shortfalls;
}
