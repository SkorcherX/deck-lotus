/**
 * Card loans: possession moves, ownership does not.
 *
 * The properties pinned here are the ones the feature exists for: the lender's
 * collection never changes, a live loan counts toward the borrower's deck
 * readiness and away from the lender's, a lent card cannot also be traded
 * away, and the return puts everything back.
 *
 * Run with `npm run test:integration`.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-loans-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const loans = await import('../../src/services/loanService.js');
const { getDeckReadiness } = await import('../../src/services/deckReadinessService.js');
const { getShoppingList } = await import('../../src/services/shoppingService.js');
const { createTrade, getDisruptions } = await import('../../src/services/tradeService.js');

let lender, borrower, printingId, lenderDeck, borrowerDeck;

const owned = (userId) => db.get(
  `SELECT quantity FROM owned_printings WHERE user_id = ? AND printing_id = ?`, [userId, printingId]
)?.quantity ?? 0;

const missing = (userId, deckId) => getDeckReadiness(userId, deckId).missingCopies;

before(async () => {
  await runMigrations();

  for (const name of ['lender', 'borrower']) {
    db.run(`INSERT INTO users (username, email, password_hash) VALUES (?, ?, 'x')`, [name, `${name}@example.com`]);
  }
  lender = db.get(`SELECT id FROM users WHERE username = 'lender'`).id;
  borrower = db.get(`SELECT id FROM users WHERE username = 'borrower'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','Set A')`);
  db.run(`INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES ('Force of Will','force of will','Instant','U')`);
  const cardId = db.get(`SELECT id FROM cards WHERE name = 'Force of Will'`).id;
  db.run(`INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?, 'uuid-fow', 'AAA', '1', 'rare')`, [cardId]);
  printingId = db.get(`SELECT id FROM printings WHERE uuid = 'uuid-fow'`).id;

  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?, ?, 1, 0)`, [lender, printingId]);

  const deck = (userId, name) => {
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?, ?, 'legacy', 'ready')`, [userId, name]);
    const id = db.get(`SELECT id FROM decks WHERE name = ?`, [name]).id;
    db.run(
      `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_sideboard, is_foil, board_type)
       VALUES (?, ?, 1, 0, 0, 'mainboard')`,
      [id, printingId]
    );
    return id;
  };
  lenderDeck = deck(lender, 'Lender Deck');
  borrowerDeck = deck(borrower, 'Borrower Deck');
});

test('a loan moves the card between decks without touching either collection', () => {
  assert.equal(missing(borrower, borrowerDeck), 1);
  assert.equal(missing(lender, lenderDeck), 0);

  const { loans: [loan] } = loans.requestLoans(borrower, lender, [{ printingId, quantity: 1 }]);
  assert.equal(loan.status, 'requested');
  // Asking changes nothing.
  assert.equal(missing(borrower, borrowerDeck), 1);

  assert.throws(() => loans.approveLoan(loan.id, borrower), /owner/);
  loans.approveLoan(loan.id, lender);

  assert.equal(owned(lender), 1, 'the lender still owns it');
  assert.equal(owned(borrower), 0, 'the borrower never owns it');
  assert.equal(missing(borrower, borrowerDeck), 0, 'it counts toward the borrower');
  assert.equal(missing(lender, lenderDeck), 1, 'and away from the lender');

  assert.equal(getShoppingList(borrower, [borrowerDeck]).totalCards, 0);
  assert.ok(getShoppingList(lender, [lenderDeck]).totalCards > 0);

  const { borrowed } = loans.listLoans(borrower);
  assert.deepEqual(borrowed[0].decks.map((d) => d.name), ['Borrower Deck']);
  // The lender must not learn which of the borrower's decks hold it.
  assert.deepEqual(loans.listLoans(lender).lent[0].decks, []);
});

test('a lent card can be neither lent twice nor traded away', () => {
  assert.throws(() => loans.requestLoans(borrower, lender, [{ printingId, quantity: 1 }]), /free to lend/);
  assert.throws(
    () => createTrade(lender, borrower, [{ printingId, quantity: 1, direction: 'give' }]),
    /Only 0/
  );
});

test('asking for it back and returning it restores both sides', () => {
  const loan = loans.listLoans(lender).lent[0];

  assert.equal(loans.countLoanActions(borrower), 0);
  loans.requestReturn(loan.id, lender);
  assert.equal(loans.countLoanActions(borrower), 1);
  // Still out until it actually comes back.
  assert.equal(missing(borrower, borrowerDeck), 0);

  loans.markReturned(loan.id, borrower);
  assert.equal(missing(borrower, borrowerDeck), 1);

  // The borrower's deck is told, the same way a trade tells it.
  const [disruption] = getDisruptions(borrower);
  assert.equal(disruption.deckId, borrowerDeck);
  assert.equal(disruption.loanId, loan.id);
  assert.equal(disruption.returnedTo, 'lender');
  assert.equal(disruption.quantity, 1);
  assert.equal(getDisruptions(lender).length, 0);
  assert.equal(missing(lender, lenderDeck), 0);
  assert.equal(owned(lender), 1);
  assert.throws(() => loans.markReturned(loan.id, lender), /already returned/);
});
