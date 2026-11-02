/**
 * The deck builder's ownership tick removes one copy, never the lot. Wiping
 * every copy left other decks holding the same card reading as short. Pinned:
 * one copy comes off, from the printing and finish the deck names when owned,
 * the card stays owned while copies remain, and the last press un-owns it.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-toggle1-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { toggleCardOwnership } = await import('../../src/services/cardService.js');

let userId;
let cardId;
const printingIds = [];

const rows = () => db.all(
  `SELECT printing_id, is_foil, quantity FROM owned_printings WHERE user_id = ? ORDER BY printing_id, is_foil`,
  [userId]
);

before(async () => {
  await runMigrations();
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('one','o@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='one'`).id;
  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','A Set')`);
  db.run(`INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES ('Sol Ring','sol ring','Artifact','')`);
  cardId = db.get(`SELECT id FROM cards WHERE name='Sol Ring'`).id;
  for (const n of ['1', '2']) {
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity) VALUES (?,?,'AAA',?,'uncommon')`,
      [cardId, `uuid-${n}`, n]
    );
    printingIds.push(db.get(`SELECT id FROM printings WHERE uuid = ?`, [`uuid-${n}`]).id);
  }
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,2,0)`, [userId, printingIds[0]]);
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,1)`, [userId, printingIds[1]]);
});

after(() => closeDb());

test('removes one copy of the printing and finish the deck lists', () => {
  const result = toggleCardOwnership(userId, cardId, {
    removeOne: true, printingId: printingIds[1], isFoil: true,
  });
  assert.equal(result.owned, true);
  assert.equal(result.copyCount, 2);
  assert.deepEqual(rows(), [{ printing_id: printingIds[0], is_foil: 0, quantity: 2 }]);
});

test('falls back to a non-foil row, and the last copy un-owns the card', () => {
  toggleCardOwnership(userId, cardId, { removeOne: true, printingId: printingIds[1], isFoil: true });
  assert.deepEqual(rows(), [{ printing_id: printingIds[0], is_foil: 0, quantity: 1 }]);

  const last = toggleCardOwnership(userId, cardId, { removeOne: true });
  assert.equal(last.owned, false);
  assert.deepEqual(rows(), []);
});

test('a grey dot adds a copy even while one is owned elsewhere', () => {
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,0)`, [userId, printingIds[0]]);
  const result = toggleCardOwnership(userId, cardId, { addOne: true, printingId: printingIds[1], isFoil: true });
  assert.equal(result.addedOne, true);
  assert.equal(result.copyCount, 2);
  assert.deepEqual(rows(), [
    { printing_id: printingIds[0], is_foil: 0, quantity: 1 },
    { printing_id: printingIds[1], is_foil: 1, quantity: 1 },
  ]);
});

test('is_available: owned but held by an equally committed deck reads as not available', async () => {
  const { getDeckById } = await import('../../src/services/deckService.js');
  db.run(`DELETE FROM owned_printings WHERE user_id = ?`, [userId]);
  db.run(`INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,0)`, [userId, printingIds[0]]);
  db.run(`INSERT OR IGNORE INTO owned_cards (user_id, card_id, quantity) VALUES (?,?,1)`, [userId, cardId]);

  const deck = (name, status) => {
    db.run(`INSERT INTO decks (user_id, name, format, status) VALUES (?,?, 'commander', ?)`, [userId, name, status]);
    const id = db.get(`SELECT id FROM decks WHERE name = ?`, [name]).id;
    db.run(`INSERT INTO deck_cards (deck_id, printing_id, quantity) VALUES (?,?,1)`, [id, printingIds[0]]);
    return id;
  };
  const ready = deck('Sleeved', 'ready');
  const building = deck('New', 'building');

  const card = (id) => getDeckById(id, userId).cards[0];
  assert.equal(card(ready).is_available, 1);
  assert.equal(card(building).is_owned, 1);
  assert.equal(card(building).is_available, 0);
});

test('pull list rows carry the Inventory page counts', async () => {
  const { getPullList } = await import('../../src/services/pullListService.js');
  // From the previous test: 1 copy owned, listed in 'Sleeved' and 'New'.
  const deckId = db.get(`SELECT id FROM decks WHERE name='New'`).id;
  const [row] = getPullList(userId, deckId).cards;
  assert.deepEqual(row.collection, { owned: 1, inDecks: 2, lentOut: 0, available: -1 });
});
