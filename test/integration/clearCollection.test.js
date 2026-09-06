/**
 * Clearing a collection is the one destructive action in the app with no
 * per-card confirmation behind it, so what is pinned here is its blast radius:
 * that it takes every owned row in both finishes, that it leaves the things
 * that are not ownership alone (decks and their card lists, the wanted list),
 * that it writes one auditable row per removal so the wipe can be reconstructed
 * afterwards, and that it refuses to run at all while a trade is open —
 * an accepted trade settles both collections in one transaction and cannot do
 * that against cards which stopped existing underneath it.
 *
 * Run with `npm run test:integration`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-lotus-clear-')), 'test.db');
process.env.DATABASE_PATH = DB_PATH;

const { runMigrations, closeDb } = await import('../../src/db/index.js');
const { default: db } = await import('../../src/db/connection.js');
const { clearCollection, summarizeCollectionForClear } =
  await import('../../src/services/inventoryService.js');

let userId;
let otherUserId;
let deckId;
const printings = {};

const ownedRows = (uid = userId) => db.all(
  `SELECT printing_id, is_foil, quantity FROM owned_printings WHERE user_id = ?`,
  [uid]
);

const stock = () => {
  db.run(`DELETE FROM owned_printings WHERE user_id = ?`, [userId]);
  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,4,0)`,
    [userId, printings.bolt.printingId]
  );
  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,2,1)`,
    [userId, printings.bolt.printingId]
  );
  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,1,0)`,
    [userId, printings.island.printingId]
  );
  db.run(
    `INSERT INTO owned_cards (user_id, card_id, quantity) VALUES (?,?,1)`,
    [userId, printings.bolt.cardId]
  );
};

before(async () => {
  await runMigrations();

  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('wiper','w@example.com','x')`);
  userId = db.get(`SELECT id FROM users WHERE username='wiper'`).id;
  db.run(`INSERT INTO users (username, email, password_hash) VALUES ('partner','p@example.com','x')`);
  otherUserId = db.get(`SELECT id FROM users WHERE username='partner'`).id;

  db.run(`INSERT INTO sets (code, name) VALUES ('AAA','A Set')`);

  const card = (name, typeLine) => {
    db.run(
      `INSERT INTO cards (name, name_normalized, type_line, color_identity) VALUES (?,?,?,'')`,
      [name, name.toLowerCase(), typeLine]
    );
    return db.get(`SELECT id FROM cards WHERE name = ?`, [name]).id;
  };

  const printing = (key, name, typeLine, collector) => {
    const cardId = card(name, typeLine);
    const uuid = `uuid-${key}`;
    db.run(
      `INSERT INTO printings (card_id, uuid, set_code, collector_number, rarity)
       VALUES (?,?,'AAA',?,'common')`,
      [cardId, uuid, collector]
    );
    printings[key] = {
      cardId,
      printingId: db.get(`SELECT id FROM printings WHERE uuid = ?`, [uuid]).id,
    };
  };

  printing('bolt', 'Lightning Bolt', 'Instant', '1');
  printing('island', 'Island', 'Basic Land — Island', '2');

  db.run(`INSERT INTO decks (user_id, name, format) VALUES (?,'Burn','modern')`, [userId]);
  deckId = db.get(`SELECT id FROM decks WHERE name='Burn'`).id;
  db.run(
    `INSERT INTO deck_cards (deck_id, printing_id, quantity, is_foil) VALUES (?,?,4,0)`,
    [deckId, printings.bolt.printingId]
  );

  db.run(
    `INSERT INTO shopping_list_items (user_id, printing_id, quantity) VALUES (?,?,2)`,
    [userId, printings.island.printingId]
  );

  stock();
});

after(() => {
  closeDb();
  fs.rmSync(path.dirname(DB_PATH), { recursive: true, force: true });
});

test('the summary counts copies, cards and foils without changing anything', () => {
  const summary = summarizeCollectionForClear(userId);

  assert.equal(summary.copies, 7, '4 + 2 foil + 1');
  assert.equal(summary.distinctCards, 2);
  assert.equal(summary.foilCopies, 2);
  assert.equal(summary.deckCount, 1);
  assert.equal(summary.openTrades, 0);
  assert.equal(ownedRows().length, 3, 'nothing was removed by looking');
});

test('clearing takes every row in both finishes and nothing of anyone else', () => {
  db.run(
    `INSERT INTO owned_printings (user_id, printing_id, quantity, is_foil) VALUES (?,?,3,0)`,
    [otherUserId, printings.bolt.printingId]
  );

  const result = clearCollection(userId);

  assert.equal(result.copies, 7);
  assert.equal(result.removedRows, 3);
  assert.equal(ownedRows().length, 0, 'the collection is empty');
  assert.equal(
    db.get(`SELECT COUNT(*) AS c FROM owned_cards WHERE user_id = ?`, [userId]).c,
    0,
    'the legacy presence table goes with it'
  );
  assert.equal(ownedRows(otherUserId).length, 1, "the other user's copies are untouched");
});

test('decks and the wanted list survive the wipe', () => {
  assert.equal(db.get(`SELECT COUNT(*) AS c FROM decks WHERE user_id = ?`, [userId]).c, 1);
  assert.equal(
    db.get(`SELECT quantity FROM deck_cards WHERE deck_id = ?`, [deckId]).quantity,
    4,
    'the deck is still listed exactly as it was'
  );
  assert.equal(
    db.get(`SELECT COUNT(*) AS c FROM shopping_list_items WHERE user_id = ?`, [userId]).c,
    1
  );
});

test('every removed row is audited under one batch id', () => {
  const rows = db.all(
    `SELECT quantity_before, quantity_after, detail FROM audit_log
      WHERE user_id = ? AND action = 'inventory.remove'`,
    [userId]
  );

  assert.equal(rows.length, 3, 'one entry per owned row, not one for the wipe');

  const batches = new Set(rows.map((row) => JSON.parse(row.detail).batchId));
  assert.equal(batches.size, 1, 'the wipe can be pulled back out as a unit');

  const before = rows.reduce((sum, row) => sum + row.quantity_before, 0);
  assert.equal(before, 7, 'the entries add back up to what was owned');
  assert.ok(rows.every((row) => row.quantity_after === 0));
  assert.ok(rows.every((row) => JSON.parse(row.detail).reason === 'clear_collection'));
});

test('an open trade blocks the wipe and leaves the collection standing', () => {
  stock();

  db.run(
    `INSERT INTO trades (from_user_id, to_user_id, status) VALUES (?,?,'awaiting_counter')`,
    [otherUserId, userId]
  );

  assert.equal(summarizeCollectionForClear(userId).openTrades, 1);
  assert.throws(() => clearCollection(userId), /open trade/i);
  assert.equal(ownedRows().length, 3, 'nothing moved');

  db.run(`UPDATE trades SET status = 'cancelled'`);
  assert.equal(summarizeCollectionForClear(userId).openTrades, 0);
  assert.equal(clearCollection(userId).removedRows, 3, 'and it runs once the trade is closed');
});
